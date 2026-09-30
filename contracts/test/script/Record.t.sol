// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {ScriptHarness} from "./ScriptHarness.sol";

/// The record helpers every script shares, called one at a time.
contract RecordProbe is BursarScript {
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

    function requireChain() external view {
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

        // A second write replaces the first rather than adding beside it.
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

    /// The records in `deployments/`: every one on Robinhood Chain, none a rehearsal, each with a
    /// status, and the history between them written in both directions where it is complete.
    function test_record_theCommittedRecordsDescribeOneHistory() public view {
        string[4] memory names = ["rhc-mainnet", "rhc-mainnet-token", "rhc-mainnet-v2", "rhc-mainnet-v3"];
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

        assertEq(vm.parseJsonString(v1, K.STATUS), "superseded");
        assertEq(vm.parseJsonString(v1, K.SUPERSEDED_BY), "rhc-mainnet-v2");
        assertEq(vm.parseJsonString(v2, ".supersedes"), "rhc-mainnet");
        assertEq(vm.parseJsonString(v3, ".supersedes"), "rhc-mainnet-v2");
        assertEq(vm.parseJsonString(v3, K.STATUS), "planned");

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

        // Nothing is deployed yet, so nothing may be recorded as deployed.
        assertEq(vm.parseJsonKeys(v3, ".contracts").length, 0);
        assertFalse(vm.keyExistsJson(v3, K.STAKING));
        assertFalse(vm.keyExistsJson(v3, K.SEEDER));

        address[] memory resolvers = vm.parseJsonAddressArray(v3, K.RESOLVERS);
        assertEq(resolvers.length, 3);
        assertEq(resolvers[0], 0xD8D90e4c8f3419B1b8305dF2905eb31d3fBBf599);
        assertEq(resolvers[1], 0xC284CdA6c6982447f202830f4e969F13cBcB0b94);
        assertEq(resolvers[2], 0x7062A480732EC7B0F00a3D0c968356e1671dd356);
        assertEq(vm.parseJsonAddressArray(v3, K.SIGNERS).length, 3);
    }
}
