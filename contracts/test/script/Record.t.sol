// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {ScriptHarness} from "./ScriptHarness.sol";

/// The record helpers every script shares, called one at a time.
contract RecordProbe is BursarScript {
    string internal node;
    bool internal answers;

    /// What the node calls itself, as though a fork of it were running.
    function answerAs(string calldata node_) external {
        node = node_;
        answers = true;
    }

    function _clientVersion() internal override returns (string memory) {
        return answers ? node : super._clientVersion();
    }

    function writeAddress(string calldata key, address value) external {
        _write(key, value);
    }

    function writeUint(string calldata key, uint256 value) external {
        _write(key, value);
    }

    function writeBool(string calldata key, bool value) external {
        _write(key, value);
    }

    function writeAddresses(string calldata key, address[] calldata values) external {
        _write(key, values);
    }

    function writeBytes32(string calldata key, bytes32 value) external {
        _write(key, value);
    }

    function writeString(string calldata key, string calldata value) external {
        _writeString(key, value);
    }

    function writeAmount(string calldata key, uint256 value) external {
        _writeAmount(key, value);
    }

    function recordAddress(string calldata key) external view returns (address) {
        return _recordAddress(key);
    }

    function recordUint(string calldata key) external view returns (uint256) {
        return _recordUint(key);
    }

    function recordBool(string calldata key) external view returns (bool) {
        return _recordBool(key);
    }

    function recordString(string calldata key) external view returns (string memory) {
        return _recordString(key);
    }

    function recordAddresses(string calldata key) external view returns (address[] memory) {
        return _recordAddresses(key);
    }

    function requireChain() external {
        _requireChain();
    }

    function requireUnrecorded(string calldata key) external view {
        _requireUnrecorded(key);
    }

    function deployer() external view returns (address) {
        return _deployer();
    }

    function role(string calldata key, string calldata envName) external view returns (address) {
        return _role(key, envName);
    }

    function upstream(string calldata key) external view returns (address) {
        return _upstream(key);
    }

    function settlementAsset() external view returns (address) {
        return _settlementAsset();
    }

    function envUint(string calldata key) external view returns (uint256) {
        return _envUint(key);
    }

    function envAddressList(string calldata key) external view returns (address[] memory) {
        return _envAddressList(key);
    }

    function envInt24(string calldata key) external view returns (int24) {
        return _envInt24(key);
    }

    function utc(uint256 timestamp) external pure returns (string memory) {
        return _utc(timestamp);
    }

    function until(uint256 timestamp) external view returns (string memory) {
        return _until(timestamp);
    }
}

/// Writes then reads back every shape a script records, the guards that decide whether a record
/// may be used on this chain at all, and the committed records themselves.
contract RecordTest is ScriptHarness {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant MAX_JSON_NUMBER = 2 ** 53 - 1;

    RecordProbe internal probe;
    string internal path;

    function _prefix() internal pure override returns (string memory) {
        return "RECORD_";
    }

    function setUp() public {
        probe = new RecordProbe();
        probe.pinEnvPrefix(_prefix());
    }

    /// A rehearsal record on 4663 and a shell with nothing else set, before each case.
    function _fresh() private {
        vm.chainId(4663);
        path = _useRecord("record", _baseRecord("record", 4663, true, USDG));
        _set("BURSAR_LOCAL", "1");
        _unset("BURSAR_FORCE");
        _unset("BURSAR_CHAIN_ID");
        _unset("BURSAR_SETTLEMENT_ASSET");
        _unset("BURSAR_TREASURY");
    }

    /// The environment is shared by every test in the process, so every case that reads it runs
    /// here, in order.
    function test_record_writesReadsAndRefusesInTheOrderAScriptMeetsThem() public {
        _whatIsWrittenIsWhatIsRead();
        _theChainTheFlagAndTheRecordHaveToAgree();
        _aRehearsalRecordRunsOnlyOnAnvil();
        _aValueThatDoesNotParseIsNamed();
        _whatIsRecordedIsNotDeployedTwice();
        _laterScriptsAreHeldToTheRecordedDeployKey();
        _aRoleIsReadOnceAndThenTheRecordAnswers();
    }

    function _contains(string memory text, string memory part) private pure returns (bool) {
        return vm.indexOf(text, part) != type(uint256).max;
    }

    function _whatIsWrittenIsWhatIsRead() private {
        _fresh();
        address pool = makeAddr("creditPool");
        probe.writeAddress(K.CREDIT_POOL, pool);
        probe.writeUint(K.PRIVACY_FROM_BLOCK, 1234);
        probe.writeUint(".parameters.Staking.minBond", 1e27);
        probe.writeUint(".parameters.edge.largestNumber", MAX_JSON_NUMBER);
        probe.writeUint(".parameters.edge.firstString", MAX_JSON_NUMBER + 1);
        probe.writeBool(".token.poolOpen", true);
        address[] memory resolvers = new address[](3);
        resolvers[0] = makeAddr("resolver1");
        resolvers[1] = makeAddr("resolver2");
        resolvers[2] = makeAddr("resolver3");
        probe.writeAddresses(K.RESOLVERS, resolvers);
        bytes32 id = keccak256("pool");
        probe.writeBytes32(".token.poolId", id);
        probe.writeString(".rwa.assets.SGOV.kind", "treasury");
        probe.writeAmount(".parameters.CommittedMandateFactory.ceiling", 25e6);
        probe.writeAmount(K.SHIELDED_MAX_PER_DEPOSITOR, 250e6);
        probe.writeUint(K.SHIELDED_DEPOSITOR_WINDOW, 7 days);
        probe.writeAmount(".parameters.Reputation.fullCredit", 250e6);
        probe.writeUint(".parameters.PriceGuard.maxFeedJumpBps", 1500);
        probe.writeAddress(K.ESCROW_PAUSER, makeAddr("firstTimelock"));
        probe.writeUint(K.GOVERNANCE48_PERIOD, 48 hours);

        // Sections that did not exist are created, and what the record held stays.
        assertEq(probe.recordAddress(K.CREDIT_POOL), pool);
        assertEq(probe.recordUint(K.PRIVACY_FROM_BLOCK), 1234);
        assertEq(probe.recordUint(".parameters.Staking.minBond"), 1e27);
        assertEq(probe.recordUint(".parameters.edge.largestNumber"), MAX_JSON_NUMBER);
        assertEq(probe.recordUint(".parameters.edge.firstString"), MAX_JSON_NUMBER + 1);
        assertTrue(probe.recordBool(".token.poolOpen"));
        assertEq(probe.recordAddresses(K.RESOLVERS), resolvers);
        assertEq(vm.parseJsonBytes32(vm.readFile(path), ".token.poolId"), id);
        assertEq(probe.recordString(".rwa.assets.SGOV.kind"), "treasury");
        assertEq(probe.recordUint(".parameters.CommittedMandateFactory.ceiling"), 25e6);
        assertEq(probe.recordUint(K.SHIELDED_MAX_PER_DEPOSITOR), 250e6);
        assertEq(probe.recordUint(K.SHIELDED_DEPOSITOR_WINDOW), 7 days);
        assertEq(probe.recordUint(".parameters.Reputation.fullCredit"), 250e6);
        assertEq(probe.recordUint(".parameters.PriceGuard.maxFeedJumpBps"), 1500);
        assertEq(probe.recordAddress(K.ESCROW_PAUSER), makeAddr("firstTimelock"));
        assertEq(probe.recordUint(K.GOVERNANCE48_PERIOD), 48 hours);
        assertEq(probe.recordString(".network"), "record");
        assertEq(probe.settlementAsset(), USDG);

        // A JavaScript reader holds integers exactly up to 2^53. Past that, and for every token
        // amount, the record carries a decimal string.
        string memory raw = vm.readFile(path);
        assertTrue(_contains(raw, '"fromBlock": 1234'));
        assertTrue(_contains(raw, string.concat('"largestNumber": ', vm.toString(MAX_JSON_NUMBER))));
        assertTrue(_contains(raw, string.concat('"firstString": "', vm.toString(MAX_JSON_NUMBER + 1), '"')));
        assertTrue(_contains(raw, '"minBond": "1000000000000000000000000000"'));
        assertTrue(_contains(raw, '"ceiling": "25000000"'));

        // A second write replaces the first.
        address replacement = makeAddr("replacement");
        probe.writeAddress(K.CREDIT_POOL, replacement);
        assertEq(probe.recordAddress(K.CREDIT_POOL), replacement);

        // What is not recorded reads as nothing, and a figure that has to be there says so.
        assertEq(probe.recordAddress(K.SHIELDED_POOL), address(0));
        assertFalse(probe.recordBool(".token.neverWritten"));
        vm.expectRevert(abi.encodeWithSelector(BursarScript.NotRecorded.selector, ".token.neverWritten"));
        probe.recordUint(".token.neverWritten");
    }

    /// The record, the flag and the chain decide together whether a run may go on.
    function _theChainTheFlagAndTheRecordHaveToAgree() private {
        _fresh();
        probe.requireChain();

        _set("BURSAR_LOCAL", "0");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.LocalFlagMismatch.selector, false, true));
        probe.requireChain();

        // A mainnet record cannot be rehearsed against by a stray flag.
        path = _useRecord("record", _baseRecord("record", 4663, false, USDG));
        probe.requireChain();
        _set("BURSAR_LOCAL", "1");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.LocalFlagMismatch.selector, true, false));
        probe.requireChain();
        _set("BURSAR_LOCAL", "0");

        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(BursarScript.RecordChainMismatch.selector, 4663, 1));
        probe.requireChain();

        // A record written for another chain is still only deployable to as a rehearsal.
        path = _useRecord("record", _baseRecord("record", 1, false, USDG));
        vm.expectRevert(abi.encodeWithSelector(BursarScript.WrongChain.selector, 4663, 1));
        probe.requireChain();
        path = _useRecord("record", _baseRecord("record", 1, true, USDG));
        _set("BURSAR_LOCAL", "1");
        probe.requireChain();

        // A parameter file that still names a chain has to name this one.
        _set("BURSAR_CHAIN_ID", "4663");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.WrongChain.selector, 4663, 1));
        probe.requireChain();
        _unset("BURSAR_CHAIN_ID");

        _set("BURSAR_RECORD", "");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_RECORD")));
        probe.requireChain();
    }

    /// A rehearsal chain answers as 4663, so the chain id cannot tell it from Robinhood Chain. The
    /// node's own name can, and a rehearsal record runs only where that name is anvil.
    function _aRehearsalRecordRunsOnlyOnAnvil() private {
        _fresh();
        RecordProbe node = new RecordProbe();
        node.pinEnvPrefix(_prefix());

        // A suite that has not forked a node runs on Foundry's own EVM, which nothing leaves.
        node.requireChain();

        string memory mainnet = "nitro/v3.12.0-rc.3+ebe9e83-20260916T211740Z/linux-amd64/go1.25.12";
        node.answerAs(mainnet);
        vm.expectRevert(abi.encodeWithSelector(BursarScript.NotAnvil.selector, mainnet));
        node.requireChain();

        node.answerAs("anvil/v1.8.1");
        node.requireChain();

        // A mainnet record never asks: the chain id and the flag already hold it to 4663.
        path = _useRecord("record", _baseRecord("record", 4663, false, USDG));
        _set("BURSAR_LOCAL", "0");
        node.answerAs(mainnet);
        node.requireChain();
    }

    /// Foundry reads a value it cannot parse as though the variable were unset. The scripts parse
    /// each one themselves, so a typo is reported with what was typed.
    function _aValueThatDoesNotParseIsNamed() private {
        _fresh();
        _set("BURSAR_FEE_BPS", "1%");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.InvalidEnv.selector, _key("BURSAR_FEE_BPS"), "1%"));
        probe.envUint("BURSAR_FEE_BPS");

        _set("BURSAR_FEE_BPS", " 100 ");
        assertEq(probe.envUint("BURSAR_FEE_BPS"), 100);
        _set("BURSAR_FEE_BPS", "");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_FEE_BPS")));
        probe.envUint("BURSAR_FEE_BPS");

        address one = address(0x1001);
        address two = address(0x1002);
        _set("BURSAR_RESOLVERS", string.concat(vm.toString(one), ", ", vm.toString(two)));
        address[] memory list = probe.envAddressList("BURSAR_RESOLVERS");
        assertEq(list.length, 2);
        assertEq(list[1], two);
        string memory doubled = string.concat(vm.toString(one), ",,", vm.toString(two));
        _set("BURSAR_RESOLVERS", doubled);
        vm.expectRevert(abi.encodeWithSelector(BursarScript.InvalidEnv.selector, _key("BURSAR_RESOLVERS"), doubled));
        probe.envAddressList("BURSAR_RESOLVERS");
        _set("BURSAR_RESOLVERS", string.concat(vm.toString(one), ",resolver-2"));
        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.InvalidEnv.selector, _key("BURSAR_RESOLVERS"), "resolver-2")
        );
        probe.envAddressList("BURSAR_RESOLVERS");
        _unset("BURSAR_RESOLVERS");

        _set("BURSAR_BUYBACK_POOL_TICK_SPACING", "-60");
        assertEq(probe.envInt24("BURSAR_BUYBACK_POOL_TICK_SPACING"), -60);
        _set("BURSAR_BUYBACK_POOL_TICK_SPACING", "sixty");
        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.InvalidEnv.selector, _key("BURSAR_BUYBACK_POOL_TICK_SPACING"), "sixty")
        );
        probe.envInt24("BURSAR_BUYBACK_POOL_TICK_SPACING");
        _unset("BURSAR_BUYBACK_POOL_TICK_SPACING");
        _unset("BURSAR_FEE_BPS");
    }

    /// A contract the record holds is not deployed a second time unless the operator says so, and
    /// an entry whose broadcast never landed is replaced without asking.
    function _whatIsRecordedIsNotDeployedTwice() private {
        _fresh();
        probe.requireUnrecorded(K.CREDIT_POOL);

        probe.writeAddress(K.CREDIT_POOL, makeAddr("neverLanded"));
        probe.requireUnrecorded(K.CREDIT_POOL);

        probe.writeAddress(K.CREDIT_POOL, address(probe));
        vm.expectRevert(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.CREDIT_POOL, address(probe)));
        probe.requireUnrecorded(K.CREDIT_POOL);

        _set("BURSAR_FORCE", "1");
        probe.requireUnrecorded(K.CREDIT_POOL);
        _set("BURSAR_FORCE", "yes");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.CREDIT_POOL, address(probe)));
        probe.requireUnrecorded(K.CREDIT_POOL);
        _unset("BURSAR_FORCE");

        // What a script builds on has to be recorded and hold code.
        vm.expectRevert(abi.encodeWithSelector(BursarScript.NotRecorded.selector, K.ESCROW));
        probe.upstream(K.ESCROW);
        address nothing = makeAddr("noEscrowHere");
        probe.writeAddress(K.ESCROW, nothing);
        vm.expectRevert(abi.encodeWithSelector(BursarScript.NotContract.selector, K.ESCROW, nothing));
        probe.upstream(K.ESCROW);
    }

    /// The one-shot setters answer to the key that deployed what they wire, so once the record
    /// names that key every later script is held to it.
    function _laterScriptsAreHeldToTheRecordedDeployKey() private {
        _fresh();
        address key = makeAddr("deployKey");
        vm.prank(key);
        assertEq(probe.deployer(), key);

        probe.writeAddress(K.DEPLOYER, key);
        vm.prank(key);
        assertEq(probe.deployer(), key);

        address other = makeAddr("otherKey");
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(BursarScript.WrongDeployer.selector, key, other));
        probe.deployer();
    }

    /// A role is read from the shell once. After that the record answers, and a shell that
    /// disagrees stops the run.
    function _aRoleIsReadOnceAndThenTheRecordAnswers() private {
        _fresh();
        vm.expectRevert(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_TREASURY")));
        probe.role(K.TREASURY, "BURSAR_TREASURY");

        address treasury = makeAddr("treasury");
        _set("BURSAR_TREASURY", vm.toString(treasury));
        assertEq(probe.role(K.TREASURY, "BURSAR_TREASURY"), treasury);

        probe.writeAddress(K.TREASURY, treasury);
        _unset("BURSAR_TREASURY");
        assertEq(probe.role(K.TREASURY, "BURSAR_TREASURY"), treasury);

        address stale = makeAddr("lastMonthsTreasury");
        _set("BURSAR_TREASURY", vm.toString(stale));
        vm.expectRevert(abi.encodeWithSelector(BursarScript.RecordMismatch.selector, K.TREASURY, treasury, stale));
        probe.role(K.TREASURY, "BURSAR_TREASURY");
        _unset("BURSAR_TREASURY");

        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(makeAddr("anotherAsset")));
        vm.expectRevert(
            abi.encodeWithSelector(
                BursarScript.RecordMismatch.selector, K.SETTLEMENT_ASSET, USDG, makeAddr("anotherAsset")
            )
        );
        probe.settlementAsset();
        _unset("BURSAR_SETTLEMENT_ASSET");
    }

    /// Dates a delay or an unbonding period ends on, as an operator reads them.
    function test_record_datesReadTheWayACalendarDoes() public {
        assertEq(probe.utc(0), "1970-01-01 00:00:00 UTC");
        assertEq(probe.utc(951_782_400), "2000-02-29 00:00:00 UTC");
        assertEq(probe.utc(1_709_164_800), "2024-02-29 00:00:00 UTC");
        assertEq(probe.utc(1_790_592_800), "2026-09-28 10:53:20 UTC");
        assertEq(probe.utc(4_102_444_799), "2099-12-31 23:59:59 UTC");
        assertEq(probe.utc(253_402_300_799), "9999-12-31 23:59:59 UTC");

        vm.warp(1_790_592_800);
        assertEq(probe.until(block.timestamp), "now");
        assertEq(probe.until(block.timestamp + 1), "1 second");
        assertEq(probe.until(block.timestamp + 90), "90 seconds");
        assertEq(probe.until(block.timestamp + 3600), "60 minutes");
        assertEq(probe.until(block.timestamp + 48 hours - 1), "47 hours 59 minutes");
        assertEq(probe.until(block.timestamp + 7 days + 1 hours), "7 days 1 hour");
    }

    /// The records in `deployments/`: every one on Robinhood Chain, none a rehearsal, each with a
    /// status, and the history between them written in both directions where it is complete.
    function test_record_committedRecordsSitOn4663AndNameWhatEachReplaced() public view {
        string[6] memory names = [
            "rhc-mainnet", "rhc-mainnet-token", "rhc-mainnet-v2", "rhc-mainnet-v3", "rhc-mainnet-v4", "rhc-mainnet-v5"
        ];
        for (uint256 i; i < names.length; ++i) {
            string memory json = vm.readFile(string.concat("deployments/", names[i], ".json"));
            assertEq(vm.parseJsonUint(json, K.CHAIN_ID), 4663, names[i]);
            assertEq(vm.parseJsonAddress(json, K.SETTLEMENT_ASSET), USDG, names[i]);
            assertFalse(vm.keyExistsJson(json, K.LOCAL) && vm.parseJsonBool(json, K.LOCAL), names[i]);
            bytes32 status = keccak256(bytes(vm.parseJsonString(json, K.STATUS)));
            assertTrue(
                status == keccak256("planned") || status == keccak256("live") || status == keccak256("superseded")
                    || status == keccak256("retired"),
                names[i]
            );
        }

        string memory v1 = vm.readFile("deployments/rhc-mainnet.json");
        string memory token = vm.readFile("deployments/rhc-mainnet-token.json");
        string memory v2 = vm.readFile("deployments/rhc-mainnet-v2.json");
        string memory v3 = vm.readFile("deployments/rhc-mainnet-v3.json");
        string memory v4 = vm.readFile("deployments/rhc-mainnet-v4.json");
        string memory v5 = vm.readFile("deployments/rhc-mainnet-v5.json");

        // The fourth set answers for the chain. The records it and the third set replaced stay
        // readable for what they still hold until the last migration step retires each.
        assertEq(vm.parseJsonString(v1, K.STATUS), "superseded");
        assertEq(vm.parseJsonString(v1, K.SUPERSEDED_BY), "rhc-mainnet-v2");
        assertEq(vm.parseJsonString(v2, ".supersedes"), "rhc-mainnet");
        assertEq(vm.parseJsonString(v2, K.SUPERSEDED_BY), "rhc-mainnet-v3");
        assertEq(vm.parseJsonString(token, K.SUPERSEDED_BY), "rhc-mainnet-v3");
        assertEq(vm.parseJsonString(v3, ".supersedes"), "rhc-mainnet-v2");
        assertEq(vm.parseJsonString(v3, K.SUPERSEDED_BY), "rhc-mainnet-v4");
        for (uint256 i; i < 3; ++i) {
            string memory replaced = i == 0 ? v2 : i == 1 ? token : v3;
            bytes32 status = keccak256(bytes(vm.parseJsonString(replaced, K.STATUS)));
            assertTrue(status == keccak256("superseded") || status == keccak256("retired"), "replaced record");
        }

        // The v3 set keeps the token and its schedule, and the libraries the shielded pool links.
        assertEq(vm.parseJsonAddress(v3, K.BRSR), vm.parseJsonAddress(token, ".contracts.BRSR"));
        assertEq(vm.parseJsonAddress(v3, K.VESTING), vm.parseJsonAddress(token, ".contracts.Vesting"));
        assertEq(
            vm.parseJsonAddress(v3, K.EXTERNAL_POSEIDON_T3), vm.parseJsonAddress(v2, ".privacy.shielded.PoseidonT3")
        );
        assertEq(
            vm.parseJsonAddress(v3, K.EXTERNAL_POSEIDON_T4), vm.parseJsonAddress(v2, ".privacy.shielded.PoseidonT4")
        );
        assertEq(vm.parseJsonAddress(v3, K.POOL_MANAGER), vm.parseJsonAddress(token, ".contracts.PoolManager"));
        assertEq(vm.parseJsonAddress(v3, K.DEPLOYER), vm.parseJsonAddress(v2, K.DEPLOYER));

        // Every deploy script has run, so every section names what it deployed.
        assertEq(vm.parseJsonKeys(v3, ".contracts").length, 6);
        assertTrue(vm.keyExistsJson(v3, K.STAKING));
        assertTrue(vm.keyExistsJson(v3, K.SEEDER));
        assertTrue(vm.keyExistsJson(v3, ".rwa.collateral.CreditPool"));
        assertTrue(vm.keyExistsJson(v3, ".privacy.shielded.ShieldedPool"));
        assertTrue(vm.keyExistsJson(v3, ".exampleMandate.address"));

        address[] memory resolvers = vm.parseJsonAddressArray(v3, K.RESOLVERS);
        assertEq(resolvers.length, 3);
        assertEq(resolvers[0], 0xD8D90e4c8f3419B1b8305dF2905eb31d3fBBf599);
        assertEq(resolvers[1], 0xC284CdA6c6982447f202830f4e969F13cBcB0b94);
        assertEq(resolvers[2], 0x7062A480732EC7B0F00a3D0c968356e1671dd356);
        assertEq(vm.parseJsonAddressArray(v3, K.SIGNERS).length, 3);

        // The fourth set is live on top of the third: same token set, roles and outside contracts,
        // everything else deployed by its own scripts. Its governance is the third set's one-hour
        // timelock until the 48-hour one takes over; from then on the first timelock keeps only the
        // escrow's brake, and the record says which.
        assertEq(vm.parseJsonString(v4, K.STATUS), "live");
        assertEq(vm.parseJsonString(v4, K.SUPERSEDES), "rhc-mainnet-v3");
        assertEq(vm.parseJsonAddress(v4, K.DEPLOYER), vm.parseJsonAddress(v3, K.DEPLOYER));
        if (vm.keyExistsJson(v4, K.ESCROW_PAUSER)) {
            assertEq(vm.parseJsonKeys(v4, ".contracts").length, 7);
            assertEq(vm.parseJsonAddress(v4, K.ESCROW_PAUSER), vm.parseJsonAddress(v3, K.ADMIN_TIMELOCK));
            assertEq(vm.parseJsonAddress(v4, K.ESCROW_PAUSER), vm.parseJsonAddress(v4, K.GOVERNANCE48_PREVIOUS));
            assertEq(vm.parseJsonAddress(v4, K.ADMIN_TIMELOCK), vm.parseJsonAddress(v4, K.GOVERNANCE48_TIMELOCK));
            assertEq(vm.parseJsonAddressArray(v4, K.SIGNERS), vm.parseJsonAddressArray(v4, K.GOVERNANCE48_SIGNERS));
            assertEq(vm.parseJsonUint(v4, ".parameters.AdminTimelock.timelockPeriod"), 48 hours);
            assertFalse(vm.parseJsonBool(v4, ".dev"));
        } else {
            assertEq(vm.parseJsonKeys(v4, ".contracts").length, 6);
            assertEq(vm.parseJsonAddress(v4, K.ADMIN_TIMELOCK), vm.parseJsonAddress(v3, K.ADMIN_TIMELOCK));
            assertEq(vm.parseJson(v4, ".roles"), vm.parseJson(v3, ".roles"));
        }
        string[6] memory carried = [K.BRSR, K.VESTING, K.STAKING, K.BUYBACK, K.SEEDER, K.KEEPER];
        for (uint256 i; i < carried.length; ++i) {
            assertEq(vm.parseJson(v4, carried[i]), vm.parseJson(v3, carried[i]), carried[i]);
        }
        assertEq(vm.parseJsonBytes32(v4, ".token.poolId"), vm.parseJsonBytes32(v3, ".token.poolId"));
        // The same deployment block, restated at the chain's own height: the third record holds
        // the Ethereum block the chain answers as `block.number`, tens of millions lower.
        assertEq(vm.parseJsonUint(v4, K.TOKEN_FROM_BLOCK), 76_462_774);
        assertLt(vm.parseJsonUint(v3, K.TOKEN_FROM_BLOCK), vm.parseJsonUint(v4, K.TOKEN_FROM_BLOCK));
        assertEq(vm.parseJson(v4, ".external"), vm.parseJson(v3, ".external"));
        assertTrue(vm.keyExistsJson(v4, K.ESCROW));
        assertTrue(vm.keyExistsJson(v4, K.CREDIT_POOL));
        assertTrue(vm.keyExistsJson(v4, K.SHIELDED_POOL));
        assertTrue(vm.keyExistsJson(v4, ".exampleMandate.address"));
        assertTrue(vm.keyExistsJson(v4, ".privacy.shielded.maxPerDepositor"));
        assertTrue(vm.keyExistsJson(v4, ".parameters.Reputation.minScored"));
        assertTrue(vm.keyExistsJson(v4, ".parameters.PriceGuard.minObservationAge"));

        // The fifth record is planned on the fourth as it reads once its governance handover has
        // landed: the 48-hour timelock governs, the one-hour one keeps the escrow's brake, and
        // everything but the collateral lane carries over at its address. The lane's own scripts
        // write the rest.
        assertEq(vm.parseJsonString(v5, K.STATUS), "planned");
        assertEq(vm.parseJsonString(v5, K.SUPERSEDES), "rhc-mainnet-v4");
        assertEq(vm.parseJsonAddress(v5, K.DEPLOYER), vm.parseJsonAddress(v4, K.DEPLOYER));
        assertEq(vm.parseJsonKeys(v5, ".contracts").length, 7);
        assertEq(vm.parseJsonAddress(v5, K.ADMIN_TIMELOCK), vm.parseJsonAddress(v4, K.GOVERNANCE48_TIMELOCK));
        assertEq(vm.parseJsonAddress(v5, K.ESCROW_PAUSER), vm.parseJsonAddress(v4, K.GOVERNANCE48_PREVIOUS));
        assertEq(vm.parseJsonAddressArray(v5, K.SIGNERS), vm.parseJsonAddressArray(v4, K.GOVERNANCE48_SIGNERS));
        assertEq(vm.parseJsonAddress(v5, K.GUARDIAN), vm.parseJsonAddress(v4, K.GOVERNANCE48_GUARDIAN));
        assertEq(
            vm.parseJsonUint(v5, ".parameters.AdminTimelock.timelockPeriod"),
            vm.parseJsonUint(v4, K.GOVERNANCE48_PERIOD)
        );
        assertFalse(vm.parseJsonBool(v5, ".dev"));
        assertEq(vm.parseJson(v5, ".governance48"), vm.parseJson(v4, ".governance48"));
        string[5] memory kept = [K.REPUTATION, K.ESCROW, K.ORACLE_REGISTRY, K.AGENT_REGISTRY, K.FACTORY];
        for (uint256 i; i < kept.length; ++i) {
            assertEq(vm.parseJsonAddress(v5, kept[i]), vm.parseJsonAddress(v4, kept[i]), kept[i]);
        }
        string[7] memory sections = [
            ".token",
            ".privacy",
            ".external",
            ".exampleMandate",
            ".exampleCommittedMandate",
            ".rwa.assets",
            ".roles.resolvers"
        ];
        for (uint256 i; i < sections.length; ++i) {
            assertEq(vm.parseJson(v5, sections[i]), vm.parseJson(v4, sections[i]), sections[i]);
        }
        assertEq(vm.parseJsonAddress(v5, K.ASSET_REGISTRY), vm.parseJsonAddress(v4, K.ASSET_REGISTRY));
        assertEq(vm.parseJsonAddress(v5, K.TREASURY_PARK), vm.parseJsonAddress(v4, K.TREASURY_PARK));
        assertEq(vm.parseJsonAddress(v5, K.USDG_ADAPTER), vm.parseJsonAddress(v4, K.USDG_ADAPTER));
        assertEq(vm.parseJsonUint(v5, K.RWA_FROM_BLOCK), vm.parseJsonUint(v4, K.RWA_FROM_BLOCK));
        assertEq(vm.parseJsonUint(v5, K.FROM_BLOCK), vm.parseJsonUint(v4, K.FROM_BLOCK));
        string[8] memory lane = [
            K.PRICE_GUARD,
            K.STOCK_ROUTER,
            K.SGOV_ADAPTER,
            ".rwa.collateral",
            ".exampleCollateralMandate",
            ".parameters.PriceGuard",
            ".parameters.CreditPool",
            ".parameters.CollateralVault"
        ];
        for (uint256 i; i < lane.length; ++i) {
            assertFalse(vm.keyExistsJson(v5, lane[i]), lane[i]);
        }
    }
}
