// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {RecordKeys as K} from "../../../script/lib/RecordKeys.sol";

import {IMandateAccount} from "../../../src/interfaces/IMandateAccount.sol";
import {IPoolManager} from "../../../src/token/Buyback.sol";
import {AssetRegistry} from "../../../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../../../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../../../src/rwa/StockSpendRouter.sol";
import {V4Swapper} from "../../../src/rwa/V4Swapper.sol";
import {IAggregatorV3} from "../../../src/rwa/interfaces/IRwaExternal.sol";

/// The sell path on a copy of Robinhood Chain as the live record stands: the new router deployed
/// against the live registry, guard and pool manager, and the live example mandate buying SPY,
/// releasing it and selling it back through the live SPY/USDG pool at the live feed.
///
///   BURSAR_RHC_FORK_RPC=$CHAINSTACK_RHC_RPC_URL forge test --match-path test/script/fork/SellFork.t.sol -vv
///
/// Without the variable every test here skips. `BURSAR_RHC_FORK_BLOCK` pins the fork; unset, the
/// fork is taken at the block below, a Saturday afternoon with the SPY feed 21 hours old, inside
/// its 26-hour trade bound and outside the equities session. The endpoint has to serve state at
/// that block.
contract SellForkTest is Test {
    uint256 internal constant PINNED_BLOCK = 85_106_897;
    string internal constant RECORD = "deployments/rhc-mainnet-v6.json";

    AssetRegistry internal registry;
    PriceGuard internal guard;
    StockSpendRouter internal router;
    IMandateAccount internal acct;
    address internal payer;
    address internal spy;
    address internal nvda;
    address internal usdg;
    address internal feed;

    function setUp() public {
        string memory rpc = vm.envOr("BURSAR_RHC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "BURSAR_RHC_FORK_RPC is unset; it names the Robinhood Chain endpoint this suite forks");
            return;
        }
        vm.createSelectFork(rpc, vm.envOr("BURSAR_RHC_FORK_BLOCK", PINNED_BLOCK));
        require(block.chainid == 4663, "the fork is not Robinhood Chain");

        string memory json = vm.readFile(RECORD);
        registry = AssetRegistry(vm.parseJsonAddress(json, K.ASSET_REGISTRY));
        guard = PriceGuard(vm.parseJsonAddress(json, K.PRICE_GUARD));
        acct = IMandateAccount(vm.parseJsonAddress(json, ".exampleMandate.address"));
        payer = vm.parseJsonAddress(json, ".exampleMandate.principal");
        spy = vm.parseJsonAddress(json, string.concat(K.RWA_ASSETS, ".SPY.address"));
        nvda = vm.parseJsonAddress(json, string.concat(K.RWA_ASSETS, ".NVDA.address"));
        feed = vm.parseJsonAddress(json, string.concat(K.RWA_ASSETS, ".SPY.feed"));
        usdg = vm.parseJsonAddress(json, K.SETTLEMENT_ASSET);

        vm.prank(vm.parseJsonAddress(json, K.DEPLOYER));
        router = new StockSpendRouter(registry, guard, IPoolManager(vm.parseJsonAddress(json, K.POOL_MANAGER)));

        // The example mandate's owner adopts the router and allows SPY both ways; the agent is the
        // same key on this mandate.
        address[] memory stocks = new address[](2);
        stocks[0] = spy;
        stocks[1] = nvda;
        bool[] memory both = new bool[](2);
        both[0] = both[1] = true;
        bool[] memory spyOnly = new bool[](2);
        spyOnly[0] = true;
        vm.startPrank(payer);
        acct.setRouter(address(router));
        router.setPolicy(address(acct), 100, stocks, both);
        router.setSalePolicy(address(acct), stocks, spyOnly);
        vm.stopPrank();

        vm.deal(payer, 1 ether);
    }

    function test_fork_aStockBoughtUnderTheMandateIsSoldBackForUsdgAtTheGuardedPrice() public {
        _requireInsideTradeBound();
        uint256 price = guard.tradePrice(spy, address(acct));
        uint256 raw = _buy(0.5e6, price);
        _release(raw);

        uint256 floor = router.minUsdgFor(address(acct), spy, raw);
        uint256 before = IERC20(usdg).balanceOf(address(acct));
        vm.prank(payer);
        uint256 out = router.sell(address(acct), spy, uint128(raw), 0, price);
        console2.log("SPY sold raw", raw, "USDG out", out);
        console2.log("floor", floor, "feed E8", price);

        assertEq(IERC20(usdg).balanceOf(address(acct)), before + out, "the proceeds did not land in the mandate");
        assertGe(out, floor, "the fill came in under the floor the quote promised");
        assertApproxEqRel(out, 0.5e6, 0.015e18, "half a dollar of SPY sold for far from half a dollar");
        assertEq(router.sellable(address(acct), spy), 0);
    }

    function test_fork_aSaleIsRefusedOutsideTheBandAndPastTheTradeBound() public {
        _requireInsideTradeBound();
        uint256 price = guard.tradePrice(spy, address(acct));
        uint256 raw = _buy(0.5e6, price);
        _release(raw);

        // A quote decided on a price 2% away from the feed's.
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(StockSpendRouter.QuoteOutsideBand.selector, spy, price * 102 / 100, price)
        );
        router.sell(address(acct), spy, uint128(raw), 0, price * 102 / 100);

        // A fill the caller will not take: the floor set above what the pool pays at the feed.
        vm.prank(payer);
        vm.expectPartialRevert(V4Swapper.SwapShort.selector);
        router.sell(address(acct), spy, uint128(raw), uint128(Math.mulDiv(raw, price, 1e20) * 2), price);

        // The feed answering 2% away from where the pool trades: refused before anything moves.
        (uint80 round,, uint256 started, uint256 updated, uint80 answered) = IAggregatorV3(feed).latestRoundData();
        vm.mockCall(
            feed,
            abi.encodeCall(IAggregatorV3.latestRoundData, ()),
            abi.encode(round, int256(price * 102 / 100), started, updated, answered)
        );
        vm.prank(payer);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        router.sell(address(acct), spy, uint128(raw), 0, price * 102 / 100);
        vm.clearMockedCalls();

        // Past the trade bound the last answer is too old to sell on.
        uint256 bound = registry.get(spy).tradeStaleness;
        vm.warp(updated + bound + 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.StalePrice.selector, spy, bound + 1, bound));
        router.sell(address(acct), spy, uint128(raw), 0, price);

        // The holding is still the mandate's: back into the account without a price.
        vm.prank(payer);
        router.recall(address(acct), spy, raw);
        assertEq(IERC20(spy).balanceOf(address(acct)), raw);
    }

    /// Out of the equities session the feed stands at the last close. A sale goes through on it
    /// while it is inside the trade bound, and nothing else about the market being closed stops it.
    function test_fork_afterHoursASaleFillsOnTheLastAnswerInsideTheBound() public {
        _requireInsideTradeBound();
        (,,, uint256 updated,) = IAggregatorV3(feed).latestRoundData();
        console2.log("feed updated", updated, "fork time", block.timestamp);
        uint256 price = guard.tradePrice(spy, address(acct));
        uint256 raw = _buy(0.25e6, price);
        _release(raw);
        vm.prank(payer);
        uint256 out = router.sell(address(acct), spy, uint128(raw), 0, price);
        assertGt(out, 0);
    }

    function test_fork_theSalePolicyIsTheOwnersAndNvdaIsNotOnIt() public {
        _requireInsideTradeBound();
        uint256 price = guard.tradePrice(nvda, address(acct));
        vm.prank(payer);
        uint256 raw = acct.buy(nvda, 0.25e6, 0, price);
        address custody = router.custodyOf(address(acct));
        vm.prank(payer);
        acct.withdraw(nvda, custody, raw);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.SaleNotAllowed.selector, nvda));
        router.sell(address(acct), nvda, uint128(raw), 0, price);

        address[] memory one = new address[](1);
        one[0] = nvda;
        bool[] memory yes = new bool[](1);
        yes[0] = true;
        vm.prank(payer);
        router.setSalePolicy(address(acct), one, yes);
        vm.prank(payer);
        assertGt(router.sell(address(acct), nvda, uint128(raw), 0, price), 0);
    }

    function _buy(uint128 usdgIn, uint256 price) private returns (uint256 raw) {
        vm.prank(payer);
        raw = acct.buy(spy, usdgIn, 0, price);
        assertGt(raw, 0, "the purchase delivered nothing");
    }

    function _release(uint256 raw) private {
        address custody = router.custodyOf(address(acct));
        vm.prank(payer);
        acct.withdraw(spy, custody, raw);
        assertEq(router.sellable(address(acct), spy), raw);
    }

    function _requireInsideTradeBound() private {
        AssetRegistry.Asset memory a = registry.get(spy);
        (,,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        if (block.timestamp - updatedAt <= a.tradeStaleness) return;
        vm.skip(true, "the SPY feed is past its trade bound at the fork block; pin BURSAR_RHC_FORK_BLOCK inside it");
    }
}
