// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {Reputation} from "../src/Reputation.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";
import {Staking} from "../src/token/Staking.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockBRSR} from "./mocks/MockBRSR.sol";

/// Stands in for an administered contract that can be stopped. It records the calldata it was
/// stopped with, which is how the guardian tests prove that path carries `pause()` and nothing
/// adjacent to it.
contract BrakeTarget {
    error Unexpected();

    bool public paused;
    uint256 public pauseCount;
    bytes public lastCall;

    function pause() external {
        paused = true;
        ++pauseCount;
        lastCall = msg.data;
    }

    function unpause() external {
        paused = false;
        lastCall = msg.data;
    }

    fallback() external {
        revert Unexpected();
    }
}

/// Reverts with empty return data, the one case where the timelock has no target error to pass
/// through and has to speak for itself.
contract MuteTarget {
    function pause() external pure {
        revert();
    }
}

/// Governance surface: the delay is real, the queue is two-of-three, and the guardian holds a
/// brake and nothing else.
contract MandateTimelockTest is Test {
    uint64 internal constant PERIOD = 3 days;

    AdminTimelock internal timelock;
    Reputation internal reputation;

    address internal signerA;
    address internal signerB;
    address internal signerC;
    address internal guardian;
    address internal stranger;

    function setUp() public {
        signerA = makeAddr("signerA");
        signerB = makeAddr("signerB");
        signerC = makeAddr("signerC");
        guardian = makeAddr("guardian");
        stranger = makeAddr("stranger");

        timelock = new AdminTimelock([signerA, signerB, signerC], guardian, PERIOD);
        reputation = new Reputation(
            address(timelock),
            IReputation.CapCurve({baseCap: 100e6, capPerScore: 10e6, maxCap: 1_100e6}),
            IReputation.Weights({minScored: 1e6, edgeCap: 100e6, fullCredit: 400e6})
        );
    }

    function test_constructor_keepsARealDelayAndTheGuardianOffTheSignerSet() public view {
        assertGt(timelock.timelockPeriod(), 0, "period must not be zero");
        assertGe(timelock.timelockPeriod(), timelock.MIN_TIMELOCK_PERIOD());
        assertEq(timelock.guardian(), guardian);
        assertFalse(timelock.isSigner(guardian));
        assertEq(timelock.REQUIRED_APPROVALS(), 2);
        assertEq(timelock.proposalCount(), 0);
    }

    function test_constructor_acceptsExactlyTheFloorAndExactlyTheCeiling() public {
        AdminTimelock atFloor = new AdminTimelock([signerA, signerB, signerC], guardian, 1 hours);
        assertEq(atFloor.timelockPeriod(), 1 hours);

        AdminTimelock atCeiling = new AdminTimelock([signerA, signerB, signerC], guardian, 30 days);
        assertEq(atCeiling.timelockPeriod(), 30 days);
    }

    function test_constructor_revertsOneSecondBelowTheFloor() public {
        vm.expectRevert(AdminTimelock.BadPeriod.selector);
        new AdminTimelock([signerA, signerB, signerC], guardian, 1 hours - 1);
    }

    function test_constructor_revertsOneSecondAboveTheCeiling() public {
        vm.expectRevert(AdminTimelock.BadPeriod.selector);
        new AdminTimelock([signerA, signerB, signerC], guardian, 30 days + 1);
    }

    function test_constructor_revertsOnAZeroPeriod() public {
        vm.expectRevert(AdminTimelock.BadPeriod.selector);
        new AdminTimelock([signerA, signerB, signerC], guardian, 0);
    }

    function testFuzz_constructor_admitsOnlyPeriodsInsideTheBounds(uint64 period) public {
        if (period < 1 hours || period > 30 days) {
            vm.expectRevert(AdminTimelock.BadPeriod.selector);
            new AdminTimelock([signerA, signerB, signerC], guardian, period);
            return;
        }

        AdminTimelock built = new AdminTimelock([signerA, signerB, signerC], guardian, period);
        assertEq(built.timelockPeriod(), period);
        assertGt(built.timelockPeriod(), 0);
    }

    function test_constructor_revertsOnAZeroSigner() public {
        vm.expectRevert(AdminTimelock.ZeroAddress.selector);
        new AdminTimelock([signerA, address(0), signerC], guardian, PERIOD);
    }

    function test_constructor_revertsOnAZeroGuardian() public {
        vm.expectRevert(AdminTimelock.ZeroAddress.selector);
        new AdminTimelock([signerA, signerB, signerC], address(0), PERIOD);
    }

    function test_constructor_revertsWhenTwoOfThreeWouldBecomeTwoOfTwo() public {
        vm.expectRevert(AdminTimelock.DuplicateSigner.selector);
        new AdminTimelock([signerA, signerB, signerA], guardian, PERIOD);
    }

    function test_constructor_revertsWhenTheGuardianAlsoHoldsAnApproval() public {
        vm.expectRevert(AdminTimelock.DuplicateSigner.selector);
        new AdminTimelock([signerA, signerB, signerC], signerB, PERIOD);
    }

    function test_propose_countsAsTheProposersOwnApproval() public {
        uint256 id = _proposeCurve(signerA, 200e6);

        assertEq(id, 0, "first id is zero");
        assertEq(timelock.proposalCount(), 1);
        assertEq(timelock.approvals(id), 1);
        assertTrue(timelock.hasApproved(id, signerA));
        assertFalse(timelock.hasApproved(id, signerB));

        AdminTimelock.Proposal memory p = timelock.getProposal(id);
        assertEq(p.target, address(reputation));
        assertEq(p.executeAfter, uint64(block.timestamp) + PERIOD);
        assertFalse(p.executed);
        assertFalse(p.cancelled);
    }

    function test_propose_revertsForANonSigner() public {
        vm.prank(stranger);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.propose(address(reputation), _curveCall(200e6));
    }

    function test_propose_revertsOnAZeroTarget() public {
        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.ZeroAddress.selector);
        timelock.propose(address(0), _curveCall(200e6));
    }

    function test_approve_reachesTheThresholdWithTheSecondSigner() public {
        uint256 id = _proposeCurve(signerA, 200e6);

        vm.prank(signerB);
        timelock.approve(id);

        assertEq(timelock.approvals(id), 2);
    }

    function test_approve_revertsWhenTheSameSignerApprovesTwice() public {
        uint256 id = _proposeCurve(signerA, 200e6);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.AlreadyApproved.selector);
        timelock.approve(id);
    }

    function test_approve_revertsForANonSigner() public {
        uint256 id = _proposeCurve(signerA, 200e6);

        vm.prank(stranger);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.approve(id);
    }

    function test_approve_revertsForAProposalThatDoesNotExist() public {
        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.ProposalNotFound.selector);
        timelock.approve(7);
    }

    function test_approve_revertsOnACancelledProposal() public {
        uint256 id = _proposeCurve(signerA, 200e6);

        vm.prank(signerA);
        timelock.cancel(id);

        vm.prank(signerB);
        vm.expectRevert(AdminTimelock.AlreadyCancelled.selector);
        timelock.approve(id);
    }

    function test_approve_revertsOnAnExecutedProposal() public {
        uint256 id = _queued(200e6);

        vm.prank(signerA);
        timelock.execute(id);

        vm.prank(signerC);
        vm.expectRevert(AdminTimelock.AlreadyExecuted.selector);
        timelock.approve(id);
    }

    function test_execute_revertsOneSecondBeforeTheDelayExpires() public {
        uint256 id = _proposeCurve(signerA, 200e6);
        vm.prank(signerB);
        timelock.approve(id);

        vm.warp(timelock.getProposal(id).executeAfter - 1);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.TimelockNotExpired.selector);
        timelock.execute(id);
    }

    function test_execute_landsExactlyWhenTheDelayExpires() public {
        uint256 id = _queued(200e6);

        vm.prank(signerA);
        timelock.execute(id);

        assertEq(reputation.curve().baseCap, 200e6);
        assertTrue(timelock.getProposal(id).executed);
    }

    function test_execute_revertsWithOnlyTheProposersApproval() public {
        uint256 id = _proposeCurve(signerA, 200e6);
        vm.warp(block.timestamp + PERIOD);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.InsufficientApprovals.selector);
        timelock.execute(id);
    }

    function test_execute_landsOnTheLastSecondOfTheGracePeriod() public {
        uint256 id = _proposeCurve(signerA, 200e6);
        vm.prank(signerB);
        timelock.approve(id);

        vm.warp(timelock.expiresAt(id));

        vm.prank(signerB);
        timelock.execute(id);

        assertEq(reputation.curve().baseCap, 200e6);
    }

    function test_execute_revertsOneSecondAfterTheGracePeriod() public {
        uint256 id = _proposeCurve(signerA, 200e6);
        vm.prank(signerB);
        timelock.approve(id);

        vm.warp(timelock.expiresAt(id) + 1);

        vm.prank(signerB);
        vm.expectRevert(AdminTimelock.ProposalExpired.selector);
        timelock.execute(id);
    }

    function test_execute_revertsTheSecondTime() public {
        uint256 id = _queued(200e6);

        vm.prank(signerA);
        timelock.execute(id);

        vm.prank(signerB);
        vm.expectRevert(AdminTimelock.AlreadyExecuted.selector);
        timelock.execute(id);
    }

    function test_execute_revertsOnACancelledProposal() public {
        uint256 id = _queued(200e6);

        vm.prank(signerA);
        timelock.cancel(id);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.AlreadyCancelled.selector);
        timelock.execute(id);
    }

    function test_execute_revertsForANonSigner() public {
        uint256 id = _queued(200e6);

        vm.prank(stranger);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.execute(id);
    }

    function test_execute_passesTheTargetsOwnErrorBackToTheSigner() public {
        bytes memory data = abi.encodeCall(
            Reputation.setCurve, (IReputation.CapCurve({baseCap: 500e6, capPerScore: 1e6, maxCap: 100e6}))
        );

        vm.prank(signerA);
        uint256 id = timelock.propose(address(reputation), data);
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);

        vm.prank(signerA);
        vm.expectRevert(IReputation.BadCurve.selector);
        timelock.execute(id);
    }

    function test_execute_reportsExecutionFailedWhenTheTargetRevertsSilently() public {
        MuteTarget mute = new MuteTarget();

        vm.prank(signerA);
        uint256 id = timelock.propose(address(mute), abi.encodeWithSignature("pause()"));
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.ExecutionFailed.selector);
        timelock.execute(id);
    }

    function test_cancel_takesTheProposerAloneAndIsFinal() public {
        uint256 id = _proposeCurve(signerA, 200e6);

        vm.prank(signerA);
        timelock.cancel(id);
        assertTrue(timelock.getProposal(id).cancelled);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.AlreadyCancelled.selector);
        timelock.cancel(id);
    }

    function test_cancel_revertsForANonSigner() public {
        uint256 id = _proposeCurve(signerA, 200e6);

        vm.prank(stranger);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.cancel(id);
    }

    function test_cancel_revertsOnceTheProposalHasExecuted() public {
        uint256 id = _queued(200e6);
        vm.prank(signerA);
        timelock.execute(id);

        vm.prank(signerB);
        vm.expectRevert(AdminTimelock.AlreadyExecuted.selector);
        timelock.cancel(id);
    }

    function test_canExecute_namesTheReasonAtEveryStage() public {
        (bool ready, bytes4 reason) = timelock.canExecute(42);
        assertFalse(ready);
        assertEq(reason, AdminTimelock.ProposalNotFound.selector);

        uint256 id = _proposeCurve(signerA, 200e6);
        (ready, reason) = timelock.canExecute(id);
        assertFalse(ready);
        assertEq(reason, AdminTimelock.InsufficientApprovals.selector);

        vm.prank(signerB);
        timelock.approve(id);
        (ready, reason) = timelock.canExecute(id);
        assertFalse(ready);
        assertEq(reason, AdminTimelock.TimelockNotExpired.selector);

        vm.warp(block.timestamp + PERIOD);
        (ready, reason) = timelock.canExecute(id);
        assertTrue(ready);
        assertEq(reason, bytes4(0));

        vm.warp(timelock.expiresAt(id) + 1);
        (ready, reason) = timelock.canExecute(id);
        assertFalse(ready);
        assertEq(reason, AdminTimelock.ProposalExpired.selector);

        vm.warp(timelock.getProposal(id).executeAfter);
        vm.prank(signerA);
        timelock.execute(id);
        (ready, reason) = timelock.canExecute(id);
        assertFalse(ready);
        assertEq(reason, AdminTimelock.AlreadyExecuted.selector);
    }

    function test_canExecute_namesTheCancellationOfAProposalThatWasOtherwiseReady() public {
        uint256 id = _queued(200e6);

        (bool ready,) = timelock.canExecute(id);
        assertTrue(ready, "the proposal has to be ready before cancelling proves anything");

        vm.prank(signerA);
        timelock.cancel(id);

        bytes4 reason;
        (ready, reason) = timelock.canExecute(id);
        assertFalse(ready);
        assertEq(reason, AdminTimelock.AlreadyCancelled.selector);
    }

    function test_theSignerSetIsReadableInOneCall() public view {
        address[3] memory signers = timelock.getSigners();

        assertEq(signers[0], signerA);
        assertEq(signers[1], signerB);
        assertEq(signers[2], signerC);
    }

    function test_expiresAt_isZeroForAProposalThatDoesNotExist() public view {
        assertEq(timelock.expiresAt(99), 0);
    }

    function testFuzz_execute_neverLandsBeforeTheDelayHasRun(uint64 elapsed) public {
        elapsed = uint64(bound(elapsed, 0, PERIOD - 1));

        uint256 id = _proposeCurve(signerA, 200e6);
        vm.prank(signerB);
        timelock.approve(id);

        vm.warp(block.timestamp + elapsed);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.TimelockNotExpired.selector);
        timelock.execute(id);
    }

    function testFuzz_execute_landsInsideTheGraceWindowAndNowhereAfterIt(uint64 offset) public {
        offset = uint64(bound(offset, 0, 60 days));

        uint256 id = _proposeCurve(signerA, 200e6);
        vm.prank(signerB);
        timelock.approve(id);

        uint64 executeAfter = timelock.getProposal(id).executeAfter;
        vm.warp(uint256(executeAfter) + offset);

        if (offset > timelock.GRACE_PERIOD()) {
            vm.prank(signerA);
            vm.expectRevert(AdminTimelock.ProposalExpired.selector);
            timelock.execute(id);
            return;
        }

        vm.prank(signerA);
        timelock.execute(id);
        assertEq(reputation.curve().baseCap, 200e6);
    }

    function test_guardianPause_stopsEveryTargetInTheSameBlockWithNoApprovals() public {
        BrakeTarget first = new BrakeTarget();
        BrakeTarget second = new BrakeTarget();

        address[] memory targets = new address[](2);
        targets[0] = address(first);
        targets[1] = address(second);

        vm.prank(guardian);
        timelock.guardianPause(targets);

        assertTrue(first.paused());
        assertTrue(second.paused());
        assertEq(timelock.proposalCount(), 0, "the brake never queues anything");
    }

    function test_guardianPause_carriesThePauseSelectorAndNothingElse() public {
        BrakeTarget target = new BrakeTarget();
        address[] memory targets = new address[](1);
        targets[0] = address(target);

        vm.prank(guardian);
        timelock.guardianPause(targets);

        assertEq(target.lastCall(), abi.encodeWithSignature("pause()"));
        assertEq(target.pauseCount(), 1);
    }

    function test_guardianPause_revertsForASignerAndForAStranger() public {
        BrakeTarget target = new BrakeTarget();
        address[] memory targets = new address[](1);
        targets[0] = address(target);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.NotGuardian.selector);
        timelock.guardianPause(targets);

        vm.prank(stranger);
        vm.expectRevert(AdminTimelock.NotGuardian.selector);
        timelock.guardianPause(targets);
    }

    /// An address with no code accepts any call silently. It is recorded as skipped, and it does
    /// not stop the rest of the batch.
    function test_guardianPause_skipsATargetWithNoCodeAndPausesTheRest() public {
        BrakeTarget target = new BrakeTarget();
        address empty = makeAddr("notAContract");
        address[] memory targets = new address[](2);
        targets[0] = empty;
        targets[1] = address(target);

        vm.expectEmit(true, true, false, true, address(timelock));
        emit AdminTimelock.GuardianPauseSkipped(empty, guardian, "");
        vm.expectEmit(true, true, false, true, address(timelock));
        emit AdminTimelock.GuardianPaused(address(target), guardian);

        vm.prank(guardian);
        timelock.guardianPause(targets);

        assertTrue(target.paused(), "one bad entry held back the brake on the rest");
    }

    function test_guardian_cannotUnpauseAndCannotQueueTheRestart() public {
        BrakeTarget target = new BrakeTarget();
        address[] memory targets = new address[](1);
        targets[0] = address(target);

        vm.prank(guardian);
        timelock.guardianPause(targets);

        // The unpause selector is not reachable through the brake: the calldata is built inside
        // the timelock and is always `pause()`.
        vm.prank(guardian);
        timelock.guardianPause(targets);
        assertTrue(target.paused());

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.propose(address(target), abi.encodeWithSignature("unpause()"));
    }

    function test_guardian_holdsNoApprovalAndNoCancel() public {
        uint256 id = _proposeCurve(signerA, 200e6);

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.approve(id);

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.cancel(id);

        vm.warp(block.timestamp + PERIOD);
        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.execute(id);
    }

    function test_setGuardian_revertsWhenCalledDirectlyByAnyone() public {
        address fresh = makeAddr("freshGuardian");

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.NotSelf.selector);
        timelock.setGuardian(fresh);

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotSelf.selector);
        timelock.setGuardian(fresh);
    }

    function test_setGuardian_rotatesOnlyThroughTheQueue() public {
        address fresh = makeAddr("freshGuardian");

        uint256 id = _queuedSelfCall(abi.encodeCall(AdminTimelock.setGuardian, (fresh)));
        vm.prank(signerA);
        timelock.execute(id);

        assertEq(timelock.guardian(), fresh);

        BrakeTarget target = new BrakeTarget();
        address[] memory targets = new address[](1);
        targets[0] = address(target);

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotGuardian.selector);
        timelock.guardianPause(targets);

        vm.prank(fresh);
        timelock.guardianPause(targets);
        assertTrue(target.paused());
    }

    function test_setGuardian_refusesASignerAndRefusesZero() public {
        uint256 collision = _queuedSelfCall(abi.encodeCall(AdminTimelock.setGuardian, (signerC)));
        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.DuplicateSigner.selector);
        timelock.execute(collision);

        uint256 zeroed = _queuedSelfCall(abi.encodeCall(AdminTimelock.setGuardian, (address(0))));
        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.ZeroAddress.selector);
        timelock.execute(zeroed);

        assertEq(timelock.guardian(), guardian);
    }

    function test_updateSigner_revertsWhenCalledDirectly() public {
        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.NotSelf.selector);
        timelock.updateSigner(0, makeAddr("newSigner"));
    }

    function test_updateSigner_revertsOnAnIndexPastTheSet() public {
        uint256 id = _queuedSelfCall(abi.encodeCall(AdminTimelock.updateSigner, (3, makeAddr("newSigner"))));

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.InvalidSignerIndex.selector);
        timelock.execute(id);
    }

    function test_updateSigner_refusesTheGuardianAndASittingSigner() public {
        uint256 asGuardian = _queuedSelfCall(abi.encodeCall(AdminTimelock.updateSigner, (0, guardian)));
        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.DuplicateSigner.selector);
        timelock.execute(asGuardian);

        uint256 asSigner = _queuedSelfCall(abi.encodeCall(AdminTimelock.updateSigner, (0, signerB)));
        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.DuplicateSigner.selector);
        timelock.execute(asSigner);
    }

    /// Approvals are counted over the live signer set, so rotating a key out takes its approval
    /// with it and a proposal it was carrying stops short of the threshold.
    function test_updateSigner_dropsTheApprovalTheRotatedKeyWasCarrying() public {
        uint256 pending = _proposeCurve(signerA, 200e6);
        vm.prank(signerB);
        timelock.approve(pending);
        assertEq(timelock.approvals(pending), 2);

        address replacement = makeAddr("replacementSigner");
        uint256 rotation = _queuedSelfCall(abi.encodeCall(AdminTimelock.updateSigner, (0, replacement)));
        vm.prank(signerC);
        timelock.execute(rotation);

        assertFalse(timelock.isSigner(signerA));
        assertTrue(timelock.isSigner(replacement));
        assertEq(timelock.approvals(pending), 1);

        vm.prank(signerB);
        vm.expectRevert(AdminTimelock.InsufficientApprovals.selector);
        timelock.execute(pending);

        vm.prank(replacement);
        timelock.approve(pending);
        vm.prank(replacement);
        timelock.execute(pending);
        assertEq(reputation.curve().baseCap, 200e6);
    }

    function _curveCall(uint128 baseCap) internal pure returns (bytes memory) {
        return abi.encodeCall(
            Reputation.setCurve,
            (IReputation.CapCurve({baseCap: baseCap, capPerScore: 10e6, maxCap: baseCap + 1_000e6}))
        );
    }

    function _proposeCurve(address signer, uint128 baseCap) internal returns (uint256 id) {
        vm.prank(signer);
        id = timelock.propose(address(reputation), _curveCall(baseCap));
    }

    /// Two approvals and the delay behind it, ready to execute in this block.
    function _queued(uint128 baseCap) internal returns (uint256 id) {
        id = _proposeCurve(signerA, baseCap);
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);
    }

    function _queuedSelfCall(bytes memory data) internal returns (uint256 id) {
        vm.prank(signerA);
        id = timelock.propose(address(timelock), data);
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);
    }
}

/// Drives the timelock through random orderings so the delay and the signer set are checked as
/// properties over many paths.
contract TimelockHandler is Test {
    AdminTimelock public timelock;
    BrakeTarget public target;
    address[3] public signers;

    bool public sawEarlyExecution;
    uint256 public executions;

    constructor(AdminTimelock timelock_, BrakeTarget target_, address[3] memory signers_) {
        timelock = timelock_;
        target = target_;
        signers = signers_;
    }

    function propose(uint256 signerSeed) external {
        vm.prank(_signer(signerSeed));
        timelock.propose(address(target), abi.encodeWithSignature("pause()"));
    }

    function approve(uint256 idSeed, uint256 signerSeed) external {
        uint256 id = _id(idSeed);
        vm.prank(_signer(signerSeed));
        try timelock.approve(id) {} catch {}
    }

    function cancel(uint256 idSeed, uint256 signerSeed) external {
        uint256 id = _id(idSeed);
        vm.prank(_signer(signerSeed));
        try timelock.cancel(id) {} catch {}
    }

    function execute(uint256 idSeed, uint256 signerSeed) external {
        uint256 id = _id(idSeed);
        if (timelock.proposalCount() == 0) return;

        uint64 executeAfter = timelock.getProposal(id).executeAfter;
        uint256 approvalsBefore = timelock.approvals(id);

        vm.prank(_signer(signerSeed));
        try timelock.execute(id) {
            ++executions;
            if (block.timestamp < executeAfter || approvalsBefore < timelock.REQUIRED_APPROVALS()) {
                sawEarlyExecution = true;
            }
        } catch {}
    }

    function rotateSigner(uint256 idSeed, uint256 signerSeed, address replacement) external {
        if (replacement == address(0)) return;
        bytes memory data = abi.encodeCall(AdminTimelock.updateSigner, (idSeed % 4, replacement));

        vm.prank(_signer(signerSeed));
        try timelock.propose(address(timelock), data) {} catch {}
    }

    function skipAhead(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 hours, 6 days));
    }

    function _signer(uint256 seed) private view returns (address) {
        return signers[seed % 3];
    }

    function _id(uint256 seed) private view returns (uint256) {
        uint256 count = timelock.proposalCount();
        return count == 0 ? 0 : seed % count;
    }
}

contract MandateTimelockInvariantTest is Test {
    AdminTimelock internal timelock;
    TimelockHandler internal handler;
    address internal guardian;

    function setUp() public {
        address[3] memory signers =
            [makeAddr("invariantSignerA"), makeAddr("invariantSignerB"), makeAddr("invariantSignerC")];
        guardian = makeAddr("invariantGuardian");

        timelock = new AdminTimelock(signers, guardian, 3 days);
        handler = new TimelockHandler(timelock, new BrakeTarget(), signers);

        targetContract(address(handler));
    }

    function invariant_noProposalEverExecutesEarlyOrUnderApproved() public view {
        assertFalse(handler.sawEarlyExecution());
    }

    function invariant_theSignerSetStaysThreeDistinctKeysWithoutTheGuardian() public view {
        address[3] memory signers = timelock.getSigners();
        for (uint256 i; i < 3; ++i) {
            assertTrue(signers[i] != address(0));
            assertTrue(signers[i] != timelock.guardian());
            for (uint256 j; j < i; ++j) {
                assertTrue(signers[i] != signers[j]);
            }
        }
    }

    function invariant_theDelayIsNeverZero() public view {
        assertGt(timelock.timelockPeriod(), 0);
    }
}

/// The wiring the deploy script performs, built by hand so the cross-contract invariants can be
/// checked without a broadcast in the way, plus the handover that leaves governance in one place.
contract MandateWiringTest is Test {
    uint16 internal constant FEE_BPS = 50;
    uint16 internal constant RESOLVER_FEE_BPS = 100;
    uint16 internal constant DISPUTE_BOND_BPS = 500;
    uint64 internal constant MIN_TTL = 5 minutes;
    uint64 internal constant MAX_TTL = 7 days;
    uint64 internal constant DISPUTE_WINDOW = 1 days;
    uint128 internal constant MIN_LOCK = 10_000;
    uint64 internal constant COMMIT_WINDOW = 1 hours;
    uint64 internal constant REVEAL_WINDOW = 1 hours;
    uint64 internal constant PERIOD = 3 days;

    MockUsdg internal settlement;
    MockBRSR internal bondAsset;
    Staking internal pool;
    AdminTimelock internal timelock;
    Reputation internal reputation;
    Escrow internal escrow;
    OracleRegistry internal oracleRegistry;
    AgentRegistry internal agentRegistry;
    MandateAccountFactory internal factory;

    address internal signerA;
    address internal signerB;
    address internal signerC;
    address internal guardian;
    address internal treasury;
    address internal slashSink;
    address internal stranger;

    function setUp() public {
        signerA = makeAddr("wiringSignerA");
        signerB = makeAddr("wiringSignerB");
        signerC = makeAddr("wiringSignerC");
        guardian = makeAddr("wiringGuardian");
        treasury = makeAddr("wiringTreasury");
        slashSink = makeAddr("wiringSlashSink");
        stranger = makeAddr("wiringStranger");

        settlement = new MockUsdg();

        timelock = new AdminTimelock([signerA, signerB, signerC], guardian, PERIOD);
        reputation = new Reputation(
            address(timelock),
            IReputation.CapCurve({baseCap: 100e6, capPerScore: 10e6, maxCap: 1_100e6}),
            IReputation.Weights({minScored: 1e6, edgeCap: 100e6, fullCredit: 400e6})
        );
        escrow = new Escrow(
            address(settlement),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            DISPUTE_BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            MIN_LOCK
        );
        oracleRegistry = new OracleRegistry(address(settlement), address(timelock), slashSink, _oracleConfig());
        agentRegistry = new AgentRegistry(IERC20(address(settlement)), address(this), slashSink, 100e6, 1_000);

        bondAsset = new MockBRSR();
        pool = new Staking(bondAsset, settlement, address(timelock), slashSink, treasury, 7 days, 1_000e18);

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(oracleRegistry));
        oracleRegistry.setEscrow(address(escrow));
        oracleRegistry.setStaking(address(pool));

        escrow.setRegistry(IAgentRegistry(address(agentRegistry)));

        factory = new MandateAccountFactory(address(escrow), address(settlement));
    }

    function test_wiring_pointsEveryContractAtTheOneItNeeds() public view {
        assertEq(reputation.escrow(), address(escrow));
        assertEq(escrow.resolver(), address(oracleRegistry));
        assertEq(oracleRegistry.escrow(), address(escrow));
        assertEq(address(escrow.registry()), address(agentRegistry));
        assertEq(escrow.reputation(), address(reputation));
        assertEq(escrow.settlementAsset(), address(settlement));
        assertEq(oracleRegistry.settlementAsset(), address(settlement));
        assertEq(factory.escrow(), address(escrow));
        assertEq(factory.settlementAsset(), address(settlement));
        assertEq(reputation.admin(), address(timelock));
        assertEq(oracleRegistry.admin(), address(timelock));
        assertEq(escrow.treasury(), treasury);
        assertEq(oracleRegistry.slashSink(), slashSink);

        // Bonds are BRSR and the floor that admits one is the pool's, both read off the pool.
        // The asset a resolver posts cannot disagree with the floor.
        assertEq(address(oracleRegistry.staking()), address(pool));
        assertEq(address(oracleRegistry.bondAsset()), address(bondAsset));
    }

    /// The resolver produces a quality score and imports nothing from this registry. Naming it
    /// as the slasher would publish a capability it does not have: agent collateral moves on a
    /// timelock proposal, with a person naming the amount.
    function test_wiring_leavesNoContractAbleToTakeAgentCollateral() public {
        assertEq(agentRegistry.slasher(), address(0));

        address agent = makeAddr("wiringAgent");
        settlement.mint(agent, 100e6);
        vm.startPrank(agent);
        settlement.approve(address(agentRegistry), type(uint256).max);
        agentRegistry.register("wiring_agent", 100e6);
        vm.stopPrank();

        vm.prank(address(oracleRegistry));
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        agentRegistry.slash(agent, 1e6, bytes32("ruling"));
    }

    function test_wiring_leavesTheDeployKeyNamedOnEveryOneShot() public view {
        assertEq(escrow.deployer(), address(this));
        assertEq(reputation.deployer(), address(this));
        assertEq(oracleRegistry.deployer(), address(this));
    }

    function test_wiring_appliesEveryParameterItWasGiven() public view {
        assertEq(escrow.feeBps(), FEE_BPS);
        assertEq(escrow.resolverFeeBps(), RESOLVER_FEE_BPS);
        assertEq(escrow.disputeBondBps(), DISPUTE_BOND_BPS);
        assertEq(escrow.minTtl(), MIN_TTL);
        assertEq(escrow.maxTtl(), MAX_TTL);
        assertEq(escrow.disputeWindow(), DISPUTE_WINDOW);
        assertEq(escrow.minLock(), MIN_LOCK);

        IReputation.CapCurve memory curve = reputation.curve();
        assertEq(curve.baseCap, 100e6);
        assertEq(curve.capPerScore, 10e6);
        assertEq(curve.maxCap, 1_100e6);

        IReputation.Weights memory weights = reputation.weights();
        assertEq(weights.minScored, 1e6);
        assertEq(weights.edgeCap, 100e6);
        assertEq(weights.fullCredit, 400e6);

        IOracleRegistry.Config memory cfg = oracleRegistry.config();
        assertEq(cfg.commitWindow, COMMIT_WINDOW);
        assertEq(cfg.revealWindow, REVEAL_WINDOW);
        assertEq(cfg.slashBps, 2_000);
        assertEq(cfg.maxVoters, 64);

        assertEq(address(agentRegistry.settlementAsset()), address(settlement));
        assertEq(agentRegistry.minStake(), 100e6);
        assertEq(agentRegistry.slashBps(), 1_000);
        assertEq(agentRegistry.slashSink(), slashSink);
    }

    /// The invariants no constructor can see on its own.
    function test_wiring_holdsTheCrossContractInvariants() public view {
        assertGt(uint256(10_000), uint256(escrow.feeBps()) + escrow.resolverFeeBps());
        assertGt(reputation.curve().baseCap, 0);
        assertGt(timelock.timelockPeriod(), 0);
    }

    function test_oneShotSetters_refuseASecondCallFromTheDeployer() public {
        vm.expectRevert(IReputation.AlreadySet.selector);
        reputation.setEscrow(stranger);

        vm.expectRevert(IEscrow.AlreadySet.selector);
        escrow.setResolver(stranger);

        vm.expectRevert(IEscrow.AlreadySet.selector);
        escrow.setRegistry(IAgentRegistry(stranger));

        vm.expectRevert(IOracleRegistry.AlreadySet.selector);
        oracleRegistry.setEscrow(stranger);
    }

    function test_oneShotSetters_refuseAnyCallerThatDidNotDeploy() public {
        vm.startPrank(stranger);

        vm.expectRevert(IReputation.NotDeployer.selector);
        reputation.setEscrow(stranger);

        vm.expectRevert(IEscrow.NotDeployer.selector);
        escrow.setResolver(stranger);

        vm.expectRevert(IEscrow.NotDeployer.selector);
        escrow.setRegistry(IAgentRegistry(stranger));

        vm.expectRevert(IOracleRegistry.NotDeployer.selector);
        oracleRegistry.setEscrow(stranger);

        vm.stopPrank();
    }

    function test_partyGate_staysOffWhenNoRegistryIsDeployed() public {
        Escrow bare = new Escrow(
            address(settlement),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            DISPUTE_BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            MIN_LOCK
        );

        assertEq(address(bare.registry()), address(0), "address zero means the gate is off");
    }

    /// The registry is the one contract the deploy key still administers when the run ends, and
    /// the handover needs two signers and the delay like any other change.
    function test_governance_finishesTheRegistryHandoverThroughTheQueue() public {
        agentRegistry.transferAdmin(address(timelock));
        assertEq(agentRegistry.admin(), address(this));
        assertEq(agentRegistry.pendingAdmin(), address(timelock));

        uint256 id = _queued(address(agentRegistry), abi.encodeCall(AgentRegistry.acceptAdmin, ()));
        vm.prank(signerA);
        timelock.execute(id);

        assertEq(agentRegistry.admin(), address(timelock));
        assertEq(agentRegistry.pendingAdmin(), address(0));

        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        agentRegistry.setMinStake(1e6);
    }

    /// Each target is paused on its own. One already paused, or one with no `pause()` at all,
    /// does not stop the rest.
    function test_guardian_aBatchWithAPausedOrPauselessTargetStillStopsTheRest() public {
        escrow.setPauser(address(timelock));

        address[] memory first = new address[](1);
        first[0] = address(escrow);
        vm.prank(guardian);
        timelock.guardianPause(first);

        address[] memory batch = new address[](3);
        batch[0] = address(escrow);
        batch[1] = address(reputation);
        batch[2] = address(oracleRegistry);

        vm.expectEmit(true, true, false, true, address(timelock));
        emit AdminTimelock.GuardianPauseSkipped(
            address(escrow), guardian, abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
        vm.expectEmit(true, true, false, true, address(timelock));
        emit AdminTimelock.GuardianPauseSkipped(address(reputation), guardian, "");
        vm.expectEmit(true, true, false, true, address(timelock));
        emit AdminTimelock.GuardianPaused(address(oracleRegistry), guardian);

        vm.prank(guardian);
        timelock.guardianPause(batch);

        assertTrue(escrow.paused());
        assertTrue(oracleRegistry.paused(), "the registry was held back by the entries before it");
    }

    function test_guardian_brakesTheRegistryInOneBlockAndCannotRestartIt() public {
        agentRegistry.transferAdmin(address(timelock));
        uint256 handover = _queued(address(agentRegistry), abi.encodeCall(AgentRegistry.acceptAdmin, ()));
        vm.prank(signerA);
        timelock.execute(handover);

        address[] memory targets = new address[](1);
        targets[0] = address(agentRegistry);

        vm.prank(guardian);
        timelock.guardianPause(targets);
        assertTrue(agentRegistry.paused());

        address agent = makeAddr("blockedAgent");
        vm.prank(agent);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        agentRegistry.register("blocked_agent", 100e6);

        vm.prank(guardian);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        agentRegistry.unpause();

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.propose(address(agentRegistry), abi.encodeCall(AgentRegistry.unpause, ()));

        uint256 restart = _queued(address(agentRegistry), abi.encodeCall(AgentRegistry.unpause, ()));
        vm.prank(signerB);
        timelock.execute(restart);
        assertFalse(agentRegistry.paused());
    }

    function _oracleConfig() internal pure returns (IOracleRegistry.Config memory) {
        return IOracleRegistry.Config({
            commitWindow: COMMIT_WINDOW,
            revealWindow: REVEAL_WINDOW,
            unbondingPeriod: 1 days,
            quorum: 3,
            maxVoters: 64,
            maxDeviation: 15,
            slashBps: 2_000
        });
    }

    function _queued(address target, bytes memory data) internal returns (uint256 id) {
        vm.prank(signerA);
        id = timelock.propose(target, data);
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);
    }
}
