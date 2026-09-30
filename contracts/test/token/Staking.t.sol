// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BRSR} from "../../src/token/BRSR.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {IStaking} from "../../src/token/interfaces/IStaking.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

contract StakingTest is Test {
    BRSR internal brsr;
    MockUsdg internal usdg;
    Staking internal staking;

    address internal constant SLASH_SINK = address(0x51A5);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant CREDIT = address(0xC2ED);
    address internal constant SLASHER = address(0x51A5E2);

    uint64 internal constant UNBONDING = 7 days;
    uint256 internal constant MIN_BOND = 1_000e18;

    address[3] internal stakers;

    function setUp() public {
        stakers = [address(0xA11CE), address(0xB0B), address(0xCA501)];

        usdg = new MockUsdg();
        brsr = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: address(0xDEAD1), treasury: TREASURY, liquidity: address(0xDEAD2)
            })
        );
        staking = new Staking(brsr, usdg, address(this), SLASH_SINK, TREASURY, UNBONDING, MIN_BOND);
        staking.setCreditManager(CREDIT);
        staking.setSlasher(SLASHER);
        // These cases are about where a loss lands, not how fast one may. The cap has its own.
        staking.setSlashLimit(10_000, 1 days);

        for (uint256 i; i < stakers.length; ++i) {
            brsr.transfer(stakers[i], 10_000_000e18);
            vm.prank(stakers[i]);
            brsr.approve(address(staking), type(uint256).max);
        }

        usdg.approve(address(staking), type(uint256).max);
    }

    function _distribute(uint256 amount) internal {
        usdg.mint(CREDIT, amount);
        vm.startPrank(CREDIT);
        usdg.approve(address(staking), amount);
        staking.distribute(amount);
        vm.stopPrank();
    }

    function _stake(address staker, uint256 amount) internal {
        vm.prank(staker);
        staking.stake(amount);
    }

    function test_supplyIsSplitAndFixed() public view {
        assertEq(brsr.totalSupply(), 1_000_000_000e18);
        assertEq(brsr.balanceOf(address(0xDEAD1)), 100_000_000e18);
        assertEq(brsr.balanceOf(TREASURY), 50_000_000e18);
        assertEq(brsr.balanceOf(address(0xDEAD2)), 50_000_000e18);
        assertEq(brsr.decimals(), 18);
        assertEq(brsr.CLOCK_MODE(), "mode=timestamp");
    }

    function test_spreadSplitsProRata() public {
        _stake(stakers[0], 300e18);
        _stake(stakers[1], 100e18);

        _distribute(4_000_000);

        assertApproxEqAbs(staking.pendingRewards(stakers[0]), 3_000_000, 3);
        assertApproxEqAbs(staking.pendingRewards(stakers[1]), 1_000_000, 3);

        uint256 owed = staking.pendingRewards(stakers[0]);
        vm.prank(stakers[0]);
        assertEq(staking.claimRewards(), owed);
        assertEq(usdg.balanceOf(stakers[0]), owed);
        assertEq(staking.pendingRewards(stakers[0]), 0);
    }

    function test_spreadIgnoresStakeArrivingAfterIt() public {
        _stake(stakers[0], 100e18);
        _distribute(1_000_000);
        _stake(stakers[1], 100e18);
        _distribute(1_000_000);

        assertApproxEqAbs(staking.pendingRewards(stakers[0]), 1_500_000, 3);
        assertApproxEqAbs(staking.pendingRewards(stakers[1]), 500_000, 3);
    }

    function test_distributionTooSmallToDivideIsCarried() public {
        _stake(stakers[0], 1_000_000e18);

        _distribute(1);
        _distribute(1);

        assertEq(staking.pendingRewards(stakers[0]), 2);
        assertEq(staking.rewardResidual(), 0);
    }

    function test_spreadWithNothingStakedParksForTreasury() public {
        _distribute(500_000);
        assertEq(staking.unallocatedRewards(), 500_000);

        staking.sweepUnallocated();
        assertEq(usdg.balanceOf(TREASURY), 500_000);
    }

    function test_exitTakesTheLossItWasExposedTo() public {
        _stake(stakers[0], 1_000e18);
        _stake(stakers[1], 1_000e18);

        uint256 shares = staking.sharesOf(stakers[0]);
        vm.prank(stakers[0]);
        staking.requestUnbond(shares);

        vm.prank(SLASHER);
        staking.slash(1_000e18);

        vm.warp(block.timestamp + UNBONDING);
        vm.prank(stakers[0]);
        uint256 returned = staking.completeUnbond();

        assertApproxEqRel(returned, 500e18, 1e12);
        assertApproxEqRel(staking.stakedValueOf(stakers[1]), 500e18, 1e12);
        assertEq(brsr.balanceOf(SLASH_SINK), 1_000e18);
    }

    function test_unbondBeforeMaturityIsRefused() public {
        _stake(stakers[0], 100e18);

        uint256 shares = staking.sharesOf(stakers[0]);
        vm.prank(stakers[0]);
        staking.requestUnbond(shares);

        vm.warp(block.timestamp + UNBONDING - 1);
        vm.prank(stakers[0]);
        vm.expectRevert(IStaking.UnbondNotMatured.selector);
        staking.completeUnbond();
    }

    function test_pauseHoldsExitsAndDeposits() public {
        _stake(stakers[0], 100e18);
        uint256 shares = staking.sharesOf(stakers[0]);
        vm.prank(stakers[0]);
        staking.requestUnbond(shares);
        vm.warp(block.timestamp + UNBONDING);

        staking.pause();

        vm.prank(stakers[0]);
        vm.expectRevert(abi.encodeWithSelector(IStaking.ExitsHeld.selector, uint64(block.timestamp) + 7 days));
        staking.completeUnbond();

        vm.prank(stakers[1]);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        staking.stake(1e18);

        staking.unpause();
        vm.prank(stakers[0]);
        staking.completeUnbond();
    }

    function test_claimStaysOpenWhilePaused() public {
        _stake(stakers[0], 100e18);
        _distribute(1_000_000);
        staking.pause();

        vm.prank(stakers[0]);
        assertEq(staking.claimRewards(), 1_000_000);
    }

    function test_totalLossClearsSharesAndKeepsAccruedSpread() public {
        _stake(stakers[0], 1_000e18);
        _distribute(2_000_000);

        vm.prank(SLASHER);
        staking.slash(type(uint128).max);

        assertEq(staking.totalStaked(), 0);
        assertEq(staking.totalShares(), 0);
        assertEq(staking.wipeEpoch(), 1);
        assertEq(staking.stakedValueOf(stakers[0]), 0);
        assertEq(staking.pendingRewards(stakers[0]), 2_000_000);

        vm.prank(stakers[0]);
        assertEq(staking.claimRewards(), 2_000_000);
        assertEq(staking.sharesOf(stakers[0]), 0);

        // The pool restarts from nothing, and the spread it earns is the new stakers' alone.
        _stake(stakers[1], 1_000e18);
        _distribute(1_000_000);
        assertEq(staking.pendingRewards(stakers[1]), 1_000_000);
        assertEq(staking.pendingRewards(stakers[0]), 0);
    }

    function test_compoundRaisesEveryShare() public {
        _stake(stakers[0], 100e18);
        _stake(stakers[1], 100e18);

        brsr.approve(address(staking), 50e18);
        staking.compound(50e18);

        assertApproxEqRel(staking.stakedValueOf(stakers[0]), 125e18, 1e12);
        assertApproxEqRel(staking.stakedValueOf(stakers[1]), 125e18, 1e12);
    }

    function test_rebateTiersReadActiveStakeOnly() public {
        IStaking.Tier[] memory tiers = new IStaking.Tier[](3);
        tiers[0] = IStaking.Tier({minStake: 1_000e18, rebateBps: 500});
        tiers[1] = IStaking.Tier({minStake: 10_000e18, rebateBps: 1_500});
        tiers[2] = IStaking.Tier({minStake: 100_000e18, rebateBps: 3_000});
        staking.setTiers(tiers);

        _stake(stakers[0], 10_000e18);
        assertEq(staking.rebateBpsOf(stakers[0]), 1_500);

        uint256 half = staking.sharesOf(stakers[0]) / 2;
        vm.prank(stakers[0]);
        staking.requestUnbond(half);
        assertEq(staking.rebateBpsOf(stakers[0]), 500);

        assertEq(staking.rebateBpsOf(stakers[2]), 0);
    }

    function test_tiersMustAscendInBothColumns() public {
        IStaking.Tier[] memory tiers = new IStaking.Tier[](2);
        tiers[0] = IStaking.Tier({minStake: 10_000e18, rebateBps: 1_500});
        tiers[1] = IStaking.Tier({minStake: 1_000e18, rebateBps: 3_000});

        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setTiers(tiers);
    }

    function test_aTierAboveTheRebateCeilingIsRefused() public {
        IStaking.Tier[] memory tiers = new IStaking.Tier[](1);
        tiers[0] = IStaking.Tier({minStake: 1e18, rebateBps: 5_001});

        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setTiers(tiers);
    }

    function test_aPerResolverFloorAndADenialBothOverrideTheGlobalBond() public {
        staking.setMinBond(25_000e18);
        assertEq(staking.minBondOf(stakers[0]), 25_000e18);
        assertTrue(staking.isBondable(stakers[0], 25_000e18));
        assertFalse(staking.isBondable(stakers[0], 24_999e18));

        staking.setBondFloor(stakers[0], 50_000e18);
        assertFalse(staking.isBondable(stakers[0], 25_000e18));
        assertTrue(staking.isBondable(stakers[0], 50_000e18));

        staking.setBondingDenied(stakers[0], true);
        assertFalse(staking.isBondable(stakers[0], 1_000_000e18));
    }

    /// The credit lane pays the spread in and nothing more. Taking stake is the slasher's alone.
    function test_onlyTheSlasherCanSlash() public {
        _stake(stakers[0], 100e18);

        vm.expectRevert(IStaking.NotSlasher.selector);
        staking.slash(1e18);

        vm.prank(CREDIT);
        vm.expectRevert(IStaking.NotSlasher.selector);
        staking.slash(1e18);

        vm.prank(SLASHER);
        assertEq(staking.slash(1e18), 1e18);
    }

    /// The unit trap, proved instead of argued: eighteen-decimal shares divide six-decimal
    /// spread, and across any sequence of stakes, distributions and claims the pool pays out
    /// what it took in, minus at most one micro-dollar of truncation per settlement point,
    /// and that remainder stays in the contract instead of vanishing.
    function testFuzz_noDustCreatedOrDestroyed(uint96[6] memory stakes, uint64[6] memory spread, uint8 claimMask)
        public
    {
        uint256 distributed;
        uint256 settlements;

        for (uint256 round; round < 6; ++round) {
            address staker = stakers[round % stakers.length];

            _stake(staker, bound(stakes[round], 1e15, 1_000_000e18));
            settlements += 1;

            uint256 amount = bound(spread[round], 1, 1_000_000e6);
            _distribute(amount);
            distributed += amount;

            if ((claimMask >> round) & 1 == 1 && staking.pendingRewards(staker) != 0 && staking.rewardsBacked() != 0) {
                vm.prank(staker);
                staking.claimRewards();
                settlements += 1;
            }
        }

        uint256 claimed;
        uint256 pending;
        for (uint256 i; i < stakers.length; ++i) {
            if (staking.pendingRewards(stakers[i]) != 0 && staking.rewardsBacked() != 0) {
                vm.prank(stakers[i]);
                staking.claimRewards();
                settlements += 1;
            }
            claimed += usdg.balanceOf(stakers[i]);
            pending += staking.pendingRewards(stakers[i]);
        }

        assertEq(staking.unallocatedRewards(), 0);
        // Anything a staker is still owed is the rounding the cap held back, not a share of
        // the spread that went missing.
        assertLe(pending, settlements + 12);

        // Nothing was created and nothing was destroyed: every micro-dollar taken in is
        // either paid out, still divided across shares, or carried for the next division.
        assertEq(usdg.balanceOf(address(staking)), distributed - claimed);
        assertEq(
            staking.rewardsBacked() + staking.rewardResidual() + staking.unallocatedRewards(), distributed - claimed
        );

        // What is left behind is truncation dust, not a lost distribution: one
        // micro-dollar per settlement point and a couple per division, no more.
        assertLe(staking.rewardsBacked() + staking.rewardResidual(), settlements + 12);
    }

    /// Stake is conserved the same way: shares round in the pool's favour on the way in and
    /// on the way out, so a round trip never returns more BRSR than it put in and the balance
    /// never falls behind the book.
    function testFuzz_stakeRoundTripNeverGains(uint96 first, uint96 second) public {
        uint256 a = bound(first, 1e15, 5_000_000e18);
        uint256 b = bound(second, 1e15, 5_000_000e18);

        _stake(stakers[0], a);
        _stake(stakers[1], b);

        uint256 shares = staking.sharesOf(stakers[0]);
        vm.prank(stakers[0]);
        staking.requestUnbond(shares);
        vm.warp(block.timestamp + UNBONDING);
        vm.prank(stakers[0]);
        uint256 returned = staking.completeUnbond();

        assertLe(returned, a);
        assertGe(brsr.balanceOf(address(staking)), staking.totalStaked());
    }
}
