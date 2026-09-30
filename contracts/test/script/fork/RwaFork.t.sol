// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RecordKeys as K} from "../../../script/lib/RecordKeys.sol";

import {MandateAccountFactory} from "../../../src/MandateAccountFactory.sol";
import {IMandateAccount} from "../../../src/interfaces/IMandateAccount.sol";
import {PriceGuard} from "../../../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../../../src/rwa/StockSpendRouter.sol";
import {TreasuryPark} from "../../../src/rwa/TreasuryPark.sol";
import {ForkWorld} from "./ForkWorld.sol";

/// The RWA lane the scripts deploy, against the live feeds, the pinned pools and the access
/// registry: a stock bought at the guarded price, the treasury fund parked and sold back, a buy
/// that unparks its own shortfall, and the staleness bounds.
contract RwaForkTest is ForkWorld {
    address internal principal = makeAddr("principal");
    address internal agent = makeAddr("agent");

    PriceGuard internal guard;
    TreasuryPark internal park;
    address internal sgovAdapter;

    function _prefix() internal pure override returns (string memory) {
        return "RWAFORK_";
    }

    function setUp() public {
        _fork("fork-rwa");
        _core();
        _rwa();
        guard = PriceGuard(_readAddress(path, K.PRICE_GUARD));
        park = TreasuryPark(_readAddress(path, K.TREASURY_PARK));
        sgovAdapter = _readAddress(path, K.SGOV_ADAPTER);
        _save();
    }

    function test_fork_stocksBuyAtTheGuardedPriceAndTheFundParksAndComesBack() public {
        _requireSession("SPY");
        _requireSession("NVDA");
        _requireSession("SGOV");
        _aStockIsBoughtAtTheGuardedPriceAndTheFundParksAndComesBack();
        _aBuyUnparksItsOwnShortfall();
        _pastTheBoundsNothingTradesAndParkedValueStopsCounting();
    }

    function _aStockIsBoughtAtTheGuardedPriceAndTheFundParksAndComesBack() private {
        _restore();
        IMandateAccount acct = _newMandate("buy-and-park");
        address spy = _asset("SPY");

        uint256 price = guard.tradePrice(spy, address(acct));
        console2.log("SPY feed E8", price, "pool E8", guard.poolPriceE8(spy));
        vm.prank(agent);
        uint256 out = acct.buy(spy, 1e6, 0, price);
        assertEq(IERC20(spy).balanceOf(address(acct)), out);
        assertApproxEqRel((out * price) / 1e20, 1e6, 0.01e18, "the stock bought is far from a dollar at the feed");

        uint256 raw = _park(address(acct), 2e6);
        (,, uint256 value,,, bool fresh) = park.position(address(acct), sgovAdapter);
        assertTrue(fresh, "the parked position reads stale");
        assertApproxEqRel(value, 2e6, 0.005e18, "the parked value is far from what went in");

        uint256 before = IERC20(USDG).balanceOf(address(acct));
        vm.prank(principal);
        uint256 back = park.unpark(address(acct), sgovAdapter, raw, 0);
        assertEq(IERC20(USDG).balanceOf(address(acct)), before + back);
        assertApproxEqRel(back, 2e6, 0.005e18, "unparking returned far less than was parked");
    }

    /// A mandate with everything parked still buys: the park sells enough of the fund back first.
    function _aBuyUnparksItsOwnShortfall() private {
        _restore();
        IMandateAccount acct = _newMandate("shortfall");
        _park(address(acct), 5e6);
        uint256 held = IERC20(USDG).balanceOf(address(acct));
        vm.prank(principal);
        acct.withdraw(USDG, principal, held);

        address nvda = _asset("NVDA");
        uint256 price = guard.tradePrice(nvda, address(acct));
        vm.prank(agent);
        uint256 out = acct.buy(nvda, 1e6, 0, price);
        assertGt(out, 0, "the purchase delivered nothing");
        assertEq(IERC20(USDG).balanceOf(address(acct)), 0);
    }

    /// Past the trade bound nothing trades while parked value still counts; past the valuation
    /// bound it stops counting toward what the mandate can spend.
    function _pastTheBoundsNothingTradesAndParkedValueStopsCounting() private {
        _restore();
        IMandateAccount acct = _newMandate("stale");
        _park(address(acct), 2e6);

        vm.warp(block.timestamp + 30 hours);
        address spy = _asset("SPY");
        vm.prank(agent);
        vm.expectPartialRevert(PriceGuard.StalePrice.selector);
        acct.buy(spy, 1e6, 0, 1);
        (uint256 total,) = park.parkedValue(address(acct));
        assertGt(total, 0, "parked value stopped counting at the trade bound");

        vm.warp(block.timestamp + 4 days);
        (total,) = park.parkedValue(address(acct));
        assertEq(total, 0, "parked value still counts past the valuation bound");
        assertEq(park.spendingPower(address(acct)), IERC20(USDG).balanceOf(address(acct)));
    }

    function _newMandate(string memory salt) private returns (IMandateAccount acct) {
        IMandateAccount.Limits memory limits = IMandateAccount.Limits({
            perCallCap: 10e6,
            dailyCap: 50e6,
            monthlyCap: 100e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 10e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: 0
        });
        MandateAccountFactory factory = MandateAccountFactory(_readAddress(path, K.FACTORY));
        vm.prank(principal);
        acct = IMandateAccount(factory.create(principal, agent, keccak256(bytes(salt)), limits));
        _usdg(address(acct), 20e6);

        address[] memory stocks = new address[](3);
        stocks[0] = _asset("SPY");
        stocks[1] = _asset("NVDA");
        stocks[2] = _asset("AAPL");
        bool[] memory allowed = new bool[](3);
        allowed[0] = allowed[1] = allowed[2] = true;
        StockSpendRouter router = StockSpendRouter(_readAddress(path, K.STOCK_ROUTER));
        vm.startPrank(principal);
        acct.setRouter(address(router));
        acct.setTreasuryPark(address(park));
        router.setPolicy(address(acct), 100, stocks, allowed);
        vm.stopPrank();
    }

    function _park(address acct, uint256 amount) private returns (uint256 raw) {
        vm.startPrank(principal);
        IMandateAccount(acct).withdraw(USDG, park.vaultOf(acct), amount);
        raw = park.park(acct, sgovAdapter, amount, 0);
        vm.stopPrank();
    }
}
