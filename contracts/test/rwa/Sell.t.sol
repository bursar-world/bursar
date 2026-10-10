// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PriceGuard} from "../../src/rwa/PriceGuard.sol";
import {SellCustody, StockSpendRouter} from "../../src/rwa/StockSpendRouter.sol";
import {V4Swapper} from "../../src/rwa/V4Swapper.sol";
import {RwaFixture} from "./RwaFixture.sol";

/// Selling a stock the mandate holds back to USDG: the principal releases it to the mandate's
/// custody, the agent sells it under the purchase guard, and the USDG lands in the mandate.
contract SellTest is RwaFixture {
    event StockSold(
        address indexed mandate, address indexed asset, uint256 amountIn, uint256 usdgOut, uint256 feedPriceE8
    );

    uint256 internal held;

    function setUp() public override {
        super.setUp();
        _allowSale(address(spy), true);
        vm.prank(agent);
        held = acct.buy(address(spy), 1e6, 0, SPY_E8);
        _release(address(spy), held);
    }

    function test_sell_deliversUsdgToTheMandate() public {
        uint256 before = usdg.balanceOf(address(acct));
        uint256 expected = _filled(Math.mulDiv(held, SPY_E8, 1e20), address(spy));

        vm.prank(agent);
        vm.expectEmit(true, true, true, false, address(router));
        emit StockSold(address(acct), address(spy), held, 0, SPY_E8);
        uint256 out = router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);

        assertEq(usdg.balanceOf(address(acct)), before + out);
        assertApproxEqRel(out, expected, 1e12);
        assertEq(router.sellable(address(acct), address(spy)), 0);
        assertEq(spy.balanceOf(address(acct)), 0);
        // A sale restores USDG the mandate can spend; it credits nothing back to the limits.
        assertEq(acct.totalSpent(), 1e6);
    }

    function test_sell_thePrincipalCanSellToo() public {
        vm.prank(principal);
        uint256 out = router.sell(address(acct), address(spy), uint128(held / 2), 0, SPY_E8);
        assertGt(out, 0);
        assertEq(router.sellable(address(acct), address(spy)), held - held / 2);
    }

    function test_sell_minUsdgForIsTheFloorTheSaleHolds() public {
        uint256 floor = router.minUsdgFor(address(acct), address(spy), held);
        assertEq(floor, Math.mulDiv(Math.mulDiv(held, SPY_E8, 1e20), 10_000 - 100, 10_000));

        _policy(20);
        assertEq(router.minUsdgFor(address(acct), address(spy), held), Math.mulDiv(Math.mulDiv(held, SPY_E8, 1e20), 9_980, 10_000));
    }

    function test_sell_refusesCallersWithoutTheRole() public {
        vm.prank(merchant);
        vm.expectRevert(StockSpendRouter.NotOperator.selector);
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);

        vm.prank(merchant);
        vm.expectRevert(StockSpendRouter.NotOperator.selector);
        router.recall(address(acct), address(spy), held);
    }

    function test_sell_refusesAnAssetOffTheSaleList() public {
        _allowSale(address(spy), false);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.SaleNotAllowed.selector, address(spy)));
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);
    }

    function test_sell_refusesTheTreasuryToken() public {
        _allowSale(address(sgov), true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.NotAStock.selector, address(sgov)));
        router.sell(address(acct), address(sgov), 1e18, 0, SGOV_E8);
    }

    function test_sell_refusesNothing() public {
        vm.prank(agent);
        vm.expectRevert(StockSpendRouter.ZeroAmount.selector);
        router.sell(address(acct), address(spy), 0, 0, SPY_E8);
    }

    function test_sell_refusesMoreThanTheCustodyHolds() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.CustodyShort.selector, held, held + 1));
        router.sell(address(acct), address(spy), uint128(held + 1), 0, SPY_E8);
    }

    /// The feed stops moving when the market closes. A sale on the last answer goes through until
    /// that answer is older than the trade bound, and is refused after.
    function test_sell_afterHoursTradesOnTheLastAnswerUntilItIsStale() public {
        vm.warp(block.timestamp + H26 - 1 hours);
        vm.prank(agent);
        uint256 out = router.sell(address(acct), address(spy), uint128(held / 2), 0, SPY_E8);
        assertGt(out, 0);

        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.StalePrice.selector, address(spy), H26 + 1, H26));
        router.sell(address(acct), address(spy), uint128(held - held / 2), 0, SPY_E8);
    }

    function test_sell_refusesAStaleFeedOnTheQuoteToo() public {
        vm.warp(block.timestamp + H26 + 1);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.StalePrice.selector, address(spy), H26 + 1, H26));
        router.minUsdgFor(address(acct), address(spy), held);
    }

    function test_sell_refusesAQuoteOutsideTheBand() public {
        uint256 quoted = SPY_E8 * 102 / 100;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.QuoteOutsideBand.selector, address(spy), quoted, SPY_E8));
        router.sell(address(acct), address(spy), uint128(held), 0, quoted);
    }

    function test_sell_refusesAPoolOutsideTheFeedBand() public {
        spyFeed.set(int256(SPY_E8 * 102 / 100), block.timestamp);
        vm.prank(agent);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8 * 102 / 100);
    }

    function test_sell_refusesWhileTheTokenIsPaused() public {
        spy.setTokenPaused(true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.TokenPaused.selector, address(spy)));
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);
    }

    function test_sell_refusesABlockedMandate() public {
        access.setBlocked(address(acct), true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.Blocked.selector, address(acct)));
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);
    }

    function test_sell_refusesAFillWorseThanTheSlippageLimit() public {
        v4.setHaircut(150);
        vm.prank(agent);
        vm.expectPartialRevert(V4Swapper.SwapShort.selector);
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);

        // The mandate's own limit binds tighter than the asset's band.
        v4.setHaircut(30);
        _policy(20);
        vm.prank(agent);
        vm.expectPartialRevert(V4Swapper.SwapShort.selector);
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);

        // And the caller's own floor above both.
        v4.setHaircut(10);
        uint256 asked = Math.mulDiv(held, SPY_E8, 1e20);
        vm.prank(agent);
        vm.expectPartialRevert(V4Swapper.SwapShort.selector);
        router.sell(address(acct), address(spy), uint128(held), uint128(asked), SPY_E8);

        vm.prank(agent);
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);
    }

    /// A sale must leave the pool inside the band as well as find it there.
    function test_sell_refusesManipulatedFill() public {
        v4.setImpact(50);
        _setPool(spy, SPY_E8 * 9_920 / 10_000); // 80 bps under the feed, inside the 100 bps band
        vm.prank(agent);
        vm.expectPartialRevert(PriceGuard.PoolPriceDeviation.selector);
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);

        _setPool(spy, SPY_E8);
        vm.prank(agent);
        router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);
    }

    function test_sell_refusesASaleAboveThePerTradeCapAtTheFeed() public {
        uint256 big = Math.mulDiv(26e6, 1e20, SPY_E8);
        spy.mint(router.custodyOf(address(acct)), big);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(StockSpendRouter.TradeCapExceeded.selector, Math.mulDiv(big, SPY_E8, 1e20), 25e6)
        );
        router.sell(address(acct), address(spy), uint128(big), 0, SPY_E8);
    }

    /// Delisting stops purchases. What a mandate already holds can still be sold out.
    function test_sell_sellsADelistedStock() public {
        vm.prank(admin);
        reg.setEligible(address(spy), false);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NotEligible.selector, address(spy)));
        acct.buy(address(spy), 1e6, 0, SPY_E8);

        vm.prank(agent);
        uint256 out = router.sell(address(acct), address(spy), uint128(held), 0, SPY_E8);
        assertGt(out, 0);
    }

    function test_recall_returnsCustodyToTheMandate() public {
        vm.prank(agent);
        router.recall(address(acct), address(spy), held / 3);
        assertEq(spy.balanceOf(address(acct)), held / 3);
        assertEq(router.sellable(address(acct), address(spy)), held - held / 3);

        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(StockSpendRouter.CustodyShort.selector, held - held / 3, held));
        router.recall(address(acct), address(spy), held);

        vm.prank(principal);
        vm.expectRevert(StockSpendRouter.ZeroAmount.selector);
        router.recall(address(acct), address(spy), 0);
    }

    function test_custody_answersOnlyToTheRouter() public {
        // The custody is created by the first sale or recall; until then it is an address.
        address at = router.custodyOf(address(acct));
        assertEq(at.code.length, 0);
        vm.prank(agent);
        router.recall(address(acct), address(spy), 1);
        SellCustody custody = SellCustody(at);
        assertEq(custody.router(), address(router));
        vm.prank(principal);
        vm.expectRevert(SellCustody.NotRouter.selector);
        custody.sweep(address(spy), principal, held);
    }

    function test_sell_onlyThePrincipalSetsTheSalePolicy() public {
        address[] memory a = new address[](1);
        a[0] = address(spy);
        bool[] memory y = new bool[](1);
        vm.prank(agent);
        vm.expectRevert(StockSpendRouter.NotPrincipal.selector);
        router.setSalePolicy(address(acct), a, y);

        vm.prank(principal);
        vm.expectRevert(StockSpendRouter.LengthMismatch.selector);
        router.setSalePolicy(address(acct), a, new bool[](0));
    }

    function _allowSale(address asset, bool allowed) internal {
        address[] memory a = new address[](1);
        a[0] = asset;
        bool[] memory y = new bool[](1);
        y[0] = allowed;
        vm.prank(principal);
        router.setSalePolicy(address(acct), a, y);
    }

    /// The principal's step: stock the agent may sell goes from the account to its custody.
    function _release(address asset, uint256 raw) internal {
        address custody = router.custodyOf(address(acct));
        vm.prank(principal);
        acct.withdraw(asset, custody, raw);
    }
}
