// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MandateAccount} from "../../src/MandateAccount.sol";
import {IMandateAccount} from "../../src/interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../../src/interfaces/IMandateAccountFactory.sol";
import {Buyback, IPoolManager, PoolKey} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {IStaking} from "../../src/token/interfaces/IStaking.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../../src/rwa/PriceGuard.sol";
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {V4Swapper} from "../../src/rwa/V4Swapper.sol";
import {ICreditStaking} from "../../src/rwa/interfaces/ICreditStaking.sol";
import {IAccessRegistry, IStateView} from "../../src/rwa/interfaces/IRwaExternal.sol";
import {MockBRSR} from "../mocks/MockBRSR.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAccess, MockAccounts, MockEscrow, MockFeed, MockStock, MockV4} from "./RwaMocks.sol";

contract CollateralTest is Test {
    uint256 internal constant SPY_E8 = 771_21266423;
    uint256 internal constant SGOV_E8 = 101_17856966;
    uint256 internal constant WAD = 1e18;
    // A Monday, 14:13 UTC, inside the 24/5 session.
    uint256 internal constant T0 = 1_790_000_000;
    uint256 internal constant STAKE = 1_000_000e18;
    /// Five cents a BRSR.
    uint128 internal constant CEILING = 50_000;
    uint256 internal constant MIN_AGE = 5 minutes;
    uint256 internal constant MAX_AGE = 1 hours;
    uint256 internal constant MAX_JUMP_BPS = 1_500;

    MockERC20 usdg;
    MockStock spy;
    MockStock sgov;
    MockStock aapl;
    MockFeed spyFeed;
    MockFeed sgovFeed;
    MockFeed aaplFeed;
    MockAccess access;
    MockV4 v4;
    MockEscrow escrow;
    MockAccounts accounts;
    MockBRSR brsr;
    Staking staking;
    Buyback buyback;

    AssetRegistry reg;
    PriceGuard guard;
    CreditPool pool;
    CollateralVault vault;
    MandateAccount acct;
    MandateAccount prefund;

    address principal = makeAddr("principal");
    address agent = makeAddr("agent");
    address admin = makeAddr("timelock");
    address lender = makeAddr("lender");
    address merchant = makeAddr("merchant");
    address keeper = makeAddr("keeper");
    address staker = makeAddr("staker");
    address slashSink = makeAddr("slashSink");
    address treasury = makeAddr("treasury");
    bytes32 constant CAP = keccak256("service:gpu.render:1");

    function setUp() public {
        // Ten minutes early: the keeper's two observations land before the clock reaches T0.
        vm.warp(T0 - 10 minutes);
        usdg = new MockERC20();
        spy = new MockStock("SPY");
        sgov = new MockStock("SGOV");
        aapl = new MockStock("AAPL");
        spyFeed = new MockFeed();
        sgovFeed = new MockFeed();
        aaplFeed = new MockFeed();
        spyFeed.set(int256(SPY_E8), block.timestamp);
        sgovFeed.set(int256(SGOV_E8), block.timestamp);
        aaplFeed.set(int256(300e8), block.timestamp);
        access = new MockAccess();
        v4 = new MockV4();
        escrow = new MockEscrow(IERC20(address(usdg)));
        accounts = new MockAccounts();
        brsr = new MockBRSR();
        staking = new Staking(IERC20(address(brsr)), IERC20(address(usdg)), admin, slashSink, treasury, 7 days, 1e18);
        buyback = new Buyback(
            address(usdg),
            address(brsr),
            address(v4),
            3000,
            60,
            address(0),
            address(staking),
            admin,
            treasury,
            _buybackParams(CEILING)
        );

        PoolKey memory spyPool = _key(address(spy), 500, 10);
        PoolKey memory sgovPool = _key(address(sgov), 375, 4);
        PoolKey memory aaplPool = _key(address(aapl), 3000, 60);
        v4.setPrice(spyPool, _sqrt(SPY_E8, spyPool.currency0 == address(spy)));
        v4.setPrice(sgovPool, _sqrt(SGOV_E8, sgovPool.currency0 == address(sgov)));
        v4.setPrice(aaplPool, _sqrt(300e8, aaplPool.currency0 == address(aapl)));
        usdg.mint(address(v4), 1_000_000e6);

        address[] memory assets = new address[](3);
        AssetRegistry.Asset[] memory configs = new AssetRegistry.Asset[](3);
        assets[0] = address(spy);
        configs[0] = _cfg(address(spyFeed), spyPool, true, false, 100);
        assets[1] = address(sgov);
        configs[1] = _cfg(address(sgovFeed), sgovPool, false, true, 50);
        assets[2] = address(aapl);
        configs[2] = _cfg(address(aaplFeed), aaplPool, true, false, 100);
        reg = new AssetRegistry(admin, address(usdg), assets, configs);
        guard = new PriceGuard(
            reg, IAccessRegistry(address(access)), IStateView(address(v4)), MIN_AGE, MAX_AGE, MAX_JUMP_BPS
        );

        pool = new CreditPool(address(usdg), address(staking), address(buyback), admin, lender, 100e6, 10e6, 200, 1_800);
        vault = new CollateralVault(
            reg,
            guard,
            pool,
            IMandateAccountFactory(address(accounts)),
            IPoolManager(address(v4)),
            admin,
            _params(),
            _tiers(),
            _assetList(),
            _assetTiers()
        );
        pool.bindVault(address(vault));
        vm.prank(admin);
        staking.setCreditManager(address(pool));

        usdg.mint(lender, 1_000e6);
        vm.startPrank(lender);
        usdg.approve(address(pool), type(uint256).max);
        pool.fund(30e6);
        vm.stopPrank();

        acct = _mandate(1);
        prefund = _mandate(0);

        vm.prank(principal);
        vault.openLine(address(acct));
        spy.mint(principal, 1e18);
        sgov.mint(principal, 10e18);
        aapl.mint(principal, 1e18);
        vm.startPrank(principal);
        spy.approve(address(vault), type(uint256).max);
        sgov.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vm.stopPrank();

        // The keeper's first two rounds: at T0 every asset has an aged sample ten minutes old and
        // a pending one five minutes old, both with the pool at its feed.
        _observeAll();
        vm.warp(T0 - MIN_AGE);
        _observeAll();
        vm.warp(T0);
        _refreshFeeds();
    }

    function test_health_isHaircutValueOverDebt() public {
        _deposit(spy, 0.01e18); // 7.7121 USDG
        _deposit(sgov, 0.05e18); // 5.0589 USDG
        _spendOnCredit(5e6);

        uint256 spyV = Math.mulDiv(0.01e18, SPY_E8, 1e20);
        uint256 sgovV = Math.mulDiv(0.05e18, SGOV_E8, 1e20);
        uint256 adjusted = spyV * 8_000 / 10_000 + sgovV * 9_500 / 10_000;
        (uint256 value, uint256 adj, uint256 debt,, uint256 h) = vault.account(address(acct));
        assertEq(value, spyV + sgovV);
        assertEq(adj, adjusted);
        assertEq(debt, 5e6);
        assertEq(h, Math.mulDiv(adjusted, WAD, 5e6));
        assertEq(usdg.balanceOf(address(escrow)), 5e6);
    }

    function test_health_isMaxWithNoDebtAndHeadroomTakesTheAfterHoursHaircut() public {
        _deposit(spy, 0.01e18);
        (uint256 value,, uint256 debt, uint256 headroom, uint256 h) = vault.account(address(acct));
        assertEq(debt, 0);
        assertEq(h, type(uint256).max);
        // Room to draw is at the after-hours haircut, 35% for the index tier.
        assertEq(headroom, Math.mulDiv(value * 6_500 / 10_000, WAD, 1.25e18));
    }

    function test_value_isTheRawAmountTimesTheFeed() public {
        _deposit(sgov, 1e18);
        (uint256 value,,,,) = vault.account(address(acct));
        assertEq(value, Math.mulDiv(1e18, SGOV_E8, 1e20));
    }

    function test_haircut_widensToTheAfterHoursTierAtTheWeekend() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        uint256 before = vault.health(address(acct));
        (uint16 bps, bool ah) = vault.haircutOf(address(spy));
        assertEq(bps, 2_000);
        assertFalse(ah);

        // Saturday 2026-09-26 10:00 UTC, feed still inside its bound.
        vm.warp(1_790_416_800);
        spyFeed.set(int256(SPY_E8), block.timestamp - 1 hours);
        (bps, ah) = vault.haircutOf(address(spy));
        assertEq(bps, 3_500);
        assertTrue(ah);
        uint256 afterH = vault.health(address(acct));
        assertLt(afterH, before);
    }

    /// Draws are checked at the after-hours haircut, so a line drawn to the floor in session is
    /// still above 1.0 when the weekend haircut takes over at Saturday 00:00 UTC, price unchanged.
    function test_floorDraw_survivesWeekendSwitch() public {
        _deposit(aapl, 0.04e18); // 12 USDG: 8.4 at the session haircut, 6 after hours
        // The 6.7 USDG the session haircut alone would have lent.
        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, Math.mulDiv(6e6, WAD, 6.7e6), 1.25e18)
        );
        _spendOnCredit(6.7e6);

        (,,, uint256 headroom,) = vault.account(address(acct));
        assertEq(headroom, 4.8e6);
        _spendOnCredit(uint128(headroom));

        vm.warp(1_790_380_801); // Saturday 00:00:01 UTC
        aaplFeed.set(int256(300e8), 1_790_380_800 - 4 hours); // Friday's 20:00 close, fresh
        (, bool afterHours) = vault.haircutOf(address(aapl));
        assertTrue(afterHours);
        uint256 h = vault.health(address(acct));
        assertGe(h, 1.2e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.Healthy.selector, h));
        vault.liquidate(address(acct), address(aapl));
    }

    function test_haircut_mondayBeforeOneUtcIsAfterHours() public view {
        assertFalse(vault.inSession(1_790_553_600 + 30 minutes)); // Monday 00:30 UTC
        assertTrue(vault.inSession(1_790_553_600 + 61 minutes));
        assertTrue(vault.inSession(1_790_553_600 + 4 days + 23 hours)); // Friday 23:00
        assertFalse(vault.inSession(1_790_553_600 + 5 days)); // Saturday 00:00
    }

    function test_haircut_silentFeedOnWeekdayIsAfterHours() public {
        spyFeed.set(int256(SPY_E8), block.timestamp - 27 hours);
        (uint16 bps, bool ah) = vault.haircutOf(address(spy));
        assertTrue(ah);
        assertEq(bps, 3_500);
    }

    function test_haircut_followsATighterRegistryFloor() public {
        AssetRegistry.Asset memory c = reg.get(address(spy));
        c.collateralHaircutBps = 4_000;
        vm.prank(admin);
        reg.setAsset(address(spy), c);
        (uint16 bps,) = vault.haircutOf(address(spy));
        assertEq(bps, 4_000);
    }

    function test_tiers_listsThreeTiersAndPlacesEveryAsset() public view {
        CollateralVault.Tier[] memory t = vault.tiers();
        assertEq(t.length, 3);
        assertEq(t[0].sessionHaircutBps, 500);
        assertEq(vault.tierOf(address(sgov)), 1);
        assertEq(vault.tierOf(address(spy)), 2);
        assertEq(vault.tierOf(address(aapl)), 3);
        assertEq(vault.collateralAssets().length, 3);
    }

    /// Tiers count from one everywhere, so the tier `tierOf` names is the one `setTier` edits.
    function test_setTier_editsTheTierThatTierOfReports() public {
        uint8 tier = vault.tierOf(address(spy));
        vm.prank(admin);
        vault.setTier(tier, CollateralVault.Tier(2_500, 4_000, 26 hours, 100 hours, "Index fund"));

        (uint16 bps,) = vault.haircutOf(address(spy));
        assertEq(bps, 2_500);
        assertEq(vault.tiers()[tier - 1].sessionHaircutBps, 2_500);
        (bps,) = vault.haircutOf(address(aapl));
        assertEq(bps, 3_000);
    }

    /// Zero is what `tierOf` answers for an asset that is not collateral, so there is no tier zero
    /// to edit. One past the last tier adds a tier; anything further is refused.
    function test_setTier_refusesTierZeroAndGaps() public {
        CollateralVault.Tier memory t = CollateralVault.Tier(1_000, 2_000, 26 hours, 100 hours, "Fund");
        vm.startPrank(admin);
        vm.expectRevert(CollateralVault.BadTier.selector);
        vault.setTier(0, t);
        vm.expectRevert(CollateralVault.BadTier.selector);
        vault.setTier(5, t);

        vm.expectEmit(address(vault));
        emit CollateralVault.TierSet(4, "Fund", 1_000, 2_000);
        vault.setTier(4, t);
        vault.setAssetTier(address(aapl), 4);
        vm.stopPrank();

        assertEq(vault.tiers().length, 4);
        (uint16 bps,) = vault.haircutOf(address(aapl));
        assertEq(bps, 1_000);
    }

    function test_aStalePriceCountsZeroAndDefersTheDraw() public {
        _deposit(spy, 0.01e18);
        spyFeed.set(int256(SPY_E8), block.timestamp - 101 hours);
        (uint256 value,,,,) = vault.account(address(acct));
        assertEq(value, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        _spendOnCredit(1e6);
    }

    function test_pausedOracleCountsZero() public {
        _deposit(spy, 0.01e18);
        spy.setOraclePaused(true);
        (uint256 value,,,,) = vault.account(address(acct));
        assertEq(value, 0);
    }

    /// A paused token cannot be sold, so it cannot back a draw that a liquidation might need it for.
    function test_draw_refusedWhileTokenPaused() public {
        _deposit(spy, 0.01e18);
        spy.setTokenPaused(true);
        (uint256 value,,, uint256 headroom,) = vault.account(address(acct));
        assertEq(value, 0);
        assertEq(headroom, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        _spendOnCredit(4e6);

        spy.setTokenPaused(false);
        access.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        _spendOnCredit(4e6);

        access.setPaused(false);
        _spendOnCredit(4e6);
        assertEq(pool.debtOf(address(acct)), 4e6);
    }

    /// A feed round 1e8 too large passes every timestamp test. Against the pool at its real mid,
    /// the position then backs no draw and no withdrawal.
    function test_draw_refusedOnMisScaledFeed() public {
        _deposit(spy, 1e14); // 0.0001 SPY, about 0.077 USDG
        spyFeed.set(int256(SPY_E8 * 1e8), block.timestamp);
        (uint256 value, uint256 adjusted,, uint256 headroom,) = vault.account(address(acct));
        assertEq(value, 0);
        assertEq(adjusted, 0);
        assertEq(headroom, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        _spendOnCredit(10e6);

        // A line drawn on a good round cannot take its collateral out on a bad one.
        spyFeed.set(int256(SPY_E8), block.timestamp);
        _deposit(spy, 0.01e18);
        _spendOnCredit(3e6);
        spyFeed.set(int256(SPY_E8 * 1e8), block.timestamp);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        vault.withdraw(address(acct), address(spy), 0.01e18, principal);

        // A feed lagging a split: the pool halves and the feed still reads the old price.
        spyFeed.set(int256(SPY_E8), block.timestamp);
        _setPool(spy, SPY_E8 / 2);
        (value,,, headroom,) = vault.account(address(acct));
        assertEq(value, 0);
        assertEq(headroom, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        _spendOnCredit(1e6);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        vault.withdraw(address(acct), address(spy), 1e14, principal);
    }

    function test_liquidation_deferredOnStaleOrPausedPrice() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        spyFeed.set(int256(SPY_E8 / 2), block.timestamp - 27 hours);
        assertLt(vault.health(address(acct)), WAD);
        vm.expectRevert();
        vault.liquidate(address(acct), address(spy));

        spyFeed.set(int256(SPY_E8 / 2), block.timestamp);
        spy.setOraclePaused(true);
        vm.expectRevert();
        vault.liquidate(address(acct), address(spy));
    }

    function test_prefundCannotBorrow() public {
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotCollateralLane.selector, address(prefund), 0));
        vault.openLine(address(prefund));

        vm.prank(address(prefund));
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NoLine.selector, address(prefund)));
        vault.unparkFor(1e6);
    }

    function test_laneSwitchedAwayCannotDraw() public {
        _deposit(spy, 0.01e18);
        IMandateAccount.Limits memory l = _limits(0);
        vm.prank(principal);
        acct.setLimits(l);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotCollateralLane.selector, address(acct), 0));
        _spendOnCredit(1e6);
    }

    function test_foreignAccountCannotOpen() public {
        MandateAccount other = new MandateAccount(principal, agent, address(usdg), address(escrow), _limits(1));
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotFactoryAccount.selector, address(other)));
        vault.openLine(address(other));
    }

    function test_drawAboveHeadroomReverts() public {
        _deposit(spy, 0.01e18); // 7.7121 USDG, 5.0129 after hours, headroom 4.0103
        vm.expectRevert();
        _spendOnCredit(4.1e6);
        _spendOnCredit(4e6);
    }

    function test_caps_refuseADrawPastTheMandateCap() public {
        _deposit(spy, 0.1e18);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.MandateCapExceeded.selector, 11e6, 10e6));
        _spendOnCredit(11e6);
        _spendOnCredit(10e6);
    }

    function test_caps_refuseADrawPastTheTotalCap() public {
        vm.prank(admin);
        pool.setCaps(12e6, 10e6);
        _deposit(spy, 0.1e18);
        _spendOnCredit(8e6);

        MandateAccount second = _mandate(1);
        vm.prank(principal);
        vault.openLine(address(second));
        vm.prank(principal);
        vault.deposit(address(second), address(spy), 0.1e18);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.TotalCapExceeded.selector, 13e6, 12e6));
        second.spend(_req(5e6), new bytes32[](0));
    }

    function test_cashLimitsDraw() public {
        vm.prank(lender);
        pool.withdrawLiquidity(lender, 29e6);
        _deposit(spy, 0.1e18);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.InsufficientCash.selector, 1e6, 2e6));
        _spendOnCredit(2e6);
    }

    function test_onlyVaultBorrows() public {
        vm.expectRevert(CreditPool.NotVault.selector);
        pool.borrow(address(acct), 1e6, address(this));
        vm.expectRevert(CreditPool.NotDeployer.selector);
        pool.bindVault(address(this));
    }

    function test_repayReducesDebtAndSpreadReachesStakers() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        vm.warp(block.timestamp + 30 days);
        spyFeed.set(int256(SPY_E8), block.timestamp);
        uint256 owed = pool.debtOf(address(acct));
        assertGt(owed, 4e6);

        usdg.mint(principal, 10e6);
        vm.startPrank(principal);
        usdg.approve(address(pool), type(uint256).max);
        pool.repay(address(acct), 1e6);
        assertApproxEqAbs(pool.debtOf(address(acct)), owed - 1e6, 1);
        pool.repay(address(acct), 10e6);
        vm.stopPrank();
        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(vault.health(address(acct)), type(uint256).max);

        uint256 spread = pool.reserves();
        assertApproxEqAbs(spread, owed - 4e6, 1);
        pool.sweepSpread();
        assertEq(usdg.balanceOf(address(staking)), spread);
        assertApproxEqAbs(usdg.balanceOf(address(pool)), 30e6, 2);
    }

    function test_sweepRevertsUntilCreditManager() public {
        vm.prank(admin);
        staking.setCreditManager(address(0));
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        vm.warp(block.timestamp + 1 days);
        usdg.mint(principal, 5e6);
        vm.startPrank(principal);
        usdg.approve(address(pool), type(uint256).max);
        pool.repay(address(acct), 5e6);
        vm.stopPrank();
        assertGt(pool.reserves(), 0);
        vm.expectRevert(IStaking.NotCreditManager.selector);
        pool.sweepSpread();
    }

    function test_withdrawCollateralBoundedByHealth() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(3e6);
        vm.prank(principal);
        vm.expectRevert();
        vault.withdraw(address(acct), address(spy), 0.005e18, principal);
        vm.prank(principal);
        vault.withdraw(address(acct), address(spy), 0.001e18, principal);
        vm.prank(agent);
        vm.expectRevert(CollateralVault.NotPrincipal.selector);
        vault.withdraw(address(acct), address(spy), 0.001e18, agent);
    }

    function test_liquidate_sellsOnlyTheSlice() public {
        _deposit(spy, 0.01e18);
        _deposit(aapl, 0.01e18);
        _spendOnCredit(5e6);
        _movePrice(spy, spyFeed, SPY_E8 * 45 / 100);
        uint256 h = vault.health(address(acct));
        assertLt(h, WAD);

        uint256 debtBefore = pool.debtOf(address(acct));
        vm.prank(keeper);
        uint256 sold = vault.liquidate(address(acct), address(spy));
        assertGt(sold, 0);
        assertLt(sold, 0.01e18);
        assertGt(usdg.balanceOf(keeper), 0);
        uint256 after_ = vault.health(address(acct));
        assertGe(after_, 1.05e18);
        assertLt(after_, 1.1e18);
        assertLt(pool.debtOf(address(acct)), debtBefore);
        assertEq(vault.collateralOf(address(acct), address(spy)), 0.01e18 - sold);
    }

    /// Pushing one asset's pool past its band inside a transaction must not open the line's
    /// other assets to a bounty sale, so the trigger counts that position at its feed.
    function test_liquidate_ignoresPoolPushedPastBand() public {
        _deposit(spy, 0.01e18);
        _deposit(sgov, 0.02e18);
        _spendOnCredit(5e6);
        uint256 h = vault.health(address(acct));

        _setPool(spy, SPY_E8 * 90 / 100);
        assertEq(vault.health(address(acct)), h);
        (,,, uint256 headroom,) = vault.account(address(acct));
        assertEq(headroom, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.Healthy.selector, h));
        vault.liquidate(address(acct), address(sgov));
    }

    /// A sale must leave the pool inside the band as well as find it there. Pushed to the band's
    /// edge earlier in the same transaction, the pool would let the sale fill past it.
    function test_liquidate_refusesManipulatedFill() public {
        _deposit(spy, 0.01e18);
        _deposit(aapl, 0.01e18);
        _spendOnCredit(5e6);
        uint256 price = SPY_E8 * 45 / 100;
        _movePrice(spy, spyFeed, price);
        v4.setImpact(50);

        // 80 bps under the feed is inside the 100 bps band, and the sale takes it past.
        _setPool(spy, price * 9_920 / 10_000);
        vm.prank(keeper);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        vault.liquidate(address(acct), address(spy));

        // From the feed the same sale stays inside it.
        _setPool(spy, price);
        vm.prank(keeper);
        assertGt(vault.liquidate(address(acct), address(spy)), 0);
    }

    function test_liquidate_refusesHealthy() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(1e6);
        uint256 h = vault.health(address(acct));
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.Healthy.selector, h));
        vault.liquidate(address(acct), address(spy));
    }

    function test_liquidate_writesOffWhenCollateralRunsOut() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        _movePrice(spy, spyFeed, SPY_E8 / 4);
        vault.liquidate(address(acct), address(spy));
        assertEq(vault.collateralOf(address(acct), address(spy)), 0);
        assertEq(pool.debtOf(address(acct)), 0);
        assertGt(pool.badDebt(), 0);
    }

    /// One wei of another asset, posted by anyone, cannot hold the write-off open while the
    /// stranded debt keeps costing the pool: dust counts as nothing left to sell. The write-off
    /// then seizes it with everything else the line holds.
    function test_dustDeposit_cannotBlockWriteOff() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        address griefer = makeAddr("griefer");
        sgov.mint(griefer, 1);
        vm.startPrank(griefer);
        sgov.approve(address(vault), 1);
        vault.deposit(address(acct), address(sgov), 1);
        vm.stopPrank();

        _movePrice(spy, spyFeed, SPY_E8 / 4);
        vm.expectEmit(address(vault));
        emit CollateralVault.Seized(address(acct), address(sgov), 1);
        vault.liquidate(address(acct), address(spy));
        assertEq(vault.collateralOf(address(acct), address(spy)), 0);
        assertEq(vault.collateralOf(address(acct), address(sgov)), 0);
        assertEq(vault.seized(address(sgov)), 1);
        assertEq(pool.debtOf(address(acct)), 0);
        assertGt(pool.badDebt(), 0);

        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.PositionEmpty.selector, address(acct), address(sgov)));
        vault.withdraw(address(acct), address(sgov), 1, principal);
        vault.claimSeized(address(sgov));
        assertEq(sgov.balanceOf(lender), 1);
    }

    /// A line whose collateral a sale could get nothing for is written off by the liquidation
    /// call itself; trying to sell dust could only revert. What it held is seized, not left to
    /// the borrower.
    function test_liquidate_writesOffLineHoldingOnlyDust() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        _movePrice(spy, spyFeed, 1e3); // $0.00001: the whole position is worth under a micro-USDG
        vm.prank(keeper);
        assertEq(vault.liquidate(address(acct), address(spy)), 0);
        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(pool.badDebt(), 4e6);
        assertEq(vault.collateralOf(address(acct), address(spy)), 0);
        assertEq(vault.seized(address(spy)), 0.01e18);
        assertEq(spy.balanceOf(address(vault)), 0.01e18);
    }

    /// Every asset the line still holds goes to the seized pot, whatever its tier: here three
    /// tiers' worth of dust, since a tiered position worth anything holds the write-off open.
    function test_writeOff_seizesEveryTieredPosition() public {
        _deposit(spy, 0.01e18);
        _deposit(sgov, 0.02e18);
        _deposit(aapl, 0.01e18);
        _spendOnCredit(4e6);
        _movePrice(spy, spyFeed, 1e3);
        _movePrice(sgov, sgovFeed, 1e3);
        _movePrice(aapl, aaplFeed, 1e3);

        vm.expectEmit(address(vault));
        emit CollateralVault.Seized(address(acct), address(sgov), 0.02e18);
        vm.expectEmit(address(vault));
        emit CollateralVault.Seized(address(acct), address(spy), 0.01e18);
        vm.expectEmit(address(vault));
        emit CollateralVault.Seized(address(acct), address(aapl), 0.01e18);
        vm.prank(keeper);
        vault.liquidate(address(acct), address(aapl));

        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(vault.collateralOf(address(acct), address(spy)), 0);
        assertEq(vault.collateralOf(address(acct), address(sgov)), 0);
        assertEq(vault.collateralOf(address(acct), address(aapl)), 0);
        assertEq(vault.seized(address(spy)), 0.01e18);
        assertEq(vault.seized(address(sgov)), 0.02e18);
        assertEq(vault.seized(address(aapl)), 0.01e18);
        // The tokens have not moved; the pot is paid out separately.
        assertEq(spy.balanceOf(address(vault)), 0.01e18);
        assertEq(sgov.balanceOf(address(vault)), 0.02e18);
        assertEq(aapl.balanceOf(address(vault)), 0.01e18);
        (uint256 value,, uint256 debt,, uint256 h) = vault.account(address(acct));
        assertEq(value, 0);
        assertEq(debt, 0);
        assertEq(h, type(uint256).max);
    }

    /// The second half of the attack, with the pool genuinely gone: the untiered pool has
    /// disagreed with its feed at the aged observation as well as at spot. Then the write-off
    /// stands, and it takes the collateral with it instead of leaving it to the borrower.
    function test_writeOff_seizesTheUntieredPositionOnceItsPoolHasDisagreedAtTheAgedObservation() public {
        _deposit(aapl, 0.04e18);
        _spendOnCredit(4e6);
        vm.prank(admin);
        vault.setAssetTier(address(aapl), 0);
        _setPool(aapl, 300e8 * 90 / 100);
        assertEq(uint8(vault.drawHalt(address(aapl))), uint8(PriceGuard.DrawHalt.SpotOffBand));
        _ageObservations();
        assertEq(uint8(vault.drawHalt(address(aapl))), uint8(PriceGuard.DrawHalt.ObservationOffBand));

        vm.prank(principal);
        vm.expectEmit(address(vault));
        emit CollateralVault.Seized(address(acct), address(aapl), 0.04e18);
        assertEq(vault.liquidate(address(acct), address(aapl)), 0);
        assertEq(pool.debtOf(address(acct)), 0);
        assertApproxEqAbs(pool.badDebt(), 4e6, 10); // plus five minutes of spread
        assertEq(vault.collateralOf(address(acct), address(aapl)), 0);
        assertEq(vault.seized(address(aapl)), 0.04e18);

        _setPool(aapl, 300e8);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.PositionEmpty.selector, address(acct), address(aapl)));
        vault.withdraw(address(acct), address(aapl), 0.04e18, principal);
        assertEq(aapl.balanceOf(principal), 1e18 - 0.04e18);
    }

    /// Without an aged observation that stands, the pushed pool is the spot reading alone, and
    /// the write-off waits: the sale is deferred until the pool is back in its band.
    function test_writeOff_waitsWhenNoAgedObservationJudgesThePushedPool() public {
        _deposit(aapl, 0.04e18);
        _spendOnCredit(4e6);
        vm.prank(admin);
        vault.setAssetTier(address(aapl), 0);
        vm.warp(block.timestamp + MAX_AGE + 1);
        _refreshFeeds();
        _setPool(aapl, 300e8 * 90 / 100);
        assertEq(uint8(vault.drawHalt(address(aapl))), uint8(PriceGuard.DrawHalt.ObservationExpired));

        vm.prank(keeper);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        vault.liquidate(address(acct), address(aapl));
        assertGe(pool.debtOf(address(acct)), 4e6);

        // Back in its band, the position is sold like any other.
        _setPool(aapl, 300e8);
        vm.prank(keeper);
        assertGt(vault.liquidate(address(acct), address(aapl)), 0);
        assertGe(vault.health(address(acct)), 1.05e18);
    }

    /// Anyone may trigger the payout; the lender the pool names at the time is who gets paid,
    /// and an empty pot is a named refusal.
    function test_claimSeized_paysThePoolsLender() public {
        _strandLine();
        vault.liquidate(address(acct), address(spy));
        assertEq(vault.seized(address(spy)), 0.01e18);

        address newLender = makeAddr("newLender");
        vm.prank(admin);
        pool.setLender(newLender);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectEmit(address(vault));
        emit CollateralVault.SeizedClaimed(address(spy), newLender, 0.01e18);
        assertEq(vault.claimSeized(address(spy)), 0.01e18);
        assertEq(spy.balanceOf(newLender), 0.01e18);
        assertEq(spy.balanceOf(stranger), 0);
        assertEq(spy.balanceOf(lender), 0);
        assertEq(spy.balanceOf(address(vault)), 0);
        assertEq(vault.seized(address(spy)), 0);

        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingSeized.selector, address(spy)));
        vault.claimSeized(address(spy));
    }

    /// A token that refuses to move does not hold up the write-off; the pot waits for it.
    function test_claimSeized_waitsOutATokenThatRefusesToMove() public {
        _strandLine();
        spy.setBlocked(address(vault), true);
        vault.liquidate(address(acct), address(spy));
        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(vault.seized(address(spy)), 0.01e18);

        vm.expectRevert("blocked");
        vault.claimSeized(address(spy));
        spy.setBlocked(address(vault), false);
        vault.claimSeized(address(spy));
        assertEq(spy.balanceOf(lender), 0.01e18);
    }

    /// A year of spread on a line that never pays reaches no one. Only spread a borrower pays is
    /// booked for stakers, so the lender loses the principal it lent and nothing more, and the
    /// written-off debt stops growing.
    function test_writeOff_reversesUnpaidSpread() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        vm.warp(block.timestamp + 365 days);
        assertGt(pool.debtOf(address(acct)), 4e6);
        vm.expectRevert(CreditPool.NothingToSweep.selector);
        pool.sweepSpread();

        _movePrice(spy, spyFeed, 1e3);
        vault.liquidate(address(acct), address(spy));
        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(pool.principalOf(address(acct)), 0);
        assertEq(pool.reserves(), 0);
        assertEq(pool.cash(), 26e6); // 30 funded, 4 lent and lost
        vm.expectRevert(CreditPool.NothingToSweep.selector);
        pool.sweepSpread();

        vm.warp(block.timestamp + 365 days);
        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(pool.totalDebt(), 0);
    }

    /// A liquidation that falls short pays the spread first, and stakers get exactly that.
    function test_shortLiquidation_paysSpreadBeforePrincipal() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        vm.warp(block.timestamp + 365 days);
        uint256 spread = pool.debtOf(address(acct)) - 4e6;

        _movePrice(spy, spyFeed, SPY_E8 / 4);
        vm.prank(keeper);
        vault.liquidate(address(acct), address(spy));
        assertEq(pool.debtOf(address(acct)), 0);
        assertApproxEqAbs(pool.reserves(), spread, 1);
        // What was written off is principal alone, and it is all the lender is down.
        assertApproxEqAbs(pool.cash(), 30e6 - pool.badDebt(), 2);
        pool.sweepSpread();
        assertApproxEqAbs(usdg.balanceOf(address(staking)), spread, 1);
        assertApproxEqAbs(pool.cash(), 30e6 - pool.badDebt(), 2);
    }

    /// Governance can take an asset out of its tier with positions still open. It then backs
    /// nothing, and a line it leaves under water can still sell it to pay the debt down.
    function test_untieredAsset_canStillBeSoldToPayTheDebtDown() public {
        _deposit(spy, 0.005e18);
        _deposit(aapl, 0.02e18);
        _spendOnCredit(4.4e6);
        vm.prank(admin);
        vault.setAssetTier(address(aapl), 0);
        assertLt(vault.health(address(acct)), WAD);

        CollateralVault.PositionView memory p = vault.positions(address(acct))[2];
        assertEq(p.asset, address(aapl));
        assertEq(p.haircutBps, 10_000);
        assertTrue(p.fresh);
        assertEq(p.value, 6e6);
        assertEq(p.adjusted, 0);

        vm.prank(keeper);
        uint256 sold = vault.liquidate(address(acct), address(aapl));
        assertGt(sold, 0);
        assertLt(sold, 0.02e18);
        assertGe(vault.health(address(acct)), 1.05e18);
    }

    /// An untiered position that can still be sold keeps the line open for its own sale; one that
    /// cannot is no reason to leave the debt stranded.
    function test_untieredAsset_holdsWriteOffOnlyWhileSellable() public {
        _deposit(spy, 0.005e18);
        _deposit(aapl, 0.02e18);
        _spendOnCredit(4.4e6);
        vm.prank(admin);
        vault.setAssetTier(address(aapl), 0);
        _movePrice(spy, spyFeed, 1e3); // the index position is dust now

        vm.prank(keeper);
        vm.expectPartialRevert(V4Swapper.SwapShort.selector);
        vault.liquidate(address(acct), address(spy));

        aapl.setOraclePaused(true);
        vm.prank(keeper);
        assertEq(vault.liquidate(address(acct), address(spy)), 0);
        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(pool.badDebt(), 4.4e6);
    }

    /// The audit's combined attack. Governance takes AAPL out of its tier with a line drawn
    /// against it. The borrower pushes AAPL's pool past its band inside one transaction, so the
    /// position reads not fresh; a write-off that skipped it would clear the debt, and the
    /// borrower would take the collateral back. The push alone must not get a write-off: the
    /// sale is deferred, the debt stands, and the collateral stays behind it.
    function test_regression_pushedUntieredPoolCannotFreeTheCollateral() public {
        _deposit(aapl, 0.04e18); // 12 USDG, 6 at the after-hours haircut
        _spendOnCredit(4e6);
        vm.prank(admin);
        vault.setAssetTier(address(aapl), 0);
        assertLt(vault.health(address(acct)), WAD);

        _setPool(aapl, 300e8 * 90 / 100);
        vm.prank(principal);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        vault.liquidate(address(acct), address(aapl));

        _setPool(aapl, 300e8);
        assertEq(pool.debtOf(address(acct)), 4e6);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        vault.withdraw(address(acct), address(aapl), 0.04e18, principal);
        assertEq(vault.collateralOf(address(acct), address(aapl)), 0.04e18);
    }

    /// A pool that agrees with the feed at spot is one swap away from wherever the caller put
    /// it. A draw needs the agreement to have stood at an aged observation first: with the
    /// keeper's samples older than the maximum age, nothing counts until two rounds have aged a
    /// new one in.
    function test_regression_drawNeedsAnAgedObservation() public {
        _deposit(spy, 0.01e18);
        vm.warp(block.timestamp + MAX_AGE + 1);
        _refreshFeeds();
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(PriceGuard.DrawHalt.ObservationExpired));
        (uint256 value,,, uint256 headroom,) = vault.account(address(acct));
        assertGt(value, 0);
        assertEq(headroom, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        _spendOnCredit(1e6);

        // One round promotes a sample that is itself too old; the next promotes a fresh one.
        _observeAll();
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(PriceGuard.DrawHalt.ObservationExpired));
        vm.warp(block.timestamp + MIN_AGE);
        _refreshFeeds();
        _observeAll();
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(PriceGuard.DrawHalt.None));
        (,,, headroom,) = vault.account(address(acct));
        assertGt(headroom, 1e6);
        _spendOnCredit(1e6);
        assertEq(pool.debtOf(address(acct)), 1e6);
    }

    /// A round far from the last aged sample is a gap or a mis-scaled answer, whether or not the
    /// pool has been pushed along to agree with it.
    function test_regression_feedJumpHaltsDraws() public {
        _deposit(spy, 0.01e18);
        _movePrice(spy, spyFeed, SPY_E8 * 120 / 100);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        _spendOnCredit(1e6);
    }

    /// Inside the session a feed that has gone quiet past the tier's session bound halts draws
    /// on the position, where it used to widen the haircut and lend on.
    function test_regression_quietFeedInSessionHaltsDraws() public {
        _deposit(spy, 0.01e18);
        spyFeed.set(int256(SPY_E8), block.timestamp - 27 hours);
        assertTrue(vault.inSession(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        _spendOnCredit(1e6);
    }

    /// `drawHalt` names the first condition a draw would fail, current state before history and
    /// the pool's spot last, and `account` lends on none of them.
    function test_drawHalt_namesTheFirstFailedCondition() public {
        _deposit(spy, 0.01e18);
        _expectHalt(PriceGuard.DrawHalt.None, true);

        spyFeed.set(0, block.timestamp);
        _expectHalt(PriceGuard.DrawHalt.NoPrice, false);
        spyFeed.set(int256(SPY_E8), block.timestamp);

        spy.setTokenPaused(true);
        _expectHalt(PriceGuard.DrawHalt.Paused, false);
        spy.setTokenPaused(false);

        spyFeed.set(int256(SPY_E8), block.timestamp - 27 hours);
        _expectHalt(PriceGuard.DrawHalt.FeedStale, false);
        spyFeed.set(int256(SPY_E8), block.timestamp);

        _setPool(spy, SPY_E8 * 98 / 100);
        _expectHalt(PriceGuard.DrawHalt.SpotOffBand, false);
        // Aged in, the pushed pool is history too, and history is reported before the spot.
        _ageObservations();
        _expectHalt(PriceGuard.DrawHalt.ObservationOffBand, false);
        _setPool(spy, SPY_E8);
        _expectHalt(PriceGuard.DrawHalt.ObservationOffBand, false);
        _ageObservations();
        _expectHalt(PriceGuard.DrawHalt.None, true);

        _movePrice(spy, spyFeed, SPY_E8 * 84 / 100);
        _expectHalt(PriceGuard.DrawHalt.FeedJump, false);

        vm.warp(block.timestamp + MAX_AGE + 1);
        _refreshFeeds();
        _expectHalt(PriceGuard.DrawHalt.ObservationExpired, false);

        MockStock msft = _registerUnobserved();
        assertEq(uint8(vault.drawHalt(address(msft))), uint8(PriceGuard.DrawHalt.NoObservation));
    }

    /// A reading lands as pending and the next call promotes it once it is old enough. A
    /// younger one is refused, so the aged slot never holds a reading from the block using it.
    function test_observe_promotesOnlyASampleOldEnough() public {
        MockStock msft = _registerUnobserved();
        vm.expectEmit(true, false, false, false, address(guard));
        emit PriceGuard.Observed(address(msft), 0, 0, false);
        guard.observe(address(msft));
        (uint48 at,,) = guard.aged(address(msft));
        assertEq(at, 0);
        (at,,) = guard.pending(address(msft));
        assertEq(at, block.timestamp);
        assertEq(uint8(vault.drawHalt(address(msft))), uint8(PriceGuard.DrawHalt.NoObservation));

        vm.warp(block.timestamp + MIN_AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(PriceGuard.ObservationTooSoon.selector, address(msft), MIN_AGE - 1, MIN_AGE)
        );
        guard.observe(address(msft));

        vm.warp(block.timestamp + 1);
        vm.expectEmit(address(guard));
        emit PriceGuard.Observed(address(msft), guard.poolPriceE8(address(msft)), 400e8, true);
        guard.observe(address(msft));
        (uint48 agedAt, uint104 poolE8, uint104 feedE8) = guard.aged(address(msft));
        assertEq(agedAt, block.timestamp - MIN_AGE);
        assertApproxEqRel(poolE8, 400e8, 1e12);
        assertEq(feedE8, 400e8);
        assertEq(uint8(vault.drawHalt(address(msft))), uint8(PriceGuard.DrawHalt.None));

        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotRegistered.selector, address(this)));
        guard.observe(address(this));
    }

    /// A round far from the aged sample halts draws until samples taken after it have aged: one
    /// keeper round promotes a sample from before the jump, the next one from after it.
    function test_feedJump_haltsDrawsUntilSamplesTakenAfterItHaveAged() public {
        _deposit(spy, 0.01e18);
        _movePrice(spy, spyFeed, SPY_E8 * 120 / 100);
        _expectHalt(PriceGuard.DrawHalt.FeedJump, false);

        vm.warp(block.timestamp + MIN_AGE);
        _refreshFeeds();
        _observeAll();
        _expectHalt(PriceGuard.DrawHalt.FeedJump, false);

        vm.warp(block.timestamp + MIN_AGE);
        _refreshFeeds();
        _observeAll();
        _expectHalt(PriceGuard.DrawHalt.None, true);
        _spendOnCredit(1e6);
        assertEq(pool.debtOf(address(acct)), 1e6);
    }

    /// Outside the session a quiet feed is the ordinary state: Friday's close counts at the
    /// after-hours haircut up to the valuation bound, and draws go on.
    function test_quietFeed_outsideTheSessionWidensTheHaircutAndLendsOn() public {
        _deposit(spy, 0.01e18);
        vm.warp(1_790_416_800); // Saturday 10:00 UTC
        spyFeed.set(int256(SPY_E8), block.timestamp - 30 hours);
        _observeAll();
        vm.warp(block.timestamp + MIN_AGE);
        _observeAll();

        (uint16 bps, bool afterHours) = vault.haircutOf(address(spy));
        assertEq(bps, 3_500);
        assertTrue(afterHours);
        _expectHalt(PriceGuard.DrawHalt.None, true);
        _spendOnCredit(1e6);
        assertEq(pool.debtOf(address(acct)), 1e6);
    }

    /// The draw rule never reaches a repayment or a withdrawal from a line that owes nothing.
    function test_repayAndDebtFreeWithdrawal_neverMeetTheDrawRule() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        vm.warp(block.timestamp + MAX_AGE + 1);
        spyFeed.set(int256(SPY_E8), block.timestamp - 27 hours);
        _setPool(spy, SPY_E8 / 2);
        _expectHalt(PriceGuard.DrawHalt.FeedStale, false);

        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.HealthTooLow.selector, 0, 1.25e18));
        vault.withdraw(address(acct), address(spy), 1, principal);

        uint256 owed = pool.debtOf(address(acct));
        usdg.mint(principal, owed);
        vm.startPrank(principal);
        usdg.approve(address(pool), owed);
        pool.repay(address(acct), owed);
        vault.withdraw(address(acct), address(spy), 0.01e18, principal);
        vm.stopPrank();
        assertEq(spy.balanceOf(principal), 1e18);
    }

    /// A feed replaced by something that reverts, or by nothing at all, costs its own position
    /// and no one else's. The line still reads, the other asset still liquidates, a line that
    /// owes nothing still takes everything back, and the keeper's round still lands. The broken
    /// asset itself cannot be sold, with a named reason.
    function test_brokenFeed_countsZeroAndLeavesTheRestOfTheLaneAlive() public {
        _deposit(spy, 0.01e18);
        _deposit(aapl, 0.02e18);
        _spendOnCredit(5e6);
        spyFeed.setBroken(true);

        CollateralVault.PositionView memory p = vault.positions(address(acct))[1];
        assertEq(p.asset, address(spy));
        assertEq(p.priceE8, 0);
        assertFalse(p.fresh);
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(PriceGuard.DrawHalt.Unreadable));
        (uint16 bps, bool afterHours) = vault.haircutOf(address(spy));
        assertEq(bps, 3_500);
        assertTrue(afterHours);
        (uint256 value,,,, uint256 h) = vault.account(address(acct));
        assertEq(value, 6e6);
        assertLt(h, WAD);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.BadPrice.selector, address(spy)));
        vault.liquidate(address(acct), address(spy));
        vm.prank(keeper);
        assertGt(vault.liquidate(address(acct), address(aapl)), 0);
        uint256 restored = vault.health(address(acct));
        assertGt(restored, WAD);
        assertApproxEqRel(restored, 1.05e18, 0.01e18);

        vm.warp(block.timestamp + MIN_AGE);
        guard.observe(address(spy));
        (,, uint104 feedE8) = guard.pending(address(spy));
        assertEq(feedE8, 0);

        uint256 owed = pool.debtOf(address(acct));
        usdg.mint(principal, owed);
        vm.startPrank(principal);
        usdg.approve(address(pool), owed);
        pool.repay(address(acct), owed);
        vault.withdraw(address(acct), address(spy), 0.01e18, principal);
        vm.stopPrank();
        assertEq(spy.balanceOf(principal), 1e18);

        // A feed address with no code behind it reads the same way.
        vm.etch(address(spyFeed), "");
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(PriceGuard.DrawHalt.Unreadable));
        (value,,,, h) = vault.account(address(acct));
        assertGt(value, 0);
        assertEq(h, type(uint256).max);
    }

    /// A token whose pause views revert is read as paused, and nothing else stops.
    function test_brokenTokenView_countsZeroAndLeavesTheRestOfTheLaneAlive() public {
        _deposit(spy, 0.01e18);
        _deposit(aapl, 0.02e18);
        _spendOnCredit(5e6);
        spy.setViewsBroken(true);

        CollateralVault.PositionView memory p = vault.positions(address(acct))[1];
        assertEq(p.priceE8, SPY_E8);
        assertFalse(p.fresh);
        assertEq(p.value, 0);
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(PriceGuard.DrawHalt.Unreadable));
        (uint256 value,,, uint256 headroom, uint256 h) = vault.account(address(acct));
        assertEq(value, 6e6);
        assertEq(headroom, 0);
        assertLt(h, WAD);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.OraclePaused.selector, address(spy)));
        vault.liquidate(address(acct), address(spy));
        vm.prank(keeper);
        assertGt(vault.liquidate(address(acct), address(aapl)), 0);

        uint256 owed = pool.debtOf(address(acct));
        usdg.mint(principal, owed);
        vm.startPrank(principal);
        usdg.approve(address(pool), owed);
        pool.repay(address(acct), owed);
        vault.withdraw(address(acct), address(spy), 0.01e18, principal);
        vm.stopPrank();
        assertEq(spy.balanceOf(principal), 1e18);
    }

    /// A sale never runs on a read that failed: the trade path names what it could not read,
    /// and the pool it could not read is a pool with no price.
    function test_tradePrice_namesTheReadItCouldNotMake() public {
        spyFeed.setBroken(true);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.BadPrice.selector, address(spy)));
        guard.exitPrice(address(spy), address(vault));
        spyFeed.setBroken(false);

        spy.setViewsBroken(true);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.OraclePaused.selector, address(spy)));
        guard.tradePrice(address(spy), address(vault));
        spy.setViewsBroken(false);

        vm.mockCallRevert(address(v4), abi.encodeCall(IStateView.getSlot0, (reg.poolId(address(spy)))), "down");
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.PoolPriceDeviation.selector, address(spy), 0, SPY_E8));
        guard.tradePrice(address(spy), address(vault));
        assertEq(guard.poolPriceE8(address(spy)), 0);
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(PriceGuard.DrawHalt.Unreadable));
        vm.clearMockedCalls();

        vm.mockCallRevert(address(access), abi.encodeCall(IAccessRegistry.paused, ()), "down");
        vm.expectRevert(PriceGuard.AccessPaused.selector);
        guard.tradePrice(address(spy), address(vault));
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(PriceGuard.DrawHalt.Unreadable));
        vm.clearMockedCalls();

        vm.mockCallRevert(address(access), abi.encodeCall(IAccessRegistry.isBlocked, (address(vault))), "down");
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.Blocked.selector, address(vault)));
        guard.tradePrice(address(spy), address(vault));
        vm.clearMockedCalls();
        assertEq(guard.tradePrice(address(spy), address(vault)), SPY_E8);
    }

    function test_guard_refusesObservationBoundsThatCannotWork() public {
        IAccessRegistry ar = IAccessRegistry(address(access));
        IStateView sv = IStateView(address(v4));
        vm.expectRevert(PriceGuard.BadObservationBounds.selector);
        new PriceGuard(reg, ar, sv, 0, 1 hours, 1_500);
        vm.expectRevert(PriceGuard.BadObservationBounds.selector);
        new PriceGuard(reg, ar, sv, 5 minutes, 10 minutes - 1, 1_500);
        vm.expectRevert(PriceGuard.BadObservationBounds.selector);
        new PriceGuard(reg, ar, sv, 5 minutes, 1 days + 1, 1_500);
        vm.expectRevert(PriceGuard.BadObservationBounds.selector);
        new PriceGuard(reg, ar, sv, 5 minutes, 1 hours, 0);
        vm.expectRevert(PriceGuard.BadObservationBounds.selector);
        new PriceGuard(reg, ar, sv, 5 minutes, 1 hours, 10_000);
        PriceGuard g = new PriceGuard(reg, ar, sv, 5 minutes, 10 minutes, 9_999);
        assertEq(g.MIN_OBSERVATION_AGE(), 5 minutes);
        assertEq(g.MAX_OBSERVATION_AGE(), 10 minutes);
        assertEq(g.MAX_FEED_JUMP_BPS(), 9_999);
    }

    function test_tierAndCapSettersRefuseNonAdmins() public {
        vm.expectRevert(CollateralVault.NotAdmin.selector);
        vault.setAssetTier(address(spy), 0);
        vm.expectRevert(CreditPool.NotAdmin.selector);
        pool.setCaps(1, 1);
    }

    function test_depositRefusesUnregisteredAndClosedLine() public {
        MockStock fake = new MockStock("SGOV");
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotCollateral.selector, address(fake)));
        vault.deposit(address(acct), address(fake), 1);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NoLine.selector, address(prefund)));
        vault.deposit(address(prefund), address(spy), 1);
    }

    /// The ceiling a write-off converts at has to belong to the Staking it slashes.
    function test_pool_refusesAnotherStakingsBuyback() public {
        Staking other =
            new Staking(IERC20(address(brsr)), IERC20(address(usdg)), admin, slashSink, treasury, 7 days, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(CreditPool.BuybackStakingMismatch.selector, address(staking), address(other))
        );
        new CreditPool(address(usdg), address(other), address(buyback), admin, lender, 100e6, 10e6, 200, 1_800);
    }

    /// The 4 USDG written off comes out of stake at the five-cent ceiling: 80 BRSR, inside the
    /// tenth of the pool a window allows. The lender is still down the whole 4 USDG.
    function test_writeOff_slashesStakeAtTheCeiling() public {
        _stake();
        _nameSlasher();
        _strandLine();

        vm.expectEmit(address(pool));
        emit CreditPool.WrittenOff(address(acct), 4e6, 80e18);
        vault.liquidate(address(acct), address(spy));

        assertEq(brsr.balanceOf(slashSink), 80e18);
        assertEq(staking.totalStaked(), STAKE - 80e18);
        assertEq(pool.badDebt(), 4e6);
        assertEq(pool.cash(), 26e6);
    }

    /// The ceiling holds through the last second the Buyback would still trade on it. A second
    /// later it is not a price: the debt is still written off, and no stake moves.
    function test_writeOff_skipsSlashOnceTheCeilingIsStale() public {
        _stake();
        _nameSlasher();
        MandateAccount second = _secondLine();
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        uint256 lastFresh = buyback.ceilingSetAt() + buyback.maxCeilingAge();
        vm.warp(lastFresh);
        _movePrice(spy, spyFeed, 1e3);

        vault.liquidate(address(acct), address(spy));
        uint256 slashed = STAKE - staking.totalStaked();
        assertGt(slashed, 0);

        vm.warp(lastFresh + 1);
        uint256 debt = pool.debtOf(address(second));
        vm.expectEmit(address(pool));
        emit CreditPool.SlashSkipped(address(second), debt, CreditPool.SlashSkip.CeilingStale);
        vm.expectEmit(address(pool));
        emit CreditPool.WrittenOff(address(second), debt, 0);
        vault.liquidate(address(second), address(spy));

        assertEq(pool.debtOf(address(second)), 0);
        assertEq(STAKE - staking.totalStaked(), slashed);
        assertEq(brsr.balanceOf(slashSink), slashed);
    }

    function test_writeOff_skipsSlashOnUnsetCeiling() public {
        _stake();
        _nameSlasher();
        vm.prank(admin);
        buyback.setParams(_buybackParams(0));
        _strandLine();

        vm.expectEmit(address(pool));
        emit CreditPool.SlashSkipped(address(acct), 4e6, CreditPool.SlashSkip.CeilingUnset);
        vm.expectEmit(address(pool));
        emit CreditPool.WrittenOff(address(acct), 4e6, 0);
        vault.liquidate(address(acct), address(spy));

        assertEq(staking.totalStaked(), STAKE);
    }

    /// Staking starts with no slasher. Until governance names the pool, a write-off takes no stake.
    function test_writeOff_skipsSlashUntilNamedSlasher() public {
        _stake();
        _strandLine();

        vm.expectEmit(address(pool));
        emit CreditPool.SlashSkipped(address(acct), 4e6, CreditPool.SlashSkip.NotSlasher);
        vm.expectEmit(address(pool));
        emit CreditPool.WrittenOff(address(acct), 4e6, 0);
        vault.liquidate(address(acct), address(spy));

        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(staking.totalStaked(), STAKE);
    }

    /// The first Staking deployment has no slasher role, so asking it reverts. The write-off
    /// must still clear the line.
    function test_writeOff_standsWhenStakingHasNoSlasherRole() public {
        _stake();
        _nameSlasher();
        vm.mockCallRevert(address(staking), abi.encodeCall(ICreditStaking.slasher, ()), "");
        _strandLine();

        vm.expectEmit(address(pool));
        emit CreditPool.SlashSkipped(address(acct), 4e6, CreditPool.SlashSkip.NotSlasher);
        vault.liquidate(address(acct), address(spy));

        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(staking.totalStaked(), STAKE);
    }

    /// At one micro-USD a BRSR the 4 USDG loss is four million BRSR. Staking gives up the tenth
    /// of the pool a window allows and no more, and a second write-off in the same block takes
    /// nothing. The lender carries both losses in full.
    function test_slash_neverExceedsTheAllowance() public {
        _stake();
        _nameSlasher();
        vm.prank(admin);
        buyback.setParams(_buybackParams(1));
        MandateAccount second = _secondLine();
        _strandLine();

        uint256 allowance = staking.slashAllowance();
        assertEq(allowance, STAKE / 10);
        vm.expectEmit(address(pool));
        emit CreditPool.WrittenOff(address(acct), 4e6, allowance);
        vault.liquidate(address(acct), address(spy));
        assertEq(staking.slashAllowance(), 0);

        vm.expectEmit(address(pool));
        emit CreditPool.WrittenOff(address(second), 4e6, 0);
        vault.liquidate(address(second), address(spy));

        assertEq(brsr.balanceOf(slashSink), allowance);
        assertEq(staking.totalStaked(), STAKE - allowance);
        assertEq(pool.badDebt(), 8e6);
        assertEq(pool.cash(), 22e6);
    }

    function _deposit(MockStock token, uint256 raw) internal {
        vm.prank(principal);
        vault.deposit(address(acct), address(token), raw);
    }

    function _observeAll() internal {
        guard.observe(address(spy));
        guard.observe(address(sgov));
        guard.observe(address(aapl));
    }

    function _refreshFeeds() internal {
        spyFeed.set(spyFeed.answer(), block.timestamp);
        sgovFeed.set(sgovFeed.answer(), block.timestamp);
        aaplFeed.set(aaplFeed.answer(), block.timestamp);
    }

    /// Two keeper rounds five minutes apart, so the pools as they stand now are the aged sample.
    function _ageObservations() internal {
        vm.warp(block.timestamp + MIN_AGE);
        _refreshFeeds();
        _observeAll();
        vm.warp(block.timestamp + MIN_AGE);
        _refreshFeeds();
        _observeAll();
    }

    /// A fourth stock in the registry that the vault does not list and nobody has observed.
    function _registerUnobserved() internal returns (MockStock msft) {
        msft = new MockStock("MSFT");
        MockFeed feed = new MockFeed();
        feed.set(int256(400e8), block.timestamp);
        PoolKey memory k = _key(address(msft), 500, 10);
        v4.setPrice(k, _sqrt(400e8, k.currency0 == address(msft)));
        vm.prank(admin);
        reg.setAsset(address(msft), _cfg(address(feed), k, true, false, 100));
    }

    function _expectHalt(PriceGuard.DrawHalt halt, bool counts) internal view {
        assertEq(uint8(vault.drawHalt(address(spy))), uint8(halt));
        (,,, uint256 headroom,) = vault.account(address(acct));
        if (counts) assertGt(headroom, 0);
        else assertEq(headroom, 0);
    }

    function _spendOnCredit(uint128 amount) internal {
        vm.prank(agent);
        acct.spend(_req(amount), new bytes32[](0));
    }

    /// Draws 4 USDG against 0.01 SPY, then drops SPY to dust, so the next liquidation writes the
    /// whole 4 USDG off.
    function _strandLine() internal {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        _movePrice(spy, spyFeed, 1e3);
    }

    /// Another line drawn like `acct` will be: 4 USDG against 0.01 SPY.
    function _secondLine() internal returns (MandateAccount second) {
        second = _mandate(1);
        vm.startPrank(principal);
        vault.openLine(address(second));
        vault.deposit(address(second), address(spy), 0.01e18);
        vm.stopPrank();
        vm.prank(agent);
        second.spend(_req(4e6), new bytes32[](0));
    }

    function _stake() internal {
        brsr.mint(staker, STAKE);
        vm.startPrank(staker);
        brsr.approve(address(staking), STAKE);
        staking.stake(STAKE);
        vm.stopPrank();
    }

    function _nameSlasher() internal {
        vm.prank(admin);
        staking.setSlasher(address(pool));
    }

    function _movePrice(MockStock token, MockFeed feed, uint256 priceE8) internal {
        feed.set(int256(priceE8), block.timestamp);
        _setPool(token, priceE8);
    }

    function _setPool(MockStock token, uint256 priceE8) internal {
        PoolKey memory k = reg.get(address(token)).pool;
        v4.setPrice(k, _sqrt(priceE8, k.currency0 == address(token)));
    }

    function _mandate(uint8 lane) internal returns (MandateAccount m) {
        m = new MandateAccount(principal, agent, address(usdg), address(escrow), _limits(lane));
        accounts.add(principal, address(m));
        vm.startPrank(principal);
        m.setTreasuryPark(address(vault));
        m.setCapability(CAP, true);
        m.setMerchant(merchant, true);
        vm.stopPrank();
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

    function _limits(uint8 lane) internal pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: 30e6,
            dailyCap: 100e6,
            monthlyCap: 1_000e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 50e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: lane
        });
    }

    function _params() internal pure returns (CollateralVault.Params memory) {
        return CollateralVault.Params({minBorrowHealth: 1.25e18, liquidationTarget: 1.05e18, bountyBps: 500});
    }

    function _buybackParams(uint128 ceiling) internal pure returns (Buyback.Params memory) {
        return Buyback.Params({
            spendPerCallMicroUsd: 1e6,
            maxSpendPerWindowMicroUsd: 10e6,
            minSpendMicroUsd: 0.1e6,
            maxPriceMicroUsdPerBrsr: ceiling,
            window: 1 days,
            minInterval: 1 hours
        });
    }

    function _tiers() internal pure returns (CollateralVault.Tier[] memory t) {
        t = new CollateralVault.Tier[](3);
        t[0] = CollateralVault.Tier(500, 1_000, 26 hours, 100 hours, "Treasury");
        t[1] = CollateralVault.Tier(2_000, 3_500, 26 hours, 100 hours, "Index fund");
        t[2] = CollateralVault.Tier(3_000, 5_000, 26 hours, 100 hours, "Single stock");
    }

    function _assetList() internal view returns (address[] memory a) {
        a = new address[](3);
        a[0] = address(sgov);
        a[1] = address(spy);
        a[2] = address(aapl);
    }

    function _assetTiers() internal pure returns (uint8[] memory t) {
        t = new uint8[](3);
        t[0] = 1;
        t[1] = 2;
        t[2] = 3;
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

    function _cfg(address feed, PoolKey memory pool_, bool isStock, bool isTreasury, uint16 band)
        internal
        pure
        returns (AssetRegistry.Asset memory)
    {
        return AssetRegistry.Asset({
            feed: feed,
            tradeStaleness: 26 hours,
            valuationStaleness: 100 hours,
            bandBps: band,
            haircutBps: 50,
            collateralHaircutBps: 0,
            decimals: 0,
            eligible: true,
            isStock: isStock,
            isTreasury: isTreasury,
            perTradeCap: 25e6,
            perMandateCap: 100e6,
            totalCap: 1_000e6,
            pool: pool_
        });
    }
}
