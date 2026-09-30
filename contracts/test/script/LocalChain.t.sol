// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {Verify} from "../../script/Verify.s.sol";
import {VerifyWiring} from "../../script/VerifyWiring.s.sol";

import {LaneFlows} from "./LaneFlows.sol";
import {ScriptHarness} from "./ScriptHarness.sol";

/// The deployment `script/local/rehearse.sh` made on anvil, checked from a fork of it: every verify
/// script against what the rehearsal recorded, then one flow per lane against the live contracts.
/// The flows run on the fork, so the rehearsal's chain is left as the scripts left it.
///
/// Skipped unless `BURSAR_LOCAL_RPC` names the rehearsal's node; the rehearsal sets it.
///
///   BURSAR_LOCAL_RPC=http://127.0.0.1:8546 forge test --match-path test/script/LocalChain.t.sol -vv
contract LocalChainTest is ScriptHarness, LaneFlows {
    function _prefix() internal pure override returns (string memory) {
        return "LOCALCHAIN_";
    }

    function setUp() public {
        string memory rpc = vm.envOr("BURSAR_LOCAL_RPC", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("BURSAR_LOCAL_RPC is unset; skipping the local chain run.");
            vm.skip(true);
        }
        vm.createSelectFork(rpc);
    }

    function test_theRehearsedDeploymentVerifiesAndRunsEveryLane() public {
        string memory path = vm.envOr("BURSAR_RECORD", string("cache/bursar/local-4663.json"));
        _set("BURSAR_RECORD", path);
        _set("BURSAR_LOCAL", "1");
        _unset("BURSAR_VERIFY_STRICT");

        VerifyWiring wiring = new VerifyWiring();
        wiring.pinEnvPrefix(_prefix());
        wiring.run();
        Verify all = new Verify();
        all.pinEnvPrefix(_prefix());
        all.run();

        _lanes(path);
    }
}
