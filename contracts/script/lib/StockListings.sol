// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {RwaConfig} from "./RwaConfig.sol";

/// The stocks governance lists after launch, on the terms the launch stocks trade under: the
/// 26-hour trade bound, a 100 bps band against the feed and the pinned pool, 25 USDG a purchase,
/// never parked. Addresses are not here: each token, its Chainlink feed and the measured id of
/// its pinned pool come from `external.assets.<SYMBOL>` in the record, as
/// `script/stocks-inventory.mjs` read them on 2026-10-10.
///
/// The pool is the deepest hookless USDG pool the inventory found for the token, named by fee
/// and spacing. The tier is the collateral vault's: index funds take the index tier, single
/// stocks the single-stock tier, and the two commodity funds (SLV, USO) the single-stock tier as
/// well, because a fund on one metal or one commodity moves like one name, not like an index.
library StockListings {
    uint8 internal constant INDEX_FUND = 2;
    uint8 internal constant SINGLE_STOCK = 3;

    struct Listing {
        string symbol;
        uint24 fee;
        int24 tickSpacing;
        uint8 tier;
    }

    function all() internal pure returns (Listing[] memory l) {
        l = new Listing[](13);
        l[0] = Listing("AMZN", 2400, 24, SINGLE_STOCK);
        l[1] = Listing("BABA", 1000, 10, SINGLE_STOCK);
        l[2] = Listing("COIN", 2500, 25, SINGLE_STOCK);
        l[3] = Listing("CRWV", 9000, 90, SINGLE_STOCK);
        l[4] = Listing("DELL", 5000, 25, SINGLE_STOCK);
        l[5] = Listing("GOOGL", 3000, 60, SINGLE_STOCK);
        l[6] = Listing("META", 310, 3, SINGLE_STOCK);
        l[7] = Listing("MSFT", 3000, 60, SINGLE_STOCK);
        l[8] = Listing("ORCL", 10000, 200, SINGLE_STOCK);
        l[9] = Listing("PLTR", 1500, 15, SINGLE_STOCK);
        l[10] = Listing("SPCX", 3000, 60, SINGLE_STOCK);
        l[11] = Listing("TSLA", 3000, 60, SINGLE_STOCK);
        l[12] = Listing("USO", 1200, 15, SINGLE_STOCK);
    }

    function asset(Listing memory listing, address token, address feed, address usdg)
        internal
        pure
        returns (AssetRegistry.Asset memory)
    {
        RwaConfig.Term memory term = RwaConfig.Term(
            listing.symbol,
            false,
            listing.fee,
            listing.tickSpacing,
            RwaConfig.TRADE_STALENESS,
            100,
            0,
            RwaConfig.STOCK_TRADE_CAP,
            0,
            0
        );
        return RwaConfig.asset(term, token, feed, usdg);
    }
}
