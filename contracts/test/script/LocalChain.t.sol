// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verify} from "../../script/Verify.s.sol";
import {VerifyWiring} from "../../script/VerifyWiring.s.sol";

import {LaneFlows} from "./LaneFlows.sol";
import {ScriptHarness} from "./ScriptHarness.sol";

/// A deployment built on anvil, by `script/local/rehearse.sh` or by hand, checked from a fork of it:
/// every verify script against what the local record says, then one flow per lane against the live
/// contracts. The flows run on the fork, so the chain is left as the scripts left it.
///
/// Skipped unless `BURSAR_LOCAL_RPC` names the node. The rehearsal sets it; by hand, with
/// `script/env/local.env` sourced:
///
///   BURSAR_LOCAL_RPC=http://127.0.0.1:8545 forge test --match-path test/script/LocalChain.t.sol -vv
contract LocalChainTest is ScriptHarness, LaneFlows {
    function _prefix() internal pure override returns (string memory) {
        return "LOCALCHAIN_";
    }

    function setUp() public {
        string memory rpc = vm.envOr("BURSAR_LOCAL_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "BURSAR_LOCAL_RPC is unset; script/local/rehearse.sh sets it to the rehearsal's node");
            return;
        }
        vm.createSelectFork(rpc);
    }

    function test_theRehearsedDeploymentVerifiesAndRunsEveryLane() public {
        string memory path = vm.envOr("BURSAR_RECORD", string("cache/bursar/local/local-4663.json"));
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
