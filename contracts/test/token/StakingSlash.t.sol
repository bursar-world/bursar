// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {BRSR} from "../../src/token/BRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";
import {IStaking} from "../../src/token/interfaces/IStaking.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

/// How fast a loss can reach the pool, and what happens when one leaves almost nothing behind.
contract StakingSlashTest is Test {
    event Slashed(uint256 requested, uint256 taken, uint256 remaining);
    event SlashLimitUpdated(uint16 capBps, uint64 window);

    uint64 internal constant UNBONDING = 7 days;
    uint256 internal constant MIN_BOND = 1_000e18;

    BRSR internal brsr;
    MockUsdg internal usdg;
    Staking internal staking;

    address internal admin = makeAddr("timelock");
    address internal credit = makeAddr("creditManager");
    address internal slasher = makeAddr("slasher");
    address internal slashSink = makeAddr("slashSink");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

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
        staking = new Staking(brsr, usdg, admin, slashSink, makeAddr("treasury"), UNBONDING, MIN_BOND);

        vm.startPrank(admin);
        staking.setCreditManager(credit);
        staking.setSlasher(slasher);
        vm.stopPrank();

        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < who.length; ++i) {
            brsr.transfer(who[i], 200_000_000e18);
            vm.prank(who[i]);
            brsr.approve(address(staking), type(uint256).max);
        }
        brsr.approve(address(staking), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(amount);
    }

    function _slash(uint256 amount) internal returns (uint256) {
        vm.prank(slasher);
        return staking.slash(amount);
    }

    function _distribute(uint256 amount) internal {
        usdg.mint(credit, amount);
        vm.startPrank(credit);
        usdg.approve(address(staking), amount);
        staking.distribute(amount);
        vm.stopPrank();
    }

    function _liftCap(uint64 window) internal {
        vm.prank(admin);
        staking.setSlashLimit(10_000, window);
    }

    /// A tenth of the pool at once by default, and the allowance grows back evenly over a week.
    /// What the cap leaves is the lender's.
    function test_theSlasherTakesAtMostTheCapAndItRefillsOverTheWindow() public {
        assertEq(staking.slashCapBps(), 1_000);
        assertEq(staking.slashWindow(), 7 days);

        _stake(alice, 1_000e18);
        _stake(bob, 1_000e18);
        assertEq(staking.slashAllowance(), 200e18);

        vm.expectEmit(false, false, false, true, address(staking));
        emit Slashed(1_000e18, 200e18, 1_800e18);
        assertEq(_slash(1_000e18), 200e18);
        assertEq(brsr.balanceOf(slashSink), 200e18);
        assertEq(staking.slashAllowance(), 0);
        assertEq(_slash(1), 0);

        // Half the window gives back half the cap, as a share of the pool as it now stands.
        vm.warp(block.timestamp + 3.5 days);
        assertApproxEqAbs(staking.slashAllowance(), 90e18, 1e6);

        vm.warp(block.timestamp + 3.5 days);
        assertEq(staking.slashAllowance(), 180e18);
        assertEq(_slash(type(uint256).max), 180e18);
        assertEq(staking.totalStaked(), 1_620e18);
    }

    /// Small slashes add up against the same allowance, each charged as the share of the pool it
    /// took and rounded up, so a run of them never takes more than the cap between them.
    function test_aRunOfSmallSlashesAddsUpToNoMoreThanTheCap() public {
        _stake(alice, 1_000_000e18);
        uint256 before = staking.totalStaked();

        uint256 taken;
        for (uint256 i; i < 40; ++i) {
            taken += _slash(before / 100);
        }

        assertLe(taken, before / 10);
        // Charged against a shrinking pool, ten one-per-cent bites come to a little under a tenth.
        assertGt(taken, (before * 95) / 1_000);
        assertEq(staking.slashAllowance(), 0);
    }

    /// Moving the limit carries the allowance already used over at its current level. It
    /// neither hands the slasher a fresh one nor takes back what has refilled.
    function test_theLimitStaysInsideItsBoundsAndCarriesTheAllowanceOver() public {
        vm.startPrank(admin);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setSlashLimit(0, 7 days);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setSlashLimit(10_001, 7 days);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setSlashLimit(1_000, 1 days - 1);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setSlashLimit(1_000, 90 days + 1);
        vm.stopPrank();

        vm.prank(slasher);
        vm.expectRevert(IStaking.NotAdmin.selector);
        staking.setSlashLimit(10_000, 1 days);

        _stake(alice, 1_000e18);
        _slash(1_000e18);
        assertEq(staking.slashAllowance(), 0);

        // Doubling the cap leaves the tenth already used in place and opens the rest.
        vm.expectEmit(false, false, false, true, address(staking));
        emit SlashLimitUpdated(2_000, 7 days);
        vm.prank(admin);
        staking.setSlashLimit(2_000, 7 days);
        assertApproxEqAbs(staking.slashAllowance(), 90e18, 1e6);

        // Halving it with the load at the old cap leaves nothing until the load drains.
        vm.prank(admin);
        staking.setSlashLimit(500, 7 days);
        assertEq(staking.slashAllowance(), 0);
    }

    /// A slash that leaves a remainder too small to matter used to keep every old share alive
    /// against it. The next deposit then minted shares at a price near zero, a distribution of
    /// a million dollars divided into nothing and sat unclaimable in the residual, and a second
    /// round overflowed `stake`. A slash that would leave less than a thousandth of the pool now
    /// takes all of it and starts the pool over.
    function test_slash_dustRemainderWipesThePool() public {
        _liftCap(1 days);

        _stake(alice, 100_000_000e18);
        uint256 all = staking.totalStaked();
        assertEq(_slash(all - 1), all);
        assertEq(staking.wipeEpoch(), 1);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.totalShares(), 0);
        assertEq(brsr.balanceOf(slashSink), all);

        // The next deposit prices from scratch and the spread divides across it in full.
        _stake(bob, 1_000_000e18);
        assertEq(staking.sharesOf(bob), 1_000_000e18 * 1_000);
        _distribute(1_000_000e6);
        assertEq(staking.rewardsBacked(), 1_000_000e6);
        assertEq(staking.rewardResidual(), 0);
        assertEq(staking.pendingRewards(bob), 1_000_000e6);

        vm.warp(block.timestamp + 1 days);
        all = staking.totalStaked();
        assertEq(_slash(all - 1), all);
        assertEq(staking.wipeEpoch(), 2);

        _stake(carol, 1_000_000e18);
        _stake(carol, 1_000_000e18);
        assertEq(staking.sharesOf(carol), 2_000_000e18 * 1_000);

        // Nothing earned before either wipe was lost to it.
        vm.prank(bob);
        assertEq(staking.claimRewards(), 1_000_000e6);
    }

    /// Short of dust, a slash leaves the pool as it found it apart from the loss. A thousandth
    /// left over is not dust.
    function test_aThousandthLeftOverIsNotDust() public {
        _liftCap(1 days);
        _stake(alice, 1_000e18);

        assertEq(_slash(999e18), 999e18);
        assertEq(staking.wipeEpoch(), 0);
        assertEq(staking.totalStaked(), 1e18);
        assertApproxEqAbs(staking.stakedValueOf(alice), 1e18, 1e6);
    }

    /// A pool whose share has fallen below a millionth of its issue price takes no new stake: a
    /// deposit there would mint shares by the billion per wei. Compounds lift it back, and the
    /// stakers already inside can leave throughout.
    function test_aPoolThatLostNearlyEverythingTakesNoNewStake() public {
        _liftCap(1 days);
        _stake(alice, 1_000e18);

        for (uint256 i; i < 3; ++i) {
            uint256 pool = staking.totalStaked();
            _slash(pool - pool / 500);
            vm.warp(block.timestamp + 1 days);
        }
        assertEq(staking.wipeEpoch(), 0);

        vm.prank(bob);
        vm.expectRevert(IStaking.PoolCollapsed.selector);
        staking.stake(1_000e18);

        staking.compound(1e18);
        _stake(bob, 1_000e18);
        assertApproxEqRel(staking.activeStakeOf(bob), 1_000e18, 1e12);

        uint256 shares = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(shares);
    }

    /// A pending exit is part of the pool a loss comes out of, in the same proportion.
    function test_aSlashReachesPendingExitsProRata() public {
        _stake(alice, 3_000e18);
        _stake(bob, 1_000e18);
        uint256 shares = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(shares);

        _slash(400e18);

        (uint256 owed,,) = staking.unbondOf(alice);
        assertEq(owed, 2_700e18);
        assertApproxEqAbs(staking.stakedValueOf(bob), 900e18, 1e6);
        assertEq(staking.unbondingStaked(), 2_700e18);
        assertEq(staking.totalStaked(), 3_600e18);
    }
}
