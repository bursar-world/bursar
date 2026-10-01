// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Escrow} from "../src/Escrow.sol";
import {Reputation} from "../src/Reputation.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";

import {MockUsdg} from "./mocks/MockUsdg.sol";

/// The weights, driven directly with the deployment's figures: what counts, what one payer is
/// worth, and how the released share is scaled by what has been earned.
contract ReputationCreditTest is Test {
    uint128 internal constant BASE_CAP = 25e6;
    uint128 internal constant CAP_PER_SCORE = 2.25e6;
    uint128 internal constant MAX_CAP = 250e6;

    uint128 internal constant MIN_SCORED = 1e6;
    uint128 internal constant EDGE_CAP = 62.5e6;
    uint128 internal constant FULL_CREDIT = 250e6;

    Reputation internal reputation;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    address internal payee = makeAddr("payee");
    address internal payerA = makeAddr("payerA");
    address internal payerB = makeAddr("payerB");
    address internal payerC = makeAddr("payerC");
    address internal payerD = makeAddr("payerD");

    function setUp() public {
        reputation = new Reputation(admin, _curve(), _weights(MIN_SCORED, EDGE_CAP, FULL_CREDIT));
        reputation.setEscrow(address(this));
    }

    function test_constructorRecordsTheWeights() public view {
        IReputation.Weights memory w = reputation.weights();
        assertEq(w.minScored, MIN_SCORED);
        assertEq(w.edgeCap, EDGE_CAP);
        assertEq(w.fullCredit, FULL_CREDIT);
    }

    /// A zero minimum scores a cent, a zero edge credits nothing, and full credit under one edge
    /// is a top one payer clears. Full credit equal to one edge is a policy and is admitted.
    function test_weightsThatCannotScoreAreRefused() public {
        vm.expectRevert(IReputation.BadWeights.selector);
        new Reputation(admin, _curve(), _weights(0, EDGE_CAP, FULL_CREDIT));

        vm.expectRevert(IReputation.BadWeights.selector);
        new Reputation(admin, _curve(), _weights(MIN_SCORED, 0, FULL_CREDIT));

        vm.expectRevert(IReputation.BadWeights.selector);
        new Reputation(admin, _curve(), _weights(MIN_SCORED, EDGE_CAP, EDGE_CAP - 1));

        vm.startPrank(admin);
        vm.expectRevert(IReputation.BadWeights.selector);
        reputation.setWeights(_weights(0, EDGE_CAP, FULL_CREDIT));
        vm.expectRevert(IReputation.BadWeights.selector);
        reputation.setWeights(_weights(MIN_SCORED, 0, FULL_CREDIT));
        vm.expectRevert(IReputation.BadWeights.selector);
        reputation.setWeights(_weights(MIN_SCORED, EDGE_CAP, EDGE_CAP - 1));

        reputation.setWeights(_weights(MIN_SCORED, EDGE_CAP, EDGE_CAP));
        vm.stopPrank();

        assertEq(reputation.weights().fullCredit, EDGE_CAP);
    }

    function test_setWeightsIsAdminOnlyAndSaysSo() public {
        vm.prank(stranger);
        vm.expectRevert(IReputation.NotAdmin.selector);
        reputation.setWeights(_weights(2e6, 50e6, 200e6));

        vm.prank(admin);
        vm.expectEmit(false, false, false, true, address(reputation));
        emit IReputation.WeightsUpdated(2e6, 50e6, 200e6);
        reputation.setWeights(_weights(2e6, 50e6, 200e6));

        IReputation.Weights memory w = reputation.weights();
        assertEq(w.minScored, 2e6);
        assertEq(w.edgeCap, 50e6);
        assertEq(w.fullCredit, 200e6);
    }

    /// Under the minimum nothing moves, whichever way the lock ended, and nothing is said. At the
    /// minimum everything does.
    function test_aLockUnderTheScoredMinimumMovesNothingEitherWay() public {
        vm.recordLogs();
        reputation.onReleased(payerA, payee, MIN_SCORED - 1);
        reputation.onTimedOut(payerA, payee, MIN_SCORED - 1);
        reputation.onDisputed(payerB, payee, MIN_SCORED - 1);

        (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(uint256(released) + timedOut + disputed, 0, "a lock under the minimum moved a counter");
        (released, timedOut, disputed) = reputation.edges(payerA, payee);
        assertEq(uint256(released) + timedOut + disputed, 0);
        assertEq(reputation.edgeVolume(payerA, payee), 0);
        assertEq(reputation.creditOf(payee), 0);
        assertEq(vm.getRecordedLogs().length, 0, "an event fired for a lock that moved nothing");
        assertEq(reputation.capOf(payee), BASE_CAP);

        reputation.onReleased(payerA, payee, MIN_SCORED);

        (released,,) = reputation.payeeStats(payee);
        assertEq(released, 1);
        assertEq(reputation.edgeVolume(payerA, payee), MIN_SCORED);
        assertEq(reputation.creditOf(payee), MIN_SCORED);
    }

    function test_creditFollowsTheEdgeUpToItsCapAndNoFurther() public {
        vm.expectEmit(true, true, false, true, address(reputation));
        emit IReputation.ReleaseCredited(payerA, payee, 40e6, 40e6);
        reputation.onReleased(payerA, payee, 40e6);
        assertEq(reputation.creditOf(payee), 40e6);

        // The second release crosses the cap: only the part up to it is credit.
        vm.expectEmit(true, true, false, true, address(reputation));
        emit IReputation.ReleaseCredited(payerA, payee, 40e6, 22.5e6);
        reputation.onReleased(payerA, payee, 40e6);
        assertEq(reputation.creditOf(payee), EDGE_CAP);
        assertEq(reputation.edgeVolume(payerA, payee), 80e6);

        // Past it the release still counts as a release and credits nothing.
        vm.expectEmit(true, true, false, true, address(reputation));
        emit IReputation.ReleaseCredited(payerA, payee, 10e6, 0);
        reputation.onReleased(payerA, payee, 10e6);

        (uint64 released,,) = reputation.payeeStats(payee);
        assertEq(released, 3);
        assertEq(reputation.creditOf(payee), EDGE_CAP);
        assertEq(reputation.edgeVolume(payerA, payee), 90e6);
    }

    /// One release and one dispute from a payer at its cap: half the jobs delivered, a quarter of
    /// the credit earned, so an eighth of the score, floored.
    function test_theScoreIsTheReleasedShareScaledByTheCreditEarned() public {
        reputation.onReleased(payerA, payee, EDGE_CAP);
        reputation.onDisputed(payerA, payee, EDGE_CAP);

        assertEq(reputation.score(payee), 12, "50 percent of a quarter is 12.5, floored");
        assertEq(reputation.capOf(payee), BASE_CAP + CAP_PER_SCORE * 12);
    }

    /// A payer below the cap is worth exactly what it paid; a payer above it is worth the cap. Four
    /// at the cap is the top, and a fifth adds credit the score no longer reads.
    function test_aFullScoreTakesFourEdgesAtTheCap() public {
        reputation.onReleased(payerA, payee, EDGE_CAP);
        reputation.onReleased(payerB, payee, EDGE_CAP);
        reputation.onReleased(payerC, payee, EDGE_CAP);
        assertEq(reputation.score(payee), 75);
        assertEq(reputation.capOf(payee), 193.75e6);

        reputation.onReleased(payerD, payee, EDGE_CAP);
        assertEq(reputation.score(payee), 100);
        assertEq(reputation.capOf(payee), MAX_CAP);

        reputation.onReleased(stranger, payee, EDGE_CAP);
        assertEq(reputation.creditOf(payee), 5 * EDGE_CAP);
        assertEq(reputation.score(payee), 100);
        assertEq(reputation.capOf(payee), MAX_CAP);
    }

    /// Credit is booked at the cap in force when a release lands. Lowering the cap binds the next
    /// release on every edge and takes nothing back.
    function test_aLoweredEdgeCapBindsTheNextReleaseOnly() public {
        reputation.onReleased(payerA, payee, EDGE_CAP);
        assertEq(reputation.creditOf(payee), EDGE_CAP);

        vm.prank(admin);
        reputation.setWeights(_weights(MIN_SCORED, 50e6, FULL_CREDIT));
        assertEq(reputation.creditOf(payee), EDGE_CAP, "a new cap recounted credit already booked");

        reputation.onReleased(payerB, payee, EDGE_CAP);
        assertEq(reputation.creditOf(payee), EDGE_CAP + 50e6);

        // Payer A already sits above the new cap, so more from it is worth nothing.
        vm.expectEmit(true, true, false, true, address(reputation));
        emit IReputation.ReleaseCredited(payerA, payee, 10e6, 0);
        reputation.onReleased(payerA, payee, 10e6);
        assertEq(reputation.creditOf(payee), EDGE_CAP + 50e6);
    }

    /// `fullCredit` is read on every score, so raising it reprices every payee at once, the way a
    /// new curve does.
    function test_fullCreditIsReadLiveAndRepricesEveryPayee() public {
        reputation.onReleased(payerA, payee, EDGE_CAP);
        reputation.onReleased(payerB, payee, EDGE_CAP);
        reputation.onReleased(payerC, payee, EDGE_CAP);
        reputation.onReleased(payerD, payee, EDGE_CAP);
        assertEq(reputation.score(payee), 100);

        vm.prank(admin);
        reputation.setWeights(_weights(MIN_SCORED, EDGE_CAP, 2 * FULL_CREDIT));

        assertEq(reputation.score(payee), 50);
        assertEq(reputation.capOf(payee), BASE_CAP + CAP_PER_SCORE * 50);
    }

    /// The minimum is read live too: a lock that would have counted yesterday does not count
    /// under a raised floor, and the other way round.
    function test_theScoredMinimumIsReadLive() public {
        vm.prank(admin);
        reputation.setWeights(_weights(10e6, EDGE_CAP, FULL_CREDIT));

        reputation.onReleased(payerA, payee, 5e6);
        (uint64 released,,) = reputation.payeeStats(payee);
        assertEq(released, 0);

        vm.prank(admin);
        reputation.setWeights(_weights(1e6, EDGE_CAP, FULL_CREDIT));

        reputation.onReleased(payerA, payee, 5e6);
        (released,,) = reputation.payeeStats(payee);
        assertEq(released, 1);
    }

    /// Any history, against the formula written out with whole edges: the score never leaves its
    /// scale and never rounds up.
    function testFuzz_theScoreIsOneDivisionOverTheWholeHistory(
        uint8 releases,
        uint8 failures,
        uint8 payerCount,
        uint128 amount
    ) public {
        uint256 r = bound(releases, 0, 8);
        uint256 f = bound(failures, 0, 8);
        uint256 k = bound(payerCount, 1, 4);
        uint128 size = uint128(bound(amount, MIN_SCORED, 2 * EDGE_CAP));

        address[4] memory payers = [payerA, payerB, payerC, payerD];
        uint256[4] memory volumes;
        for (uint256 i; i < r; ++i) {
            uint256 at = i % k;
            reputation.onReleased(payers[at], payee, size);
            volumes[at] += size;
        }
        for (uint256 i; i < f; ++i) {
            reputation.onTimedOut(payers[i % k], payee, size);
        }

        uint256 credit;
        for (uint256 i; i < k; ++i) {
            credit += volumes[i] > EDGE_CAP ? EDGE_CAP : volumes[i];
        }
        assertEq(reputation.creditOf(payee), credit);

        uint256 earned = credit > FULL_CREDIT ? FULL_CREDIT : credit;
        uint256 expected = (r + f) == 0 ? 0 : (r * 100 * earned) / ((r + f) * FULL_CREDIT);
        assertEq(reputation.score(payee), expected);
        assertLe(reputation.score(payee), 100);
    }

    function _curve() private pure returns (IReputation.CapCurve memory) {
        return IReputation.CapCurve({baseCap: BASE_CAP, capPerScore: CAP_PER_SCORE, maxCap: MAX_CAP});
    }

    function _weights(uint128 minScored, uint128 edgeCap, uint128 fullCredit)
        private
        pure
        returns (IReputation.Weights memory)
    {
        return IReputation.Weights({minScored: minScored, edgeCap: edgeCap, fullCredit: fullCredit});
    }
}

/// The finding: a payee that opened a second address and paid itself one cent through the escrow
/// scored 100 and unlocked the whole curve. Walked against a live escrow with the deployment's own
/// figures, so the numbers here are the numbers on chain.
contract ReputationSybilTest is Test {
    uint128 internal constant BASE_CAP = 25e6;
    uint128 internal constant CAP_PER_SCORE = 2.25e6;
    uint128 internal constant MAX_CAP = 250e6;

    uint128 internal constant MIN_SCORED = 1e6;
    uint128 internal constant EDGE_CAP = 62.5e6;
    uint128 internal constant FULL_CREDIT = 250e6;

    uint16 internal constant FEE_BPS = 100;
    uint64 internal constant DISPUTE_WINDOW = 1 hours;
    uint128 internal constant MIN_LOCK = 10_000;

    MockUsdg internal asset;
    Reputation internal reputation;
    Escrow internal escrow;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal payee = makeAddr("payee");
    /// The payee's own second address.
    address internal sybil = makeAddr("sybil");
    address internal payerB = makeAddr("payerB");
    address internal payerC = makeAddr("payerC");
    address internal payerD = makeAddr("payerD");

    function setUp() public {
        vm.warp(1_800_000_000);

        asset = new MockUsdg();
        reputation = new Reputation(
            admin,
            IReputation.CapCurve({baseCap: BASE_CAP, capPerScore: CAP_PER_SCORE, maxCap: MAX_CAP}),
            IReputation.Weights({minScored: MIN_SCORED, edgeCap: EDGE_CAP, fullCredit: FULL_CREDIT})
        );
        escrow = new Escrow(
            address(asset), address(reputation), treasury, FEE_BPS, 50, 500, 5 minutes, 7 days, DISPUTE_WINDOW, MIN_LOCK
        );
        reputation.setEscrow(address(escrow));

        address[4] memory payers = [sybil, payerB, payerC, payerD];
        for (uint256 i; i < 4; ++i) {
            asset.mint(payers[i], 10_000e6);
            vm.prank(payers[i]);
            asset.approve(address(escrow), type(uint256).max);
        }
    }

    function test_oneCentFromASecondAddressDoesNotLiftTheCap() public {
        _settle(sybil, MIN_LOCK);

        (uint64 released,,) = reputation.payeeStats(payee);
        assertEq(released, 0, "a cent was written into the history");
        assertEq(reputation.creditOf(payee), 0);
        assertEq(reputation.score(payee), 0);
        assertEq(reputation.capOf(payee), BASE_CAP);
    }

    /// One address paying itself the most the cap admits, as often as it likes, buys a quarter of
    /// the score and no more.
    function test_oneAddressPayingItselfStopsAQuarterOfTheWayUp() public {
        for (uint256 i; i < 12; ++i) {
            _settle(sybil, reputation.capOf(payee));
        }

        assertEq(reputation.creditOf(payee), EDGE_CAP);
        assertEq(reputation.score(payee), 25);
        assertEq(reputation.capOf(payee), 81.25e6);
    }

    /// Reaching the top takes four counterparties and the volume behind them, every unit of which
    /// paid the escrow's fee on the way through.
    function test_aFullScoreTakesFourCounterpartiesAndTheVolumeBehindThem() public {
        _settle(sybil, 25e6);
        assertEq(reputation.score(payee), 10, "25 USDG of credit against 250 is a tenth");
        assertEq(reputation.capOf(payee), 47.5e6);

        // The same payer again: the edge fills to its cap of 62.5 USDG and stops counting there.
        _settle(sybil, 47.5e6);
        assertEq(reputation.edgeVolume(sybil, payee), 72.5e6);
        assertEq(reputation.creditOf(payee), EDGE_CAP);
        assertEq(reputation.score(payee), 25);
        assertEq(reputation.capOf(payee), 81.25e6);

        _settle(payerB, 81.25e6);
        assertEq(reputation.score(payee), 50);
        assertEq(reputation.capOf(payee), 137.5e6);

        _settle(payerC, 137.5e6);
        assertEq(reputation.score(payee), 75);
        assertEq(reputation.capOf(payee), 193.75e6);

        _settle(payerD, 193.75e6);
        assertEq(reputation.score(payee), 100);
        assertEq(reputation.capOf(payee), MAX_CAP);

        uint256 settled = 25e6 + 47.5e6 + 81.25e6 + 137.5e6 + 193.75e6;
        assertGe(settled, FULL_CREDIT, "a full score came cheaper than the credit it stands for");
        assertEq(escrow.feesAccrued(), settled / 100, "every unit of that volume paid the fee");
    }

    /// Lock, release, wait out the payer's window, write the release into the history.
    function _settle(address payer, uint128 amount) private {
        vm.prank(payer);
        uint256 id = escrow.lock(payee, keccak256("cap"), keccak256("in"), "", amount, uint64(block.timestamp + 1 days));

        vm.prank(payee);
        escrow.release(id, keccak256("out"), "");

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        escrow.finalizeRelease(id);
    }
}
