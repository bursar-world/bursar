// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {RecordKeys as K} from "./RecordKeys.sol";

/// The part of `AdminTimelock` a script reads to know it is looking at governance. Declared here
/// rather than imported, because the shielded scripts build on this contract with the compiler
/// the vendored code needs, and `src/` outside `shielded/` is pinned to the other one.
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
abstract contract BursarScript is Script {
    /// Robinhood Chain mainnet, read from the chain itself. Testnet 46630 answers, but USDG holds
    /// no contract there, so nothing on it can settle and it is not a deploy target.
    uint256 internal constant RHC_CHAIN_ID = 4663;

    /// USDG. Six decimals, a diamond proxy, verified on chain.
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint8 internal constant SETTLEMENT_DECIMALS = 6;
    uint256 internal constant BPS = 10_000;

    /// No legitimate parameter reaches these, so they tell an unset variable apart from a zero
    /// someone chose.
    uint256 internal constant UNSET = type(uint256).max;
    address internal constant UNSET_ADDRESS = address(type(uint160).max);
    int256 internal constant UNSET_INT = type(int256).min;

    /// The largest integer a JavaScript reader holds exactly. A figure above it is written as a
    /// decimal string, the way the records have always carried token amounts.
    uint256 private constant MAX_JSON_NUMBER = 2 ** 53 - 1;

    error MissingEnv(string key);
    error RetiredEnv(string key, string replacement);
    error EnvOutOfRange(string key, uint256 value, uint256 max);
    error EnvIntOutOfRange(string key, int256 value, int256 min, int256 max);
    error EnvNotBoolean(string key, string value);
    error WrongChain(uint256 expected, uint256 actual);
    error RecordChainMismatch(uint256 recorded, uint256 actual);
    error LocalFlagMismatch(bool flagSet, bool recordIsLocal);
    error NotRecorded(string key);
    error AlreadyRecorded(string key, address deployed);
    error NotContract(string what, address account);
    error NoAnswer(string what, address account);
    error WrongDeployer(address recorded, address caller);
    error RecordMismatch(string key, address recorded, address fromEnv);
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

    // --- the chain ---

    /// The record, the flag and the chain have to agree before anything else is read.
    ///
    /// A run is local only when `BURSAR_LOCAL=1` is set and the record says `"local": true`. Either
    /// one alone stops the run, so a rehearsal record cannot be pointed at mainnet by a missing
    /// flag, and a mainnet record cannot be rehearsed against by a stray one.
    function _requireChain() internal view {
        uint256 recorded = _recordUint(K.CHAIN_ID);
        if (recorded != block.chainid) revert RecordChainMismatch(recorded, block.chainid);

        bool flag = _envFlag("BURSAR_LOCAL");
        bool recordIsLocal = _recordBool(K.LOCAL);
        if (flag != recordIsLocal) revert LocalFlagMismatch(flag, recordIsLocal);
        if (!flag && block.chainid != RHC_CHAIN_ID) revert WrongChain(RHC_CHAIN_ID, block.chainid);

        // Earlier parameter files named the chain as well. One that still does has to agree.
        uint256 named = vm.envOr(_key("BURSAR_CHAIN_ID"), UNSET);
        if (named != UNSET && named != block.chainid) revert WrongChain(named, block.chainid);
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

    // --- the record ---

    function _recordPath() internal view returns (string memory path) {
        path = vm.envOr(_key("BURSAR_RECORD"), string(""));
        if (bytes(path).length == 0) revert MissingEnv(_key("BURSAR_RECORD"));
    }

    function _json() internal view returns (string memory) {
        return vm.readFile(_recordPath());
    }

    function _recorded(string memory key) internal view returns (bool) {
        return vm.keyExistsJson(_json(), key);
    }

    function _recordAddress(string memory key) internal view returns (address) {
        string memory json = _json();
        return vm.keyExistsJson(json, key) ? vm.parseJsonAddress(json, key) : address(0);
    }

    function _recordUint(string memory key) internal view returns (uint256) {
        string memory json = _json();
        if (!vm.keyExistsJson(json, key)) revert NotRecorded(key);
        return vm.parseJsonUint(json, key);
    }

    function _recordBool(string memory key) internal view returns (bool) {
        string memory json = _json();
        return vm.keyExistsJson(json, key) && vm.parseJsonBool(json, key);
    }

    function _recordString(string memory key) internal view returns (string memory) {
        string memory json = _json();
        return vm.keyExistsJson(json, key) ? vm.parseJsonString(json, key) : "";
    }

    function _recordAddresses(string memory key) internal view returns (address[] memory list) {
        string memory json = _json();
        if (vm.keyExistsJson(json, key)) list = vm.parseJsonAddressArray(json, key);
    }

    /// A contract an earlier script deployed, which this one builds on. Missing, or recorded with
    /// no code behind it, the run stops before it sends anything.
    function _upstream(string memory key) internal view returns (address at) {
        at = _recordAddress(key);
        if (at == address(0)) revert NotRecorded(key);
        if (at.code.length == 0) revert NotContract(key, at);
    }

    /// Refuses to deploy what the record already holds, because a second copy of a contract the
    /// rest of the system points at is two answers to one question. `BURSAR_FORCE=1` replaces it.
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
        address named = vm.envOr(_key(envName), address(0));
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
        address named = vm.envOr(_key("BURSAR_SETTLEMENT_ASSET"), address(0));
        if (named != address(0) && named != asset) revert RecordMismatch(K.SETTLEMENT_ASSET, asset, named);
    }

    /// The governance every contract after the core set answers to, from the record. It has to
    /// hold code and a delay, and to be the governance the record's roles describe: a timelock
    /// with someone else's guardian or signers is someone else's timelock.
    function _timelock() internal view returns (address timelock) {
        // The rwa, privacy and shielded scripts used to read governance from this name, in a
        // different file each. One name remains, and the record answers before it.
        _refuseRetired("BURSAR_TIMELOCK", "the record's contracts.AdminTimelock");
        timelock = _upstream(K.ADMIN_TIMELOCK);
        address named = vm.envOr(_key("BURSAR_ADMIN_TIMELOCK"), address(0));
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

    // --- checks ---

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

    // --- the environment ---

    /// A retired variable still holds a value in the unit it was retired for. Reading it under
    /// the new name would be worse than ignoring it.
    function _refuseRetired(string memory key, string memory replacement) internal view {
        string memory name = _key(key);
        if (bytes(vm.envOr(name, string(""))).length != 0) revert RetiredEnv(name, replacement);
    }

    /// `1` or `true` turns a flag on. Anything else, unset included, leaves it off.
    function _envFlag(string memory key) internal view returns (bool) {
        bytes32 given = keccak256(bytes(vm.envOr(_key(key), string(""))));
        return given == keccak256("1") || given == keccak256("true");
    }

    function _envAddress(string memory key) internal view returns (address value) {
        string memory name = _key(key);
        value = vm.envOr(name, address(0));
        if (value == address(0)) revert MissingEnv(name);
    }

    function _envUint(string memory key) internal view returns (uint256 value) {
        string memory name = _key(key);
        value = vm.envOr(name, UNSET);
        if (value == UNSET) revert MissingEnv(name);
    }

    function _envUintOr(string memory key, uint256 whenUnset) internal view returns (uint256) {
        return vm.envOr(_key(key), whenUnset);
    }

    /// Spelled out, because `envOr` reads an unset variable as false and would quietly skip
    /// whatever it gates.
    function _envBool(string memory key) internal view returns (bool) {
        string memory name = _key(key);
        string memory raw = vm.envOr(name, string(""));
        bytes32 given = keccak256(bytes(raw));
        if (given == keccak256("")) revert MissingEnv(name);
        if (given == keccak256("true")) return true;
        if (given == keccak256("false")) return false;
        revert EnvNotBoolean(name, raw);
    }

    function _envAddressList(string memory key) internal view returns (address[] memory value) {
        address[] memory empty;
        value = vm.envOr(_key(key), ",", empty);
        if (value.length == 0) revert MissingEnv(_key(key));
    }

    function _envUint128List(string memory key) internal view returns (uint128[] memory value) {
        string memory name = _key(key);
        uint256[] memory empty;
        uint256[] memory raw = vm.envOr(name, ",", empty);
        if (raw.length == 0) revert MissingEnv(name);

        value = new uint128[](raw.length);
        for (uint256 i; i < raw.length; ++i) {
            if (raw[i] > type(uint128).max) revert EnvOutOfRange(name, raw[i], type(uint128).max);
            // forge-lint: disable-next-line(unsafe-typecast)
            value[i] = uint128(raw[i]);
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
        string memory name = _key(key);
        uint256 value = vm.envOr(name, uint256(whenUnset));
        if (value > type(uint128).max) revert EnvOutOfRange(name, value, type(uint128).max);
        return uint128(value);
    }

    function _envInt24(string memory key) internal view returns (int24) {
        string memory name = _key(key);
        int256 value = vm.envOr(name, UNSET_INT);
        if (value == UNSET_INT) revert MissingEnv(name);
        if (value < type(int24).min || value > type(int24).max) {
            revert EnvIntOutOfRange(name, value, type(int24).min, type(int24).max);
        }
        return int24(value);
    }
    // forge-lint: disable-end
}
