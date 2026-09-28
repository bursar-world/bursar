// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {Reputation} from "../src/Reputation.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";

import {DualViewERC20} from "./mocks/DualViewERC20.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";

/// Stands in for the oracle registry on the paths where the escrow only needs an adjudicator
/// to exist. It records the dispute id it handed out and accepts a reward without opinion, so
/// a reputation test can reach `resolve` and `disputeTimeout` without dragging commit-reveal
/// voting into the fixture.
contract RepRegResolverStub {
    mapping(uint256 escrowId => uint256 disputeId) public disputeIdOf;

    uint256 public nextDisputeId = 1;

    function openDispute(uint256 escrowId, address, address) external returns (uint256 disputeId) {
        disputeId = nextDisputeId++;
        disputeIdOf[escrowId] = disputeId;
    }

    function notifyReward(uint256, uint256) external {}
}

/// Score derivation, the cap curve and the write permissions, driven directly instead of
/// through an escrow. The fixture makes this contract the escrow so a test can place a
/// counter exactly where it wants one.
contract ReputationTest is Test {
    event EscrowSet(address indexed escrow);
    event CurveUpdated(uint128 baseCap, uint128 capPerScore, uint128 maxCap);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    uint128 internal constant BASE_CAP = 100e6;
    uint128 internal constant CAP_PER_SCORE = 5e6;
    uint128 internal constant MAX_CAP = 1_000e6;

    Reputation internal reputation;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    address internal payerA = makeAddr("payerA");
    address internal payerB = makeAddr("payerB");
    address internal payee = makeAddr("payee");

    function setUp() public {
        reputation = new Reputation(
            admin, IReputation.CapCurve({baseCap: BASE_CAP, capPerScore: CAP_PER_SCORE, maxCap: MAX_CAP})
        );
        reputation.setEscrow(address(this));
    }

    function test_constructorRejectsAZeroAdmin() public {
        vm.expectRevert(IReputation.ZeroAddress.selector);
        new Reputation(address(0), IReputation.CapCurve({baseCap: 1, capPerScore: 1, maxCap: 2}));
    }

    function test_constructorRejectsACeilingBelowTheFloor() public {
        vm.expectRevert(IReputation.BadCurve.selector);
        new Reputation(admin, IReputation.CapCurve({baseCap: 100, capPerScore: 1, maxCap: 99}));
    }

    /// A flat curve is a policy, not a misconfiguration: a ceiling equal to the floor is the
    /// boundary the constructor has to admit.
    function test_constructorAdmitsACeilingEqualToTheFloor() public {
        Reputation flat = new Reputation(admin, IReputation.CapCurve({baseCap: 100, capPerScore: 7, maxCap: 100}));
        flat.setEscrow(address(this));

        _release(flat, payerA, payee);

        assertEq(flat.score(payee), 100);
        assertEq(flat.capOf(payee), 100);
    }

    function test_anUnscoredPayeeScoresZeroAndGetsTheBaseCap() public view {
        assertEq(reputation.score(payee), 0);
        assertEq(reputation.capOf(payee), BASE_CAP);
    }

    function test_scoreIsTheReleasedShareOfEverySettledJob() public {
        _release(reputation, payerA, payee);
        _release(reputation, payerA, payee);
        _release(reputation, payerA, payee);
        reputation.onTimedOut(payerA, payee);

        assertEq(reputation.score(payee), 75);
    }

    /// Three settled jobs and two of them released is 66.67 percent. The payee gets 66, since
    /// rounding up would hand out the headroom of a point the history has not reached.
    function test_scoreTruncatesRatherThanRoundingUp() public {
        _release(reputation, payerA, payee);
        _release(reputation, payerA, payee);
        reputation.onDisputed(payerA, payee);

        assertEq(reputation.score(payee), 66);
    }

    function test_aTimeoutAndADisputeCostThePayeeTheSame() public {
        address disputed = makeAddr("disputedPayee");

        _release(reputation, payerA, payee);
        reputation.onTimedOut(payerA, payee);

        _release(reputation, payerA, disputed);
        reputation.onDisputed(payerA, disputed);

        assertEq(reputation.score(payee), 50);
        assertEq(reputation.score(disputed), reputation.score(payee));
        assertEq(reputation.capOf(disputed), reputation.capOf(payee));
    }

    function test_capIsTheFloorPlusTheSlopeUntilTheCeilingBinds() public {
        // Four jobs, three released: score 75, so the cap is 100 + 5 * 75.
        _release(reputation, payerA, payee);
        _release(reputation, payerA, payee);
        _release(reputation, payerA, payee);
        reputation.onTimedOut(payerA, payee);

        assertEq(reputation.capOf(payee), BASE_CAP + CAP_PER_SCORE * 75);
    }

    /// The curve is written so a perfect payee lands exactly on the ceiling, then the ceiling
    /// is lowered by one to prove the clamp fires on the next unit, not one late.
    function test_capClampsAtTheCeilingAndOneUnitBeyondIt() public {
        vm.prank(admin);
        reputation.setCurve(IReputation.CapCurve({baseCap: 100, capPerScore: 9, maxCap: 1_000}));

        _release(reputation, payerA, payee);
        assertEq(reputation.score(payee), 100);
        assertEq(reputation.capOf(payee), 1_000);

        vm.prank(admin);
        reputation.setCurve(IReputation.CapCurve({baseCap: 100, capPerScore: 9, maxCap: 999}));
        assertEq(reputation.capOf(payee), 999);
    }

    /// A hundred times a uint128 slope leaves the type. The widened multiply has to survive it
    /// and come back clamped instead of reverting under the escrow's lock.
    function test_capSurvivesASlopeThatOverflowsTheTypeWhenScaled() public {
        vm.prank(admin);
        reputation.setCurve(
            IReputation.CapCurve({baseCap: 1, capPerScore: type(uint128).max, maxCap: type(uint128).max})
        );

        _release(reputation, payerA, payee);

        assertEq(reputation.capOf(payee), type(uint128).max);
    }

    function test_edgesRecordEachPayerWhileTheAggregateSumsThem() public {
        _release(reputation, payerA, payee);
        _release(reputation, payerA, payee);
        reputation.onTimedOut(payerB, payee);

        (uint64 releasedA, uint64 timedOutA, uint64 disputedA) = reputation.edges(payerA, payee);
        assertEq(releasedA, 2);
        assertEq(timedOutA, 0);
        assertEq(disputedA, 0);

        (uint64 releasedB, uint64 timedOutB,) = reputation.edges(payerB, payee);
        assertEq(releasedB, 0);
        assertEq(timedOutB, 1);

        (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 2);
        assertEq(timedOut, 1);
        assertEq(disputed, 0);
    }

    function test_onlyTheEscrowMovesACounter() public {
        vm.startPrank(stranger);

        vm.expectRevert(IReputation.NotEscrow.selector);
        reputation.onReleased(payerA, payee);

        vm.expectRevert(IReputation.NotEscrow.selector);
        reputation.onTimedOut(payerA, payee);

        vm.expectRevert(IReputation.NotEscrow.selector);
        reputation.onDisputed(payerA, payee);

        vm.stopPrank();
    }

    /// The admin holds the curve, not the counters. A key that could write history could mint
    /// itself an unbounded cap.
    function test_theAdminCannotMoveACounterEither() public {
        vm.prank(admin);
        vm.expectRevert(IReputation.NotEscrow.selector);
        reputation.onReleased(payerA, payee);
    }

    function test_setEscrowIsDeployerOnly() public {
        Reputation fresh = _freshReputation();

        vm.prank(stranger);
        vm.expectRevert(IReputation.NotDeployer.selector);
        fresh.setEscrow(address(0xE5C0));
    }

    function test_setEscrowRejectsTheZeroAddress() public {
        Reputation fresh = _freshReputation();

        vm.expectRevert(IReputation.ZeroAddress.selector);
        fresh.setEscrow(address(0));
    }

    function test_setEscrowIsOneShot() public {
        Reputation fresh = _freshReputation();

        vm.expectEmit(true, false, false, false, address(fresh));
        emit EscrowSet(address(0xE5C0));
        fresh.setEscrow(address(0xE5C0));

        assertEq(fresh.escrow(), address(0xE5C0));

        vm.expectRevert(IReputation.AlreadySet.selector);
        fresh.setEscrow(address(0xBEEF));
    }

    function test_setCurveIsAdminOnly() public {
        vm.prank(stranger);
        vm.expectRevert(IReputation.NotAdmin.selector);
        reputation.setCurve(IReputation.CapCurve({baseCap: 1, capPerScore: 1, maxCap: 2}));
    }

    function test_setCurveRejectsACeilingBelowTheFloor() public {
        vm.prank(admin);
        vm.expectRevert(IReputation.BadCurve.selector);
        reputation.setCurve(IReputation.CapCurve({baseCap: 500, capPerScore: 1, maxCap: 499}));
    }

    /// A curve change is retroactive: the cap is derived on read. A tightened policy binds the
    /// next lock, not only the next payee.
    function test_aNewCurveRepricesTheHistoryAlreadyRecorded() public {
        _release(reputation, payerA, payee);
        assertEq(reputation.capOf(payee), BASE_CAP + CAP_PER_SCORE * 100);

        vm.prank(admin);
        vm.expectEmit(false, false, false, true, address(reputation));
        emit CurveUpdated(10e6, 1e6, 50e6);
        reputation.setCurve(IReputation.CapCurve({baseCap: 10e6, capPerScore: 1e6, maxCap: 50e6}));

        assertEq(reputation.capOf(payee), 50e6);

        (uint128 baseCap, uint128 capPerScore, uint128 maxCap) = _curve(reputation);
        assertEq(baseCap, 10e6);
        assertEq(capPerScore, 1e6);
        assertEq(maxCap, 50e6);
    }

    function test_adminTransferNeedsBothSteps() public {
        address next = makeAddr("nextAdmin");

        vm.prank(stranger);
        vm.expectRevert(IReputation.NotAdmin.selector);
        reputation.transferAdmin(next);

        vm.prank(admin);
        vm.expectRevert(IReputation.ZeroAddress.selector);
        reputation.transferAdmin(address(0));

        vm.prank(admin);
        vm.expectEmit(true, true, false, false, address(reputation));
        emit AdminTransferStarted(admin, next);
        reputation.transferAdmin(next);

        assertEq(reputation.admin(), admin, "admin moves only on acceptance");
        assertEq(reputation.pendingAdmin(), next);

        vm.prank(stranger);
        vm.expectRevert(IReputation.NotPendingAdmin.selector);
        reputation.acceptAdmin();

        vm.prank(next);
        vm.expectEmit(true, true, false, false, address(reputation));
        emit AdminTransferred(admin, next);
        reputation.acceptAdmin();

        assertEq(reputation.admin(), next);
        assertEq(reputation.pendingAdmin(), address(0));

        vm.prank(admin);
        vm.expectRevert(IReputation.NotAdmin.selector);
        reputation.setCurve(IReputation.CapCurve({baseCap: 1, capPerScore: 1, maxCap: 2}));
    }

    function test_scoreMaxIsTheScaleTheCurveIsDenominatedIn() public view {
        assertEq(reputation.scoreMax(), 100);
    }

    function testFuzz_scoreNeverLeavesItsScale(uint8 released, uint8 timedOut, uint8 disputed) public {
        uint256 r = bound(released, 0, 8);
        uint256 t = bound(timedOut, 0, 8);
        uint256 d = bound(disputed, 0, 8);

        for (uint256 i = 0; i < r; ++i) {
            reputation.onReleased(payerA, payee);
        }
        for (uint256 i = 0; i < t; ++i) {
            reputation.onTimedOut(payerA, payee);
        }
        for (uint256 i = 0; i < d; ++i) {
            reputation.onDisputed(payerA, payee);
        }

        uint16 result = reputation.score(payee);
        assertLe(result, reputation.scoreMax());

        uint256 settled = r + t + d;
        assertEq(result, settled == 0 ? 0 : (r * 100) / settled);
    }

    function testFuzz_capOfMatchesTheCurveFormula(
        uint128 baseCap,
        uint128 capPerScore,
        uint128 maxCap,
        uint8 released,
        uint8 failures
    ) public {
        uint128 floorCap = uint128(bound(baseCap, 0, type(uint128).max / 2));
        uint128 ceilingCap = uint128(bound(maxCap, floorCap == 0 ? 1 : floorCap, type(uint128).max));
        uint128 slope = uint128(bound(capPerScore, 0, type(uint128).max));

        vm.prank(admin);
        reputation.setCurve(IReputation.CapCurve({baseCap: floorCap, capPerScore: slope, maxCap: ceilingCap}));

        uint256 r = bound(released, 0, 6);
        uint256 f = bound(failures, 0, 6);
        for (uint256 i = 0; i < r; ++i) {
            reputation.onReleased(payerA, payee);
        }
        for (uint256 i = 0; i < f; ++i) {
            reputation.onTimedOut(payerA, payee);
        }

        uint256 expectedScore = (r + f) == 0 ? 0 : (r * 100) / (r + f);
        uint256 expectedCap = uint256(floorCap) + uint256(slope) * expectedScore;
        if (expectedCap > ceilingCap) expectedCap = ceilingCap;

        // `expectedCap` is clamped to `ceilingCap`, itself a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reputation.capOf(payee), uint128(expectedCap));
        assertGe(reputation.capOf(payee), floorCap > ceilingCap ? ceilingCap : floorCap);
        assertLe(reputation.capOf(payee), ceilingCap);
    }

    function _freshReputation() private returns (Reputation) {
        return
            new Reputation(
                admin, IReputation.CapCurve({baseCap: BASE_CAP, capPerScore: CAP_PER_SCORE, maxCap: MAX_CAP})
            );
    }

    function _release(Reputation target, address payer, address to) private {
        target.onReleased(payer, to);
    }

    function _curve(Reputation target) private view returns (uint128, uint128, uint128) {
        IReputation.CapCurve memory c = target.curve();
        return (c.baseCap, c.capPerScore, c.maxCap);
    }
}

/// One lock, one counter. Every way a lock can end is walked against a live escrow to prove
/// the payee's history moves exactly once and that the cap the escrow reads is the cap this
/// contract publishes.
contract ReputationEscrowCountingTest is Test {
    uint16 internal constant FEE_BPS = 100;
    uint64 internal constant MIN_TTL = 1 hours;
    uint64 internal constant MAX_TTL = 30 days;
    uint64 internal constant DISPUTE_WINDOW = 2 days;
    uint64 internal constant DISPUTE_TIMEOUT = 5 days;

    uint128 internal constant LOCK_AMOUNT = 100e6;

    MockUsdg internal asset;
    Reputation internal reputation;
    Escrow internal escrow;
    RepRegResolverStub internal resolverStub;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");

    function setUp() public {
        vm.warp(1_700_000_000);

        asset = new MockUsdg();
        reputation = new Reputation(admin, IReputation.CapCurve({baseCap: 1_000e6, capPerScore: 10e6, maxCap: 2_000e6}));
        escrow = new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            0,
            0,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            DISPUTE_TIMEOUT
        );
        reputation.setEscrow(address(escrow));

        resolverStub = new RepRegResolverStub();
        escrow.setResolver(address(resolverStub));

        asset.mint(payer, 5_000_000e6);
        vm.prank(payer);
        asset.approve(address(escrow), type(uint256).max);
    }

    function test_aReleaseIsNotHistoryUntilTheDisputeWindowCloses() public {
        uint256 id = _lock(LOCK_AMOUNT);

        vm.prank(payee);
        escrow.release(id, keccak256("out"), "ipfs://out");

        assertEq(_total(), 0, "the window is still open");

        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.expectRevert(IEscrow.TooEarly.selector);
        escrow.finalizeRelease(id);

        vm.warp(block.timestamp + 1);
        escrow.finalizeRelease(id);

        (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 1);
        assertEq(timedOut, 0);
        assertEq(disputed, 0);

        (uint64 edgeReleased,,) = reputation.edges(payer, payee);
        assertEq(edgeReleased, 1);
    }

    function test_finalizingAReleaseTwiceCannotCountItTwice() public {
        uint256 id = _lock(LOCK_AMOUNT);

        vm.prank(payee);
        escrow.release(id, keccak256("out"), "ipfs://out");

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        escrow.finalizeRelease(id);

        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.finalizeRelease(id);

        assertEq(_total(), 1);
    }

    /// With no window there is nothing to wait for, so the release is history in the same
    /// transaction and there is no second call that could add to it.
    function test_aZeroWindowCountsTheReleaseInline() public {
        (Reputation inlineReputation, Escrow inlineEscrow) = _deployWithWindow(0);

        asset.mint(payer, 1_000e6);
        vm.startPrank(payer);
        asset.approve(address(inlineEscrow), type(uint256).max);
        uint256 id = inlineEscrow.lock(
            payee, keccak256("cap"), keccak256("in"), "ipfs://in", LOCK_AMOUNT, uint64(block.timestamp + 1 days)
        );
        vm.stopPrank();

        vm.prank(payee);
        inlineEscrow.release(id, keccak256("out"), "ipfs://out");

        (uint64 released,,) = inlineReputation.payeeStats(payee);
        assertEq(released, 1);

        vm.expectRevert(IEscrow.BadStatus.selector);
        inlineEscrow.finalizeRelease(id);
    }

    /// A payer that contests inside the window turns the outcome into a dispute. The payee
    /// must not end the job carrying both a release and a dispute for the one lock.
    function test_aDisputeInsideTheWindowReplacesTheReleaseInTheHistory() public {
        uint256 id = _lock(LOCK_AMOUNT);

        vm.prank(payee);
        escrow.release(id, keccak256("out"), "ipfs://out");

        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.prank(payer);
        escrow.dispute(id);

        (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 0);
        assertEq(timedOut, 0);
        assertEq(disputed, 1);

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.finalizeRelease(id);

        assertEq(_total(), 1);
    }

    function test_aTimeoutCountsOnceAgainstThePayee() public {
        uint256 id = _lock(LOCK_AMOUNT);

        vm.warp(block.timestamp + 1 days + 1);
        escrow.timeout(id);

        (uint64 released, uint64 timedOut,) = reputation.payeeStats(payee);
        assertEq(released, 0);
        assertEq(timedOut, 1);

        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.timeout(id);

        assertEq(_total(), 1);
    }

    /// Declining early is not a failure to deliver. Counting it would push payees to sit on a
    /// job they cannot do until the deadline refunds it.
    function test_aCancellationCountsNothing() public {
        uint256 id = _lock(LOCK_AMOUNT);

        vm.prank(payee);
        escrow.cancel(id);

        assertEq(_total(), 0);
    }

    function test_aRulingThatRefundsNothingCountsAsARelease() public {
        uint256 id = _lock(LOCK_AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);
        assertEq(_total(), 0, "an open dispute is not yet an outcome");

        vm.prank(address(resolverStub));
        escrow.resolve(id, 0, 1);

        (uint64 released,, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 1);
        assertEq(disputed, 0);
    }

    function test_aRulingThatRefundsAnythingCountsAsADispute() public {
        uint256 id = _lock(LOCK_AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);

        vm.prank(address(resolverStub));
        escrow.resolve(id, 1, 1);

        (uint64 released,, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 0);
        assertEq(disputed, 1);
    }

    function test_anUnheardDisputeStillCountsOnce() public {
        uint256 id = _lock(LOCK_AMOUNT);

        vm.prank(payee);
        escrow.dispute(id);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);
        escrow.disputeTimeout(id);

        (,, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(disputed, 1);
        assertEq(_total(), 1);
    }

    function test_theCapGatesTheLockAtItsExactBoundary() public {
        vm.prank(admin);
        reputation.setCurve(IReputation.CapCurve({baseCap: 100e6, capPerScore: 5e6, maxCap: 1_000e6}));

        assertEq(reputation.capOf(payee), 100e6);

        vm.prank(payer);
        vm.expectRevert(IEscrow.PayeeCapExceeded.selector);
        escrow.lock(payee, keccak256("cap"), keccak256("in"), "ipfs://in", 100e6 + 1, uint64(block.timestamp + 1 days));

        _lock(100e6);
    }

    /// The cap is the product of the history, so it moves in both directions: settled work
    /// raises it and a timeout takes the headroom back.
    function test_theCapGrowsWithSettledWorkAndFallsBackOnAFailure() public {
        vm.prank(admin);
        reputation.setCurve(IReputation.CapCurve({baseCap: 100e6, capPerScore: 5e6, maxCap: 1_000e6}));

        uint256 first = _lock(100e6);
        vm.prank(payee);
        escrow.release(first, keccak256("out"), "ipfs://out");
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        escrow.finalizeRelease(first);

        assertEq(reputation.capOf(payee), 600e6, "a perfect payee reaches the top of the curve");

        vm.prank(payer);
        vm.expectRevert(IEscrow.PayeeCapExceeded.selector);
        escrow.lock(payee, keccak256("cap"), keccak256("in"), "ipfs://in", 600e6 + 1, uint64(block.timestamp + 1 days));

        uint256 second = _lock(600e6);
        vm.warp(block.timestamp + 1 days + 1);
        escrow.timeout(second);

        assertEq(reputation.score(payee), 50);
        assertEq(reputation.capOf(payee), 350e6, "one failure in two halves the headroom");
    }

    /// Every terminal path, walked one at a time. Cancellation is the only one that leaves the
    /// payee's history untouched; everything else moves exactly one counter, and the edge
    /// ledger agrees with the aggregate.
    function testFuzz_oneLockMovesTheCountersExactlyOnce(uint8 pathSeed) public {
        uint256 path = pathSeed % 7;
        uint256 id = _lock(LOCK_AMOUNT);

        if (path == 0) {
            vm.prank(payee);
            escrow.release(id, keccak256("out"), "ipfs://out");
            vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
            escrow.finalizeRelease(id);
        } else if (path == 1) {
            vm.warp(block.timestamp + 1 days + 1);
            escrow.timeout(id);
        } else if (path == 2) {
            vm.prank(payee);
            escrow.cancel(id);
        } else if (path == 3) {
            vm.prank(payee);
            escrow.release(id, keccak256("out"), "ipfs://out");
            vm.prank(payer);
            escrow.dispute(id);
        } else if (path == 4) {
            vm.prank(payer);
            escrow.dispute(id);
            vm.prank(address(resolverStub));
            escrow.resolve(id, 0, 1);
        } else if (path == 5) {
            vm.prank(payer);
            escrow.dispute(id);
            vm.prank(address(resolverStub));
            escrow.resolve(id, 10_000, 1);
        } else {
            vm.prank(payer);
            escrow.dispute(id);
            vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);
            escrow.disputeTimeout(id);
        }

        uint256 expected = path == 2 ? 0 : 1;
        assertEq(_total(), expected);

        (uint64 edgeReleased, uint64 edgeTimedOut, uint64 edgeDisputed) = reputation.edges(payer, payee);
        assertEq(uint256(edgeReleased) + edgeTimedOut + edgeDisputed, expected, "the edge tracks the aggregate");
    }

    function _lock(uint128 amount) private returns (uint256 id) {
        vm.prank(payer);
        id = escrow.lock(
            payee, keccak256("cap"), keccak256("in"), "ipfs://in", amount, uint64(block.timestamp + 1 days)
        );
    }

    function _total() private view returns (uint256) {
        (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payee);
        return uint256(released) + timedOut + disputed;
    }

    function _deployWithWindow(uint64 window) private returns (Reputation, Escrow) {
        Reputation freshReputation =
            new Reputation(admin, IReputation.CapCurve({baseCap: 1_000e6, capPerScore: 10e6, maxCap: 2_000e6}));
        Escrow freshEscrow = new Escrow(
            address(asset), address(freshReputation), treasury, FEE_BPS, 0, 0, MIN_TTL, MAX_TTL, window, DISPUTE_TIMEOUT
        );
        freshReputation.setEscrow(address(freshEscrow));
        return (freshReputation, freshEscrow);
    }
}

/// Registration, collateral, rulings and the exit queue.
contract AgentRegistryTest is Test {
    event AgentRegistered(address indexed agent, string name, uint128 stake);
    event AgentDeactivated(address indexed agent);
    event AgentReactivated(address indexed agent);
    event WithdrawalRequested(address indexed agent, uint128 amount, uint64 maturesAt);
    event WithdrawalReduced(address indexed agent, uint128 amount);
    event WithdrawalCancelled(address indexed agent);
    event StakeWithdrawn(address indexed agent, uint128 amount, uint128 stake);
    event AgentSlashed(address indexed agent, uint128 amount, uint128 stake, bytes32 reason);
    event AgentBlacklisted(address indexed agent);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    uint128 internal constant MIN_STAKE = 100e6;
    uint16 internal constant SLASH_BPS = 1_000;

    DualViewERC20 internal asset;
    AgentRegistry internal registry;

    address internal admin = makeAddr("registryAdmin");
    address internal slasher = makeAddr("slasher");
    address internal sink = makeAddr("slashSink");
    address internal agentA = makeAddr("agentA");
    address internal agentB = makeAddr("agentB");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_700_000_000);

        asset = new DualViewERC20();
        registry = new AgentRegistry(IERC20(address(asset)), admin, sink, MIN_STAKE, SLASH_BPS);

        vm.prank(admin);
        registry.setSlasher(slasher);

        _fund(agentA);
        _fund(agentB);
    }

    function test_constructorRejectsAZeroAddressInAnySlot() public {
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        new AgentRegistry(IERC20(address(0)), admin, sink, MIN_STAKE, SLASH_BPS);

        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        new AgentRegistry(IERC20(address(asset)), address(0), sink, MIN_STAKE, SLASH_BPS);

        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        new AgentRegistry(IERC20(address(asset)), admin, address(0), MIN_STAKE, SLASH_BPS);
    }

    function test_constructorRejectsAZeroFloorOrARateOffTheScale() public {
        vm.expectRevert(AgentRegistry.BadConfig.selector);
        new AgentRegistry(IERC20(address(asset)), admin, sink, 0, SLASH_BPS);

        vm.expectRevert(AgentRegistry.BadConfig.selector);
        new AgentRegistry(IERC20(address(asset)), admin, sink, MIN_STAKE, 0);

        vm.expectRevert(AgentRegistry.BadConfig.selector);
        new AgentRegistry(IERC20(address(asset)), admin, sink, MIN_STAKE, 5_001);

        AgentRegistry atTheCeiling = new AgentRegistry(IERC20(address(asset)), admin, sink, MIN_STAKE, 5_000);
        assertEq(atTheCeiling.slashBps(), atTheCeiling.MAX_SLASH_BPS());
    }

    /// A settlement asset that publishes the same balance again, scaled up by 1e12.
    /// The stake ledger has to read the six-decimal view and only that one.
    function test_stakeIsPulledOverTheSixDecimalViewAndCountedOnce() public {
        uint256 balanceBefore = asset.balanceOf(agentA);

        vm.expectEmit(true, false, false, true, address(registry));
        emit AgentRegistered(agentA, "agent_one", 250e6);
        _register(agentA, 250e6);

        assertEq(asset.balanceOf(agentA), balanceBefore - 250e6);
        assertEq(asset.balanceOf(address(registry)), 250e6);
        assertEq(registry.totalStaked(), 250e6);
        assertEq(registry.stakeOf(agentA), 250e6);
        assertEq(registry.unaccounted(), 0);

        // The other view of the same money, which nothing in the ledger is allowed to add in.
        assertEq(asset.nativeBalanceOf(address(registry)), 250e6 * asset.NATIVE_DECIMAL_SCALE());
        assertTrue(registry.stakeOf(agentA) != asset.nativeBalanceOf(address(registry)));
    }

    function test_registrationRecordsTheAgentAndListsIt() public {
        _register(agentA, MIN_STAKE);

        AgentRegistry.Agent memory entry = registry.getAgent(agentA);
        assertEq(entry.name, "agent_one");
        assertEq(entry.stake, MIN_STAKE);
        assertEq(entry.registeredAt, uint64(block.timestamp));
        assertTrue(entry.active);

        assertTrue(registry.isRegistered(agentA));
        assertTrue(registry.isActive(agentA));
        assertEq(registry.totalAgents(), 1);
    }

    function test_registrationAdmitsTheFloorAndRefusesOneUnitUnderIt() public {
        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.InsufficientStake.selector);
        registry.register("agent_one", MIN_STAKE - 1);

        _register(agentA, MIN_STAKE);
        assertEq(registry.stakeOf(agentA), MIN_STAKE);
    }

    function test_anAddressCannotRegisterTwice() public {
        _register(agentA, MIN_STAKE);

        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.AlreadyRegistered.selector);
        registry.register("agent_two", MIN_STAKE);
    }

    function test_nameLengthIsBoundedOnBothSides() public {
        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.InvalidName.selector);
        registry.register(_repeat(2), MIN_STAKE);

        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.InvalidName.selector);
        registry.register(_repeat(33), MIN_STAKE);

        vm.prank(agentA);
        registry.register(_repeat(3), MIN_STAKE);

        vm.prank(agentB);
        registry.register(_repeat(32), MIN_STAKE);

        assertEq(registry.totalAgents(), 2);
    }

    /// A handle carrying a right-to-left override or a zero-width space renders as another
    /// agent's name, so the character set is narrowed to what a principal can read literally.
    function test_nameRejectsAnythingOutsideAsciiAlphanumericsAndUnderscore() public {
        string[4] memory rejected = ["bad name", "bad-name", "bad.name", "bad/name"];

        for (uint256 i = 0; i < rejected.length; ++i) {
            vm.prank(agentA);
            vm.expectRevert(AgentRegistry.InvalidName.selector);
            registry.register(rejected[i], MIN_STAKE);
        }

        // U+202E, the right-to-left override, written as its raw UTF-8 bytes.
        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.InvalidName.selector);
        registry.register(string(abi.encodePacked("agent", hex"E280AE", "eman")), MIN_STAKE);

        // U+200B, a zero-width space, which renders as nothing at all.
        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.InvalidName.selector);
        registry.register(string(abi.encodePacked("agent", hex"E2808B", "one")), MIN_STAKE);

        vm.prank(agentA);
        registry.register("Agent_09", MIN_STAKE);
        assertTrue(registry.isRegistered(agentA));
    }

    function test_pauseStopsNewExposureButNotAMaturedExit() public {
        _register(agentA, 300e6);

        vm.prank(agentA);
        registry.requestWithdrawal(200e6);

        vm.prank(admin);
        registry.pause();

        vm.prank(agentB);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.register("agent_two", MIN_STAKE);

        vm.prank(agentA);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.addStake(10e6);

        vm.warp(block.timestamp + registry.WITHDRAWAL_DELAY());
        vm.prank(agentA);
        registry.executeWithdrawal();

        assertEq(registry.stakeOf(agentA), 100e6);
    }

    function test_pauseAndUnpauseAreAdminOnly() public {
        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.pause();

        vm.prank(admin);
        registry.pause();

        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.unpause();

        vm.prank(admin);
        registry.unpause();
        assertFalse(registry.paused());
    }

    function test_addStakeCancelsAPendingExit() public {
        _register(agentA, 300e6);

        vm.prank(agentA);
        registry.requestWithdrawal(200e6);
        (uint128 pending,) = registry.withdrawals(agentA);
        assertEq(pending, 200e6);

        vm.prank(agentA);
        vm.expectEmit(true, false, false, false, address(registry));
        emit WithdrawalCancelled(agentA);
        registry.addStake(50e6);

        (uint128 afterTopUp,) = registry.withdrawals(agentA);
        assertEq(afterTopUp, 0);
        assertEq(registry.stakeOf(agentA), 350e6);
        assertEq(registry.withdrawalMaturity(agentA), 0);
    }

    function test_addStakeRejectsZeroAndUnknownCallers() public {
        _register(agentA, MIN_STAKE);

        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.ZeroAmount.selector);
        registry.addStake(0);

        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotRegistered.selector);
        registry.addStake(10e6);
    }

    function test_anActiveAgentMustLeaveTheFloorBehind() public {
        _register(agentA, 300e6);

        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.InsufficientStake.selector);
        registry.requestWithdrawal(201e6);

        uint64 maturity = uint64(block.timestamp) + registry.WITHDRAWAL_DELAY();

        vm.prank(agentA);
        vm.expectEmit(true, false, false, true, address(registry));
        emit WithdrawalRequested(agentA, 200e6, maturity);
        registry.requestWithdrawal(200e6);
    }

    /// Leaving in full is a deregistration, and the way to ask for one is to stand down first.
    function test_aDeactivatedAgentMayAskForTheWholeStake() public {
        _register(agentA, 300e6);

        vm.startPrank(agentA);
        registry.deactivate();
        registry.requestWithdrawal(300e6);
        vm.stopPrank();

        (uint128 pending,) = registry.withdrawals(agentA);
        assertEq(pending, 300e6);
    }

    function test_aWithdrawalCannotBeTakenBeforeTheDelayMatures() public {
        _register(agentA, 300e6);

        vm.prank(agentA);
        registry.requestWithdrawal(200e6);
        uint64 maturity = registry.withdrawalMaturity(agentA);

        vm.warp(maturity - 1);
        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.WithdrawalNotMatured.selector);
        registry.executeWithdrawal();

        vm.warp(maturity);
        uint256 balanceBefore = asset.balanceOf(agentA);
        vm.prank(agentA);
        vm.expectEmit(true, false, false, true, address(registry));
        emit StakeWithdrawn(agentA, 200e6, 100e6);
        registry.executeWithdrawal();

        assertEq(asset.balanceOf(agentA), balanceBefore + 200e6);
        assertEq(registry.totalStaked(), 100e6);
    }

    function test_onlyOneExitRequestCanBeOpenAtATime() public {
        _register(agentA, 300e6);

        vm.startPrank(agentA);
        registry.requestWithdrawal(100e6);

        vm.expectRevert(AgentRegistry.WithdrawalPending.selector);
        registry.requestWithdrawal(50e6);

        registry.cancelWithdrawal();

        vm.expectRevert(AgentRegistry.WithdrawalNotRequested.selector);
        registry.cancelWithdrawal();

        vm.expectRevert(AgentRegistry.WithdrawalNotRequested.selector);
        registry.executeWithdrawal();
        vm.stopPrank();
    }

    function test_requestingMoreThanIsStakedReverts() public {
        _register(agentA, 300e6);

        vm.startPrank(agentA);
        registry.deactivate();
        vm.expectRevert(AgentRegistry.InsufficientStake.selector);
        registry.requestWithdrawal(300e6 + 1);
        vm.stopPrank();
    }

    /// The floor can move under a pending request. The exit still pays out, and the agent
    /// drops off the active list instead of sitting there underfunded.
    function test_anExitThatLandsBelowANewFloorDeactivatesTheAgent() public {
        _register(agentA, 300e6);

        vm.prank(agentA);
        registry.requestWithdrawal(200e6);

        vm.prank(admin);
        registry.setMinStake(250e6);

        vm.warp(block.timestamp + registry.WITHDRAWAL_DELAY());
        vm.prank(agentA);
        vm.expectEmit(true, false, false, false, address(registry));
        emit AgentDeactivated(agentA);
        registry.executeWithdrawal();

        assertFalse(registry.isActive(agentA));
        assertFalse(registry.getAgent(agentA).active);
    }

    function test_deactivationLeavesTheStakeSlashable() public {
        _register(agentA, 300e6);

        vm.prank(agentA);
        registry.deactivate();

        assertFalse(registry.isActive(agentA));
        assertEq(registry.stakeOf(agentA), 300e6, "standing down is not an exit");

        vm.prank(slasher);
        registry.slash(agentA, 30e6, "late");

        assertEq(registry.stakeOf(agentA), 270e6);
    }

    function test_deactivateAndReactivateGuardTheirOwnState() public {
        _register(agentA, MIN_STAKE);

        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.AlreadyActive.selector);
        registry.reactivate();

        vm.startPrank(agentA);
        registry.deactivate();

        vm.expectRevert(AgentRegistry.NotActive.selector);
        registry.deactivate();

        registry.reactivate();
        vm.stopPrank();

        assertTrue(registry.isActive(agentA));
    }

    function test_reactivationNeedsTheFloorBack() public {
        _register(agentA, 300e6);

        vm.startPrank(agentA);
        registry.deactivate();
        registry.requestWithdrawal(250e6);
        vm.warp(block.timestamp + registry.WITHDRAWAL_DELAY());
        registry.executeWithdrawal();

        vm.expectRevert(AgentRegistry.InsufficientStake.selector);
        registry.reactivate();

        registry.addStake(50e6);
        registry.reactivate();
        vm.stopPrank();

        assertTrue(registry.isActive(agentA));
    }

    function test_onlyTheSlasherOrTheAdminMayRule() public {
        _register(agentA, 300e6);

        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.slash(agentA, 10e6, "bad");

        vm.prank(slasher);
        registry.slash(agentA, 10e6, "bad");

        vm.prank(admin);
        registry.slash(agentA, 10e6, "bad");

        assertEq(registry.stakeOf(agentA), 280e6);
    }

    /// A resolver finalising a dispute cannot be left holding an unresolvable case because it
    /// asked for more than the ceiling. An oversized request is clamped, never refused.
    function test_aRulingIsClampedToTheCeilingRatherThanReverting() public {
        _register(agentA, 300e6);

        uint256 ceiling = registry.maxSlash(agentA);
        assertEq(ceiling, 30e6);

        vm.prank(slasher);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AgentSlashed(agentA, 30e6, 270e6, "undelivered");
        registry.slash(agentA, type(uint256).max, "undelivered");

        assertEq(registry.stakeOf(agentA), 270e6);
        assertEq(registry.totalStaked(), 270e6);
        assertEq(registry.totalSlashed(), 30e6);
        assertEq(asset.balanceOf(sink), 30e6);
    }

    function test_aRulingAtTheCeilingTakesExactlyTheCeiling() public {
        _register(agentA, 300e6);

        uint256 ceiling = registry.maxSlash(agentA);

        vm.prank(slasher);
        registry.slash(agentA, ceiling, "undelivered");

        assertEq(registry.stakeOf(agentA), 270e6);
    }

    function test_aRulingNeedsARegisteredCounterpartyAndANonZeroFigure() public {
        _register(agentA, 300e6);

        vm.prank(slasher);
        vm.expectRevert(AgentRegistry.NotRegistered.selector);
        registry.slash(stranger, 10e6, "bad");

        vm.prank(slasher);
        vm.expectRevert(AgentRegistry.ZeroAmount.selector);
        registry.slash(agentA, 0, "bad");
    }

    /// An agent that has already served the delay should not have to serve it again because a
    /// ruling landed in the meantime.
    function test_aRulingTrimsAPendingExitInsteadOfStrandingIt() public {
        vm.prank(admin);
        registry.setSlashBps(5_000);

        _register(agentA, 1_000e6);

        vm.startPrank(agentA);
        registry.deactivate();
        registry.requestWithdrawal(1_000e6);
        vm.stopPrank();

        vm.prank(slasher);
        vm.expectEmit(true, false, false, true, address(registry));
        emit WithdrawalReduced(agentA, 500e6);
        registry.slash(agentA, 500e6, "undelivered");

        (uint128 pending,) = registry.withdrawals(agentA);
        assertEq(pending, 500e6);

        vm.warp(block.timestamp + registry.WITHDRAWAL_DELAY());
        vm.prank(agentA);
        registry.executeWithdrawal();

        assertEq(registry.stakeOf(agentA), 0);
        assertEq(registry.totalStaked(), 0);
    }

    function test_aRulingThatDropsAnAgentUnderTheFloorDeactivatesIt() public {
        vm.prank(admin);
        registry.setSlashBps(5_000);

        _register(agentA, 150e6);

        vm.prank(slasher);
        vm.expectEmit(true, false, false, false, address(registry));
        emit AgentDeactivated(agentA);
        registry.slash(agentA, 75e6, "undelivered");

        assertEq(registry.stakeOf(agentA), 75e6);
        assertFalse(registry.isActive(agentA));
    }

    /// The record is what a principal reads. An agent stripped to nothing still gets the
    /// ruling written against it, with a take of zero and no transfer.
    function test_aRulingAgainstAStrippedAgentStillRecordsTheOutcome() public {
        _register(agentA, 300e6);

        vm.startPrank(agentA);
        registry.deactivate();
        registry.requestWithdrawal(300e6);
        vm.warp(block.timestamp + registry.WITHDRAWAL_DELAY());
        registry.executeWithdrawal();
        vm.stopPrank();

        assertEq(registry.stakeOf(agentA), 0);

        vm.prank(slasher);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AgentSlashed(agentA, 0, 0, "undelivered");
        registry.slash(agentA, 10e6, "undelivered");

        assertEq(asset.balanceOf(sink), 0);
        assertEq(registry.totalSlashed(), 0);
    }

    function test_aRulingNeverReachesAnotherAgentsCollateral() public {
        _register(agentA, 300e6);
        _register(agentB, 500e6);

        vm.prank(slasher);
        registry.slash(agentA, type(uint256).max, "undelivered");

        assertEq(registry.stakeOf(agentB), 500e6);
        assertEq(registry.totalStaked(), 270e6 + 500e6);
        assertEq(asset.balanceOf(address(registry)), registry.totalStaked());
    }

    function test_theReasonTagIsCarriedIntoTheRecordVerbatim() public {
        _register(agentA, 300e6);
        bytes32 reason = keccak256("dispute:4421:undelivered");

        vm.prank(slasher);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AgentSlashed(agentA, 10e6, 290e6, reason);
        registry.slash(agentA, 10e6, reason);
    }

    function test_isActiveIsFalseForEveryWayAnAgentCanBeUnavailable() public {
        assertFalse(registry.isActive(stranger), "unregistered");

        _register(agentA, 300e6);
        assertTrue(registry.isActive(agentA));

        vm.prank(agentA);
        registry.deactivate();
        assertFalse(registry.isActive(agentA), "stood down");

        vm.prank(agentA);
        registry.reactivate();

        vm.prank(admin);
        registry.setMinStake(400e6);
        assertFalse(registry.isActive(agentA), "under the floor");

        vm.prank(admin);
        registry.setMinStake(MIN_STAKE);
        assertTrue(registry.isActive(agentA));

        _flag(agentA, agentB);
        assertFalse(registry.isActive(agentA), "barred");
    }

    function test_flaggingABarredAddressNeedsARootAndAProof() public {
        _register(agentA, 300e6);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = registry.agentLeaf(agentB);

        vm.expectRevert(AgentRegistry.RootNotSet.selector);
        registry.flagBlacklisted(agentA, proof);

        bytes32 root = _root(agentA, agentB);
        vm.prank(admin);
        registry.setBlacklistRoot(root);

        bytes32[] memory wrongProof = new bytes32[](1);
        wrongProof[0] = registry.agentLeaf(stranger);

        vm.expectRevert(AgentRegistry.BadProof.selector);
        registry.flagBlacklisted(agentA, wrongProof);

        // Permissionless: the root is the admin's statement and anyone may hold the registry
        // to it.
        vm.prank(stranger);
        vm.expectEmit(true, false, false, false, address(registry));
        emit AgentBlacklisted(agentA);
        registry.flagBlacklisted(agentA, proof);

        assertTrue(registry.isBlacklisted(agentA));
        assertFalse(registry.isActive(agentA));
        assertFalse(registry.getAgent(agentA).active);

        vm.expectRevert(AgentRegistry.IsBlacklisted.selector);
        registry.flagBlacklisted(agentA, proof);
    }

    function test_aBarredAddressCanNeitherRegisterNorReturn() public {
        _register(agentA, 300e6);
        _flag(agentA, agentB);

        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.IsBlacklisted.selector);
        registry.reactivate();

        vm.prank(agentA);
        vm.expectRevert(AgentRegistry.IsBlacklisted.selector);
        registry.addStake(10e6);

        // Flagging works on addresses that never registered, which is what stops a barred
        // party signing up a moment later.
        bytes32 root = _root(stranger, agentB);
        vm.prank(admin);
        registry.setBlacklistRoot(root);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = registry.agentLeaf(agentB);
        registry.flagBlacklisted(stranger, proof);

        _fund(stranger);
        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.IsBlacklisted.selector);
        registry.register("agent_new", MIN_STAKE);
    }

    /// A barred agent keeps its collateral where a ruling can still reach it.
    function test_barringAnAgentDoesNotTouchItsCollateral() public {
        _register(agentA, 300e6);
        _flag(agentA, agentB);

        assertEq(registry.stakeOf(agentA), 300e6);

        vm.prank(slasher);
        registry.slash(agentA, 30e6, "barred");
        assertEq(registry.stakeOf(agentA), 270e6);
    }

    function test_clearingTheFlagIsAdminOnlyAndDoesNotReactivate() public {
        _register(agentA, 300e6);
        _flag(agentA, agentB);

        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.clearBlacklist(agentA);

        vm.prank(admin);
        registry.clearBlacklist(agentA);

        assertFalse(registry.isBlacklisted(agentA));
        assertFalse(registry.isActive(agentA), "clearing the flag is not a reinstatement");

        vm.prank(admin);
        vm.expectRevert(AgentRegistry.NotBlacklisted.selector);
        registry.clearBlacklist(agentA);

        // The root still carries the address, so anyone can put the flag straight back.
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = registry.agentLeaf(agentB);
        registry.flagBlacklisted(agentA, proof);
        assertTrue(registry.isBlacklisted(agentA));
    }

    function test_aZeroRootDisablesTheGateRatherThanBarringEveryone() public {
        _register(agentA, 300e6);

        vm.prank(admin);
        registry.setBlacklistRoot(bytes32(0));

        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(AgentRegistry.RootNotSet.selector);
        registry.flagBlacklisted(agentA, proof);

        assertTrue(registry.isActive(agentA));
    }

    function test_theLeafIsDoubleHashedSoAnInnerNodeCannotPassAsOne() public view {
        assertEq(registry.agentLeaf(agentA), keccak256(bytes.concat(keccak256(abi.encode(agentA)))));
    }

    function test_configurationSettersAreAdminOnlyAndRejectNonsense() public {
        vm.startPrank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setMinStake(1);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setSlashBps(1);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setSlasher(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setSlashSink(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setBlacklistRoot(bytes32(uint256(1)));
        vm.stopPrank();

        vm.startPrank(admin);
        vm.expectRevert(AgentRegistry.BadConfig.selector);
        registry.setMinStake(0);

        vm.expectRevert(AgentRegistry.BadConfig.selector);
        registry.setSlashBps(0);

        vm.expectRevert(AgentRegistry.BadConfig.selector);
        registry.setSlashBps(5_001);

        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setSlasher(address(0));

        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setSlashSink(address(0));

        registry.setSlashBps(5_000);
        registry.setSlashSink(stranger);
        vm.stopPrank();

        assertEq(registry.slashBps(), 5_000);
        assertEq(registry.slashSink(), stranger);
    }

    /// Raising the floor binds the next registration and any partial exit. It does not
    /// deregister anyone already listed.
    function test_raisingTheFloorDoesNotDeregisterAnyone() public {
        _register(agentA, 300e6);

        vm.prank(admin);
        registry.setMinStake(500e6);

        assertTrue(registry.isRegistered(agentA));
        assertFalse(registry.isActive(agentA));

        vm.prank(agentB);
        vm.expectRevert(AgentRegistry.InsufficientStake.selector);
        registry.register("agent_two", 400e6);

        vm.startPrank(agentA);
        registry.deactivate();
        registry.requestWithdrawal(300e6);
        vm.stopPrank();

        (uint128 pending,) = registry.withdrawals(agentA);
        assertEq(pending, 300e6, "a full exit stays open to an underfunded agent");
    }

    function test_adminTransferNeedsBothSteps() public {
        address next = makeAddr("nextRegistryAdmin");

        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.transferAdmin(next);

        vm.prank(admin);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.transferAdmin(address(0));

        vm.prank(admin);
        vm.expectEmit(true, true, false, false, address(registry));
        emit AdminTransferStarted(admin, next);
        registry.transferAdmin(next);

        assertEq(registry.admin(), admin);
        assertEq(registry.pendingAdmin(), next);

        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.acceptAdmin();

        vm.prank(next);
        vm.expectEmit(true, true, false, false, address(registry));
        emit AdminTransferred(admin, next);
        registry.acceptAdmin();

        assertEq(registry.admin(), next);
        assertEq(registry.pendingAdmin(), address(0));

        vm.prank(admin);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setMinStake(1);
    }

    function test_sweepCannotReachStakedCollateral() public {
        _register(agentA, 300e6);
        asset.mint(address(registry), 50e6);

        assertEq(registry.unaccounted(), 50e6);

        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.sweep(address(asset), stranger, 1);

        vm.startPrank(admin);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.sweep(address(asset), address(0), 1);

        vm.expectRevert(AgentRegistry.ZeroAmount.selector);
        registry.sweep(address(asset), admin, 0);

        vm.expectRevert(AgentRegistry.InsufficientStake.selector);
        registry.sweep(address(asset), admin, 50e6 + 1);

        registry.sweep(address(asset), admin, 50e6);
        vm.stopPrank();

        assertEq(asset.balanceOf(admin), 50e6);
        assertEq(asset.balanceOf(address(registry)), 300e6);
        assertEq(registry.unaccounted(), 0);
    }

    function test_sweepMovesAnUnrelatedTokenInFull() public {
        _register(agentA, 300e6);

        MockUsdg other = new MockUsdg();
        other.mint(address(registry), 12e6);

        vm.prank(admin);
        registry.sweep(address(other), admin, 12e6);

        assertEq(other.balanceOf(admin), 12e6);
    }

    /// `getAgents(0, type(uint256).max)` is how a caller asks for everything. It has to answer
    /// with the list instead of reverting on an arithmetic overflow.
    function test_getAgentsClampsAnUnboundedLimit() public {
        _register(agentA, MIN_STAKE);
        _register(agentB, MIN_STAKE);

        (address[] memory all, uint256 total) = registry.getAgents(0, type(uint256).max);
        assertEq(total, 2);
        assertEq(all.length, 2);
        assertEq(all[0], agentA);
        assertEq(all[1], agentB);

        (address[] memory tail, uint256 tailTotal) = registry.getAgents(1, type(uint256).max);
        assertEq(tailTotal, 2);
        assertEq(tail.length, 1);
        assertEq(tail[0], agentB);
    }

    function test_getAgentsAnswersEmptyPastTheEndAndForAZeroLimit() public {
        _register(agentA, MIN_STAKE);

        (address[] memory pastTheEnd, uint256 total) = registry.getAgents(1, 10);
        assertEq(pastTheEnd.length, 0);
        assertEq(total, 1);

        (address[] memory none, uint256 sameTotal) = registry.getAgents(0, 0);
        assertEq(none.length, 0);
        assertEq(sameTotal, 1);

        (address[] memory wayPast, uint256 stillTotal) = registry.getAgents(type(uint256).max, type(uint256).max);
        assertEq(wayPast.length, 0);
        assertEq(stillTotal, 1);
    }

    function testFuzz_aRulingNeverTakesMoreThanTheCeiling(uint128 stake, uint256 requested, uint16 rate) public {
        uint128 posted = uint128(bound(stake, MIN_STAKE, 1_000_000e6));
        uint16 bps = uint16(bound(rate, 1, registry.MAX_SLASH_BPS()));

        vm.prank(admin);
        registry.setSlashBps(bps);

        asset.mint(agentA, posted);
        vm.startPrank(agentA);
        asset.approve(address(registry), type(uint256).max);
        registry.register("agent_one", posted);
        vm.stopPrank();

        uint256 ceiling = registry.maxSlash(agentA);
        uint256 amount = bound(requested, 1, type(uint256).max);

        vm.prank(slasher);
        registry.slash(agentA, amount, "fuzz");

        uint256 taken = posted - registry.stakeOf(agentA);
        assertLe(taken, ceiling);
        assertEq(taken, amount < ceiling ? amount : ceiling);
        assertEq(asset.balanceOf(sink), taken);
        assertEq(asset.balanceOf(address(registry)), registry.totalStaked());
    }

    function testFuzz_stakeAccountingSurvivesAnyOrderOfTopUpsAndExits(uint128 first, uint128 second, uint128 exit)
        public
    {
        uint128 opening = uint128(bound(first, MIN_STAKE, 100_000e6));
        uint128 topUp = uint128(bound(second, 1, 100_000e6));

        asset.mint(agentA, uint256(opening) + topUp);
        vm.startPrank(agentA);
        asset.approve(address(registry), type(uint256).max);
        registry.register("agent_one", opening);
        registry.addStake(topUp);

        uint128 staked = opening + topUp;
        assertEq(registry.stakeOf(agentA), staked);
        assertEq(registry.totalStaked(), staked);

        uint128 requested = uint128(bound(exit, 1, staked - MIN_STAKE == 0 ? 1 : staked - MIN_STAKE));
        registry.requestWithdrawal(requested);
        vm.warp(block.timestamp + registry.WITHDRAWAL_DELAY());
        registry.executeWithdrawal();
        vm.stopPrank();

        assertEq(registry.stakeOf(agentA), staked - requested);
        assertEq(registry.totalStaked(), registry.stakeOf(agentA));
        assertEq(asset.balanceOf(address(registry)), registry.totalStaked());
        assertEq(registry.unaccounted(), 0);
    }

    function _fund(address who) private {
        asset.mint(who, 2_000_000e6);
        vm.prank(who);
        asset.approve(address(registry), type(uint256).max);
    }

    function _register(address who, uint128 stake) private {
        vm.prank(who);
        registry.register(who == agentA ? "agent_one" : "agent_two", stake);
    }

    /// Two-leaf tree, so the proof carries a sibling and is not trivially empty.
    function _root(address left, address right) private view returns (bytes32) {
        bytes32 a = registry.agentLeaf(left);
        bytes32 b = registry.agentLeaf(right);
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _flag(address target, address sibling) private {
        bytes32 root = _root(target, sibling);
        vm.prank(admin);
        registry.setBlacklistRoot(root);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = registry.agentLeaf(sibling);
        registry.flagBlacklisted(target, proof);
    }

    function _repeat(uint256 length) private pure returns (string memory) {
        bytes memory raw = new bytes(length);
        for (uint256 i = 0; i < length; ++i) {
            raw[i] = "a";
        }
        return string(raw);
    }
}

/// Drives the registry through whatever order the fuzzer picks, so the ledger invariants are
/// checked against sequences a single test would never think to write.
contract RepRegRegistryHandler is CommonBase, StdCheats, StdUtils {
    // forge-lint: disable-start(screaming-snake-case-immutable)
    AgentRegistry public immutable registry;
    MockUsdg public immutable asset;

    address public immutable admin;
    address public immutable slasher;
    // forge-lint: disable-end

    address[] public actors;

    constructor(AgentRegistry registry_, MockUsdg asset_, address admin_, address slasher_) {
        registry = registry_;
        asset = asset_;
        admin = admin_;
        slasher = slasher_;

        for (uint256 i = 0; i < 4; ++i) {
            address actor = address(uint160(uint256(keccak256(abi.encodePacked("registry actor", i)))));
            actors.push(actor);
            asset_.mint(actor, 10_000_000e6);
            vm.prank(actor);
            asset_.approve(address(registry_), type(uint256).max);
        }
    }

    function register(uint256 actorSeed, uint128 stake) external {
        address actor = _actor(actorSeed);
        uint128 posted = uint128(bound(stake, registry.minStake(), 1_000_000e6));
        vm.prank(actor);
        try registry.register("agent_fuzz", posted) {} catch {}
    }

    function addStake(uint256 actorSeed, uint128 amount) external {
        address actor = _actor(actorSeed);
        uint128 topUp = uint128(bound(amount, 1, 100_000e6));
        vm.prank(actor);
        try registry.addStake(topUp) {} catch {}
    }

    function requestWithdrawal(uint256 actorSeed, uint128 amount) external {
        address actor = _actor(actorSeed);
        uint128 requested = uint128(bound(amount, 1, registry.stakeOf(actor) == 0 ? 1 : registry.stakeOf(actor)));
        vm.prank(actor);
        try registry.requestWithdrawal(requested) {} catch {}
    }

    function executeWithdrawal(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        vm.prank(actor);
        try registry.executeWithdrawal() {} catch {}
    }

    function cancelWithdrawal(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        vm.prank(actor);
        try registry.cancelWithdrawal() {} catch {}
    }

    function deactivate(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        vm.prank(actor);
        try registry.deactivate() {} catch {}
    }

    function reactivate(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        vm.prank(actor);
        try registry.reactivate() {} catch {}
    }

    function slash(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 figure = bound(amount, 1, 2_000_000e6);
        vm.prank(slasher);
        try registry.slash(actor, figure, "fuzz") {} catch {}
    }

    function setMinStake(uint128 amount) external {
        uint128 floorStake = uint128(bound(amount, 1, 500_000e6));
        vm.prank(admin);
        try registry.setMinStake(floorStake) {} catch {}
    }

    function passTime(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1 hours, 10 days));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }
}

contract AgentRegistryInvariants is Test {
    DualViewERC20 internal asset;
    AgentRegistry internal registry;
    RepRegRegistryHandler internal handler;

    address internal admin = makeAddr("invariantAdmin");
    address internal slasher = makeAddr("invariantSlasher");
    address internal sink = makeAddr("invariantSink");

    function setUp() public {
        vm.warp(1_700_000_000);

        asset = new DualViewERC20();
        registry = new AgentRegistry(IERC20(address(asset)), admin, sink, 100e6, 1_000);

        vm.prank(admin);
        registry.setSlasher(slasher);

        handler = new RepRegRegistryHandler(registry, asset, admin, slasher);
        targetContract(address(handler));
    }

    /// The registry may hold more than it owes, never less. Anything else means an exit could
    /// be paid out of a stake that belongs to someone else.
    function invariant_theLedgerNeverExceedsTheCollateralHeld() public view {
        assertLe(registry.totalStaked(), asset.balanceOf(address(registry)));
    }

    function invariant_everyStakeAddsUpToTheLedger() public view {
        (address[] memory agents,) = registry.getAgents(0, type(uint256).max);

        uint256 sum;
        for (uint256 i = 0; i < agents.length; ++i) {
            sum += registry.stakeOf(agents[i]);
        }

        assertEq(sum, registry.totalStaked());
    }

    function invariant_anActiveAgentAlwaysMeetsTheFloor() public view {
        (address[] memory agents,) = registry.getAgents(0, type(uint256).max);

        for (uint256 i = 0; i < agents.length; ++i) {
            if (registry.isActive(agents[i])) {
                assertGe(registry.stakeOf(agents[i]), registry.minStake());
                assertFalse(registry.isBlacklisted(agents[i]));
            }
        }
    }

    function invariant_slashedCollateralOnlyEverLandsInTheSink() public view {
        assertEq(asset.balanceOf(sink), registry.totalSlashed());
    }

    /// Nothing in the system may read the eighteen-decimal view of this balance. If it did,
    /// the ledger would drift from the six-decimal one by the scale factor.
    function invariant_theLedgerReadsTheSixDecimalViewOnly() public view {
        uint256 held = asset.balanceOf(address(registry));
        assertEq(asset.nativeBalanceOf(address(registry)), held * asset.NATIVE_DECIMAL_SCALE());
        assertLe(registry.totalStaked(), held);
    }
}

/// Stands in for the escrow so the fuzzer can write outcome histories directly.
contract RepRegReputationHandler is CommonBase, StdCheats, StdUtils {
    // forge-lint: disable-next-item(screaming-snake-case-immutable)
    Reputation public immutable reputation;

    address[] public payees;
    address[] public payers;

    constructor(Reputation reputation_) {
        reputation = reputation_;

        for (uint256 i = 0; i < 3; ++i) {
            payees.push(address(uint160(uint256(keccak256(abi.encodePacked("payee", i))))));
            payers.push(address(uint160(uint256(keccak256(abi.encodePacked("payer", i))))));
        }
    }

    function released(uint256 payerSeed, uint256 payeeSeed) external {
        reputation.onReleased(_payer(payerSeed), _payee(payeeSeed));
    }

    function timedOut(uint256 payerSeed, uint256 payeeSeed) external {
        reputation.onTimedOut(_payer(payerSeed), _payee(payeeSeed));
    }

    function disputed(uint256 payerSeed, uint256 payeeSeed) external {
        reputation.onDisputed(_payer(payerSeed), _payee(payeeSeed));
    }

    function payeeAt(uint256 index) external view returns (address) {
        return payees[index];
    }

    function payeeCount() external view returns (uint256) {
        return payees.length;
    }

    function _payer(uint256 seed) private view returns (address) {
        return payers[seed % payers.length];
    }

    function _payee(uint256 seed) private view returns (address) {
        return payees[seed % payees.length];
    }
}

contract ReputationInvariants is Test {
    uint128 internal constant BASE_CAP = 250e6;
    uint128 internal constant CAP_PER_SCORE = 7e6;
    uint128 internal constant MAX_CAP = 900e6;

    Reputation internal reputation;
    RepRegReputationHandler internal handler;

    address internal admin = makeAddr("curveAdmin");

    function setUp() public {
        reputation = new Reputation(
            admin, IReputation.CapCurve({baseCap: BASE_CAP, capPerScore: CAP_PER_SCORE, maxCap: MAX_CAP})
        );
        handler = new RepRegReputationHandler(reputation);
        reputation.setEscrow(address(handler));

        targetContract(address(handler));
    }

    function invariant_theCapNeverLeavesTheCurve() public view {
        for (uint256 i = 0; i < handler.payeeCount(); ++i) {
            address payee = handler.payeeAt(i);
            uint128 cap = reputation.capOf(payee);

            assertGe(cap, BASE_CAP);
            assertLe(cap, MAX_CAP);
            assertLe(reputation.score(payee), reputation.scoreMax());
        }
    }

    function invariant_theCapIsAlwaysTheFormulaAppliedToTheHistory() public view {
        for (uint256 i = 0; i < handler.payeeCount(); ++i) {
            address payee = handler.payeeAt(i);
            (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payee);

            uint256 settled = uint256(released) + timedOut + disputed;
            uint256 expectedScore = settled == 0 ? 0 : (uint256(released) * 100) / settled;
            uint256 expectedCap = BASE_CAP + uint256(CAP_PER_SCORE) * expectedScore;
            if (expectedCap > MAX_CAP) expectedCap = MAX_CAP;

            // Both quotients are bounded by the scale and by MAX_CAP respectively.
            // forge-lint: disable-start(unsafe-typecast)
            assertEq(reputation.score(payee), uint16(expectedScore));
            assertEq(reputation.capOf(payee), uint128(expectedCap));
            // forge-lint: disable-end
        }
    }
}
