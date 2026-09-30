// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BRSR} from "../../src/token/BRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";
import {IStaking} from "../../src/token/interfaces/IStaking.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

/// The way out of the pool. A request stops earning the block it is filed and keeps losing
/// until it completes, it has a window to complete in and lapses after it, and a pause holds
/// it for a bounded time and never costs it that window.
contract StakingExitsTest is Test {
    uint64 internal constant UNBONDING = 7 days;
    uint64 internal constant WINDOW = 7 days;
    uint64 internal constant HOLD = 7 days;
    uint256 internal constant MIN_BOND = 1_000e18;

    BRSR internal brsr;
    MockUsdg internal usdg;
    Staking internal staking;

    address internal admin = makeAddr("timelock");
    address internal credit = makeAddr("creditManager");
    address internal slasher = makeAddr("slasher");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

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

        vm.startPrank(admin);
        staking.setCreditManager(credit);
        staking.setSlasher(slasher);
        vm.stopPrank();

        address[2] memory who = [alice, bob];
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

    function _requestAll(address who) internal {
        uint256 shares = staking.sharesOf(who);
        vm.prank(who);
        staking.requestUnbond(shares);
    }

    function _distribute(uint256 amount) internal {
        usdg.mint(credit, amount);
        vm.startPrank(credit);
        usdg.approve(address(staking), amount);
        staking.distribute(amount);
        vm.stopPrank();
    }

    /// The trade a request that never lapsed and kept earning would allow: file an exit a year
    /// ahead, collect the spread the whole time, and leave in the block a loss is announced
    /// while the staker who stayed carries all of it. The request earns nothing from the block
    /// it is filed, it has lapsed long before the loss, and the loss lands on it in the same
    /// proportion as on everyone else.
    function test_unbond_requestLapsesAndStopsEarning() public {
        _stake(alice, 1_000_000e18);
        _stake(bob, 1_000_000e18);
        _requestAll(alice);

        vm.warp(block.timestamp + 400 days);
        _distribute(1_000_000e6);

        assertEq(staking.pendingRewards(alice), 0, "an exit request earned spread");
        assertApproxEqAbs(staking.pendingRewards(bob), 1_000_000e6, 2, "the staker who stayed was not paid");

        (uint256 owed,, uint64 lapsesAt) = staking.unbondOf(alice);
        assertEq(owed, 1_000_000e18);
        assertLt(lapsesAt, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStaking.UnbondLapsed.selector, lapsesAt));
        staking.completeUnbond();

        uint256 aliceBefore = staking.stakedValueOf(alice);
        uint256 bobBefore = staking.stakedValueOf(bob);
        uint256 everything = staking.totalStaked();
        vm.prank(slasher);
        uint256 taken = staking.slash(everything);
        assertEq(taken, 200_000e18, "the default cap is a tenth of the pool");

        uint256 aliceAfter = staking.stakedValueOf(alice);
        uint256 bobAfter = staking.stakedValueOf(bob);
        assertApproxEqRel(aliceAfter * bobBefore, bobAfter * aliceBefore, 1e12, "the early requester dodged part of it");
        assertApproxEqAbs(aliceAfter, 900_000e18, 1e6);

        // Filing again folds the lapsed request back in and starts the whole wait over.
        (owed,,) = staking.unbondOf(alice);
        uint256 again = staking.previewStake(owed);
        vm.prank(alice);
        staking.requestUnbond(again);
        vm.prank(alice);
        vm.expectRevert(IStaking.UnbondNotMatured.selector);
        staking.completeUnbond();

        vm.warp(block.timestamp + UNBONDING);
        vm.prank(alice);
        uint256 out = staking.completeUnbond();
        assertApproxEqAbs(out, 900_000e18, 1e6);
        assertApproxEqAbs(staking.stakedValueOf(bob), 900_000e18, 1e6);
    }

    /// A compound raises the earning pool only. The request keeps the value it was filed at,
    /// less any loss, and the compound goes to the staker who stayed.
    function test_anExitRequestEarnsNoCompounds() public {
        _stake(alice, 1_000e18);
        _stake(bob, 1_000e18);
        _requestAll(alice);

        staking.compound(200e18);

        (uint256 owed,,) = staking.unbondOf(alice);
        assertEq(owed, 1_000e18);
        assertApproxEqAbs(staking.stakedValueOf(bob), 1_200e18, 1e6);
        assertEq(staking.totalShares(), staking.sharesOf(bob));
        assertEq(staking.unbondingStaked(), 1_000e18);

        // Cancelling buys back in at the raised price, so it returns as fewer shares.
        uint256 sharesBefore = staking.sharesOf(bob);
        vm.prank(alice);
        staking.cancelUnbond();
        assertLt(staking.sharesOf(alice), sharesBefore);
        assertApproxEqAbs(staking.activeStakeOf(alice), 1_000e18, 1e6);
        assertApproxEqAbs(staking.stakedValueOf(bob), 1_200e18, 1e6);
    }

    /// Open from maturity for exactly the window, then closed for good.
    function test_aMaturedRequestIsOpenForTheWindowAndNoLonger() public {
        _stake(alice, 1_000e18);
        uint64 requestedAt = uint64(block.timestamp);
        _requestAll(alice);

        (, uint64 maturesAt, uint64 lapsesAt) = staking.unbondOf(alice);
        assertEq(maturesAt, requestedAt + UNBONDING);
        assertEq(lapsesAt, requestedAt + UNBONDING + WINDOW);

        uint256 snapshot = vm.snapshotState();
        vm.warp(lapsesAt - 1);
        vm.prank(alice);
        assertEq(staking.completeUnbond(), 1_000e18);
        vm.revertToState(snapshot);

        vm.warp(lapsesAt);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStaking.UnbondLapsed.selector, lapsesAt));
        staking.completeUnbond();
    }

    /// A lapsed request can be cancelled like any other, which puts the stake back to work,
    /// and an open one cannot be refiled on top of itself.
    function test_aLapsedRequestCanBeCancelledAndAnOpenOneCannotBeRefiled() public {
        _stake(alice, 1_000e18);
        uint256 shares = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnbond(shares / 2);

        vm.warp(block.timestamp + UNBONDING);
        vm.prank(alice);
        vm.expectRevert(IStaking.UnbondAlreadyRequested.selector);
        staking.requestUnbond(1);

        vm.warp(block.timestamp + WINDOW);
        vm.prank(alice);
        staking.cancelUnbond();
        assertEq(staking.unbondingStaked(), 0);
        assertEq(staking.totalUnbondingShares(), 0);
        assertApproxEqAbs(staking.activeStakeOf(alice), 1_000e18, 1e6);
    }

    /// The window moves on a proposal and reaches requests already pending, the same way the
    /// unbonding period does.
    function test_theWindowStaysInsideItsBoundsAndReachesPendingRequests() public {
        vm.startPrank(admin);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setUnbondWindow(1 days - 1);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setUnbondWindow(30 days + 1);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(IStaking.NotAdmin.selector);
        staking.setUnbondWindow(1 days);

        _stake(alice, 1_000e18);
        _requestAll(alice);
        vm.warp(block.timestamp + UNBONDING + 2 days);

        vm.prank(admin);
        staking.setUnbondWindow(1 days);
        vm.prank(alice);
        vm.expectPartialRevert(IStaking.UnbondLapsed.selector);
        staking.completeUnbond();

        vm.prank(admin);
        staking.setUnbondWindow(30 days);
        vm.prank(alice);
        staking.completeUnbond();
    }

    /// A pause is an outage. Matured exits stay closed for `maxExitHold` into it and then reopen
    /// whether or not anyone lifts it; new stake stays refused for as long as it lasts.
    function test_pause_completeUnbondReopensAfterTheHold() public {
        _stake(alice, 1_000e18);
        _requestAll(alice);
        vm.warp(block.timestamp + UNBONDING);

        vm.prank(admin);
        staking.pause();
        uint64 reopensAt = uint64(block.timestamp) + HOLD;
        assertEq(staking.exitsHeldUntil(), reopensAt);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStaking.ExitsHeld.selector, reopensAt));
        staking.completeUnbond();

        vm.warp(reopensAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStaking.ExitsHeld.selector, reopensAt));
        staking.completeUnbond();

        vm.warp(reopensAt);
        assertTrue(staking.paused());
        vm.prank(alice);
        assertEq(staking.completeUnbond(), 1_000e18);

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        staking.stake(1e18);
    }

    /// The time a pause spent holding exits is added to the window of every request it held,
    /// so a request that matured into a pause is still open once the pause lets it out.
    function test_aPauseDoesNotCostARequestItsWindow() public {
        _stake(alice, 1_000e18);
        _requestAll(alice);
        (,, uint64 lapsesAt) = staking.unbondOf(alice);

        // Paused a day before maturity and lifted after the request would otherwise have
        // lapsed. The seven days the pause held exits are added to the request's window.
        vm.warp(block.timestamp + UNBONDING - 1 days);
        vm.prank(admin);
        staking.pause();

        vm.warp(lapsesAt + 1);
        (,, uint64 extended) = staking.unbondOf(alice);
        assertEq(extended, lapsesAt + HOLD);

        vm.prank(admin);
        staking.unpause();
        vm.prank(alice);
        assertEq(staking.completeUnbond(), 1_000e18);
    }

    /// The hold a pause starts with is the hold it keeps. A proposal landing mid-pause cannot
    /// stretch it, and the setter stays inside its bounds.
    function test_theHoldIsFixedWhenThePauseStarts() public {
        vm.startPrank(admin);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setMaxExitHold(1 days - 1);
        vm.expectRevert(IStaking.BadConfig.selector);
        staking.setMaxExitHold(30 days + 1);

        staking.pause();
        uint64 heldUntil = staking.exitsHeldUntil();
        staking.setMaxExitHold(30 days);
        assertEq(staking.exitsHeldUntil(), heldUntil);

        staking.unpause();
        assertEq(staking.exitsHeldUntil(), 0);
        staking.pause();
        assertEq(staking.exitsHeldUntil(), uint64(block.timestamp) + 30 days);
        vm.stopPrank();
    }
}
