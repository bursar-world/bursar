// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verify} from "../../script/Verify.s.sol";
import {VerifyCollateral} from "../../script/VerifyCollateral.s.sol";
import {VerifyCore} from "../../script/VerifyCore.s.sol";
import {VerifyPrivacy} from "../../script/VerifyPrivacy.s.sol";
import {VerifyRwa} from "../../script/VerifyRwa.s.sol";
import {VerifyShielded} from "../../script/VerifyShielded.s.sol";
import {VerifyStaking} from "../../script/VerifyStaking.s.sol";
import {VerifyToken} from "../../script/VerifyToken.s.sol";
import {VerifyWiring} from "../../script/VerifyWiring.s.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {Buyback} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {LaneFlows} from "./LaneFlows.sol";
import {World} from "./World.sol";

/// The whole deployment, in one process, through the real scripts and the real parameter files: the
/// local fixtures, every deploy script in order with its verify companion after it, the market
/// opened by the seeding script, the wiring batch through the timelock from the signers' own keys,
/// the lender's first cash, the full verify with nothing left owed, and then one flow per lane.
///
/// It runs the same steps `script/local/rehearse.sh` runs against anvil, with the same accounts:
/// anvil's first account deploys, and the deploy key's nonce is pinned before the shielded run, so
/// the shielded pool lands where the proofs in `fixtures/shielded-e2e.json` were made for.
contract EndToEndTest is World, LaneFlows {
    function _prefix() internal pure override returns (string memory) {
        return "E2E_";
    }

    function test_theWholeSetDeploysThroughTheScriptsVerifiesAndRunsEveryLane() public {
        _world("e2e-4663");

        _core();
        _check(address(new VerifyCore()));
        _token();
        _check(address(new VerifyToken()));
        _staking();
        _check(address(new VerifyStaking()));
        _seed();
        // BRSR sorts above USDG here, so the market opened the other way round from mainnet's.
        assertTrue(Buyback(_readAddress(path, K.BUYBACK)).settlementIsCurrency0(), "BRSR is not currency1 here");
        _check(address(new VerifyStaking()));
        _rwa();
        _check(address(new VerifyRwa()));
        _collateral();
        _check(address(new VerifyCollateral()));
        _privacy();
        _check(address(new VerifyPrivacy()));

        vm.setNonce(DEPLOYER, SHIELDED_NONCE);
        _as(DEPLOYER, _deployShieldedScript(), abi.encodeWithSignature("run()"));
        _check(address(new VerifyShielded()));

        _wiring();
        Staking staking = Staking(_readAddress(path, K.STAKING));
        assertEq(staking.slasher(), _readAddress(path, K.CREDIT_POOL), "the credit pool is not the slasher");
        address[] memory resolvers = vm.parseJsonAddressArray(vm.readFile(path), K.RESOLVERS);
        assertTrue(staking.isBondable(resolvers[0], 30_000e18), "a vetted resolver cannot bond at its floor");
        assertFalse(staking.isBondable(address(0xB0B), 30_000e18), "a resolver nobody vetted can bond");

        assertEq(
            V4LiquiditySeeder(_readAddress(path, K.SEEDER)).owner(),
            _readAddress(path, K.ADMIN_TIMELOCK),
            "the wiring batch did not take the seeder"
        );
        _fundCredit();

        _check(address(new VerifyWiring()));
        _set("BURSAR_VERIFY_STRICT", "1");
        _check(address(new Verify()));
        _unset("BURSAR_VERIFY_STRICT");

        _lanes(path);
    }
}
