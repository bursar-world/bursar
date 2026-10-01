// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {RecordKeys as K} from "./RecordKeys.sol";

/// The Arbitrum precompile at address 100, which answers the chain's own block height. Robinhood
/// Chain is an Arbitrum chain, so `block.number` there is Ethereum's block number, tens of millions
/// behind the height its own logs are indexed by.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// The part of `AdminTimelock` a script reads to know it is looking at governance. Declared here
/// because the shielded scripts build on this contract with the compiler the vendored code needs,
/// and `src/` outside `shielded/` is pinned to the other one.
interface IGovernance {
    function timelockPeriod() external view returns (uint64);
    function guardian() external view returns (address);
    function getSigners() external view returns (address[3] memory);
}

/// What every deploy, verify and migration script shares: one namespace for the environment, one
/// deployment record for addresses, and the refusals that have to hold before anything is sent.
///
/// Addresses come from the record, figures from the environment. The record at `BURSAR_RECORD`
/// names what is already on chain and who holds each role. A script reads the contracts deployed
/// before it from there, and writes its own there when it finishes, together with the figures it
/// applied, so the next script and every verify script read one file and never a shell.
///
/// A role the record does not name yet is read from the environment once, by the first script
/// that needs it, and recorded. After that the record answers, and an environment that disagrees
/// with it stops the run: a shell carrying last month's treasury is exactly the mistake the
/// record exists to catch.
///
/// A deployment that replaces another names the record it replaces in `supersedes`, and the shell
/// points `BURSAR_PREVIOUS_RECORD` at that record's file. The migration scripts move money out of
/// the contracts it names, the wiring batch winds its shielded pool down, and the verify scripts
/// read it to tell a carried contract still wired to the previous set from one wired wrong.
abstract contract BursarScript is Script {
    /// Robinhood Chain mainnet, read from the chain itself. Testnet 46630 answers, but USDG has no
    /// contract there, so nothing on it can settle and it is not a deploy target.
    uint256 internal constant RHC_CHAIN_ID = 4663;

    /// USDG, a diamond proxy with six decimals.
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint8 internal constant SETTLEMENT_DECIMALS = 6;
    uint256 internal constant BPS = 10_000;

    /// No legitimate parameter reaches these, so they tell an unset variable apart from a zero
    /// someone chose.
    uint256 internal constant UNSET = type(uint256).max;
    address internal constant UNSET_ADDRESS = address(type(uint160).max);

    /// The largest integer a JavaScript reader holds exactly. A figure above it is written as a
    /// decimal string, the way the records have always carried token amounts.
    uint256 private constant MAX_JSON_NUMBER = 2 ** 53 - 1;

    error MissingEnv(string key);
    error InvalidEnv(string key, string value);
    error RetiredEnv(string key, string replacement);
    error EnvOutOfRange(string key, uint256 value, uint256 max);
    error EnvIntOutOfRange(string key, int256 value, int256 min, int256 max);
    error EnvNotBoolean(string key, string value);
    error WrongChain(uint256 expected, uint256 actual);
    error RecordChainMismatch(uint256 recorded, uint256 actual);
    error LocalFlagMismatch(bool flagSet, bool recordIsLocal);
    error NotAnvil(string node);
    error NotRecorded(string key);
    error AlreadyRecorded(string key, address deployed);
    error NotContract(string what, address account);
    error NoAnswer(string what, address account);
    error WrongDeployer(address recorded, address caller);
    error RecordMismatch(string key, address recorded, address fromEnv);
    error PreviousRecordMismatch(string supersedes, string network);
    error TimelockPeriodZero();
    error WiringFailed(string what, address expected, address actual);
    error ParameterNotApplied(string what, uint256 expected, uint256 actual);

    /// Namespace every variable this script reads sits under, empty for an ordinary run.
    ///
    /// The process environment is not part of the EVM state Foundry snapshots per test, so two
    /// suites driving a script in one process write the same variables and read each other's
    /// values. A harness pins a prefix per instance, which lives in state and is therefore
    /// isolated; an operator running two deployments from one shell sets `BURSAR_ENV_PREFIX`.
    string public envPrefix;

    function pinEnvPrefix(string calldata prefix) external {
        envPrefix = prefix;
    }

    /// Read once, so every variable in one run comes from one namespace.
    function _loadPrefix() internal {
        if (bytes(envPrefix).length == 0) envPrefix = vm.envOr("BURSAR_ENV_PREFIX", string(""));
    }

    function _key(string memory key) internal view returns (string memory) {
        return bytes(envPrefix).length == 0 ? key : string.concat(envPrefix, key);
    }

    /// The record, the flag and the chain have to agree before anything else is read.
    ///
    /// A run is local only when `BURSAR_LOCAL=1` is set and the record says `"local": true`. Either
    /// one alone stops the run, so a rehearsal record cannot be pointed at mainnet by a missing
    /// flag, and a mainnet record cannot be rehearsed against by a stray one. A local run also has
    /// to be talking to anvil: a rehearsal chain answers as 4663, so the chain id alone cannot tell
    /// it from Robinhood Chain.
    function _requireChain() internal {
        uint256 recorded = _recordUint(K.CHAIN_ID);
        if (recorded != block.chainid) revert RecordChainMismatch(recorded, block.chainid);

        bool flag = _envFlag("BURSAR_LOCAL");
        bool recordIsLocal = _recordBool(K.LOCAL);
        if (flag != recordIsLocal) revert LocalFlagMismatch(flag, recordIsLocal);
        if (!flag && block.chainid != RHC_CHAIN_ID) revert WrongChain(RHC_CHAIN_ID, block.chainid);
        if (flag) _requireAnvil();

        // Earlier parameter files named the chain as well. One that still does has to agree.
        uint256 named = _envUintOr("BURSAR_CHAIN_ID", UNSET);
        if (named != UNSET && named != block.chainid) revert WrongChain(named, block.chainid);
    }

    /// A rehearsal record names contracts on a chain that lasts as long as its anvil. Against any
    /// other node its addresses mean nothing, and its transactions would be real ones, so a local
    /// run goes on only when the node says it is anvil.
    function _requireAnvil() internal {
        string memory node = _clientVersion();
        if (vm.indexOf(vm.toLowercase(node), "anvil") != type(uint256).max) return;
        // A suite that has not forked a node runs on Foundry's own EVM, which nothing leaves.
        if (bytes(node).length == 0 && vm.isContext(VmSafe.ForgeContext.TestGroup)) return;
        revert NotAnvil(node);
    }

    /// What the node calls itself in `web3_clientVersion`, such as `anvil/v1.8.1`. Empty when no
    /// node answers.
    function _clientVersion() internal virtual returns (string memory) {
        try vm.rpc("web3_clientVersion", "[]") returns (bytes memory answer) {
            return answer.length < 64 ? "" : abi.decode(answer, (string));
        } catch {
            return "";
        }
    }

    function _isLocal() internal view returns (bool) {
        return _recordBool(K.LOCAL);
    }

    /// Robinhood Chain mainnet, the one chain whose settlement asset is pinned by address.
    function _onRobinhood() internal view returns (bool) {
        return block.chainid == RHC_CHAIN_ID && !_isLocal();
    }

    /// The key this run signs with. A record that names its deployer holds every later script
    /// to the same key, because the one-shot setters answer only to the address that deployed
    /// the contracts they wire.
    function _deployer() internal view returns (address deployer) {
        deployer = msg.sender;
        address recorded = _recordAddress(K.DEPLOYER);
        if (recorded != address(0) && recorded != deployer) revert WrongDeployer(recorded, deployer);
    }

    function _recordPath() internal view returns (string memory path) {
        path = vm.envOr(_key("BURSAR_RECORD"), string(""));
        if (bytes(path).length == 0) revert MissingEnv(_key("BURSAR_RECORD"));
    }

    function _json() internal view returns (string memory) {
        return vm.readFile(_recordPath());
    }

    /// The record is read afresh on every lookup, so a write is seen by the next read, and each
    /// read copies the whole file into memory. Memory is never freed and costs the square of its
    /// size, so a run that looks up a few hundred keys would spend most of its gas holding copies
    /// of one file. A lookup that answers with a value keeps none of what it allocated: it notes
    /// where free memory started and hands it back.
    function _memoryMark() private pure returns (uint256 free) {
        assembly {
            free := mload(0x40)
        }
    }

    function _memoryRelease(uint256 free) private pure {
        assembly {
            mstore(0x40, free)
        }
    }

    function _recorded(string memory key) internal view returns (bool found) {
        uint256 free = _memoryMark();
        found = vm.keyExistsJson(_json(), key);
        _memoryRelease(free);
    }

    function _recordAddress(string memory key) internal view returns (address at) {
        uint256 free = _memoryMark();
        string memory json = _json();
        if (vm.keyExistsJson(json, key)) at = vm.parseJsonAddress(json, key);
        _memoryRelease(free);
    }

    function _recordUint(string memory key) internal view returns (uint256 value) {
        uint256 free = _memoryMark();
        string memory json = _json();
        if (!vm.keyExistsJson(json, key)) revert NotRecorded(key);
        value = vm.parseJsonUint(json, key);
        _memoryRelease(free);
    }

    function _recordBool(string memory key) internal view returns (bool value) {
        uint256 free = _memoryMark();
        string memory json = _json();
        value = vm.keyExistsJson(json, key) && vm.parseJsonBool(json, key);
        _memoryRelease(free);
    }

    function _recordString(string memory key) internal view returns (string memory) {
        string memory json = _json();
        return vm.keyExistsJson(json, key) ? vm.parseJsonString(json, key) : "";
    }

    function _recordAddresses(string memory key) internal view returns (address[] memory list) {
        string memory json = _json();
        if (vm.keyExistsJson(json, key)) list = vm.parseJsonAddressArray(json, key);
    }

    /// The file of the record this deployment supersedes, as the shell names it in
    /// `BURSAR_PREVIOUS_RECORD`. Empty when the shell names none.
    function _previousPath() internal view returns (string memory) {
        return _envRaw(_key("BURSAR_PREVIOUS_RECORD"));
    }

    /// The previous record's contents. It has to be the record this one says it supersedes, on
    /// this chain: a shell still pointing at the record before that one is the mistake the
    /// `supersedes` field exists to catch.
    function _previousJson() internal view returns (string memory json) {
        string memory path = _previousPath();
        if (bytes(path).length == 0) revert MissingEnv(_key("BURSAR_PREVIOUS_RECORD"));
        json = vm.readFile(path);
        string memory supersedes = _recordString(K.SUPERSEDES);
        string memory network = vm.keyExistsJson(json, K.NETWORK) ? vm.parseJsonString(json, K.NETWORK) : "";
        if (keccak256(bytes(supersedes)) != keccak256(bytes(network))) {
            revert PreviousRecordMismatch(supersedes, network);
        }
        uint256 chain = vm.parseJsonUint(json, K.CHAIN_ID);
        if (chain != block.chainid) revert RecordChainMismatch(chain, block.chainid);
    }

    /// An address the previous record names, or zero when the shell names no previous record or
    /// that record lacks the key.
    function _previousAddress(string memory key) internal view returns (address at) {
        if (bytes(_previousPath()).length == 0) return address(0);
        uint256 free = _memoryMark();
        string memory json = _previousJson();
        if (vm.keyExistsJson(json, key)) at = vm.parseJsonAddress(json, key);
        _memoryRelease(free);
    }

    /// A contract an earlier script deployed, which this one builds on. Missing, or recorded with
    /// no code behind it, the run stops before it sends anything.
    function _upstream(string memory key) internal view returns (address at) {
        at = _recordAddress(key);
        if (at == address(0)) revert NotRecorded(key);
        if (at.code.length == 0) revert NotContract(key, at);
    }

    /// Refuses to deploy what the record already holds, because a second copy splits callers
    /// between two contracts. `BURSAR_FORCE=1` replaces it.
    ///
    /// An entry with no code behind it is a run whose broadcast never landed. It points at nothing,
    /// so replacing it loses nothing, and the run carries on.
    function _requireUnrecorded(string memory key) internal view {
        address at = _recordAddress(key);
        if (at == address(0)) return;
        if (at.code.length == 0) {
            console2.log(string.concat(key, " is recorded with no code behind it; this run replaces it"));
            return;
        }
        if (_envFlag("BURSAR_FORCE")) {
            console2.log(string.concat("BURSAR_FORCE=1: this run replaces ", key));
            return;
        }
        revert AlreadyRecorded(key, at);
    }

    /// A role address. The record answers when it names one; otherwise the environment does, and
    /// the run records it. When both do, they have to agree.
    function _role(string memory key, string memory envName) internal view returns (address) {
        return _roleOr(key, envName, address(0));
    }

    function _roleOr(string memory key, string memory envName, address otherwise) internal view returns (address) {
        address recorded = _recordAddress(key);
        address named = _envAddressOr(envName, address(0));
        if (recorded != address(0)) {
            if (named != address(0) && named != recorded) revert RecordMismatch(key, recorded, named);
            return recorded;
        }
        if (named != address(0)) return named;
        if (otherwise != address(0)) return otherwise;
        revert MissingEnv(_key(envName));
    }

    /// The settlement asset every contract in the record settles in. A parameter file that still
    /// names one has to name the same.
    function _settlementAsset() internal view returns (address asset) {
        asset = _recordAddress(K.SETTLEMENT_ASSET);
        if (asset == address(0)) revert NotRecorded(K.SETTLEMENT_ASSET);
        address named = _envAddressOr("BURSAR_SETTLEMENT_ASSET", address(0));
        if (named != address(0) && named != asset) revert RecordMismatch(K.SETTLEMENT_ASSET, asset, named);
    }

    /// The governance every contract after the core set answers to, from the record. It has to
    /// hold code and a delay, and to be the governance the record's roles describe: a timelock
    /// with someone else's guardian or signers is someone else's timelock.
    function _timelock() internal view returns (address timelock) {
        // The RWA, privacy and shielded scripts read governance from the record. A shell that
        // still sets their retired `BURSAR_TIMELOCK` stops the run.
        _refuseRetired("BURSAR_TIMELOCK", "the record's contracts.AdminTimelock");
        timelock = _upstream(K.ADMIN_TIMELOCK);
        address named = _envAddressOr("BURSAR_ADMIN_TIMELOCK", address(0));
        if (named != address(0) && named != timelock) revert RecordMismatch(K.ADMIN_TIMELOCK, timelock, named);

        IGovernance governance = IGovernance(timelock);
        try governance.timelockPeriod() returns (uint64 period) {
            if (period == 0) revert TimelockPeriodZero();
        } catch {
            revert NoAnswer("AdminTimelock.timelockPeriod", timelock);
        }
        address guardian = _recordAddress(K.GUARDIAN);
        if (guardian != address(0)) _expect("AdminTimelock.guardian", guardian, governance.guardian());
        address[] memory signers = _recordAddresses(K.SIGNERS);
        if (signers.length == 3) {
            address[3] memory live = governance.getSigners();
            for (uint256 i; i < 3; ++i) {
                _expect("AdminTimelock.signer", signers[i], live[i]);
            }
        }
    }

    /// Writes are skipped on a dry run, which is what `forge script` without `--broadcast` is.
    /// The record then still describes the chain, and the next script reads what is really there.
    function _write(string memory key, address value) internal {
        _put(key, vm.toString(value));
    }

    function _write(string memory key, uint256 value) internal {
        _put(key, value > MAX_JSON_NUMBER ? _quoted(vm.toString(value)) : vm.toString(value));
    }

    function _writeString(string memory key, string memory value) internal {
        _put(key, _quoted(value));
    }

    function _write(string memory key, bytes32 value) internal {
        _put(key, _quoted(vm.toString(value)));
    }

    function _write(string memory key, bool value) internal {
        _put(key, value ? "true" : "false");
    }

    function _write(string memory key, address[] memory values) internal {
        string memory list = "[";
        for (uint256 i; i < values.length; ++i) {
            list = string.concat(list, i == 0 ? "" : ",", _quoted(vm.toString(values[i])));
        }
        _put(key, string.concat(list, "]"));
    }

    /// Token amounts are always strings, whatever their size, so a reader never has to guess.
    function _writeAmount(string memory key, uint256 value) internal {
        _put(key, _quoted(vm.toString(value)));
    }

    function _put(string memory key, string memory json) private {
        _putAt(_recordPath(), key, json);
    }

    /// Writes into a record other than this run's, which only the retirement step does.
    function _putAt(string memory path, string memory key, string memory json) internal {
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            console2.log(string.concat("dry run, not recorded: ", path, " ", key, " = ", json));
            return;
        }
        vm.writeJson(json, path, key);
    }

    function _quoted(string memory value) internal pure returns (string memory) {
        return string.concat('"', value, '"');
    }

    /// A unix time as a UTC date, `2026-09-30 14:05:00 UTC`, so the end of a delay or an unbonding
    /// period can be read off a calendar. The date is Howard Hinnant's `civil_from_days`, whose
    /// years start in March so that a leap day falls at the end of one.
    function _utc(uint256 timestamp) internal pure returns (string memory) {
        uint256 z = timestamp / 1 days + 719_468;
        uint256 era = z / 146_097;
        uint256 dayOfEra = z - era * 146_097;
        uint256 yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365;
        uint256 dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100);
        uint256 fromMarch = (5 * dayOfYear + 2) / 153;
        uint256 day = dayOfYear - (153 * fromMarch + 2) / 5 + 1;
        uint256 month = fromMarch < 10 ? fromMarch + 3 : fromMarch - 9;
        uint256 year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
        uint256 time = timestamp % 1 days;
        return string.concat(
            vm.toString(year),
            "-",
            _twoDigits(month),
            "-",
            _twoDigits(day),
            " ",
            _twoDigits(time / 1 hours),
            ":",
            _twoDigits((time % 1 hours) / 1 minutes),
            ":",
            _twoDigits(time % 1 minutes),
            " UTC"
        );
    }

    /// How long until `timestamp`, in the two largest units that apply.
    function _until(uint256 timestamp) internal view returns (string memory) {
        if (timestamp <= block.timestamp) return "now";
        uint256 left = timestamp - block.timestamp;
        if (left < 2 minutes) return _count(left, "second");
        if (left < 2 hours) return _count((left + 1 minutes - 1) / 1 minutes, "minute");
        if (left < 2 days) {
            return string.concat(_count(left / 1 hours, "hour"), " ", _count((left % 1 hours) / 1 minutes, "minute"));
        }
        return string.concat(_count(left / 1 days, "day"), " ", _count((left % 1 days) / 1 hours, "hour"));
    }

    function _count(uint256 n, string memory unit) private pure returns (string memory) {
        return string.concat(vm.toString(n), " ", unit, n == 1 ? "" : "s");
    }

    function _twoDigits(uint256 n) private pure returns (string memory) {
        return n < 10 ? string.concat("0", vm.toString(n)) : vm.toString(n);
    }

    /// The block a reader scans this deployment's logs from: the chain's own height, which the
    /// Arbitrum precompile answers on Robinhood Chain and in a simulation against it. A chain with
    /// no precompile at that address, which a local anvil is, answers nothing, and its `block.number`
    /// is the height its logs are indexed by.
    function _chainBlock() internal view returns (uint256) {
        (bool ok, bytes memory answer) = address(100).staticcall(abi.encodeCall(IArbSys.arbBlockNumber, ()));
        if (ok && answer.length == 32) return abi.decode(answer, (uint256));
        return block.number;
    }

    /// Whether `account`'s code carries `target` as a 20-byte constant, which is how a contract
    /// names a library it was linked against.
    function _linksTo(address account, address target) internal view returns (bool) {
        bytes memory code = account.code;
        bytes20 needle = bytes20(target);
        for (uint256 i; i + 20 <= code.length; ++i) {
            bytes20 window;
            assembly ("memory-safe") {
                window := mload(add(add(code, 0x20), i))
            }
            if (window == needle) return true;
        }
        return false;
    }

    /// An address read that has to answer. A contract that does not implement the read reverts
    /// with nothing to explain it; this names the read and the address instead.
    function _read(address target, bytes memory call, string memory what) internal view returns (address) {
        (bool ok, bytes memory answer) = target.staticcall(call);
        if (!ok || answer.length < 32) revert NoAnswer(what, target);
        return abi.decode(answer, (address));
    }

    function _requireCode(string memory what, address account) internal view {
        if (account.code.length == 0) revert NotContract(what, account);
    }

    function _expect(string memory what, address expected, address actual) internal pure {
        if (expected != actual) revert WiringFailed(what, expected, actual);
    }

    function _expectUint(string memory what, uint256 expected, uint256 actual) internal pure {
        if (expected != actual) revert ParameterNotApplied(what, expected, actual);
    }

    /// A retired variable still holds a value in the unit it was retired for. Reading it under
    /// the new name would be worse than ignoring it.
    function _refuseRetired(string memory key, string memory replacement) internal view {
        string memory name = _key(key);
        if (bytes(_envRaw(name)).length != 0) revert RetiredEnv(name, replacement);
    }

    /// `1` or `true` turns a flag on. Anything else, unset included, leaves it off.
    function _envFlag(string memory key) internal view returns (bool) {
        bytes32 given = keccak256(bytes(_envRaw(_key(key))));
        return given == keccak256("1") || given == keccak256("true");
    }

    /// A variable as the shell holds it, trimmed. Unset and set to nothing read the same.
    ///
    /// Every typed read starts here. `vm.envOr` answers a value it cannot parse with the default,
    /// so `BURSAR_FEE_BPS=1%` would read as unset and be reported as missing; parsed here, it stops
    /// the run as `InvalidEnv` with the variable and what it holds.
    function _envRaw(string memory name) internal view returns (string memory) {
        return vm.trim(vm.envOr(name, string("")));
    }

    function _envString(string memory key) internal view returns (string memory value) {
        string memory name = _key(key);
        value = _envRaw(name);
        if (bytes(value).length == 0) revert MissingEnv(name);
    }

    function _envAddress(string memory key) internal view returns (address value) {
        value = _envAddressOr(key, address(0));
        if (value == address(0)) revert MissingEnv(_key(key));
    }

    function _envAddressOr(string memory key, address whenUnset) internal view returns (address) {
        string memory name = _key(key);
        string memory raw = _envRaw(name);
        return bytes(raw).length == 0 ? whenUnset : _parseAddress(name, raw);
    }

    function _envUint(string memory key) internal view returns (uint256) {
        string memory name = _key(key);
        string memory raw = _envRaw(name);
        if (bytes(raw).length == 0) revert MissingEnv(name);
        return _parseUint(name, raw);
    }

    function _envUintOr(string memory key, uint256 whenUnset) internal view returns (uint256) {
        string memory name = _key(key);
        string memory raw = _envRaw(name);
        return bytes(raw).length == 0 ? whenUnset : _parseUint(name, raw);
    }

    function _envBytes(string memory key) internal view returns (bytes memory) {
        string memory name = _key(key);
        string memory raw = _envRaw(name);
        if (bytes(raw).length == 0) revert MissingEnv(name);
        try vm.parseBytes(raw) returns (bytes memory value) {
            return value;
        } catch {
            revert InvalidEnv(name, raw);
        }
    }

    /// Spelled out, because `envOr` reads an unset variable as false and would quietly skip
    /// whatever it gates.
    function _envBool(string memory key) internal view returns (bool) {
        string memory name = _key(key);
        string memory raw = _envRaw(name);
        bytes32 given = keccak256(bytes(raw));
        if (given == keccak256("")) revert MissingEnv(name);
        if (given == keccak256("true")) return true;
        if (given == keccak256("false")) return false;
        revert EnvNotBoolean(name, raw);
    }

    function _envAddressList(string memory key) internal view returns (address[] memory value) {
        string memory name = _key(key);
        string[] memory items = _envItems(name);
        value = new address[](items.length);
        for (uint256 i; i < items.length; ++i) {
            value[i] = _parseAddress(name, items[i]);
        }
    }

    function _envUint128List(string memory key) internal view returns (uint128[] memory value) {
        string memory name = _key(key);
        string[] memory items = _envItems(name);
        value = new uint128[](items.length);
        for (uint256 i; i < items.length; ++i) {
            uint256 item = _parseUint(name, items[i]);
            if (item > type(uint128).max) revert EnvOutOfRange(name, item, type(uint128).max);
            // forge-lint: disable-next-line(unsafe-typecast)
            value[i] = uint128(item);
        }
    }

    /// The comma-separated items of a list, each trimmed; an empty item stops the run as a typo.
    function _envItems(string memory name) private view returns (string[] memory items) {
        string memory raw = _envRaw(name);
        if (bytes(raw).length == 0) revert MissingEnv(name);
        items = vm.split(raw, ",");
        for (uint256 i; i < items.length; ++i) {
            items[i] = vm.trim(items[i]);
            if (bytes(items[i]).length == 0) revert InvalidEnv(name, raw);
        }
    }

    function _parseUint(string memory name, string memory raw) internal pure returns (uint256) {
        try vm.parseUint(raw) returns (uint256 value) {
            return value;
        } catch {
            revert InvalidEnv(name, raw);
        }
    }

    function _parseInt(string memory name, string memory raw) internal pure returns (int256) {
        try vm.parseInt(raw) returns (int256 value) {
            return value;
        } catch {
            revert InvalidEnv(name, raw);
        }
    }

    function _parseAddress(string memory name, string memory raw) internal pure returns (address) {
        try vm.parseAddress(raw) returns (address value) {
            return value;
        } catch {
            revert InvalidEnv(name, raw);
        }
    }

    /// Each narrowing read range-checks the value on the line above the cast. A variable that
    /// does not fit its field is named in `EnvOutOfRange`, never silently wrapped into a fee or a
    /// window nobody chose.
    // forge-lint: disable-start(unsafe-typecast)
    function _envUint8(string memory key) internal view returns (uint8) {
        uint256 value = _envUint(key);
        if (value > type(uint8).max) revert EnvOutOfRange(_key(key), value, type(uint8).max);
        return uint8(value);
    }

    function _envUint16(string memory key) internal view returns (uint16) {
        uint256 value = _envUint(key);
        if (value > type(uint16).max) revert EnvOutOfRange(_key(key), value, type(uint16).max);
        return uint16(value);
    }

    function _envUint24(string memory key) internal view returns (uint24) {
        uint256 value = _envUint(key);
        if (value > type(uint24).max) revert EnvOutOfRange(_key(key), value, type(uint24).max);
        return uint24(value);
    }

    function _envUint64(string memory key) internal view returns (uint64) {
        uint256 value = _envUint(key);
        if (value > type(uint64).max) revert EnvOutOfRange(_key(key), value, type(uint64).max);
        return uint64(value);
    }

    function _envUint128(string memory key) internal view returns (uint128) {
        uint256 value = _envUint(key);
        if (value > type(uint128).max) revert EnvOutOfRange(_key(key), value, type(uint128).max);
        return uint128(value);
    }

    function _envUint128Or(string memory key, uint128 whenUnset) internal view returns (uint128) {
        uint256 value = _envUintOr(key, whenUnset);
        if (value > type(uint128).max) revert EnvOutOfRange(_key(key), value, type(uint128).max);
        return uint128(value);
    }

    function _envInt24(string memory key) internal view returns (int24) {
        string memory name = _key(key);
        string memory raw = _envRaw(name);
        if (bytes(raw).length == 0) revert MissingEnv(name);
        int256 value = _parseInt(name, raw);
        if (value < type(int24).min || value > type(int24).max) {
            revert EnvIntOutOfRange(name, value, type(int24).min, type(int24).max);
        }
        return int24(value);
    }
    // forge-lint: disable-end
}
