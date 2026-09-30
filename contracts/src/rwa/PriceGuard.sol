// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AssetRegistry} from "./AssetRegistry.sol";
import {IAccessRegistry, IAggregatorV3, IRobinhoodStock, IStateView} from "./interfaces/IRwaExternal.sol";

/// Decides whether a registered asset can be traded or valued right now, and at what price.
///
/// A trade needs all of: a registered and eligible asset, a feed answer younger than the
/// asset's trade bound, the token's oracle and transfers unpaused, Robinhood's access registry
/// unpaused and not blocking the account, and the pinned pool's mid within the asset's band of
/// the feed. The last check is what catches a mis-scaled answer: on 2026-06-23 the AAPL, SPY and
/// NVDA feeds each published a round 1e8 too large, fresh by every timestamp test.
///
/// Valuation is softer on age on purpose. SGOV prices once a day and skips Sunday, so parked
/// value keeps counting up to the asset's valuation bound (100 hours covers a long weekend) and
/// reads zero after it. It is not softer on the pool: a value counted off a mis-scaled or lagging
/// answer is spent before anyone notices, so a holding whose pool disagrees with its feed is not
/// fresh either. Valuation never reverts; it reports `fresh`.
contract PriceGuard {
    AssetRegistry public immutable registry;
    IAccessRegistry public immutable accessRegistry;
    IStateView public immutable stateView;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q96 = 1 << 96;

    error NotEligible(address asset);
    error StalePrice(address asset, uint256 age, uint256 bound);
    error BadPrice(address asset);
    error OraclePaused(address asset);
    error TokenPaused(address asset);
    error AccessPaused();
    error Blocked(address account);
    error PoolPriceDeviation(address asset, uint256 poolPriceE8, uint256 feedPriceE8);
    error PriceOutsideBand(address asset, uint256 quotedPriceE8, uint256 feedPriceE8);

    constructor(AssetRegistry registry_, IAccessRegistry accessRegistry_, IStateView stateView_) {
        registry = registry_;
        accessRegistry = accessRegistry_;
        stateView = stateView_;
    }

    /// The feed price a trade in `asset` may use for `account`, or a named revert.
    function tradePrice(address asset, address account) public view returns (uint256 priceE8) {
        AssetRegistry.Asset memory a = registry.get(asset);
        if (!a.eligible) revert NotEligible(asset);
        return _tradePrice(asset, a, account);
    }

    /// Like `tradePrice`, for selling a position out. A delisted asset can still be sold.
    function exitPrice(address asset, address account) public view returns (uint256 priceE8) {
        return _tradePrice(asset, registry.get(asset), account);
    }

    /// Also checks a caller's quote against the feed.
    function checkQuote(address asset, address account, uint256 quotedPriceE8) external view returns (uint256 priceE8) {
        priceE8 = tradePrice(asset, account);
        AssetRegistry.Asset memory a = registry.get(asset);
        if (_deviationBps(quotedPriceE8, priceE8) > a.bandBps) revert PriceOutsideBand(asset, quotedPriceE8, priceE8);
    }

    /// Price for counting a holding. Never reverts for a registered asset.
    function valuationPrice(address asset) public view returns (uint256 priceE8, uint256 updatedAt, bool fresh) {
        AssetRegistry.Asset memory a = registry.get(asset);
        bool unpaused;
        bool inBand;
        (priceE8, updatedAt, unpaused, inBand) = _valuation(asset, a);
        fresh = priceE8 != 0 && block.timestamp - updatedAt <= a.valuationStaleness && unpaused && inBand;
    }

    /// What `valuationPrice` rests on, for a caller that holds the answer to its own age bound:
    /// the feed answer (zero when it is not positive or is dated after the block), when it was
    /// written, whether the token's oracle is unpaused, and whether the pinned pool's mid sits
    /// inside the asset's band of the answer.
    function valuation(address asset)
        external
        view
        returns (uint256 priceE8, uint256 updatedAt, bool unpaused, bool inBand)
    {
        return _valuation(asset, registry.get(asset));
    }

    /// USDG value of `raw` at the valuation price, zero when the price is not fresh.
    function valueOf(address asset, uint256 raw) external view returns (uint256 usdg, bool fresh) {
        (uint256 priceE8,, bool ok) = valuationPrice(asset);
        if (!ok) return (0, false);
        AssetRegistry.Asset memory a = registry.get(asset);
        return (Math.mulDiv(raw, priceE8, 10 ** (uint256(a.decimals) + 2)), true);
    }

    /// Mid of the asset's pinned pool, as USD per whole token with eight decimals.
    function poolPriceE8(address asset) public view returns (uint256) {
        return _poolPrice(asset, registry.get(asset));
    }

    /// `sqrtPriceX96` is token1 per token0 in raw units. USDG has six decimals.
    function midE8(uint160 sqrtPriceX96, bool assetIsCurrency0, uint8 decimals) public pure returns (uint256) {
        uint256 s = sqrtPriceX96;
        if (s == 0) return 0;
        uint256 scale = 10 ** (uint256(decimals) + 2);
        if (assetIsCurrency0) return Math.mulDiv(Math.mulDiv(s, s, Q96), scale, Q96);
        return Math.mulDiv(Math.mulDiv(Q96, Q96, s), scale, s);
    }

    function _tradePrice(address asset, AssetRegistry.Asset memory a, address account)
        private
        view
        returns (uint256 priceE8)
    {
        if (IRobinhoodStock(asset).oraclePaused()) revert OraclePaused(asset);
        if (IRobinhoodStock(asset).tokenPaused()) revert TokenPaused(asset);
        if (accessRegistry.paused()) revert AccessPaused();
        if (accessRegistry.isBlocked(account)) revert Blocked(account);

        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        if (answer <= 0 || updatedAt > block.timestamp) revert BadPrice(asset);
        uint256 age = block.timestamp - updatedAt;
        if (age > a.tradeStaleness) revert StalePrice(asset, age, a.tradeStaleness);
        priceE8 = uint256(answer);

        uint256 pool = _poolPrice(asset, a);
        if (!_agrees(pool, priceE8, a.bandBps)) revert PoolPriceDeviation(asset, pool, priceE8);
    }

    function _valuation(address asset, AssetRegistry.Asset memory a)
        private
        view
        returns (uint256 priceE8, uint256 updatedAt, bool unpaused, bool inBand)
    {
        int256 answer;
        (, answer,, updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        if (answer <= 0 || updatedAt > block.timestamp) return (0, updatedAt, false, false);
        priceE8 = uint256(answer);
        unpaused = !IRobinhoodStock(asset).oraclePaused();
        inBand = _agrees(_poolPrice(asset, a), priceE8, a.bandBps);
    }

    function _poolPrice(address asset, AssetRegistry.Asset memory a) private view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = stateView.getSlot0(keccak256(abi.encode(a.pool)));
        return midE8(sqrtPriceX96, a.pool.currency0 == asset, a.decimals);
    }

    /// A pool with no price never agrees; that is how a pool nobody seeded reads.
    function _agrees(uint256 poolE8, uint256 feedE8, uint16 bandBps) private pure returns (bool) {
        return poolE8 != 0 && _deviationBps(poolE8, feedE8) <= bandBps;
    }

    function _deviationBps(uint256 x, uint256 ref) private pure returns (uint256) {
        uint256 diff = x > ref ? x - ref : ref - x;
        return Math.mulDiv(diff, BPS, ref, Math.Rounding.Ceil);
    }
}
