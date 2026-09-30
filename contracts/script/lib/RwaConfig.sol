// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "../../src/token/Buyback.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";

/// The terms each asset trades under in the RWA lane, from the 2026-09-28 measurements. Addresses
/// are not here: the token, its feed and, on Robinhood Chain, the measured id of its pinned pool
/// come from the record's `external.assets`, so a rehearsal against stand-ins runs the same terms.
///
/// Each asset trades through one hookless v4 pool against USDG. The pool is named by its fee and
/// spacing here and by the two currencies, sorted, from the record.
library RwaConfig {
    /// Trade bound: the stock feeds' 24 h heartbeat plus two hours. Valuation bound for the
    /// treasury fund: a three-day weekend. Stocks are never parked, so their valuation bound is
    /// the trade bound.
    uint32 internal constant TRADE_STALENESS = 93_600;
    uint32 internal constant TREASURY_VALUATION_STALENESS = 360_000;

    uint128 internal constant STOCK_TRADE_CAP = 25e6;
    uint128 internal constant PARK_PER_MANDATE = 100e6;
    uint128 internal constant PARK_TOTAL = 1_000e6;

    struct Term {
        string symbol;
        bool isTreasury;
        uint24 fee;
        int24 tickSpacing;
        uint32 valuationStaleness;
        uint16 bandBps;
        uint16 haircutBps;
        uint128 perTradeCap;
        uint128 perMandateCap;
        uint128 totalCap;
    }

    function terms() internal pure returns (Term[] memory t) {
        t = new Term[](4);
        t[0] = Term("SGOV", true, 375, 4, TREASURY_VALUATION_STALENESS, 50, 50, 0, PARK_PER_MANDATE, PARK_TOTAL);
        t[1] = Term("SPY", false, 500, 5, TRADE_STALENESS, 100, 0, STOCK_TRADE_CAP, 0, 0);
        t[2] = Term("NVDA", false, 100, 1, TRADE_STALENESS, 100, 0, STOCK_TRADE_CAP, 0, 0);
        t[3] = Term("AAPL", false, 3000, 60, TRADE_STALENESS, 100, 0, STOCK_TRADE_CAP, 0, 0);
    }

    function asset(Term memory term, address token, address feed, address usdg)
        internal
        pure
        returns (AssetRegistry.Asset memory a)
    {
        a.feed = feed;
        a.tradeStaleness = TRADE_STALENESS;
        a.valuationStaleness = term.valuationStaleness;
        a.bandBps = term.bandBps;
        a.haircutBps = term.haircutBps;
        a.eligible = true;
        a.isStock = !term.isTreasury;
        a.isTreasury = term.isTreasury;
        a.perTradeCap = term.perTradeCap;
        a.perMandateCap = term.perMandateCap;
        a.totalCap = term.totalCap;
        a.pool = pool(token, usdg, term.fee, term.tickSpacing);
    }

    /// The key v4 files the pool under: the lower address is `currency0`.
    function pool(address token, address usdg, uint24 fee, int24 tickSpacing) internal pure returns (PoolKey memory) {
        (address c0, address c1) = token < usdg ? (token, usdg) : (usdg, token);
        return PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)});
    }
}
