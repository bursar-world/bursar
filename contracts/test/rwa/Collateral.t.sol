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
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {IAccessRegistry, IStateView} from "../../src/rwa/interfaces/IRwaExternal.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAccess, MockEscrow, MockFeed, MockStock, MockV4} from "./RwaMocks.sol";

contract MockAccounts {
    mapping(address => address[]) internal _list;

    function add(address principal, address account) external {
        _list[principal].push(account);
    }

    function accountsOf(address principal) external view returns (address[] memory) {
        return _list[principal];
    }
}

contract MockStaking {
    IERC20 public immutable usdg;
    address public creditManager;
    uint256 public distributed;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function setCreditManager(address a) external {
        creditManager = a;
    }

    function distribute(uint256 amount) external {
        require(msg.sender == creditManager, "NotCreditManager");
        usdg.transferFrom(msg.sender, address(this), amount);
        distributed += amount;
    }
}

contract CollateralTest is Test {
    uint256 internal constant SPY_E8 = 771_21266423;
    uint256 internal constant SGOV_E8 = 101_17856966;
    uint256 internal constant WAD = 1e18;
    // A Monday, 14:13 UTC, inside the 24/5 session.
    uint256 internal constant T0 = 1_790_000_000;

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
    MockStaking staking;

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
    bytes32 constant CAP = keccak256("service:gpu.render:1");

    function setUp() public {
        vm.warp(T0);
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
        staking = new MockStaking(IERC20(address(usdg)));

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
        guard = new PriceGuard(reg, IAccessRegistry(address(access)), IStateView(address(v4)));

        pool = new CreditPool(address(usdg), address(staking), admin, lender, 100e6, 10e6, 200, 1_800);
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
    }

    // ---- health math ----

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

    function test_health_maxWithNoDebt_andHeadroom() public {
        _deposit(spy, 0.01e18);
        (, uint256 adj, uint256 debt, uint256 headroom, uint256 h) = vault.account(address(acct));
        assertEq(debt, 0);
        assertEq(h, type(uint256).max);
        assertEq(headroom, Math.mulDiv(adj, WAD, 1.25e18));
    }

    function test_value_usesFeedNotMultiplier() public {
        _deposit(sgov, 1e18);
        (uint256 value,,,,) = vault.account(address(acct));
        assertEq(value, Math.mulDiv(1e18, SGOV_E8, 1e20));
    }

    // ---- haircuts ----

    function test_haircut_afterHoursOnWeekend() public {
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

    function test_haircut_registryFloorTightens() public {
        AssetRegistry.Asset memory c = reg.get(address(spy));
        c.collateralHaircutBps = 4_000;
        vm.prank(admin);
        reg.setAsset(address(spy), c);
        (uint16 bps,) = vault.haircutOf(address(spy));
        assertEq(bps, 4_000);
    }

    function test_tiers_published() public view {
        CollateralVault.Tier[] memory t = vault.tiers();
        assertEq(t.length, 3);
        assertEq(t[0].sessionHaircutBps, 500);
        assertEq(vault.tierOf(address(sgov)), 1);
        assertEq(vault.tierOf(address(spy)), 2);
        assertEq(vault.tierOf(address(aapl)), 3);
        assertEq(vault.collateralAssets().length, 3);
    }

    // ---- stale and paused ----

    function test_stalePriceCountsZero_andDefersDraw() public {
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

    /// The 2026-06-23 rounds were 1e8 too large and fresh by every timestamp test. With the pool
    /// at its real mid the position backs nothing: no draw, no withdrawal, no inflated value.
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
        _spendOnCredit(4.5e6);
        spyFeed.set(int256(SPY_E8 / 2), block.timestamp - 27 hours);
        assertLt(vault.health(address(acct)), WAD);
        vm.expectRevert();
        vault.liquidate(address(acct), address(spy));

        spyFeed.set(int256(SPY_E8 / 2), block.timestamp);
        spy.setOraclePaused(true);
        vm.expectRevert();
        vault.liquidate(address(acct), address(spy));
    }

    // ---- borrowing ----

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
        _deposit(spy, 0.01e18); // adjusted 6.1697, headroom 4.9357
        vm.expectRevert();
        _spendOnCredit(5e6);
        _spendOnCredit(4.9e6);
    }

    function test_caps_perMandate() public {
        _deposit(spy, 0.1e18);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.MandateCapExceeded.selector, 11e6, 10e6));
        _spendOnCredit(11e6);
        _spendOnCredit(10e6);
    }

    function test_caps_total() public {
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

    // ---- repayment and spread ----

    function test_repayReducesDebt_andSpreadReachesStakers() public {
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
        assertEq(staking.distributed(), spread);
        assertApproxEqAbs(usdg.balanceOf(address(pool)), 30e6, 2);
    }

    function test_sweepRevertsUntilCreditManager() public {
        staking.setCreditManager(address(0));
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert("NotCreditManager");
        pool.sweepSpread();
    }

    function test_withdrawCollateralBoundedByHealth() public {
        _deposit(spy, 0.01e18);
        _spendOnCredit(4e6);
        vm.prank(principal);
        vm.expectRevert();
        vault.withdraw(address(acct), address(spy), 0.005e18, principal);
        vm.prank(principal);
        vault.withdraw(address(acct), address(spy), 0.001e18, principal);
        vm.prank(agent);
        vm.expectRevert(CollateralVault.NotPrincipal.selector);
        vault.withdraw(address(acct), address(spy), 0.001e18, agent);
    }

    // ---- liquidation ----

    function test_liquidate_sellsOnlyTheSlice() public {
        _deposit(spy, 0.01e18);
        _deposit(aapl, 0.01e18);
        _spendOnCredit(6e6);
        _movePrice(spy, spyFeed, SPY_E8 * 60 / 100);
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

    function test_adminOnly() public {
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

    // ---- helpers ----

    function _deposit(MockStock token, uint256 raw) internal {
        vm.prank(principal);
        vault.deposit(address(acct), address(token), raw);
    }

    function _spendOnCredit(uint128 amount) internal {
        vm.prank(agent);
        acct.spend(_req(amount), new bytes32[](0));
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
            collateralTier: 0,
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
