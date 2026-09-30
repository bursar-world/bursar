// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {Deploy} from "../script/Deploy.s.sol";
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

/// A settlement asset at the wrong scale. USDG is six decimals and the whole accounting
/// surface assumes it.
contract WideDecimalsToken {
    function decimals() external pure returns (uint8) {
        return 18;
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
            address(timelock), IReputation.CapCurve({baseCap: 100e6, capPerScore: 10e6, maxCap: 1_100e6})
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

    function test_theSignerSetIsReadableAsASetRatherThanOneSlotAtATime() public view {
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

    function test_guardianPause_revertsWhenATargetHasNoCode() public {
        BrakeTarget target = new BrakeTarget();
        address[] memory targets = new address[](2);
        targets[0] = address(target);
        targets[1] = makeAddr("notAContract");

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotAContract.selector);
        timelock.guardianPause(targets);

        assertFalse(target.paused(), "a batch with a bad target pauses nothing");
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

/// Drives the timelock through random orderings so the delay and the signer set can be checked
/// as properties, not as single paths.
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
    uint64 internal constant DISPUTE_TIMEOUT = 2 days;
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
            address(timelock), IReputation.CapCurve({baseCap: 100e6, capPerScore: 10e6, maxCap: 1_100e6})
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
            DISPUTE_TIMEOUT
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

    /// The resolver produces a quality score, not a figure to take off an agent's balance
    /// sheet, and it imports nothing from this registry. Naming it as the slasher would publish
    /// a capability it does not have: agent collateral moves on a timelock proposal, with a
    /// person naming the amount.
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
        assertEq(escrow.disputeTimeoutPeriod(), DISPUTE_TIMEOUT);

        IReputation.CapCurve memory curve = reputation.curve();
        assertEq(curve.baseCap, 100e6);
        assertEq(curve.capPerScore, 10e6);
        assertEq(curve.maxCap, 1_100e6);

        IOracleRegistry.Config memory cfg = oracleRegistry.config();
        assertEq(cfg.commitWindow, COMMIT_WINDOW);
        assertEq(cfg.revealWindow, REVEAL_WINDOW);
        assertEq(cfg.slashBps, 2_000);
        assertEq(oracleRegistry.votingPeriod(), COMMIT_WINDOW + REVEAL_WINDOW);

        assertEq(address(agentRegistry.settlementAsset()), address(settlement));
        assertEq(agentRegistry.minStake(), 100e6);
        assertEq(agentRegistry.slashBps(), 1_000);
        assertEq(agentRegistry.slashSink(), slashSink);
    }

    /// The three invariants no constructor can see on its own.
    function test_wiring_holdsTheCrossContractInvariants() public view {
        assertGt(escrow.disputeTimeoutPeriod(), oracleRegistry.votingPeriod());
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
            DISPUTE_TIMEOUT
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
            maxVoters: 7,
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

/// Stands in for the key a real run is invoked with. Etched at forge-std's default sender so
/// the address that calls the script is the address the script broadcasts as.
contract DeployRunner {
    function go(Deploy script) external returns (Deploy.Deployment memory) {
        return script.run();
    }
}

/// The deploy script, driven through the environment it reads. Foundry's environment is
/// process-wide and test functions in a contract run in parallel, so every case that varies a
/// variable lives in one function and runs in order.
///
/// A script that broadcasts signs as the harness default key while `run` reads its deployer from
/// its caller, and the two cannot be made equal without a prank, which broadcasting rejects. So
/// a run that gets past every check stops at the script's own wiring readback, and that is the
/// deepest the script goes in process: everything before it, constructors and one-shot setters
/// included, has already executed.
contract MandateDeployScriptTest is Test {
    uint256 internal constant RHC_CHAIN_ID = 4663;
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant MIN_SETTLEMENT_BALANCE = 1_000_000;
    string internal constant EOA_ACK = "i-accept-eoa-governance";

    /// Every variable this suite writes sits under this prefix, and the script is pinned to it.
    /// Foundry's environment is process-wide and is not part of the EVM state it snapshots, so
    /// the token deployment suite driving its own script writes the same variable names at the
    /// same time. Sharing them made this suite fail on an address from someone else's fixture,
    /// about one run in three.
    string internal constant ENV = "COREDEPLOY_";

    Deploy internal script;
    MockUsdg internal settlement;

    /// Off testnet the script insists one signer holds code, in practice a multisig.
    address internal multisigSigner;
    address internal signerB;
    address internal signerC;
    address internal guardian;
    address internal treasury;
    address internal slashSink;
    uint256 internal homeChain;

    function setUp() public {
        settlement = new MockUsdg();
        multisigSigner = address(new BrakeTarget());
        signerB = makeAddr("deploySignerB");
        signerC = makeAddr("deploySignerC");
        guardian = makeAddr("deployGuardian");
        treasury = makeAddr("deployTreasury");
        slashSink = makeAddr("deploySlashSink");
        homeChain = block.chainid;

        script = new Deploy();
        script.pinEnvPrefix(ENV);
    }

    function _set(string memory key, string memory value) private {
        vm.setEnv(string.concat(ENV, key), value);
    }

    function _key(string memory key) private pure returns (string memory) {
        return string.concat(ENV, key);
    }

    function test_deployScript_stopsOnEveryParameterSetThatDoesNotHoldTogether() public {
        _caseWrongChain();
        _caseSentinelAddressReadsAsUnset();
        _caseSentinelAmountReadsAsUnset();
        _caseEmptyBoolean();
        _caseBooleanThatIsNotSpelledOut();
        _caseValueTooWideForItsField();
        _caseAssetIsNotAContract();
        _caseAssetCannotAnswerDecimals();
        _caseAssetAtTheWrongScale();
        _caseFeesConsumeAWholeSettlement();
        _caseEscrowsTighterFeeCeiling();
        _caseDisputeBondAtPar();
        _caseDisputeTimeoutEqualsTheVotingWindow();
        _caseZeroTimelockPeriod();
        _casePeriodBelowTheTimelocksOwnFloor();
        _caseZeroBaseCap();
        _caseResolverSlashOfZero();
        _caseDeployKeyCarriesGovernance();
        _caseGuardianAlsoCarriesAnApproval();
        _caseDeployKeyIsTheTreasury();
        _caseOneAddressForFeesAndSlashedCollateral();
        _caseEveryChainDemandsAMultisigOrAnExplicitAcknowledgement();
        _caseTheRetiredResolverBondVariableIsRefused();
        _caseAForeignEnvironmentCannotReachThisRun();
        _caseTheMinimalSetLeavesThePartyGateOpen();
        _caseRobinhoodChainPinsTheUsdgAddress();
        _caseTheSettlementAssetHasToBeAbleToMove();
        _caseDeploysTheSetThenReadsItsOwnWiringBack();
        _caseGovernanceAddressHoldsNoCode();
        _caseLiveGovernanceDisagreesWithTheParameterFile();
        _caseJoinsGovernanceThatIsAlreadyLive();
    }

    /// Resolver bonds are posted in BRSR now and the floor that admits one lives in the staking
    /// pool, which the token deployment brings. A variable left over from the old parameter set
    /// would otherwise sit in the operator's shell reading as though it still set a floor.
    function _caseTheRetiredResolverBondVariableIsRefused() private {
        _setBaseEnv();
        _set("BURSAR_RESOLVER_MIN_BOND", "1000000");

        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.RetiredEnv.selector,
                _key("BURSAR_RESOLVER_MIN_BOND"),
                "BURSAR_STAKING_MIN_BOND, in the token deployment"
            )
        );
        script.run();
    }

    /// The failure this namespace exists to stop: another suite, or an operator with the
    /// parameter file sourced, writing the same variable names into the same process. Nothing
    /// outside the namespace reaches this run, whatever it says.
    function _caseAForeignEnvironmentCannotReachThisRun() private {
        _setBaseEnv();

        vm.setEnv("BURSAR_CHAIN_ID", vm.toString(homeChain + 99));
        vm.setEnv("BURSAR_SETTLEMENT_ASSET", vm.toString(makeAddr("someoneElsesAsset")));
        vm.setEnv("BURSAR_TREASURY", vm.toString(address(0)));
        vm.setEnv("BURSAR_RESOLVER_MIN_BOND", "1000000");

        Deploy.Deployment memory out = _runAsDeployKey();
        assertEq(Escrow(out.escrow).settlementAsset(), address(settlement));
    }

    /// Robinhood Chain is the one chain this run pins an asset address on, because it is the
    /// one chain the address was read off. A typo in the parameter file stops here instead of
    /// becoming the settlement asset of a live deployment.
    function _caseRobinhoodChainPinsTheUsdgAddress() private {
        _setBaseEnv();
        vm.chainId(RHC_CHAIN_ID);
        _set("BURSAR_CHAIN_ID", vm.toString(RHC_CHAIN_ID));

        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetNotUsdg.selector, address(settlement), RHC_USDG));
        script.run();

        vm.chainId(homeChain);
    }

    /// The compliance preflight, which runs only on the chain where the asset is pinned and
    /// only on the selectors USDG answers. Every one of these is read straight: there is no
    /// stipend and no three-valued answer, because nothing on 4663 hides behind a precompile.
    function _caseTheSettlementAssetHasToBeAbleToMove() private {
        _setBaseEnv();
        MockUsdg usdg = _useRobinhoodChain();

        usdg.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetPaused.selector, RHC_USDG));
        script.run();
        usdg.setPaused(false);

        // The script attributes the deployment to its own caller, so a case that calls `run`
        // directly is deploying as this contract and a case that goes through the broadcast key
        // is deploying as forge-std's default sender. Both appear below, each named.
        usdg.setFrozen(address(this), true);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AddressFrozen.selector, "deployer", address(this)));
        script.run();
        usdg.setFrozen(address(this), false);

        // A frozen treasury can never be swept, and the escrow names it immutably.
        usdg.setFrozen(treasury, true);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AddressFrozen.selector, "treasury", treasury));
        script.run();
        usdg.setFrozen(treasury, false);

        // A deploy key holding none of the settlement asset cannot fund the first mandate, and
        // an empty balance is also what a wrong address that happens to hold code looks like.
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.SettlementBalanceTooLow.selector, address(this), uint256(0), MIN_SETTLEMENT_BALANCE
            )
        );
        script.run();

        usdg.mint(DEFAULT_SENDER, MIN_SETTLEMENT_BALANCE);
        Deploy.Deployment memory out = _runAsDeployKey();
        assertEq(Escrow(out.escrow).settlementAsset(), RHC_USDG);

        vm.chainId(homeChain);
    }

    /// Moves the fixture onto chain 4663 with USDG at its pinned address.
    function _useRobinhoodChain() private returns (MockUsdg) {
        vm.etch(RHC_USDG, address(new MockUsdg()).code);
        vm.chainId(RHC_CHAIN_ID);
        _set("BURSAR_CHAIN_ID", vm.toString(RHC_CHAIN_ID));
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(RHC_USDG));
        return MockUsdg(RHC_USDG);
    }

    function _caseWrongChain() private {
        _setBaseEnv();
        _set("BURSAR_CHAIN_ID", vm.toString(homeChain + 1));

        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, homeChain + 1, homeChain));
        script.run();
    }

    /// Address zero is how the script tells a variable nobody set from a value someone chose.
    function _caseSentinelAddressReadsAsUnset() private {
        _setBaseEnv();
        _set("BURSAR_TREASURY", vm.toString(address(0)));

        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, _key("BURSAR_TREASURY")));
        script.run();
    }

    function _caseSentinelAmountReadsAsUnset() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", vm.toString(type(uint256).max));

        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, _key("BURSAR_FEE_BPS")));
        script.run();
    }

    /// An unset boolean would otherwise read as false and quietly drop the registry.
    function _caseEmptyBoolean() private {
        _setBaseEnv();
        _set("BURSAR_DEPLOY_AGENT_REGISTRY", "");

        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, _key("BURSAR_DEPLOY_AGENT_REGISTRY")));
        script.run();
    }

    function _caseBooleanThatIsNotSpelledOut() private {
        _setBaseEnv();
        _set("BURSAR_DEPLOY_AGENT_REGISTRY", "yes");

        vm.expectRevert(
            abi.encodeWithSelector(Deploy.EnvNotBoolean.selector, _key("BURSAR_DEPLOY_AGENT_REGISTRY"), "yes")
        );
        script.run();
    }

    function _caseValueTooWideForItsField() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", "70000");

        vm.expectRevert(
            abi.encodeWithSelector(Deploy.EnvOutOfRange.selector, _key("BURSAR_FEE_BPS"), 70_000, type(uint16).max)
        );
        script.run();
    }

    function _caseAssetIsNotAContract() private {
        _setBaseEnv();
        address notAContract = makeAddr("notAContract");
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(notAContract));

        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetNotContract.selector, notAContract));
        script.run();
    }

    function _caseAssetCannotAnswerDecimals() private {
        _setBaseEnv();
        address mute = address(new MuteTarget());
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(mute));

        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetNotContract.selector, mute));
        script.run();
    }

    function _caseAssetAtTheWrongScale() private {
        _setBaseEnv();
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(address(new WideDecimalsToken())));

        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetDecimalsMismatch.selector, uint8(18), uint8(6)));
        script.run();
    }

    function _caseFeesConsumeAWholeSettlement() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", "6000");
        _set("BURSAR_RESOLVER_FEE_BPS", "4000");

        vm.expectRevert(abi.encodeWithSelector(Deploy.FeeSplitTooLarge.selector, uint16(6_000), uint16(4_000)));
        script.run();
    }

    /// One basis point under the sum the script rejects, the escrow's own ceiling is what stops
    /// the run. The two checks are not the same check.
    function _caseEscrowsTighterFeeCeiling() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", "5999");
        _set("BURSAR_RESOLVER_FEE_BPS", "4000");

        vm.expectRevert(IEscrow.BadFee.selector);
        script.run();
        // The revert lands inside the broadcast, and cheatcode state does not roll back with it.
        vm.stopBroadcast();
    }

    function _caseDisputeBondAtPar() private {
        _setBaseEnv();
        _set("BURSAR_DISPUTE_BOND_BPS", "10000");

        vm.expectRevert(abi.encodeWithSelector(Deploy.DisputeBondTooLarge.selector, uint16(10_000)));
        script.run();
    }

    /// A timeout inside the voting windows refunds every payer before a resolver can rule, so
    /// equal is rejected. One second longer is accepted, in the last case below.
    function _caseDisputeTimeoutEqualsTheVotingWindow() private {
        _setBaseEnv();
        _set("BURSAR_DISPUTE_TIMEOUT", "7200");

        vm.expectRevert(abi.encodeWithSelector(Deploy.DisputeTimeoutTooShort.selector, uint64(7_200), uint64(7_200)));
        script.run();
    }

    function _caseZeroTimelockPeriod() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_PERIOD", "0");

        vm.expectRevert(Deploy.TimelockPeriodZero.selector);
        script.run();
    }

    /// The script rejects only zero. The floor that makes the delay worth having lives in the
    /// timelock, and a period under it stops the run there instead.
    function _casePeriodBelowTheTimelocksOwnFloor() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_PERIOD", vm.toString(uint256(1 hours - 1)));

        vm.expectRevert(AdminTimelock.BadPeriod.selector);
        script.run();
        vm.stopBroadcast();
    }

    function _caseZeroBaseCap() private {
        _setBaseEnv();
        _set("BURSAR_CAP_BASE", "0");

        vm.expectRevert(Deploy.BaseCapZero.selector);
        script.run();
    }

    /// A slash of zero would leave the only cost a resolver faces a no-op while the slash event
    /// still fires. The registry constructor reverts on that.
    function _caseResolverSlashOfZero() private {
        _setBaseEnv();
        _set("BURSAR_RESOLVER_SLASH_BPS", "0");

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        script.run();
        vm.stopBroadcast();
    }

    function _caseDeployKeyCarriesGovernance() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_SIGNER_2", vm.toString(address(this)));

        vm.expectRevert(abi.encodeWithSelector(Deploy.DeployerIsTimelockSigner.selector, address(this)));
        script.run();
    }

    function _caseGuardianAlsoCarriesAnApproval() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_GUARDIAN", vm.toString(signerC));

        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCollision.selector, "guardian", "timelockSigner", signerC));
        script.run();
    }

    function _caseDeployKeyIsTheTreasury() private {
        _setBaseEnv();
        _set("BURSAR_TREASURY", vm.toString(address(this)));

        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCollision.selector, "treasury", "deployer", address(this)));
        script.run();
    }

    function _caseOneAddressForFeesAndSlashedCollateral() private {
        _setBaseEnv();
        _set("BURSAR_SLASH_SINK", vm.toString(treasury));

        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCollision.selector, "treasury", "slashSink", treasury));
        script.run();
    }

    /// Three plain keys are refused on every chain. No chain is exempt, because Robinhood Chain
    /// has no second chain to rehearse on: testnet 46630 carries no USDG and cannot settle. What
    /// stands in for an exemption is a variable an operator has to mean.
    ///
    /// Release 1 governance is three plain keys by decision, so the refusal has to be
    /// liftable. It lifts on a phrase and not on a boolean, because `true` is a word that
    /// arrives in a shell by accident.
    function _caseEveryChainDemandsAMultisigOrAnExplicitAcknowledgement() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_SIGNER_1", vm.toString(makeAddr("hotKey")));

        // Unset, the refusal stands.
        vm.expectRevert(Deploy.GovernanceHasNoMultisig.selector);
        script.run();

        _set("BURSAR_ALLOW_EOA_GOVERNANCE", "true");
        vm.expectRevert(abi.encodeWithSelector(Deploy.EoaGovernanceNotAcknowledged.selector, "true", EOA_ACK));
        script.run();

        // A near miss is still a miss. The comparison is over the bytes.
        _set("BURSAR_ALLOW_EOA_GOVERNANCE", "I-ACCEPT-EOA-GOVERNANCE");
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.EoaGovernanceNotAcknowledged.selector, "I-ACCEPT-EOA-GOVERNANCE", EOA_ACK)
        );
        script.run();

        _set("BURSAR_ALLOW_EOA_GOVERNANCE", EOA_ACK);
        Deploy.Deployment memory out = _runAsDeployKey();

        assertEq(Escrow(out.escrow).settlementAsset(), address(settlement));
        address[3] memory deployed = AdminTimelock(out.timelock).getSigners();
        for (uint256 i; i < 3; ++i) {
            assertEq(deployed[i].code.length, 0, "a contract signer reached the acknowledged path");
        }
    }

    /// The minimal set: no agent registry, and the party gate left open. Nothing about it is
    /// chain-specific, so it runs on the home chain with a signer set that holds code.
    function _caseTheMinimalSetLeavesThePartyGateOpen() private {
        _setBaseEnv();
        _set("BURSAR_DEPLOY_AGENT_REGISTRY", "false");

        Deploy.Deployment memory out = _runAsDeployKey();

        assertEq(Escrow(out.escrow).settlementAsset(), address(settlement));
        assertEq(address(Escrow(out.escrow).registry()), address(0), "the minimal set wired a party gate");
        assertEq(out.agentRegistry, address(0));
    }

    /// The whole set constructs and wires with a dispute timeout one second past the voting
    /// window, and the run reads every pairing back before it returns. Anything the readback
    /// disagrees with stops the run, so reaching the end is the assertion.
    function _caseDeploysTheSetThenReadsItsOwnWiringBack() private {
        _setBaseEnv();
        _set("BURSAR_DISPUTE_TIMEOUT", "7201");

        Deploy.Deployment memory out = _runAsDeployKey();

        assertEq(Escrow(out.escrow).deployer(), DEFAULT_SENDER);
        assertEq(Escrow(out.escrow).resolver(), out.oracleRegistry);
        assertEq(OracleRegistry(out.oracleRegistry).escrow(), out.escrow);
        assertEq(Reputation(out.reputation).escrow(), out.escrow);
        assertEq(MandateAccountFactory(out.factory).escrow(), out.escrow);

        // Governance is the timelock everywhere from the first block, the agent registry and
        // the escrow's brake included. The deploy key keeps nothing.
        assertEq(Reputation(out.reputation).admin(), out.timelock);
        assertEq(OracleRegistry(out.oracleRegistry).admin(), out.timelock);
        assertEq(AgentRegistry(out.agentRegistry).admin(), out.timelock);
        assertEq(AgentRegistry(out.agentRegistry).pendingAdmin(), address(0));
        assertEq(Escrow(out.escrow).pauser(), out.timelock);
        assertEq(address(Escrow(out.escrow).registry()), out.agentRegistry);

        // Two capabilities the run leaves absent. No contract can take agent collateral, and
        // no resolver can bond until the token deployment names a staking pool.
        assertEq(AgentRegistry(out.agentRegistry).slasher(), address(0));
        assertEq(address(OracleRegistry(out.oracleRegistry).staking()), address(0));
        assertEq(address(OracleRegistry(out.oracleRegistry).bondAsset()), address(0));
    }

    /// A redeploy of the money path joins the governance that already holds the rest of the
    /// system. Nothing in the run stands up a second timelock, and every admin lands on the
    /// live one.
    function _caseJoinsGovernanceThatIsAlreadyLive() private {
        AdminTimelock live = new AdminTimelock([multisigSigner, signerB, signerC], guardian, 3 days);

        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(live)));

        Deploy.Deployment memory out = _runAsDeployKey();

        assertEq(out.timelock, address(live));
        assertEq(Reputation(out.reputation).admin(), address(live));
        assertEq(OracleRegistry(out.oracleRegistry).admin(), address(live));
        assertEq(AgentRegistry(out.agentRegistry).admin(), address(live));
    }

    /// An address with nothing behind it would deploy a set whose every admin call reverts.
    function _caseGovernanceAddressHoldsNoCode() private {
        address empty = makeAddr("governanceWithNoCode");
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(empty));

        vm.expectRevert(abi.encodeWithSelector(Deploy.TimelockNotContract.selector, empty));
        script.run();
    }

    /// The run never sets the terms of governance it joins, so it holds the live contract
    /// against the parameter file instead. A wrong address is otherwise invisible until the
    /// first proposal, by which point every contract answers to something nobody chose.
    function _caseLiveGovernanceDisagreesWithTheParameterFile() private {
        AdminTimelock shorterDelay = new AdminTimelock([multisigSigner, signerB, signerC], guardian, 2 days);
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(shorterDelay)));

        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.ParameterNotApplied.selector, "timelock.timelockPeriod", uint256(3 days), uint256(2 days)
            )
        );
        script.run();

        address otherGuardian = makeAddr("someoneElsesGuardian");
        AdminTimelock otherBrake = new AdminTimelock([multisigSigner, signerB, signerC], otherGuardian, 3 days);
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(otherBrake)));

        vm.expectRevert(
            abi.encodeWithSelector(Deploy.WiringFailed.selector, "timelock.guardian", guardian, otherGuardian)
        );
        script.run();

        address otherSigner = makeAddr("someoneElsesSigner");
        AdminTimelock otherSigners = new AdminTimelock([multisigSigner, signerB, otherSigner], guardian, 3 days);
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(otherSigners)));

        vm.expectRevert(abi.encodeWithSelector(Deploy.WiringFailed.selector, "timelock.signer", signerC, otherSigner));
        script.run();
    }

    /// `run` attributes the deployment to its own caller and signs with the broadcast key, so
    /// the two have to be the same address for the readback to hold. On a real run they are:
    /// the sender the script is invoked with is the sender it broadcasts as.
    ///
    /// Under the test harness the broadcast key is forge-std's default sender and the caller
    /// would be this contract, so the call is made from the default sender itself. A prank
    /// cannot do it, since a broadcast cannot be opened under one.
    function _runAsDeployKey() private returns (Deploy.Deployment memory) {
        vm.etch(DEFAULT_SENDER, address(new DeployRunner()).code);
        return DeployRunner(DEFAULT_SENDER).go(script);
    }

    function _setBaseEnv() private {
        // Cleared, not assumed absent, because one case sets it to prove the run rejects it.
        _set("BURSAR_RESOLVER_MIN_BOND", "");
        // Same, and this one matters more: a value left over from the case that acknowledges
        // an EOA signer set would silence the refusal in every case after it.
        _set("BURSAR_ALLOW_EOA_GOVERNANCE", "");
        // Zero is the sentinel for "this run brings its own governance", which is the default
        // every case but the reuse ones expects.
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(0)));

        _set("BURSAR_CHAIN_ID", vm.toString(homeChain));
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(address(settlement)));
        _set("BURSAR_TREASURY", vm.toString(treasury));
        _set("BURSAR_SLASH_SINK", vm.toString(slashSink));

        _set("BURSAR_TIMELOCK_SIGNER_1", vm.toString(multisigSigner));
        _set("BURSAR_TIMELOCK_SIGNER_2", vm.toString(signerB));
        _set("BURSAR_TIMELOCK_SIGNER_3", vm.toString(signerC));
        _set("BURSAR_TIMELOCK_GUARDIAN", vm.toString(guardian));
        _set("BURSAR_TIMELOCK_PERIOD", vm.toString(uint256(3 days)));

        _set("BURSAR_FEE_BPS", "50");
        _set("BURSAR_RESOLVER_FEE_BPS", "100");
        _set("BURSAR_DISPUTE_BOND_BPS", "500");
        _set("BURSAR_MIN_TTL", vm.toString(uint256(5 minutes)));
        _set("BURSAR_MAX_TTL", vm.toString(uint256(7 days)));
        _set("BURSAR_DISPUTE_WINDOW", vm.toString(uint256(1 days)));
        _set("BURSAR_DISPUTE_TIMEOUT", vm.toString(uint256(2 days)));

        _set("BURSAR_CAP_BASE", "100000000");
        _set("BURSAR_CAP_PER_SCORE", "10000000");
        _set("BURSAR_CAP_MAX", "1100000000");

        _set("BURSAR_COMMIT_WINDOW", "3600");
        _set("BURSAR_REVEAL_WINDOW", "3600");
        _set("BURSAR_UNBONDING_PERIOD", "86400");
        _set("BURSAR_RESOLVER_QUORUM", "3");
        _set("BURSAR_MAX_VOTERS", "7");
        _set("BURSAR_MAX_DEVIATION", "15");
        _set("BURSAR_RESOLVER_SLASH_BPS", "2000");

        _set("BURSAR_DEPLOY_AGENT_REGISTRY", "true");
        _set("BURSAR_AGENT_MIN_STAKE", "100000000");
        _set("BURSAR_AGENT_SLASH_BPS", "1000");
    }
}
