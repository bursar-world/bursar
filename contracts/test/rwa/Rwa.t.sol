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

contract RwaTest is Test {
    uint256 internal constant SPY_E8 = 771_21266423;
    uint256 internal constant SGOV_E8 = 101_17856966;
    uint32 internal constant H26 = 26 hours;
    uint32 internal constant H100 = 100 hours;

    MockERC20 usdg;
    MockStock spy;
    MockStock sgov;
    MockStock lookalike;
    MockFeed spyFeed;
    MockFeed sgovFeed;
    MockAccess access;
    MockV4 v4;
    MockEscrow escrow;
    MockAccounts accounts;

    AssetRegistry reg;
    PriceGuard guard;
    StockSpendRouter router;
    TreasuryPark park;
    RobinhoodStockAdapter sgovAdapter;
    UsdgAdapter usdgAdapter;
    MandateAccount acct;

    address principal = makeAddr("principal");
    address agent = makeAddr("agent");
    address admin = makeAddr("timelock");
    address merchant = makeAddr("merchant");
    bytes32 constant CAP = keccak256("service:gpu.render:1");

    function setUp() public {
        vm.warp(1_790_000_000);
        usdg = new MockERC20();
        spy = new MockStock("SPY");
        sgov = new MockStock("SGOV");
        lookalike = new MockStock("SGOV");
        spyFeed = new MockFeed();
        sgovFeed = new MockFeed();
        spyFeed.set(int256(SPY_E8), block.timestamp);
        sgovFeed.set(int256(SGOV_E8), block.timestamp);
        access = new MockAccess();
        v4 = new MockV4();
        escrow = new MockEscrow(IERC20(address(usdg)));

        PoolKey memory spyPool = _key(address(spy), 500, 10);
        PoolKey memory sgovPool = _key(address(sgov), 375, 4);
        v4.setPrice(spyPool, _sqrt(SPY_E8, spyPool.currency0 == address(spy)));
        v4.setPrice(sgovPool, _sqrt(SGOV_E8, sgovPool.currency0 == address(sgov)));
        usdg.mint(address(v4), 1_000_000e6);
        spy.mint(address(v4), 1_000e18);
        sgov.mint(address(v4), 10_000e18);

        address[] memory assets = new address[](2);
        AssetRegistry.Asset[] memory configs = new AssetRegistry.Asset[](2);
        assets[0] = address(spy);
        configs[0] = _cfg(address(spyFeed), spyPool, true, false, H26, 100, 0);
        assets[1] = address(sgov);
        configs[1] = _cfg(address(sgovFeed), sgovPool, false, true, H100, 50, 50);
        reg = new AssetRegistry(admin, address(usdg), assets, configs);

        guard = new PriceGuard(reg, IAccessRegistry(address(access)), IStateView(address(v4)));
        router = new StockSpendRouter(reg, guard, IPoolManager(address(v4)));
        accounts = new MockAccounts();
        IMandateAccountFactory[] memory factories = new IMandateAccountFactory[](1);
        factories[0] = IMandateAccountFactory(address(accounts));
        park = new TreasuryPark(address(usdg), admin, factories);
        sgovAdapter = new RobinhoodStockAdapter(address(park), address(sgov), reg, guard, IPoolManager(address(v4)));
        usdgAdapter = new UsdgAdapter(address(park), address(usdg), 100e6, 1_000e6);
        address[] memory ads = new address[](2);
        ads[0] = address(sgovAdapter);
        ads[1] = address(usdgAdapter);
        park.initAdapters(ads);

        acct = new MandateAccount(principal, agent, address(usdg), address(escrow), _limits(7));
        accounts.add(principal, address(acct));
        usdg.mint(address(acct), 200e6);

        vm.startPrank(principal);
        acct.setRouter(address(router));
        acct.setTreasuryPark(address(park));
        address[] memory allow = new address[](1);
        allow[0] = address(spy);
        bool[] memory yes = new bool[](1);
        yes[0] = true;
        router.setPolicy(address(acct), 0, allow, yes);
        acct.setCapability(CAP, true);
        acct.setMerchant(merchant, true);
        vm.stopPrank();
    }

    // ---- registry ----

    function test_registry_keysOnAddress() public {
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotRegistered.selector, address(lookalike)));
        reg.get(address(lookalike));
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotRegistered.selector, address(lookalike)));
        guard.tradePrice(address(lookalike), address(acct));
        assertEq(reg.assets().length, 2);
        assertEq(reg.get(address(sgov)).decimals, 18);
    }

    function test_registry_onlyAdmin() public {
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

    function test_guard_midMatchesFeed() public view {
        uint256 mid = guard.poolPriceE8(address(spy));
        assertApproxEqRel(mid, SPY_E8, 1e12);
        mid = guard.poolPriceE8(address(sgov));
        assertApproxEqRel(mid, SGOV_E8, 1e12);
    }

    // ---- stock purchases ----

    function test_buy_deliversToMandate() public {
        vm.prank(agent);
        uint256 out = acct.buy(address(spy), 1e6, 0, SPY_E8);
        assertEq(spy.balanceOf(address(acct)), out);
        assertApproxEqRel(out, _filled(Math.mulDiv(1e6, 1e20, SPY_E8), address(spy)), 1e12);
        assertEq(usdg.balanceOf(address(acct)), 199e6);
        assertEq(acct.totalSpent(), 1e6);
    }

    function test_buy_classNotAllowed() public {
        vm.prank(principal);
        acct.setLimits(_limits(3));
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ClassNotAllowed.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_assetNotOnMandateList() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.AssetNotAllowed.selector, address(sgov)));
        acct.buy(address(sgov), 1e6, 0, SGOV_E8);
    }

    function test_buy_treasuryTokenIsNotAStock() public {
        _allow(address(sgov));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.NotAStock.selector, address(sgov)));
        acct.buy(address(sgov), 1e6, 0, SGOV_E8);
    }

    function test_buy_perTradeCap() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.TradeCapExceeded.selector, 26e6, 25e6));
        acct.buy(address(spy), 26e6, 0, SPY_E8);
    }

    function test_buy_stale() public {
        vm.warp(block.timestamp + H26 + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.StalePrice.selector, address(spy), H26 + 1, H26));
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_oraclePaused() public {
        spy.setOraclePaused(true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.OraclePaused.selector, address(spy)));
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_tokenPaused() public {
        spy.setTokenPaused(true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.TokenPaused.selector, address(spy)));
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_blocked() public {
        access.setBlocked(address(acct), true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.Blocked.selector, address(acct)));
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    function test_buy_accessPaused() public {
        access.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(PriceGuard.AccessPaused.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8);
    }

    /// The 2026-06-23 incident: a fresh round 1e8 too large.
    function test_buy_misScaledFeed() public {
        spyFeed.set(int256(SPY_E8 * 1e8), block.timestamp);
        uint256 mid = guard.poolPriceE8(address(spy));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.PoolPriceDeviation.selector, address(spy), mid, SPY_E8 * 1e8));
        acct.buy(address(spy), 1e6, 0, SPY_E8 * 1e8);
    }

    function test_buy_poolOutOfBand() public {
        spyFeed.set(int256(SPY_E8 * 102 / 100), block.timestamp);
        vm.prank(agent);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        acct.buy(address(spy), 1e6, 0, SPY_E8 * 102 / 100);
    }

    function test_buy_quoteOutsideBand() public {
        uint256 quoted = SPY_E8 * 102 / 100;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.PriceOutsideBand.selector, address(spy), quoted, SPY_E8));
        acct.buy(address(spy), 1e6, 0, quoted);
    }

    function test_buy_fillWorseThanSlippage() public {
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

    function test_buy_onlyPrincipalSetsPolicy() public {
        vm.prank(agent);
        vm.expectRevert(StockSpendRouter.NotPrincipal.selector);
        router.setPolicy(address(acct), 0, new address[](0), new bool[](0));
    }

    // ---- treasury lane ----

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

    function test_park_keepsBuffer() public {
        vm.prank(principal);
        park.setBuffer(address(acct), 160e6);
        address vault = park.vaultOf(address(acct));
        vm.prank(principal);
        acct.withdraw(address(usdg), vault, 50e6);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.BelowBuffer.selector, 150e6, 160e6));
        park.park(address(acct), address(sgovAdapter), 50e6, 0);
    }

    function test_park_caps() public {
        _park(100e6);
        address vault = park.vaultOf(address(acct));
        vm.prank(principal);
        acct.withdraw(address(usdg), vault, 1e6);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.MandateCapExceeded.selector, 101e6, 100e6));
        park.park(address(acct), address(sgovAdapter), 1e6, 0);

        AssetRegistry.Asset memory c = reg.get(address(sgov));
        c.perMandateCap = 1_000e6;
        c.totalCap = 100e6;
        vm.prank(admin);
        reg.setAsset(address(sgov), c);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPark.TotalCapExceeded.selector, 101e6, 100e6));
        park.park(address(acct), address(sgovAdapter), 1e6, 0);
    }

    function test_park_staleFeed() public {
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

    function test_spend_staleParkedDefers() public {
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
    /// spend falls through to the USDG reserve instead of failing with it.
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

    function test_park_onlyOperators() public {
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

    function test_returnIdle() public {
        address vault = park.vaultOf(address(acct));
        vm.prank(principal);
        acct.withdraw(address(usdg), vault, 7e6);
        assertEq(park.spendingPower(address(acct)), 200e6);
        vm.prank(principal);
        park.returnIdle(address(acct));
        assertEq(usdg.balanceOf(address(acct)), 200e6);
    }

    function test_usdgAdapter_roundTrip() public {
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

    // ---- helpers ----

    /// What the mock pool pays for `atMid` of output at its mid: the LP fee comes off the input
    /// and the fill haircut off the output.
    function _filled(uint256 atMid, address asset) internal view returns (uint256) {
        uint256 fee = reg.get(asset).pool.fee;
        return atMid * (1e6 - fee) / 1e6 * (10_000 - v4.haircutBps()) / 10_000;
    }

    /// Value at the mid that it costs to take `out` from the mock pool.
    function _cost(uint256 out, address asset) internal view returns (uint256) {
        uint256 fee = reg.get(asset).pool.fee;
        return Math.mulDiv(out * (10_000 + v4.haircutBps()) / 10_000, 1e6, 1e6 - fee);
    }

    function _park(uint256 amount) internal returns (uint256 raw) {
        vm.startPrank(principal);
        acct.withdraw(address(usdg), park.vaultOf(address(acct)), amount);
        raw = park.park(address(acct), address(sgovAdapter), amount, 0);
        vm.stopPrank();
    }

    function _parkUsdg(uint256 amount) internal {
        vm.startPrank(principal);
        acct.withdraw(address(usdg), park.vaultOf(address(acct)), amount);
        park.park(address(acct), address(usdgAdapter), amount, amount);
        vm.stopPrank();
    }

    function _allow(address asset) internal {
        address[] memory a = new address[](1);
        a[0] = asset;
        bool[] memory y = new bool[](1);
        y[0] = true;
        vm.prank(principal);
        router.setPolicy(address(acct), 0, a, y);
    }

    function _policy(uint16 bps) internal {
        vm.prank(principal);
        router.setPolicy(address(acct), bps, new address[](0), new bool[](0));
    }

    function _req(uint128 amount) internal view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: merchant,
            capabilityId: CAP,
            inputCommit: bytes32(0),
            inputURI: "",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }

    function _limits(uint32 classMask) internal pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: 30e6,
            dailyCap: 100e6,
            monthlyCap: 1_000e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 50e6,
            validFrom: 0,
            validUntil: 0,
            classMask: classMask,
            totalCap: 0,
            lane: 1
        });
    }

    function _key(address stock, uint24 fee, int24 ts) internal view returns (PoolKey memory) {
        (address c0, address c1) = stock < address(usdg) ? (stock, address(usdg)) : (address(usdg), stock);
        return PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: ts, hooks: address(0)});
    }

    function _sqrt(uint256 priceE8, bool stockIs0) internal pure returns (uint160) {
        uint256 q192 = 1 << 192;
        uint256 ratio = stockIs0 ? Math.mulDiv(priceE8, q192, 1e20) : Math.mulDiv(1e20, q192, priceE8);
        return uint160(Math.sqrt(ratio));
    }

    function _cfg(
        address feed,
        PoolKey memory pool,
        bool isStock,
        bool isTreasury,
        uint32 valuation,
        uint16 band,
        uint16 haircut
    ) internal pure returns (AssetRegistry.Asset memory) {
        return AssetRegistry.Asset({
            feed: feed,
            tradeStaleness: H26,
            valuationStaleness: valuation,
            bandBps: band,
            haircutBps: haircut,
            collateralTier: 0,
            collateralHaircutBps: 0,
            decimals: 0,
            eligible: true,
            isStock: isStock,
            isTreasury: isTreasury,
            perTradeCap: 25e6,
            perMandateCap: 100e6,
            totalCap: 1_000e6,
            pool: pool
        });
    }
}
