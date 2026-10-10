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

/// The RWA lane on mocks: the registry, the guard, the router and the park, one mandate with the
/// `rwa` class, and the helpers every suite on the lane shares.
abstract contract RwaFixture is Test {
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

    function setUp() public virtual {
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

        guard = new PriceGuard(
            reg, IAccessRegistry(address(access)), IStateView(address(v4)), 5 minutes, 1 hours, 1_500, admin, address(0)
        );
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

    function _expectBadBounds(AssetRegistry.Asset memory c) internal {
        vm.prank(admin);
        vm.expectRevert(AssetRegistry.BadBounds.selector);
        reg.setAsset(address(spy), c);
    }

    function _setPool(MockStock token, uint256 priceE8) internal {
        PoolKey memory k = reg.get(address(token)).pool;
        v4.setPrice(k, _sqrt(priceE8, k.currency0 == address(token)));
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

    function _factories() internal view returns (IMandateAccountFactory[] memory list) {
        list = new IMandateAccountFactory[](1);
        list[0] = IMandateAccountFactory(address(accounts));
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
