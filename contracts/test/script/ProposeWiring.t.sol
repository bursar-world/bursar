// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProposeWiring} from "../../script/ProposeWiring.s.sol";
import {VerifyWiring} from "../../script/VerifyWiring.s.sol";
import {Governance} from "../../script/lib/Governance.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {Buyback} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {World} from "./World.sol";

/// What `execute` prints for a call that cannot run yet.
contract ProposeWiringProbe is ProposeWiring {
    function whyNot(AdminTimelock timelock, uint256 id, bytes4 reason) external view returns (string memory) {
        return _whyNot(timelock, id, reason);
    }
}

/// The wiring batch through the timelock, one step per signer key, repeated the way an operator
/// repeats a step whose output they did not see: nothing is proposed or approved twice, nothing
/// executes early, and a key that cannot sign stops before anything is queued.
contract ProposeWiringTest is World {
    /// The keeper, a floor for each of the three resolvers, the rebate table, and the credit
    /// pool's two roles on staking.
    uint256 internal constant BATCH = 7;

    AdminTimelock internal timelock;
    address[] internal signers;

    function _prefix() internal pure override returns (string memory) {
        return "PROPOSEWIRING_";
    }

    function setUp() public {
        _world("propose-wiring");
        _core();
        _token();
        _staking();
        _rwa();
        _collateral();
        timelock = AdminTimelock(_readAddress(path, K.ADMIN_TIMELOCK));
        signers = vm.parseJsonAddressArray(vm.readFile(path), K.SIGNERS);
        _save();
    }

    function _step(address key, bytes memory call) private {
        _as(key, _pinned(address(new ProposeWiring())), call);
    }

    function _propose(address key) private {
        _step(key, abi.encodeWithSignature("propose()"));
    }

    function _approve(address key) private {
        _step(key, abi.encodeWithSignature("approve()"));
    }

    function _execute(address key) private {
        _step(key, abi.encodeWithSignature("execute()"));
    }

    /// One test, because every suite built on a world shares its record file between its tests.
    function test_proposeWiring_proposesOnceApprovesOnceAndExecutesOnlyWhenDue() public {
        _eachStepIsIdempotentAndWaitsForItsTurn();
        _anExpiredProposalIsProposedAgain();
    }

    function _eachStepIsIdempotentAndWaitsForItsTurn() private {
        _restore();
        uint256 before = timelock.proposalCount();

        // A key that is not a signer is refused before anything is broadcast.
        address script = _pinned(address(new ProposeWiring()));
        vm.expectRevert(abi.encodeWithSelector(Governance.NotSigner.selector, address(timelock), DEPLOYER));
        _as(DEPLOYER, script, abi.encodeWithSignature("propose()"));

        _step(signers[2], abi.encodeWithSignature("status()"));
        _propose(signers[0]);
        assertEq(timelock.proposalCount(), before + BATCH);

        // A call that cannot run yet is explained, not printed as the selector `canExecute` returns.
        ProposeWiringProbe probe = new ProposeWiringProbe();
        (bool due, bytes4 reason) = timelock.canExecute(before);
        assertFalse(due);
        assertEq(probe.whyNot(timelock, before, reason), "1 of 2 approvals: a second signer runs approve() first.");

        // A second run, by the same signer or another, finds every call already proposed.
        _propose(signers[0]);
        _propose(signers[1]);
        assertEq(timelock.proposalCount(), before + BATCH);

        // One approval, the proposer's, is not enough, however late it is.
        vm.warp(block.timestamp + timelock.timelockPeriod() + 1);
        _execute(signers[0]);
        _assertUnwired();

        _approve(signers[1]);
        _approve(signers[1]);
        for (uint256 id = before; id < before + BATCH; ++id) {
            assertEq(timelock.approvals(id), 2);
        }

        // Approved, but the delay runs from the proposal, which the warp above already passed.
        // Propose afresh to see the delay hold.
        _restore();
        assertEq(block.timestamp, T0);
        _propose(signers[0]);
        _approve(signers[1]);
        _execute(signers[0]);
        _assertUnwired();
        (due, reason) = timelock.canExecute(before);
        assertEq(reason, AdminTimelock.TimelockNotExpired.selector);
        // The restore took the first probe with it.
        probe = new ProposeWiringProbe();
        assertEq(
            probe.whyNot(timelock, before, reason),
            "The delay ends 2026-09-28 11:53:20 UTC, in 60 minutes: run execute() again then."
        );

        vm.warp(block.timestamp + timelock.timelockPeriod());
        _execute(signers[2]);
        _check(address(new VerifyWiring()));

        // Once everything is applied, every step has nothing to do.
        uint256 after_ = timelock.proposalCount();
        _propose(signers[0]);
        _approve(signers[1]);
        _execute(signers[2]);
        assertEq(timelock.proposalCount(), after_);
    }

    /// A proposal past its grace period can never execute, so it no longer counts as proposed and
    /// the batch is put up again.
    function _anExpiredProposalIsProposedAgain() private {
        _restore();
        uint256 before = timelock.proposalCount();
        _propose(signers[0]);
        vm.warp(block.timestamp + timelock.timelockPeriod() + timelock.GRACE_PERIOD() + 1);
        _propose(signers[1]);
        assertEq(timelock.proposalCount(), before + 2 * BATCH);

        _approve(signers[0]);
        vm.warp(block.timestamp + timelock.timelockPeriod());
        _execute(signers[2]);
        _check(address(new VerifyWiring()));
    }

    function _assertUnwired() private view {
        Staking staking = Staking(_readAddress(path, K.STAKING));
        assertEq(staking.slasher(), address(0));
        assertEq(staking.creditManager(), address(0));
        assertEq(Buyback(_readAddress(path, K.BUYBACK)).keeper(), address(0));
    }
}
