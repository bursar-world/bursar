// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BRSR} from "../../src/token/BRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";
import {IStaking} from "../../src/token/interfaces/IStaking.sol";
import {FeeOnTransferERC20} from "../mocks/FeeOnTransferERC20.sol";
import {InflatingERC20} from "../mocks/InflatingERC20.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {ReentrantERC20} from "../mocks/ReentrantERC20.sol";
import {ShrinkingERC20} from "../mocks/ShrinkingERC20.sol";

/// First loss: pro rata across everyone in the pool at that instant, exits included, and down to
/// nothing when the shortfall is larger than the pool.
contract StakingLossTest is Test {
    event Slashed(uint256 requested, uint256 taken, uint256 remaining);
    event PoolWiped(uint32 indexed epoch, uint256 shares);
    event StakeWiped(address indexed staker, uint32 indexed epoch, uint256 shares, uint256 unbondingShares);

    uint64 internal constant UNBONDING = 7 days;
    uint256 internal constant MIN_BOND = 1_000e18;

    BRSR internal brsr;
    MockUsdg internal usdg;
    Staking internal staking;

    address internal admin = makeAddr("timelock");
    address internal credit = makeAddr("creditManager");
    address internal slasher = makeAddr("slasher");
    address internal slashSink = makeAddr("slashSink");
    address internal treasury = makeAddr("treasury");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        usdg = new MockUsdg();
        brsr = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: makeAddr("team"), treasury: treasury, liquidity: makeAddr("liquidity")
            })
        );
        staking = new Staking(brsr, usdg, admin, slashSink, treasury, UNBONDING, MIN_BOND);

        vm.startPrank(admin);
        staking.setCreditManager(credit);
        staking.setSlasher(slasher);
        // The cap on how fast a loss may land is lifted here and tested on its own.
        staking.setSlashLimit(10_000, 1 days);
        vm.stopPrank();

        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < who.length; ++i) {
            brsr.transfer(who[i], 10_000_000e18);
            vm.prank(who[i]);
            brsr.approve(address(staking), type(uint256).max);
        }
        usdg.approve(address(staking), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(amount);
    }

    function _distribute(uint256 amount) internal {
        usdg.mint(credit, amount);
        vm.startPrank(credit);
        usdg.approve(address(staking), amount);
        staking.distribute(amount);
        vm.stopPrank();
    }

    function _slash(uint256 amount) internal returns (uint256) {
        vm.prank(slasher);
        return staking.slash(amount);
    }

    /// Every staker loses the same fraction, whatever they staked and whenever they staked it.
    function test_aLossLandsProRataOnEveryone() public {
        _stake(alice, 600e18);
        _stake(bob, 300e18);
        _stake(carol, 100e18);

        assertEq(_slash(250e18), 250e18);

        assertEq(staking.totalStaked(), 750e18);
        assertEq(brsr.balanceOf(slashSink), 250e18);

        // Three quarters of each position, to the wei the share price can express.
        assertApproxEqAbs(staking.stakedValueOf(alice), 450e18, 1e6);
        assertApproxEqAbs(staking.stakedValueOf(bob), 225e18, 1e6);
        assertApproxEqAbs(staking.stakedValueOf(carol), 75e18, 1e6);

        // Nothing is created: the three claims never add to more than the pool holds.
        uint256 sum = staking.stakedValueOf(alice) + staking.stakedValueOf(bob) + staking.stakedValueOf(carol);
        assertLe(sum, staking.totalStaked());
        assertApproxEqRel(sum, staking.totalStaked(), 1e12);
    }

    /// A first-loss pool that cannot be exhausted is not first loss. A shortfall larger than
    /// the pool takes the pool and reports what it took.
    function test_aLossLargerThanThePoolTakesThePoolAndSaysSo() public {
        _stake(alice, 700e18);
        _stake(bob, 300e18);

        vm.expectEmit(true, false, false, true, address(staking));
        emit PoolWiped(0, staking.totalShares());
        vm.expectEmit(false, false, false, true, address(staking));
        emit Slashed(5_000e18, 1_000e18, 0);
        assertEq(_slash(5_000e18), 1_000e18);

        assertEq(staking.totalStaked(), 0);
        assertEq(staking.totalShares(), 0);
        assertEq(staking.wipeEpoch(), 1);
        assertEq(brsr.balanceOf(slashSink), 1_000e18);
        assertEq(staking.stakedValueOf(alice), 0);
        assertEq(staking.stakedValueOf(bob), 0);
        assertEq(staking.sharesOf(alice), 0);
    }

    /// A wiped position is cleared the next time it is touched, and the clearing is the only
    /// thing that happens: the stake is already gone.
    function test_aWipedPositionIsClearedOnItsNextTouch() public {
        _stake(alice, 1_000e18);
        uint256 shares = staking.sharesOf(alice);

        _slash(type(uint128).max);

        vm.expectEmit(true, true, false, true, address(staking));
        emit StakeWiped(alice, 1, shares, 0);
        vm.prank(alice);
        staking.stake(1e18);

        assertEq(staking.positionOf(alice).epoch, 1);
        assertApproxEqRel(staking.stakedValueOf(alice), 1e18, 1e12);
    }

    /// A second wipe is not a special case. Each generation settles against the accumulator as
    /// it stood when that generation ended.
    function test_theSpreadEachGenerationEarnedStaysWithIt() public {
        _stake(alice, 1_000e18);
        _distribute(3_000_000);
        _slash(type(uint128).max);

        _stake(bob, 1_000e18);
        _distribute(5_000_000);
        // The first wipe spent the allowance. It refills over the window.
        vm.warp(block.timestamp + 1 days);
        _slash(type(uint128).max);

        _stake(carol, 1_000e18);
        _distribute(7_000_000);

        assertEq(staking.wipeEpoch(), 2);
        assertEq(staking.pendingRewards(alice), 3_000_000);
        assertEq(staking.pendingRewards(bob), 5_000_000);
        assertEq(staking.pendingRewards(carol), 7_000_000);

        vm.prank(alice);
        assertEq(staking.claimRewards(), 3_000_000);
        vm.prank(bob);
        assertEq(staking.claimRewards(), 5_000_000);
        vm.prank(carol);
        assertEq(staking.claimRewards(), 7_000_000);
    }

    /// The unbonding period is not an escape hatch. Shares committed to an exit stay in the
    /// pool and take the loss with everyone else.
    function test_anExitInFlightTakesTheSameLossAsAStakerWhoStayed() public {
        _stake(alice, 1_000e18);
        _stake(bob, 1_000e18);

        uint256 shares = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(shares);

        _slash(1_000e18);

        vm.warp(block.timestamp + UNBONDING);
        vm.prank(alice);
        uint256 returned = staking.completeUnbond();

        assertApproxEqRel(returned, 500e18, 1e12);
        assertApproxEqRel(staking.stakedValueOf(bob), 500e18, 1e12);
        // Neither of them did better than the other by a wei that matters.
        assertApproxEqAbs(returned, staking.stakedValueOf(bob), 1e6);
    }

    /// The exit is priced when it completes, which closes the gap between hearing about a
    /// default and the pool measuring it.
    function test_anExitIsPricedOnCompletion() public {
        _stake(alice, 1_000e18);
        _stake(bob, 1_000e18);

        uint256 shares = staking.sharesOf(alice);
        uint256 quotedAtRequest = staking.previewUnbond(shares);
        vm.prank(alice);
        staking.requestUnbond(shares);

        vm.warp(block.timestamp + UNBONDING);
        _slash(400e18);

        vm.prank(alice);
        uint256 returned = staking.completeUnbond();

        assertLt(returned, quotedAtRequest);
        assertApproxEqRel(returned, 800e18, 1e12);
    }

    /// A loss that lands after the exit completed is somebody else's. The pool the exit left
    /// is the pool that carries it.
    function test_aCompletedExitIsOutOfTheWayOfWhatComesNext() public {
        _stake(alice, 1_000e18);
        _stake(bob, 1_000e18);

        uint256 shares = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(shares);
        vm.warp(block.timestamp + UNBONDING);
        vm.prank(alice);
        uint256 returned = staking.completeUnbond();

        _slash(500e18);

        assertApproxEqRel(returned, 1_000e18, 1e12);
        assertApproxEqRel(staking.stakedValueOf(bob), 500e18, 1e12);
    }

    /// Lengthening the period reaches a request already pending, so an exit cannot freeze the
    /// old parameter by being filed ahead of the change.
    function test_aPendingExitCannotFreezeTheOldUnbondingPeriod() public {
        _stake(alice, 1_000e18);
        uint256 shares = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(shares);

        vm.prank(admin);
        staking.setUnbondingPeriod(30 days);

        vm.warp(block.timestamp + UNBONDING);
        vm.prank(alice);
        vm.expectRevert(IStaking.UnbondNotMatured.selector);
        staking.completeUnbond();

        vm.warp(block.timestamp + 30 days - UNBONDING);
        vm.prank(alice);
        staking.completeUnbond();
    }

    function test_shorteningThePeriodReachesAPendingExitToo() public {
        vm.prank(admin);
        staking.setUnbondingPeriod(30 days);

        _stake(alice, 1_000e18);
        uint256 shares = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(shares);

        vm.prank(admin);
        staking.setUnbondingPeriod(UNBONDING);

        vm.warp(block.timestamp + UNBONDING);
        vm.prank(alice);
        staking.completeUnbond();
    }

    function test_cancellingAnExitPutsTheStakeBackToWork() public {
        _stake(alice, 1_000e18);
        uint256 shares = staking.sharesOf(alice);

        vm.prank(alice);
        staking.requestUnbond(shares);
        assertEq(staking.activeStakeOf(alice), 0);

        vm.prank(alice);
        staking.cancelUnbond();
        assertApproxEqRel(staking.activeStakeOf(alice), 1_000e18, 1e12);

        vm.prank(alice);
        vm.expectRevert(IStaking.UnbondNotRequested.selector);
        staking.cancelUnbond();

        vm.prank(alice);
        vm.expectRevert(IStaking.UnbondNotRequested.selector);
        staking.completeUnbond();
    }

    function test_onlyOneExitIsInFlightAtATime() public {
        _stake(alice, 1_000e18);
        uint256 shares = staking.sharesOf(alice);

        vm.prank(alice);
        staking.requestUnbond(shares / 2);

        vm.prank(alice);
        vm.expectRevert(IStaking.UnbondAlreadyRequested.selector);
        staking.requestUnbond(shares / 2);
    }

    function test_anExitCannotAskForSharesItDoesNotHold() public {
        _stake(alice, 1_000e18);

        uint256 held = staking.sharesOf(alice);
        vm.prank(alice);
        vm.expectRevert(IStaking.InsufficientShares.selector);
        staking.requestUnbond(held + 1);

        vm.prank(alice);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.requestUnbond(0);
    }

    /// The brake holds first-loss capital in place while a shortfall is measured. Spread
    /// already earned is not first-loss capital, so claiming stays open.
    function test_theBrakeHoldsCapitalAndLeavesSpreadClaimable() public {
        _stake(alice, 1_000e18);
        _distribute(4_000_000);

        uint256 shares = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(shares);
        vm.warp(block.timestamp + UNBONDING);

        vm.prank(admin);
        staking.pause();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStaking.ExitsHeld.selector, uint64(block.timestamp) + 7 days));
        staking.completeUnbond();

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        staking.stake(1e18);

        vm.prank(alice);
        assertEq(staking.claimRewards(), 4_000_000);

        // The measurement finishes and the loss lands on capital that was held in place.
        _slash(500e18);

        vm.prank(admin);
        staking.unpause();
        vm.prank(alice);
        assertApproxEqRel(staking.completeUnbond(), 500e18, 1e12);
    }

    function test_aSlashNeedsTheSlasherAndTheSlasherStartsUnset() public {
        Staking fresh = new Staking(brsr, usdg, admin, slashSink, treasury, UNBONDING, MIN_BOND);
        assertEq(fresh.slasher(), address(0));

        brsr.approve(address(fresh), 1_000e18);
        fresh.stake(1_000e18);

        vm.prank(slasher);
        vm.expectRevert(IStaking.NotSlasher.selector);
        fresh.slash(1e18);

        vm.prank(admin);
        vm.expectRevert(IStaking.NotSlasher.selector);
        fresh.slash(1e18);
    }

    /// A write-off calls this with whatever it has measured, and it must not fail on the state
    /// of the pool. Nothing to take is a return of zero, and the lender carries the loss.
    function test_aSlashOfNothingOrOfAnEmptyPoolTakesNothing() public {
        assertEq(_slash(1e18), 0);

        _stake(alice, 100e18);
        assertEq(_slash(0), 0);
        assertEq(staking.totalStaked(), 100e18);
        assertEq(brsr.balanceOf(slashSink), 0);
    }

    /// The separation in one test: the key that takes stake is not the key that sets the
    /// parameters, the credit lane that pays the spread cannot take stake, and naming the
    /// slasher is a governance decision on its own.
    function test_theAdminCannotSlashAndNeitherLaneCanGovern() public {
        _stake(alice, 1_000e18);

        vm.prank(admin);
        vm.expectRevert(IStaking.NotSlasher.selector);
        staking.slash(1e18);

        vm.prank(credit);
        vm.expectRevert(IStaking.NotSlasher.selector);
        staking.slash(1e18);

        vm.prank(slasher);
        vm.expectRevert(IStaking.NotCreditManager.selector);
        staking.distribute(1);

        address[2] memory lanes = [credit, slasher];
        for (uint256 i; i < lanes.length; ++i) {
            vm.startPrank(lanes[i]);
            vm.expectRevert(IStaking.NotAdmin.selector);
            staking.setCreditManager(lanes[i]);
            vm.expectRevert(IStaking.NotAdmin.selector);
            staking.setSlasher(lanes[i]);
            vm.expectRevert(IStaking.NotAdmin.selector);
            staking.setSlashLimit(10_000, 1 days);
            vm.expectRevert(IStaking.NotAdmin.selector);
            staking.pause();
            vm.expectRevert(IStaking.NotAdmin.selector);
            staking.setSlashSink(lanes[i]);
            vm.stopPrank();
        }
    }

    function test_compoundingIntoAnEmptyPoolIsRefused() public {
        brsr.approve(address(staking), 100e18);
        vm.expectRevert(IStaking.NothingStaked.selector);
        staking.compound(100e18);

        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.compound(0);
    }

    function test_aDepositTooSmallToBuyAShareIsRefused() public {
        _stake(alice, 1_000e18);

        // A compound of the whole community allocation makes one share worth more than the
        // smallest deposit anyone can make.
        brsr.approve(address(staking), 500_000_000e18);
        staking.compound(500_000_000e18);

        vm.prank(bob);
        vm.expectRevert(IStaking.DustAmount.selector);
        staking.stake(1);

        vm.prank(bob);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.stake(0);
    }

    /// The pool books what arrived, so a token that takes a cut on transfer cannot leave the
    /// books ahead of the balance.
    function test_thePoolBooksWhatArrived() public {
        FeeOnTransferERC20 lossy = new FeeOnTransferERC20();
        Staking odd = new Staking(lossy, usdg, admin, slashSink, treasury, UNBONDING, MIN_BOND);

        lossy.mint(alice, 1_000e18);
        vm.startPrank(alice);
        lossy.approve(address(odd), type(uint256).max);
        odd.stake(1_000e18);
        vm.stopPrank();

        assertEq(odd.totalStaked(), 990e18);
        assertEq(lossy.balanceOf(address(odd)), 990e18);
        assertGe(lossy.balanceOf(address(odd)), odd.totalStaked());
    }

    function test_aTokenThatCreditsMoreThanWasSentIsBookedAtWhatArrived() public {
        InflatingERC20 generous = new InflatingERC20();
        Staking odd = new Staking(generous, usdg, admin, slashSink, treasury, UNBONDING, MIN_BOND);

        generous.mint(alice, 1_000e18);
        vm.startPrank(alice);
        generous.approve(address(odd), type(uint256).max);
        odd.stake(500e18);
        vm.stopPrank();

        assertEq(odd.totalStaked(), 1_000e18);
        assertGe(generous.balanceOf(address(odd)), odd.totalStaked());
    }

    /// A blacklist or a rebase looks like this from inside: the funds are booked and then taken
    /// from the outside. The pool credits what it can still see, which is nothing, and reverts.
    function test_aDepositThatArrivesAndVanishesIsRefused() public {
        ShrinkingERC20 vanishing = new ShrinkingERC20();
        Staking odd = new Staking(vanishing, usdg, admin, slashSink, treasury, UNBONDING, MIN_BOND);

        vanishing.mint(alice, 1_000e18);
        vanishing.arm(address(odd));

        vm.startPrank(alice);
        vanishing.approve(address(odd), type(uint256).max);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        odd.stake(100e18);
        vm.stopPrank();

        assertEq(odd.totalStaked(), 0);
    }

    /// A token with a transfer hook cannot re-enter the pool part way through a deposit and
    /// buy shares against a balance the pool has not finished counting.
    function test_aTokenThatCallsBackCannotReenterTheDeposit() public {
        ReentrantERC20 hooked = new ReentrantERC20();
        Staking odd = new Staking(hooked, usdg, admin, slashSink, treasury, UNBONDING, MIN_BOND);

        hooked.mint(alice, 1_000e18);
        vm.startPrank(alice);
        hooked.approve(address(odd), type(uint256).max);
        hooked.arm(address(odd), abi.encodeCall(Staking.stake, (1e18)));
        odd.stake(100e18);
        vm.stopPrank();

        assertFalse(hooked.callbackSucceeded());
        assertEq(odd.totalStaked(), 100e18);
    }

    function test_constructorRefusesAnIncoherentSetup() public {
        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(IERC20(address(0)), usdg, admin, slashSink, treasury, UNBONDING, MIN_BOND);

        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(brsr, IERC20(address(0)), admin, slashSink, treasury, UNBONDING, MIN_BOND);

        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(brsr, usdg, address(0), slashSink, treasury, UNBONDING, MIN_BOND);

        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(brsr, usdg, admin, address(0), treasury, UNBONDING, MIN_BOND);

        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(brsr, usdg, admin, slashSink, address(0), UNBONDING, MIN_BOND);

        // One token in both roles would let a distribution be counted as stake and a slash
        // pay out as spread.
        vm.expectRevert(IStaking.SameToken.selector);
        new Staking(brsr, brsr, admin, slashSink, treasury, UNBONDING, MIN_BOND);

        vm.expectRevert(IStaking.BadConfig.selector);
        new Staking(brsr, usdg, admin, slashSink, treasury, 7 days - 1, MIN_BOND);

        vm.expectRevert(IStaking.BadConfig.selector);
        new Staking(brsr, usdg, admin, slashSink, treasury, 90 days + 1, MIN_BOND);
    }

    function test_theUnbondingPeriodStaysInsideItsBounds() public {
        vm.startPrank(admin);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setUnbondingPeriod(7 days - 1);

        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setUnbondingPeriod(90 days + 1);

        staking.setUnbondingPeriod(7 days);
        assertEq(staking.unbondingPeriod(), 7 days);
        staking.setUnbondingPeriod(90 days);
        assertEq(staking.unbondingPeriod(), 90 days);
        vm.stopPrank();
    }

    /// Whatever the loss and whatever the split, the pool never pays out more than it holds
    /// and every claim moves by the same proportion.
    function testFuzz_aLossIsTheSameFractionForEveryone(uint96 a, uint96 b, uint96 loss) public {
        uint256 stakeA = bound(a, 1e18, 1_000_000e18);
        uint256 stakeB = bound(b, 1e18, 1_000_000e18);
        // Anything short of leaving dust. A slash that leaves under a thousandth takes it all.
        uint256 taken = bound(loss, 1, ((stakeA + stakeB) * 999) / 1_000);

        _stake(alice, stakeA);
        _stake(bob, stakeB);

        uint256 beforeA = staking.stakedValueOf(alice);
        uint256 beforeB = staking.stakedValueOf(bob);

        assertEq(_slash(taken), taken);

        uint256 afterA = staking.stakedValueOf(alice);
        uint256 afterB = staking.stakedValueOf(bob);

        assertLe(afterA + afterB, staking.totalStaked());
        assertGe(brsr.balanceOf(address(staking)), staking.totalStaked());

        // The two positions fell by the same fraction, to within the precision the share
        // price can carry.
        assertApproxEqRel(afterA * beforeB, afterB * beforeA, 1e12);
    }

    /// Whatever order deposits, losses and exits arrive in, the pool's books never claim more
    /// BRSR than it holds.
    function testFuzz_thePoolNeverOwesMoreThanItHolds(uint96[4] memory amounts, uint96[2] memory losses, bool exitFirst)
        public
    {
        address[3] memory who = [alice, bob, carol];

        for (uint256 i; i < 4; ++i) {
            _stake(who[i % who.length], bound(amounts[i], 1e15, 1_000_000e18));
        }

        if (exitFirst) {
            uint256 shares = staking.sharesOf(alice);
            vm.prank(alice);
            staking.requestUnbond(shares);
        }

        for (uint256 i; i < 2; ++i) {
            uint256 pool = staking.totalStaked();
            if (pool == 0) break;
            _slash(bound(losses[i], 1, pool));
        }

        vm.warp(block.timestamp + UNBONDING);
        (, uint64 maturesAt,) = staking.unbondOf(alice);
        if (maturesAt != 0) {
            vm.prank(alice);
            staking.completeUnbond();
        }

        uint256 owed;
        for (uint256 i; i < who.length; ++i) {
            owed += staking.stakedValueOf(who[i]);
        }
        assertLe(owed, staking.totalStaked());
        assertGe(brsr.balanceOf(address(staking)), staking.totalStaked());
    }
}

/// The rebate a staked balance earns, read at every boundary the tier table defines.
contract StakingRebateTest is Test {
    uint64 internal constant UNBONDING = 7 days;
    uint256 internal constant MIN_BOND = 1_000e18;

    uint256 internal constant TIER_1 = 1_000e18;
    uint256 internal constant TIER_2 = 10_000e18;
    uint256 internal constant TIER_3 = 100_000e18;

    BRSR internal brsr;
    MockUsdg internal usdg;
    Staking internal staking;

    address internal admin = makeAddr("timelock");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdg = new MockUsdg();
        brsr = new BRSR(
            IBRSR.Allocation({
                community: address(this),
                team: makeAddr("team"),
                treasury: makeAddr("treasury"),
                liquidity: makeAddr("liquidity")
            })
        );
        staking = new Staking(brsr, usdg, admin, makeAddr("slashSink"), makeAddr("treasury"), UNBONDING, MIN_BOND);

        IStaking.Tier[] memory tiers = new IStaking.Tier[](3);
        tiers[0] = IStaking.Tier({minStake: TIER_1, rebateBps: 500});
        tiers[1] = IStaking.Tier({minStake: TIER_2, rebateBps: 1_500});
        tiers[2] = IStaking.Tier({minStake: TIER_3, rebateBps: 3_000});
        vm.prank(admin);
        staking.setTiers(tiers);

        brsr.transfer(alice, 1_000_000e18);
        vm.prank(alice);
        brsr.approve(address(staking), type(uint256).max);
    }

    /// One wei short of a tier is the tier below. The pool prices shares with a virtual offset,
    /// so the boundary is read against what the shares are worth.
    function _stakeToExactly(uint256 target) internal {
        vm.prank(alice);
        staking.stake(target);
        while (staking.activeStakeOf(alice) < target) {
            vm.prank(alice);
            staking.stake(1e12);
        }
    }

    function test_zeroStakeEarnsNoRebate() public view {
        assertEq(staking.rebateBpsOf(stranger), 0);
        assertEq(staking.rebateBpsOf(alice), 0);
    }

    function test_belowTheFirstTierEarnsNoRebate() public {
        vm.prank(alice);
        staking.stake(TIER_1 - 1e18);
        assertEq(staking.rebateBpsOf(alice), 0);
    }

    function test_everyTierBoundaryReadsTheTierItReaches() public {
        _stakeToExactly(TIER_1);
        assertGe(staking.activeStakeOf(alice), TIER_1);
        assertEq(staking.rebateBpsOf(alice), 500);

        _stakeToExactly(TIER_2);
        assertGe(staking.activeStakeOf(alice), TIER_2);
        assertEq(staking.rebateBpsOf(alice), 1_500);

        _stakeToExactly(TIER_3);
        assertGe(staking.activeStakeOf(alice), TIER_3);
        assertEq(staking.rebateBpsOf(alice), 3_000);

        // Past the top tier the rebate stops climbing.
        vm.prank(alice);
        staking.stake(500_000e18);
        assertEq(staking.rebateBpsOf(alice), 3_000);
    }

    function test_justBelowATierIsTheTierBelow() public {
        _stakeToExactly(TIER_2);
        assertEq(staking.rebateBpsOf(alice), 1_500);

        // Drop back under the second tier and the rebate follows.
        uint256 shares = staking.sharesOf(alice);
        uint256 active = staking.activeStakeOf(alice);
        uint256 leaving = (shares * (active - TIER_2 + 1)) / active + 1;
        vm.prank(alice);
        staking.requestUnbond(leaving);

        assertLt(staking.activeStakeOf(alice), TIER_2);
        assertEq(staking.rebateBpsOf(alice), 500);
    }

    /// A discount for alignment should not outlive the alignment: shares committed to an exit
    /// stop counting the moment the request is filed.
    function test_sharesLeavingThePoolStopEarningTheDiscount() public {
        _stakeToExactly(TIER_3);
        assertEq(staking.rebateBpsOf(alice), 3_000);

        uint256 all = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(all);
        assertEq(staking.rebateBpsOf(alice), 0);
        assertGt(staking.stakedValueOf(alice), 0);

        vm.prank(alice);
        staking.cancelUnbond();
        assertEq(staking.rebateBpsOf(alice), 3_000);
    }

    function test_aWipedPositionEarnsNothing() public {
        _stakeToExactly(TIER_3);

        vm.startPrank(admin);
        staking.setSlasher(address(this));
        staking.setSlashLimit(10_000, 1 days);
        vm.stopPrank();
        staking.slash(type(uint128).max);

        assertEq(staking.rebateBpsOf(alice), 0);
        assertEq(staking.activeStakeOf(alice), 0);
    }

    function test_theRebateIsCappedAtHalfTheFee() public {
        IStaking.Tier[] memory tiers = new IStaking.Tier[](1);
        tiers[0] = IStaking.Tier({minStake: 1e18, rebateBps: staking.MAX_REBATE_BPS()});

        vm.prank(admin);
        staking.setTiers(tiers);

        vm.prank(alice);
        staking.stake(10e18);
        assertEq(staking.rebateBpsOf(alice), 5_000);

        tiers[0].rebateBps = staking.MAX_REBATE_BPS() + 1;
        vm.prank(admin);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setTiers(tiers);
    }

    function test_theTierTableRefusesEveryShapeThatCannotBeReadTopDown() public {
        IStaking.Tier[] memory one = new IStaking.Tier[](1);

        one[0] = IStaking.Tier({minStake: 0, rebateBps: 100});
        _expectBadTiers(one);

        one[0] = IStaking.Tier({minStake: 1e18, rebateBps: 0});
        _expectBadTiers(one);

        IStaking.Tier[] memory two = new IStaking.Tier[](2);
        two[0] = IStaking.Tier({minStake: 1e18, rebateBps: 100});
        two[1] = IStaking.Tier({minStake: 1e18, rebateBps: 200});
        _expectBadTiers(two);

        two[1] = IStaking.Tier({minStake: 2e18, rebateBps: 100});
        _expectBadTiers(two);

        IStaking.Tier[] memory tooMany = new IStaking.Tier[](9);
        for (uint256 i; i < 9; ++i) {
            tooMany[i] = IStaking.Tier({minStake: (i + 1) * 1e18, rebateBps: uint16((i + 1) * 100)});
        }
        _expectBadTiers(tooMany);
    }

    function test_theTableCanBeClearedBackToNoRebate() public {
        vm.prank(alice);
        staking.stake(TIER_3);
        assertEq(staking.rebateBpsOf(alice), 3_000);

        IStaking.Tier[] memory none = new IStaking.Tier[](0);
        vm.prank(admin);
        staking.setTiers(none);

        assertEq(staking.tiers().length, 0);
        assertEq(staking.rebateBpsOf(alice), 0);
    }

    function _expectBadTiers(IStaking.Tier[] memory tiers) internal {
        vm.prank(admin);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setTiers(tiers);
    }

    /// The live pool's first figures: 25,000 BRSR staked, then the first buyback's compound. A
    /// stake of exactly the tier's amount after that is worth a shade under it once the pool
    /// keeps the fraction of a share the deposit paid for, and it still reads as its tier.
    function test_anExactTierStakeReadsItsTierAfterACompound() public {
        IStaking.Tier[] memory one = new IStaking.Tier[](1);
        one[0] = IStaking.Tier({minStake: 25_000e18, rebateBps: 500});
        vm.prank(admin);
        staking.setTiers(one);

        brsr.approve(address(staking), type(uint256).max);
        staking.stake(25_000e18);
        staking.compound(2_443_771202227581992667);

        vm.prank(alice);
        staking.stake(25_000e18);

        assertLt(staking.activeStakeOf(alice), 25_000e18, "the rounding the read has to absorb");
        assertEq(staking.rebateBpsOf(alice), 500);
    }

    /// A stake reads exactly the tier its amount reaches, before or after a compound has moved
    /// the share price off a round number: never a tier it has not reached, and never the one
    /// below because the pool kept the fraction of a share the deposit paid for.
    function testFuzz_aStakeReadsTheTierItsAmountReaches(uint96 amount, uint96 compounded) public {
        brsr.approve(address(staking), type(uint256).max);
        staking.stake(25_000e18);
        uint256 extra = bound(compounded, 0, 50_000e18);
        if (extra != 0) staking.compound(extra);

        uint256 staked = bound(amount, 1e15, 900_000e18);
        vm.prank(alice);
        staking.stake(staked);

        uint16 rebate = staking.rebateBpsOf(alice);
        if (staked < TIER_1) assertEq(rebate, 0);
        else if (staked < TIER_2) assertEq(rebate, 500);
        else if (staked < TIER_3) assertEq(rebate, 1_500);
        else assertEq(rebate, 3_000);
    }
}

/// Governance handover, the bonding views the dispute layer reads, and the solvency edge in
/// the reward accumulator.
contract StakingAdminTest is Test {
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event SlashSinkUpdated(address indexed account);
    event TreasuryUpdated(address indexed account);

    uint64 internal constant UNBONDING = 7 days;
    uint256 internal constant MIN_BOND = 1_000e18;

    BRSR internal brsr;
    MockUsdg internal usdg;
    Staking internal staking;

    address internal admin = makeAddr("timelock");
    address internal credit = makeAddr("creditManager");
    address internal treasury = makeAddr("treasury");
    address internal slashSink = makeAddr("slashSink");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdg = new MockUsdg();
        brsr = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: makeAddr("team"), treasury: treasury, liquidity: makeAddr("liquidity")
            })
        );
        staking = new Staking(brsr, usdg, admin, slashSink, treasury, UNBONDING, MIN_BOND);

        vm.prank(admin);
        staking.setCreditManager(credit);

        brsr.transfer(alice, 1_000_000e18);
        brsr.transfer(bob, 1_000_000e18);
        vm.prank(alice);
        brsr.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        brsr.approve(address(staking), type(uint256).max);
        usdg.approve(address(staking), type(uint256).max);
    }

    function _distribute(uint256 amount) internal {
        usdg.mint(credit, amount);
        vm.startPrank(credit);
        usdg.approve(address(staking), amount);
        staking.distribute(amount);
        vm.stopPrank();
    }

    function test_adminMovesInTwoStepsAndTheOldKeyStopsWorking() public {
        address next = makeAddr("multisig");

        vm.prank(stranger);
        vm.expectRevert(IStaking.NotAdmin.selector);
        staking.transferAdmin(next);

        vm.prank(admin);
        vm.expectRevert(IStaking.ZeroAddress.selector);
        staking.transferAdmin(address(0));

        vm.expectEmit(true, true, false, false, address(staking));
        emit AdminTransferStarted(admin, next);
        vm.prank(admin);
        staking.transferAdmin(next);

        // The handover is not done until the incoming key answers for itself.
        assertEq(staking.admin(), admin);
        assertEq(staking.pendingAdmin(), next);

        vm.prank(stranger);
        vm.expectRevert(IStaking.NotPendingAdmin.selector);
        staking.acceptAdmin();

        vm.expectEmit(true, true, false, false, address(staking));
        emit AdminTransferred(admin, next);
        vm.prank(next);
        staking.acceptAdmin();

        assertEq(staking.admin(), next);
        assertEq(staking.pendingAdmin(), address(0));

        vm.prank(admin);
        vm.expectRevert(IStaking.NotAdmin.selector);
        staking.pause();

        vm.prank(next);
        staking.pause();
    }

    function test_theSinkAndTheTreasuryMoveOnlyThroughGovernance() public {
        address newSink = makeAddr("newSink");
        address newTreasury = makeAddr("newTreasury");

        vm.prank(stranger);
        vm.expectRevert(IStaking.NotAdmin.selector);
        staking.setSlashSink(newSink);

        vm.startPrank(admin);
        vm.expectRevert(IStaking.ZeroAddress.selector);
        staking.setSlashSink(address(0));
        vm.expectEmit(true, false, false, false, address(staking));
        emit SlashSinkUpdated(newSink);
        staking.setSlashSink(newSink);

        vm.expectRevert(IStaking.ZeroAddress.selector);
        staking.setTreasury(address(0));
        vm.expectEmit(true, false, false, false, address(staking));
        emit TreasuryUpdated(newTreasury);
        staking.setTreasury(newTreasury);
        vm.stopPrank();

        assertEq(staking.slashSink(), newSink);
        assertEq(staking.treasury(), newTreasury);

        _distribute(500_000);
        staking.sweepUnallocated();
        assertEq(usdg.balanceOf(newTreasury), 500_000);
    }

    /// The floor arrives with the pool because the dispute layer reads it: a pool deployed at zero
    /// would bar every resolver from bonding at all until a forty-eight hour proposal landed.
    function test_theBondFloorIsSetAtConstructionAndZeroIsRefusedThere() public {
        assertEq(staking.minBond(), MIN_BOND);
        assertEq(staking.minBondOf(alice), MIN_BOND);
        assertEq(staking.bondFloorOf(alice), 0);
        assertTrue(staking.isBondable(alice, MIN_BOND));
        assertFalse(staking.isBondable(alice, MIN_BOND - 1));

        vm.expectRevert(IStaking.ZeroAmount.selector);
        new Staking(brsr, usdg, admin, slashSink, treasury, UNBONDING, 0);

        vm.prank(admin);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.setMinBond(0);

        vm.prank(admin);
        staking.setMinBond(25_000e18);
        assertTrue(staking.isBondable(alice, 25_000e18));
        assertFalse(staking.isBondable(alice, 24_999e18));

        // A per-resolver floor is the lever for a resolver that has been slashed before.
        vm.prank(admin);
        staking.setBondFloor(alice, 60_000e18);
        assertEq(staking.bondFloorOf(alice), 60_000e18);
        assertEq(staking.minBondOf(alice), 60_000e18);
        assertEq(staking.minBondOf(bob), 25_000e18);
        assertFalse(staking.isBondable(alice, 25_000e18));

        // Zero returns the resolver to the global floor.
        vm.prank(admin);
        staking.setBondFloor(alice, 0);
        assertEq(staking.minBondOf(alice), 25_000e18);

        vm.startPrank(admin);
        vm.expectRevert(IStaking.ZeroAddress.selector);
        staking.setBondFloor(address(0), 1e18);
        vm.expectRevert(IStaking.ZeroAddress.selector);
        staking.setBondingDenied(address(0), true);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(IStaking.NotAdmin.selector);
        staking.setBondFloor(alice, 1e18);
    }

    /// The spread stakers are told to expect is paid by the credit lane and by nothing else.
    /// Open to anyone, a stranger could move the accumulator that prices every claim and emit
    /// a distribution receipt for the price of a micro-dollar.
    function test_onlyTheCreditLaneCanPostTheSpread() public {
        usdg.mint(stranger, 1_000e6);
        vm.startPrank(stranger);
        usdg.approve(address(staking), type(uint256).max);
        vm.expectRevert(IStaking.NotCreditManager.selector);
        staking.distribute(1_000e6);
        vm.stopPrank();

        vm.prank(alice);
        staking.stake(1_000e18);

        _distribute(1_000e6);
        assertGt(staking.pendingRewards(alice), 0);
    }

    function test_aDeniedResolverCannotBondWhateverItPosts() public {
        vm.startPrank(admin);
        staking.setMinBond(1_000e18);
        staking.setBondingDenied(alice, true);
        vm.stopPrank();

        assertTrue(staking.bondingDenied(alice));
        assertFalse(staking.isBondable(alice, type(uint256).max));
        assertTrue(staking.isBondable(bob, 1_000e18));

        vm.prank(admin);
        staking.setBondingDenied(alice, false);
        assertTrue(staking.isBondable(alice, 1_000e18));
    }

    function test_thePreviewsAgreeWithWhatTheCallsDo() public {
        assertEq(staking.previewStake(1_000e18), 1_000e18 * 1_000);

        uint256 quoted = staking.previewStake(1_000e18);
        vm.prank(alice);
        assertEq(staking.stake(1_000e18), quoted);
        assertEq(staking.sharesOf(alice), quoted);

        uint256 shares = staking.sharesOf(alice);
        uint256 back = staking.previewUnbond(shares);
        vm.prank(alice);
        staking.requestUnbond(shares);
        vm.warp(block.timestamp + UNBONDING);
        vm.prank(alice);
        assertEq(staking.completeUnbond(), back);
    }

    function test_sweepingNothingIsRefusedAndADistributionOfNothingToo() public {
        vm.expectRevert(IStaking.NothingToClaim.selector);
        staking.sweepUnallocated();

        vm.prank(credit);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.distribute(0);

        vm.prank(alice);
        vm.expectRevert(IStaking.NothingToClaim.selector);
        staking.claimRewards();
    }

    /// The accumulator rounds once per distribution and a claim rounds once over the sum of
    /// them, so a run of small distributions can leave a claimant entitled to a micro-dollar
    /// or two more than was actually divided. Paying it out of somebody else's spread is how
    /// a pool like this ends up short for whoever claims last.
    function test_theLastClaimantIsNeverShort() public {
        vm.prank(alice);
        staking.stake(700_000e18);
        vm.prank(bob);
        staking.stake(300_000e18);

        for (uint256 i; i < 40; ++i) {
            _distribute(7);
        }

        uint256 taken;
        if (staking.pendingRewards(alice) != 0) {
            vm.prank(alice);
            taken += staking.claimRewards();
        }
        if (staking.pendingRewards(bob) != 0) {
            vm.prank(bob);
            taken += staking.claimRewards();
        }

        // Nobody was paid out of anybody else's share, and the balance still covers the books.
        assertLe(taken, 280);
        assertEq(usdg.balanceOf(address(staking)), 280 - taken);
        assertEq(
            staking.rewardsBacked() + staking.rewardResidual() + staking.unallocatedRewards(),
            usdg.balanceOf(address(staking))
        );
    }

    /// The edge in exact numbers. Three hundred BRSR buys 3e23 shares, and two distributions
    /// of one micro-dollar each divide to one micro-dollar between them while the accumulator
    /// says the staker has earned two. The claim pays the one that was actually divided; the
    /// second micro-dollar stays owed, never taken out of a pot that does not hold it.
    function test_aClaimCannotOutrunWhatWasDivided() public {
        vm.prank(alice);
        staking.stake(300e18);

        _distribute(1);
        _distribute(1);

        assertEq(staking.pendingRewards(alice), 2);
        assertEq(staking.rewardsBacked(), 1);
        assertEq(staking.rewardResidual(), 1);

        vm.prank(alice);
        assertEq(staking.claimRewards(), 1);
        assertEq(staking.rewardsBacked(), 0);
        assertEq(staking.pendingRewards(alice), 1);

        vm.prank(alice);
        vm.expectRevert(IStaking.NothingToClaim.selector);
        staking.claimRewards();

        // Still owed, and the next distribution settles it.
        _distribute(1_000_000);
        vm.prank(alice);
        assertGe(staking.claimRewards(), 1_000_000);
        assertEq(usdg.balanceOf(alice), 1_000_001);
    }

    /// A claim capped by what has been divided leaves the remainder owed, and the next
    /// distribution settles it.
    function test_aCappedClaimStaysOwedAndIsSettledNext() public {
        vm.prank(alice);
        staking.stake(1_000e18);

        for (uint256 i; i < 30; ++i) {
            _distribute(3);
        }

        uint256 owed = staking.pendingRewards(alice);
        vm.prank(alice);
        uint256 paid = staking.claimRewards();
        assertLe(paid, owed);

        uint256 stillOwed = staking.pendingRewards(alice);
        assertEq(stillOwed, owed - paid);

        _distribute(1_000_000);
        vm.prank(alice);
        uint256 second = staking.claimRewards();
        assertEq(usdg.balanceOf(alice), paid + second);
        assertGe(paid + second, owed);
    }
}
