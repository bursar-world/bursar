// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "../../src/token/Buyback.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";

/// Launch parameters for the RWA lane on Robinhood Chain 4663, from the 2026-09-28 measurements.
/// Feeds are the Chainlink proxies; pools are the hookless v4 pool pinned per asset.
library RwaConfig {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant ACCESS_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;

    address internal constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;

    address internal constant SGOV_FEED = 0xa0DF4ee0fFf975306345875E3548Fcc519577A11;
    address internal constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

    bytes32 internal constant SGOV_POOL_ID = 0x2a72510d7d92cc121f9733ab6d14227ef8963cfadf9d40ac574f02e20e6299a8;
    bytes32 internal constant SPY_POOL_ID = 0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907;
    bytes32 internal constant NVDA_POOL_ID = 0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5;
    bytes32 internal constant AAPL_POOL_ID = 0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb;

    /// Trade bound: the 24 h heartbeat plus two hours. Valuation bound for SGOV: a three-day
    /// weekend. Stocks are never parked, so their valuation bound equals the trade bound.
    uint32 internal constant TRADE_STALENESS = 93_600;
    uint32 internal constant SGOV_VALUATION_STALENESS = 360_000;

    uint128 internal constant STOCK_TRADE_CAP = 25e6;
    uint128 internal constant SGOV_PER_MANDATE = 100e6;
    uint128 internal constant SGOV_TOTAL = 1_000e6;

    function assets() internal pure returns (address[] memory list, AssetRegistry.Asset[] memory configs) {
        list = new address[](4);
        configs = new AssetRegistry.Asset[](4);

        list[0] = SGOV;
        configs[0] = _asset(SGOV_FEED, SGOV_VALUATION_STALENESS, 50, 50, false, true, 0, SGOV_PER_MANDATE, SGOV_TOTAL);
        configs[0].pool = PoolKey(USDG, SGOV, 375, 4, address(0));

        list[1] = SPY;
        configs[1] = _asset(SPY_FEED, TRADE_STALENESS, 100, 0, true, false, STOCK_TRADE_CAP, 0, 0);
        configs[1].pool = PoolKey(SPY, USDG, 500, 5, address(0));

        list[2] = NVDA;
        configs[2] = _asset(NVDA_FEED, TRADE_STALENESS, 100, 0, true, false, STOCK_TRADE_CAP, 0, 0);
        configs[2].pool = PoolKey(USDG, NVDA, 100, 1, address(0));

        list[3] = AAPL;
        configs[3] = _asset(AAPL_FEED, TRADE_STALENESS, 100, 0, true, false, STOCK_TRADE_CAP, 0, 0);
        configs[3].pool = PoolKey(USDG, AAPL, 3000, 60, address(0));
    }

    function _asset(
        address feed,
        uint32 valuation,
        uint16 band,
        uint16 haircut,
        bool isStock,
        bool isTreasury,
        uint128 perTrade,
        uint128 perMandate,
        uint128 total
    ) private pure returns (AssetRegistry.Asset memory a) {
        a.feed = feed;
        a.tradeStaleness = TRADE_STALENESS;
        a.valuationStaleness = valuation;
        a.bandBps = band;
        a.haircutBps = haircut;
        a.eligible = true;
        a.isStock = isStock;
        a.isTreasury = isTreasury;
        a.perTradeCap = perTrade;
        a.perMandateCap = perMandate;
        a.totalCap = total;
    }
}
