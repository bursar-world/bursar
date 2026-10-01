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
///
/// A draw against a holding asks more than a trade or a valuation, because the pool's spot is one
/// swap away from wherever a borrower wants it inside a transaction. The pool has to have agreed
/// with the feed at an aged observation as well: a reading `observe` took at least
/// `MIN_OBSERVATION_AGE` earlier, which nobody can replace in the same block, so a manipulated
/// price has to be held open to arbitrage for that long before it counts. Two breakers sit on the
/// feed itself for draws. An answer more than `MAX_FEED_JUMP_BPS` away from the aged sample's is
/// a gap or a mis-scaled round, and the caller's own age bound halts a feed that has gone quiet
/// in session. Neither reads the feed's round history, so neither depends on the feed keeping
/// one.
contract PriceGuard {
    /// A reading of the pool's mid against the feed's answer, taken by `observe`.
    struct Sample {
        uint48 at;
        uint104 poolE8;
        uint104 feedE8;
    }

    /// The first condition a draw against a holding fails, `None` when it fails none. Current
    /// state is checked before history, and the pool's spot last, so a caller that sees the spot
    /// disagree knows the aged observation stood.
    enum DrawHalt {
        None,
        NoPrice,
        Paused,
        FeedStale,
        NoObservation,
        ObservationExpired,
        ObservationOffBand,
        FeedJump,
        SpotOffBand
    }

    AssetRegistry public immutable registry;
    IAccessRegistry public immutable accessRegistry;
    IStateView public immutable stateView;

    /// How old a sample has to be before it counts, and before the next one may replace it.
    uint256 public immutable MIN_OBSERVATION_AGE;
    /// Past this age an aged sample no longer vouches for the pool.
    uint256 public immutable MAX_OBSERVATION_AGE;
    /// Widest move of the feed since the aged sample that a draw still counts.
    uint256 public immutable MAX_FEED_JUMP_BPS;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q96 = 1 << 96;
    /// An aged sample that could be a day old says nothing about the pool now.
    uint256 internal constant MAX_OBSERVATION_AGE_BOUND = 1 days;

    /// The sample a draw reads, and the newer one waiting to replace it.
    mapping(address asset => Sample) public aged;
    mapping(address asset => Sample) public pending;

    event Observed(address indexed asset, uint256 poolE8, uint256 feedE8, bool promoted);

    error NotEligible(address asset);
    error StalePrice(address asset, uint256 age, uint256 bound);
    error BadPrice(address asset);
    error OraclePaused(address asset);
    error TokenPaused(address asset);
    error AccessPaused();
    error Blocked(address account);
    error PoolPriceDeviation(address asset, uint256 poolPriceE8, uint256 feedPriceE8);
    error PriceOutsideBand(address asset, uint256 quotedPriceE8, uint256 feedPriceE8);
    error BadObservationBounds();
    error ObservationTooSoon(address asset, uint256 age, uint256 bound);

    constructor(
        AssetRegistry registry_,
        IAccessRegistry accessRegistry_,
        IStateView stateView_,
        uint256 minObservationAge,
        uint256 maxObservationAge,
        uint256 maxFeedJumpBps
    ) {
        // A keeper observing every `minObservationAge` leaves the aged sample up to twice that
        // old between promotions, so a tighter maximum would halt draws on schedule.
        if (
            minObservationAge == 0 || maxObservationAge < 2 * minObservationAge
                || maxObservationAge > MAX_OBSERVATION_AGE_BOUND || maxFeedJumpBps == 0 || maxFeedJumpBps >= BPS
        ) revert BadObservationBounds();
        registry = registry_;
        accessRegistry = accessRegistry_;
        stateView = stateView_;
        MIN_OBSERVATION_AGE = minObservationAge;
        MAX_OBSERVATION_AGE = maxObservationAge;
        MAX_FEED_JUMP_BPS = maxFeedJumpBps;
    }

    /// Records the pool's mid and the feed's answer for `asset`. Anyone may call it. The reading
    /// lands as `pending`; once it is `MIN_OBSERVATION_AGE` old the next call promotes it to
    /// `aged` and takes its place. A younger pending sample stays, so the aged slot can never
    /// hold a reading taken in the block that uses it.
    function observe(address asset) external {
        AssetRegistry.Asset memory a = registry.get(asset);
        Sample storage p = pending[asset];
        bool promoted = p.at != 0;
        if (promoted) {
            uint256 age = block.timestamp - p.at;
            if (age < MIN_OBSERVATION_AGE) revert ObservationTooSoon(asset, age, MIN_OBSERVATION_AGE);
            aged[asset] = p;
        }
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        uint256 feedE8 = answer > 0 && updatedAt <= block.timestamp ? uint256(answer) : 0;
        uint256 poolE8 = _poolPrice(asset, a);
        // forge-lint: disable-next-line(unsafe-typecast)
        pending[asset] = Sample({at: uint48(block.timestamp), poolE8: _clip(poolE8), feedE8: _clip(feedE8)});
        emit Observed(asset, poolE8, feedE8, promoted);
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
    /// written, whether the token, its oracle and the access registry are all unpaused, and
    /// whether the pinned pool's mid sits inside the asset's band of the answer. A holding that
    /// cannot move cannot be sold to cover what was drawn against it.
    function valuation(address asset)
        external
        view
        returns (uint256 priceE8, uint256 updatedAt, bool unpaused, bool inBand)
    {
        return _valuation(asset, registry.get(asset));
    }

    /// `valuation` with the draw rule on top. `maxFeedAge` is the oldest answer the caller lets
    /// a draw count: the collateral tier's session bound inside the US equities session, its
    /// valuation bound outside it. Never reverts for a registered asset.
    function drawValuation(address asset, uint256 maxFeedAge)
        external
        view
        returns (uint256 priceE8, uint256 updatedAt, bool unpaused, bool inBand, DrawHalt halt)
    {
        AssetRegistry.Asset memory a = registry.get(asset);
        (priceE8, updatedAt, unpaused, inBand) = _valuation(asset, a);
        halt = _drawHalt(asset, a.bandBps, priceE8, updatedAt, unpaused, inBand, maxFeedAge);
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
        unpaused =
            !IRobinhoodStock(asset).oraclePaused() && !IRobinhoodStock(asset).tokenPaused() && !accessRegistry.paused();
        inBand = _agrees(_poolPrice(asset, a), priceE8, a.bandBps);
    }

    /// The aged sample is promoted only once it is `MIN_OBSERVATION_AGE` old, so its lower age
    /// bound holds without a check here. A sample taken while the feed had no answer agrees with
    /// nothing.
    function _drawHalt(
        address asset,
        uint16 bandBps,
        uint256 priceE8,
        uint256 updatedAt,
        bool unpaused,
        bool inBand,
        uint256 maxFeedAge
    ) private view returns (DrawHalt) {
        if (priceE8 == 0) return DrawHalt.NoPrice;
        if (!unpaused) return DrawHalt.Paused;
        if (block.timestamp - updatedAt > maxFeedAge) return DrawHalt.FeedStale;
        Sample memory s = aged[asset];
        if (s.at == 0) return DrawHalt.NoObservation;
        if (block.timestamp - s.at > MAX_OBSERVATION_AGE) return DrawHalt.ObservationExpired;
        if (s.feedE8 == 0 || !_agrees(s.poolE8, s.feedE8, bandBps)) return DrawHalt.ObservationOffBand;
        if (_deviationBps(priceE8, s.feedE8) > MAX_FEED_JUMP_BPS) return DrawHalt.FeedJump;
        if (!inBand) return DrawHalt.SpotOffBand;
        return DrawHalt.None;
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

    /// A mid past the field is a pool at the edge of its range, which no feed will agree with.
    function _clip(uint256 priceE8) private pure returns (uint104) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return priceE8 > type(uint104).max ? type(uint104).max : uint104(priceE8);
    }
}
