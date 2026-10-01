// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "../../token/Buyback.sol";
import {AssetRegistry} from "../AssetRegistry.sol";
import {PriceGuard} from "../PriceGuard.sol";
import {V4Swapper} from "../V4Swapper.sol";
import {IParkAsset} from "../interfaces/IParkAsset.sol";

/// Parks USDG in one registered Robinhood token (SGOV at launch) through its pinned pool.
///
/// Value is raw × feed, with no multiplier and no projected return: the parked figure is what the
/// token is priced at now, and nothing else. Every trade passes the price guard at the asset's
/// trade bound, fills within the asset's band of the feed, and leaves the pool inside that band:
/// a trade that only had to find the pool there could follow a push to the band's edge earlier
/// in the same transaction and fill past it.
contract RobinhoodStockAdapter is IParkAsset, V4Swapper {
    uint256 internal constant BPS = 10_000;

    address public immutable park;
    address public immutable override asset;
    AssetRegistry public immutable registry;
    PriceGuard public immutable guard;
    address public immutable usdg;

    error NotPark();
    error ZeroAddress();
    error NotTreasuryAsset(address asset);

    modifier onlyPark() {
        if (msg.sender != park) revert NotPark();
        _;
    }

    constructor(address park_, address asset_, AssetRegistry registry_, PriceGuard guard_, IPoolManager poolManager_)
        V4Swapper(poolManager_)
    {
        // Immutable, and with no park nothing can call the adapter.
        if (park_ == address(0)) revert ZeroAddress();
        park = park_;
        // The registry lists no zero address, so the lookup below refuses one.
        // slither-disable-next-line missing-zero-check
        asset = asset_;
        registry = registry_;
        guard = guard_;
        usdg = registry_.settlementAsset();
        if (!registry_.get(asset_).isTreasury) revert NotTreasuryAsset(asset_);
    }

    function value(uint256 raw)
        external
        view
        override
        returns (uint256 usdgValue, uint256 priceE8, uint256 updatedAt, bool fresh)
    {
        (priceE8, updatedAt, fresh) = guard.valuationPrice(asset);
        if (fresh) usdgValue = Math.mulDiv(raw, priceE8, _scale());
    }

    function haircutBps() external view override returns (uint16) {
        return registry.get(asset).haircutBps;
    }

    function caps() external view override returns (uint128, uint128) {
        AssetRegistry.Asset memory a = registry.get(asset);
        return (a.perMandateCap, a.totalCap);
    }

    function acquire(uint256 usdgIn, uint256 minOut, address beneficiary)
        external
        override
        onlyPark
        returns (uint256 rawOut)
    {
        AssetRegistry.Asset memory a = registry.get(asset);
        uint256 price = guard.tradePrice(asset, beneficiary);
        uint256 floor = Math.mulDiv(Math.mulDiv(usdgIn, _scale(), price), BPS - a.bandBps, BPS);
        if (minOut > floor) floor = minOut;
        (, rawOut) = _swap(
            SwapOrder({
                key: a.pool,
                zeroForOne: a.pool.currency0 == usdg,
                exactIn: true,
                amount: usdgIn,
                limit: floor,
                to: address(this)
            })
        );
        // The second look is for its revert: the trade has to leave the pool inside the band too.
        // slither-disable-next-line unused-return
        guard.tradePrice(asset, beneficiary);
    }

    function release(uint256 raw, uint256 minUsdg, address to, address beneficiary)
        external
        override
        onlyPark
        returns (uint256 usdgOut)
    {
        AssetRegistry.Asset memory a = registry.get(asset);
        uint256 price = guard.exitPrice(asset, beneficiary);
        uint256 floor = Math.mulDiv(Math.mulDiv(raw, price, _scale()), BPS - a.bandBps, BPS);
        if (minUsdg > floor) floor = minUsdg;
        (, usdgOut) = _swap(
            SwapOrder({
                key: a.pool, zeroForOne: a.pool.currency0 == asset, exactIn: true, amount: raw, limit: floor, to: to
            })
        );
        // The second look is for its revert: the trade has to leave the pool inside the band too.
        // slither-disable-next-line unused-return
        guard.exitPrice(asset, beneficiary);
    }

    function releaseExact(uint256 usdgOut, uint256 maxRaw, address to, address beneficiary)
        external
        override
        onlyPark
        returns (uint256 rawIn)
    {
        AssetRegistry.Asset memory a = registry.get(asset);
        uint256 price = guard.exitPrice(asset, beneficiary);
        uint256 ceiling = Math.mulDiv(Math.mulDiv(usdgOut, _scale(), price, Math.Rounding.Ceil), BPS + a.bandBps, BPS);
        if (maxRaw < ceiling) ceiling = maxRaw;
        (rawIn,) = _swap(
            SwapOrder({
                key: a.pool,
                zeroForOne: a.pool.currency0 == asset,
                exactIn: false,
                amount: usdgOut,
                limit: ceiling,
                to: to
            })
        );
        // The second look is for its revert: the trade has to leave the pool inside the band too.
        // slither-disable-next-line unused-return
        guard.exitPrice(asset, beneficiary);
    }

    function _scale() private view returns (uint256) {
        return 10 ** (uint256(registry.get(asset).decimals) + 2);
    }
}
