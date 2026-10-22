// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MandateAccount} from "../../src/MandateAccount.sol";
import {IMandateAccount} from "../../src/interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../../src/interfaces/IMandateAccountFactory.sol";
import {IPoolManager, PoolKey} from "../../src/token/Buyback.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../../src/rwa/StockSpendRouter.sol";
import {TreasuryPark} from "../../src/rwa/TreasuryPark.sol";
import {V4Swapper} from "../../src/rwa/V4Swapper.sol";
import {RobinhoodStockAdapter} from "../../src/rwa/adapters/RobinhoodStockAdapter.sol";
import {UsdgAdapter} from "../../src/rwa/adapters/UsdgAdapter.sol";
import {IAccessRegistry, IStateView} from "../../src/rwa/interfaces/IRwaExternal.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {FakeMandate, MockAccess, MockAccounts, MockEscrow, MockFeed, MockStock, MockV4} from "./RwaMocks.sol";

import {RwaFixture} from "./RwaFixture.sol";

contract RwaTest is RwaFixture {
    function test_registry_knowsAnAssetByAddressAndRefusesALookalike() public {
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotRegistered.selector, address(lookalike)));
        reg.get(address(lookalike));
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotRegistered.selector, address(lookalike)));
        guard.tradePrice(address(lookalike), address(acct));
        assertEq(reg.assets().length, 2);
        assertEq(reg.get(address(sgov)).decimals, 18);
    }

    function test_registry_refusesNonAdminsAndIneligibleAssetsCannotTrade() public {
        AssetRegistry.Asset memory c = reg.get(address(spy));
        vm.expectRevert(AssetRegistry.NotAdmin.selector);
        reg.setAsset(address(spy), c);
        vm.prank(admin);
        reg.setEligible(address(spy), false);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NotEligible.selector, address(spy)));
        guard.tradePrice(address(spy), address(acct));
    }

    function test_registry_refusesHookedPoolAndBadFeed() public {
        AssetRegistry.Asset memory c = reg.get(address(spy));
        c.pool.hooks = address(0xdead);
        vm.prank(admin);
        vm.expectRevert(AssetRegistry.BadPool.selector);
        reg.setAsset(address(spy), c);

        c = reg.get(address(spy));
        MockFeed f = new MockFeed();
        f.setDecimals(18);
        c.feed = address(f);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.FeedNot8Decimals.selector, address(f)));
        reg.setAsset(address(spy), c);
    }

    function test_registry_rejectsWideBandAndLongStaleness() public {
        AssetRegistry.Asset memory c = reg.get(address(spy));
        c.bandBps = 501;
        _expectBadBounds(c);
        c.bandBps = 500;
        c.tradeStaleness = 7 days;
        c.valuationStaleness = 14 days;
        vm.prank(admin);
        reg.setAsset(address(spy), c);

        c = reg.get(address(spy));
        c.tradeStaleness = 7 days + 1;
        _expectBadBounds(c);

        c = reg.get(address(spy));
        c.valuationStaleness = 14 days + 1;
        _expectBadBounds(c);

        c = reg.get(address(spy));
        c.perMandateCap = c.totalCap + 1;
        _expectBadBounds(c);
    }

    function test_guard_midMatchesFeed() public view {
        uint256 mid = guard.poolPriceE8(address(spy));
        assertApproxEqRel(mid, SPY_E8, 1e12);
        mid = guard.poolPriceE8(address(sgov));
        assertApproxEqRel(mid, SGOV_E8, 1e12);
    }

    function test_buy_deliversToMandate() public {
        vm.prank(agent);
        uint256 out = acct.buy(address(spy), 1e6, 0, SPY_E8);
        assertEq(spy.balanceOf(address(acct)), out);
        assertApproxEqRel(out, _filled(Math.mulDiv(1e6, 1e20, SPY_E8), address(spy)), 1e12);
        assertEq(usdg.balanceOf(address(acct)), 199e6);
        assertEq(acct.totalSpent(), 1e6);
    }

    function test_buy_refusesAMandateWithoutTheRwaClass() public {
        vm.prank(principal);
        acct.setLimits(_limits(3));
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ClassNotAllowed.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_refusesAnAssetOffTheMandatesList() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.AssetNotAllowed.selector, address(sgov)));
        acct.buy(address(sgov), 1e6, 0, SGOV_E8);
    }

    function test_buy_refusesTheTreasuryToken() public {
        _allow(address(sgov));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.NotAStock.selector, address(sgov)));
        acct.buy(address(sgov), 1e6, 0, SGOV_E8);
    }

    function test_buy_refusesATradeAboveThePerTradeCap() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.TradeCapExceeded.selector, 26e6, 25e6));
        acct.buy(address(spy), 26e6, 0, SPY_E8);
    }

    function test_buy_refusesAStaleFeed() public {
        vm.warp(block.timestamp + H26 + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.StalePrice.selector, address(spy), H26 + 1, H26));
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_refusesWhileTheOracleIsPaused() public {
        spy.setOraclePaused(true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.OraclePaused.selector, address(spy)));
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_refusesWhileTheTokenIsPaused() public {
        spy.setTokenPaused(true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.TokenPaused.selector, address(spy)));
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_refusesABlockedAccount() public {
        access.setBlocked(address(acct), true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.Blocked.selector, address(acct)));
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_refusesWhileTheAccessRegistryIsPaused() public {
        access.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(PriceGuard.AccessPaused.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    /// A fresh round 1e8 too large, caught against the pool's price.
    function test_buy_refusesAMisScaledFeed() public {
        spyFeed.set(int256(SPY_E8 * 1e8), block.timestamp);
        uint256 mid = guard.poolPriceE8(address(spy));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.PoolPriceDeviation.selector, address(spy), mid, SPY_E8 * 1e8));
        acct.buy(address(spy), 1e6, 0, SPY_E8 * 1e8);
    }

    function test_buy_refusesAPoolOutsideTheFeedBand() public {
        spyFeed.set(int256(SPY_E8 * 102 / 100), block.timestamp);
        vm.prank(agent);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8 * 102 / 100);
    }

    function test_buy_refusesAQuoteOutsideTheBand() public {
        uint256 quoted = SPY_E8 * 102 / 100;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.PriceOutsideBand.selector, address(spy), quoted, SPY_E8));
        acct.buy(address(spy), 1e6, 0, quoted);
    }

    function test_buy_refusesAFillWorseThanTheSlippageLimit() public {
        v4.setHaircut(150);
        vm.prank(agent);
        vm.expectPartialRevert(V4Swapper.SwapShort.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8);

        // The mandate's own limit binds tighter than the asset's band.
        v4.setHaircut(30);
        _policy(20);
        vm.prank(agent);
        vm.expectPartialRevert(V4Swapper.SwapShort.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8);

        v4.setHaircut(10);
        vm.prank(agent);
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    /// A purchase must leave the pool inside the band as well as find it there. Pushed to the
    /// band's edge earlier in the same transaction, the pool would let the fill run past it.
    function test_buy_refusesManipulatedFill() public {
        v4.setImpact(50);
        _setPool(spy, SPY_E8 * 10_080 / 10_000); // 80 bps over the feed, inside the 100 bps band
        vm.prank(agent);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8);

        _setPool(spy, SPY_E8);
        vm.prank(agent);
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_onlyPrincipalSetsPolicy() public {
        vm.prank(agent);
        vm.expectRevert(StockSpendRouter.NotPrincipal.selector);
        router.setPolicy(address(acct), 0, new address[](0), new bool[](0));
    }

    function test_park_valuesAtRawTimesFeed() public {
        uint256 raw = _park(50e6);
        (uint256 r, uint256 basis, uint256 value,,, bool fresh) = park.position(address(acct), address(sgovAdapter));
        assertEq(r, raw);
        assertEq(basis, 50e6);
        assertTrue(fresh);
        assertEq(value, Math.mulDiv(raw, SGOV_E8, 1e20));
        assertApproxEqAbs(value, _filled(50e6, address(sgov)), 2);
        assertEq(sgov.balanceOf(address(sgovAdapter)), raw);
        assertEq(park.spendingPower(address(acct)), 150e6 + Math.mulDiv(value, 9_950, 10_000));
    }

    function test_park_refusesToDipBelowTheBuffer() public {
        vm.prank(principal);
        park.setBuffer(address(acct), 160e6);
        address vault = park.vaultOf(address(acct));
        vm.prank(principal);
        acct.withdraw(address(usdg), vault, 50e6);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.BelowBuffer.selector, 150e6, 160e6));
        park.park(address(acct), address(sgovAdapter), 50e6, 0);
    }

    function test_park_refusesPastTheMandateCapAndTheSharedCap() public {
        _park(100e6);
        address vault = park.vaultOf(address(acct));
        vm.prank(principal);
        acct.withdraw(address(usdg), vault, 1e6);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.MandateCapExceeded.selector, 101e6, 100e6));
        park.park(address(acct), address(sgovAdapter), 1e6, 0);

        // A second mandate under its own cap still meets the one they share.
        AssetRegistry.Asset memory c = reg.get(address(sgov));
        c.totalCap = 100e6;
        vm.prank(admin);
        reg.setAsset(address(sgov), c);
        MandateAccount second = new MandateAccount(principal, agent, address(usdg), address(escrow), _limits(7));
        accounts.add(principal, address(second));
        usdg.mint(park.vaultOf(address(second)), 1e6);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.TotalCapExceeded.selector, 101e6, 100e6));
        park.park(address(second), address(sgovAdapter), 1e6, 0);
    }

    function test_park_staleFeedStopsTradesFirstAndValueLater() public {
        uint256 raw = _park(50e6);

        vm.warp(block.timestamp + H26 + 1);
        address vault = park.vaultOf(address(acct));
        vm.prank(principal);
        acct.withdraw(address(usdg), vault, 1e6);
        vm.prank(principal);
        vm.expectPartialRevert(PriceGuard.StalePrice.selector);
        park.park(address(acct), address(sgovAdapter), 1e6, 0);
        vm.prank(principal);
        vm.expectPartialRevert(PriceGuard.StalePrice.selector);
        park.unpark(address(acct), address(sgovAdapter), raw, 0);
        // Past the trade bound and inside the valuation bound, the position still counts.
        (uint256 total,) = park.parkedValue(address(acct));
        assertGt(total, 0);

        vm.warp(block.timestamp + H100);
        (total,) = park.parkedValue(address(acct));
        assertEq(total, 0);
        (,, uint256 value,,, bool fresh) = park.position(address(acct), address(sgovAdapter));
        assertEq(value, 0);
        assertFalse(fresh);
        assertEq(park.spendingPower(address(acct)), 150e6);
    }

    function test_park_oraclePausedCountsZero() public {
        _park(50e6);
        sgov.setOraclePaused(true);
        (uint256 total,) = park.parkedValue(address(acct));
        assertEq(total, 0);
    }

    function test_park_pausedTokenOrAccessCountsZero() public {
        _park(50e6);
        sgov.setTokenPaused(true);
        (uint256 total,) = park.parkedValue(address(acct));
        assertEq(total, 0);
        sgov.setTokenPaused(false);
        access.setPaused(true);
        (total,) = park.parkedValue(address(acct));
        assertEq(total, 0);
        assertEq(park.spendingPower(address(acct)), 150e6);
    }

    /// Parked value off a mis-scaled answer would be spent before anyone noticed; the pool
    /// catches it the way it catches a trade.
    function test_park_misScaledFeedCountsZero() public {
        _park(50e6);
        sgovFeed.set(int256(SGOV_E8 * 1e8), block.timestamp);
        (uint256 total,) = park.parkedValue(address(acct));
        assertEq(total, 0);
        (,,,,, bool fresh) = park.position(address(acct), address(sgovAdapter));
        assertFalse(fresh);
        assertEq(park.spendingPower(address(acct)), 150e6);
    }

    function test_unpark_refusesManipulatedFill() public {
        uint256 raw = _park(50e6);
        v4.setImpact(30);
        _setPool(sgov, SGOV_E8 * 9_970 / 10_000); // 30 bps under the feed, inside the 50 bps band
        vm.prank(principal);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        park.unpark(address(acct), address(sgovAdapter), raw, 0);
    }

    function test_unpark_returnsUsdgToMandate() public {
        uint256 raw = _park(50e6);
        vm.prank(agent);
        uint256 out = park.unpark(address(acct), address(sgovAdapter), raw, 0);
        assertApproxEqAbs(out, _filled(_filled(50e6, address(sgov)), address(sgov)), 2);
        assertEq(usdg.balanceOf(address(acct)), 150e6 + out);
        (uint256 r, uint256 basis,,,,) = park.position(address(acct), address(sgovAdapter));
        assertEq(r, 0);
        assertEq(basis, 0);
        assertEq(park.totalBasis(address(sgovAdapter)), 0);
    }

    function test_spend_unparksShortfallInSameTx() public {
        _park(100e6);
        vm.prank(principal);
        acct.withdraw(address(usdg), principal, 95e6);

        vm.prank(agent);
        acct.spend(_req(20e6), new bytes32[](0));
        assertEq(usdg.balanceOf(address(escrow)), 20e6);
        assertEq(usdg.balanceOf(address(acct)), 0);
        (,, uint256 value,,,) = park.position(address(acct), address(sgovAdapter));
        assertApproxEqAbs(value, _filled(100e6, address(sgov)) - _cost(15e6, address(sgov)), 10);
    }

    function test_spend_cannotDrawOnStaleParkedValue() public {
        _park(100e6);
        vm.prank(principal);
        acct.withdraw(address(usdg), principal, 95e6);
        vm.warp(block.timestamp + H100 + 1);
        spyFeed.set(int256(SPY_E8), block.timestamp);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.NothingToUnpark.selector, 15e6));
        acct.spend(_req(20e6), new bytes32[](0));

        // The buffer still pays what it covers.
        vm.prank(agent);
        acct.spend(_req(5e6), new bytes32[](0));
    }

    /// SGOV counts for 100 hours but trades only inside 26, so every Sunday its sale reverts. The
    /// spend falls through to the USDG reserve.
    function test_unparkFor_fallsThroughWhenSgovTradeStale() public {
        uint256 raw = _park(50e6);
        _parkUsdg(50e6);
        vm.prank(principal);
        acct.withdraw(address(usdg), principal, 100e6);
        vm.warp(block.timestamp + 30 hours);

        vm.prank(agent);
        acct.spend(_req(20e6), new bytes32[](0));
        assertEq(usdg.balanceOf(address(escrow)), 20e6);
        (uint256 sgovRaw,,,,,) = park.position(address(acct), address(sgovAdapter));
        assertEq(sgovRaw, raw);
        (uint256 reserve,,,,,) = park.position(address(acct), address(usdgAdapter));
        assertEq(reserve, 30e6);
    }

    /// Asking the pool for a small position's full feed value as an exact output needs more SGOV
    /// than the position holds once fills land under the feed. The position is sold whole and
    /// the next adapter covers the rest.
    function test_unparkFor_drainsSgovThenUsdg() public {
        _park(10e6);
        _parkUsdg(50e6);
        vm.prank(principal);
        acct.withdraw(address(usdg), principal, 140e6);
        (,, uint256 worth,,,) = park.position(address(acct), address(sgovAdapter));

        vm.prank(agent);
        acct.spend(_req(20e6), new bytes32[](0));
        assertEq(usdg.balanceOf(address(escrow)), 20e6);
        assertEq(usdg.balanceOf(address(acct)), 0);
        (uint256 raw, uint256 basis,,,,) = park.position(address(acct), address(sgovAdapter));
        assertEq(raw, 0);
        assertEq(basis, 0);
        (uint256 reserve,,,,,) = park.position(address(acct), address(usdgAdapter));
        assertApproxEqAbs(reserve, 30e6 + _filled(worth, address(sgov)), 2);
    }

    function test_buy_unparksShortfall() public {
        _park(100e6);
        vm.prank(principal);
        acct.withdraw(address(usdg), principal, 100e6);
        vm.prank(agent);
        uint256 out = acct.buy(address(spy), 2e6, 0, SPY_E8);
        assertGt(out, 0);
    }

    /// Anything that answers `principal()` could otherwise book against the caps every mandate
    /// shares, and a real account the factory never made is no different.
    function test_park_refusesNonFactoryMandate() public {
        address griefer = makeAddr("griefer");
        FakeMandate fake = new FakeMandate(griefer);
        usdg.mint(park.vaultOf(address(fake)), 100e6);
        vm.prank(griefer);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.NotFactoryAccount.selector, address(fake)));
        park.park(address(fake), address(sgovAdapter), 100e6, 0);

        MandateAccount stray = new MandateAccount(principal, agent, address(usdg), address(escrow), _limits(7));
        usdg.mint(park.vaultOf(address(stray)), 10e6);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.NotFactoryAccount.selector, address(stray)));
        park.park(address(stray), address(sgovAdapter), 10e6, 0);
        assertEq(park.totalBasis(address(sgovAdapter)), 0);
    }

    /// The park's asset is immutable and only its admin can name a successor, so a zero in either
    /// is there for good. One refusal to a test: a test ends at the first constructor revert it
    /// expects.
    function test_park_refusesAZeroAsset() public {
        vm.expectRevert(TreasuryPark.ZeroAddress.selector);
        new TreasuryPark(address(0), admin, _factories());
    }

    function test_park_refusesAZeroAdmin() public {
        vm.expectRevert(TreasuryPark.ZeroAddress.selector);
        new TreasuryPark(address(usdg), address(0), _factories());
    }

    /// With no park nothing can call an adapter. A USDG adapter with no asset would take USDG in
    /// and have no token to pay it back out in.
    function test_usdgAdapter_refusesAZeroPark() public {
        vm.expectRevert(UsdgAdapter.ZeroAddress.selector);
        new UsdgAdapter(address(0), address(usdg), 100e6, 1_000e6);
    }

    function test_usdgAdapter_refusesAZeroAsset() public {
        vm.expectRevert(UsdgAdapter.ZeroAddress.selector);
        new UsdgAdapter(address(park), address(0), 100e6, 1_000e6);
    }

    function test_stockAdapter_refusesAZeroPark() public {
        vm.expectRevert(RobinhoodStockAdapter.ZeroAddress.selector);
        new RobinhoodStockAdapter(address(0), address(sgov), reg, guard, IPoolManager(address(v4)));
    }

    function test_parkAndAdapterRefuseCallersWithoutTheRole() public {
        vm.expectRevert(TreasuryPark.NotOperator.selector);
        park.park(address(acct), address(sgovAdapter), 1e6, 0);
        vm.expectRevert(TreasuryPark.NotPrincipal.selector);
        park.setBuffer(address(acct), 0);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.NothingToUnpark.selector, 1e6));
        park.unparkFor(1e6);
        vm.expectRevert(TreasuryPark.NotDeployer.selector);
        park.initAdapters(new address[](0));
        vm.expectRevert(RobinhoodStockAdapter.NotPark.selector);
        sgovAdapter.release(1, 0, address(this), address(this));
    }

    /// Disabling an adapter stops new parks in it; what is already there still comes out, inside
    /// a spend or by hand.
    function test_disabledAdapter_exitsStayOpen() public {
        _park(50e6);
        vm.prank(admin);
        park.setAdapter(address(sgovAdapter), false);

        vm.startPrank(principal);
        acct.withdraw(address(usdg), park.vaultOf(address(acct)), 1e6);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.UnknownAdapter.selector, address(sgovAdapter)));
        park.park(address(acct), address(sgovAdapter), 1e6, 0);
        acct.withdraw(address(usdg), principal, 149e6);
        vm.stopPrank();

        vm.prank(agent);
        acct.spend(_req(10e6), new bytes32[](0));
        assertEq(usdg.balanceOf(address(escrow)), 10e6);

        (uint256 raw,,,,,) = park.position(address(acct), address(sgovAdapter));
        vm.prank(principal);
        park.unpark(address(acct), address(sgovAdapter), raw, 0);
        (raw,,,,,) = park.position(address(acct), address(sgovAdapter));
        assertEq(raw, 0);
    }

    function test_returnIdle_movesIdleUsdgBackToTheMandate() public {
        address vault = park.vaultOf(address(acct));
        vm.prank(principal);
        acct.withdraw(address(usdg), vault, 7e6);
        assertEq(park.spendingPower(address(acct)), 200e6);
        vm.prank(principal);
        park.returnIdle(address(acct));
        assertEq(usdg.balanceOf(address(acct)), 200e6);
    }

    function test_usdgAdapter_parksAndUnparksAtPar() public {
        address vault = park.vaultOf(address(acct));
        vm.prank(principal);
        acct.withdraw(address(usdg), vault, 30e6);
        vm.prank(principal);
        uint256 raw = park.park(address(acct), address(usdgAdapter), 30e6, 30e6);
        assertEq(raw, 30e6);
        assertEq(park.spendingPower(address(acct)), 200e6);
        vm.prank(principal);
        park.unpark(address(acct), address(usdgAdapter), 30e6, 30e6);
        assertEq(usdg.balanceOf(address(acct)), 200e6);
    }
}
