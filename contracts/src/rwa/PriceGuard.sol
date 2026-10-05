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
/// Nor does it revert for an outside contract that does. The feeds, the tokens' pause flags, the
/// access registry and the pool's StateView are all read with the failure in hand: one that
/// reverts, holds no code or answers short reads as no price, a raised flag, or a pool with no
/// price. The collateral vault values every asset a line could hold on every withdrawal and
/// liquidation, so a feed swapped for a reverting proxy would otherwise freeze every line until
/// governance repointed it. A trade is different: it names the read it could not make and stops,
/// because a sale must not run on a price nobody could check.
///
/// A draw against a holding asks more than a trade or a valuation, because the pool's spot is one
/// swap away from wherever a borrower wants it inside a transaction. The pool has to have agreed
/// with the feed at the keeper's last two readings: the aged one, at least `MIN_OBSERVATION_AGE`
/// old, and the pending one waiting to replace it, whatever its age, each inside the asset's band
/// of its own feed sample. A push held open across one keeper transaction does not count; the
/// price has to have stood at two of them. The pending reading is judged from the block after the
/// one that took it, not only once it is old enough to promote: judged that late, a keeper that
/// promotes and replaces it at exactly that age would leave one reading in force at a time. Two
/// breakers sit on the feed itself for draws. An answer more than `MAX_FEED_JUMP_BPS` away from
/// the aged sample's is a gap or a mis-scaled round, and the caller's own age bound halts a feed
/// that has gone quiet in session. Neither reads the feed's round history, so neither depends on
/// the feed keeping one.
///
/// Only a keeper may `observe`, and it is trusted for timing alone. A keeper that recorded a
/// pushed pool would be caught the same block it mattered: the spot-versus-feed and feed-jump
/// checks run on every draw against the live pool, not the sample. A keeper that stops leaves the
/// aged sample to expire past `MAX_OBSERVATION_AGE`, which halts draws, the same outcome as a
/// keeper that never ran. What a keeper cannot do is age a reading faster or plant one a draw
/// reads in the same block: a sample is promoted to `aged` only once it has sat as `pending` for
/// `MIN_OBSERVATION_AGE`, overwriting a younger pending resets that clock, and a pending reading
/// is judged only from the next block on. Governance names keepers through its timelock; the
/// guardian it names here can take one off at once and add none, so a key that has gone rogue or
/// quiet is off the guard in the same block instead of after the timelock's delay. Removal halts
/// draws and sales once the aged reading expires, the safe outcome.
contract PriceGuard {
    /// A reading of the pool's mid against the feed's answer, taken by `observe`.
    struct Sample {
        uint48 at;
        uint104 poolE8;
        uint104 feedE8;
    }

    /// The first condition a draw against a holding fails, `None` when it fails none. An asset
    /// whose feed, token, access registry or pool could not be read is `Unreadable` before
    /// anything else. Then current state is checked before history, and the pool's spot last, so
    /// a caller that sees the spot disagree knows the aged observation stood. `Unreadable` and
    /// `PendingOffBand` are checked out of their declared order, first and between the two
    /// observation checks: the enum keeps its earlier members at their numbers so a reader of a
    /// stored value does not shift.
    enum DrawHalt {
        None,
        NoPrice,
        Paused,
        FeedStale,
        NoObservation,
        ObservationExpired,
        ObservationOffBand,
        FeedJump,
        SpotOffBand,
        Unreadable,
        PendingOffBand
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

    /// Governance, the keeper service it trusts to take readings on schedule, and the brake that
    /// can take a keeper off without a proposal.
    address public admin;
    address public pendingAdmin;
    address public guardian;
    mapping(address keeper => bool) public isKeeper;

    /// Names the first keeper once, so the lane can draw before the timelock's first proposal.
    address public immutable deployer;
    bool private _keeperInitialised;

    event Observed(address indexed asset, uint256 poolE8, uint256 feedE8, bool promoted);
    event KeeperSet(address indexed keeper, bool enabled);
    event GuardianSet(address indexed guardian);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

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
    error NotAdmin();
    error NotPendingAdmin();
    error NotDeployer();
    error NotKeeper();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        AssetRegistry registry_,
        IAccessRegistry accessRegistry_,
        IStateView stateView_,
        uint256 minObservationAge,
        uint256 maxObservationAge,
        uint256 maxFeedJumpBps,
        address admin_,
        address guardian_
    ) {
        // A keeper observing every `minObservationAge` leaves the aged sample up to twice that
        // old between promotions, so a tighter maximum would halt draws on schedule.
        if (
            minObservationAge == 0 || maxObservationAge < 2 * minObservationAge
                || maxObservationAge > MAX_OBSERVATION_AGE_BOUND || maxFeedJumpBps == 0 || maxFeedJumpBps >= BPS
        ) revert BadObservationBounds();
        if (admin_ == address(0)) revert NotAdmin();
        registry = registry_;
        accessRegistry = accessRegistry_;
        stateView = stateView_;
        MIN_OBSERVATION_AGE = minObservationAge;
        MAX_OBSERVATION_AGE = maxObservationAge;
        MAX_FEED_JUMP_BPS = maxFeedJumpBps;
        admin = admin_;
        // Zero names no guardian, which leaves removing a keeper to governance alone.
        // slither-disable-next-line missing-zero-check
        guardian = guardian_;
        deployer = msg.sender;
        emit AdminTransferred(address(0), admin_);
        emit GuardianSet(guardian_);
    }

    /// Records the pool's mid and the feed's answer for `asset`. Only a keeper may call it. The
    /// reading lands as `pending`, where draws judge it from the next block on; once it is
    /// `MIN_OBSERVATION_AGE` old the next call promotes it to `aged` and takes its place. A pending
    /// sample younger than that is overwritten in place and not promoted, so the aged slot never
    /// holds a reading from the block that uses it and a keeper cannot age one faster. A feed or
    /// pool that cannot be read is recorded as no price, which agrees with nothing.
    function observe(address asset) external {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        AssetRegistry.Asset memory a = registry.get(asset);
        Sample storage p = pending[asset];
        bool promoted = p.at != 0 && block.timestamp - p.at >= MIN_OBSERVATION_AGE;
        if (promoted) aged[asset] = p;
        (uint256 feedE8,,) = _answer(a.feed);
        (uint256 poolE8,) = _poolPrice(asset, a);
        // forge-lint: disable-next-line(unsafe-typecast)
        pending[asset] = Sample({at: uint48(block.timestamp), poolE8: _clip(poolE8), feedE8: _clip(feedE8)});
        emit Observed(asset, poolE8, feedE8, promoted);
    }

    /// Governance adds or removes a keeper; the guardian removes one and adds none. Zero stays
    /// off. A keeper removed can no longer take readings, which halts draws and sales once the
    /// aged sample expires, as a stopped keeper does; the guardian's path exists so that a key
    /// that has gone rogue or quiet is off the guard in one transaction, not after the delay a
    /// proposal waits.
    function setKeeper(address keeper, bool enabled) external {
        if (msg.sender != admin && (msg.sender != guardian || enabled)) revert NotAdmin();
        isKeeper[keeper] = enabled;
        emit KeeperSet(keeper, enabled);
    }

    /// Governance names the brake. Zero leaves removal to governance alone.
    function setGuardian(address guardian_) external onlyAdmin {
        // slither-disable-next-line missing-zero-check
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// The deployer names the first keeper once, the way it binds the vault and lists the park's
    /// adapters: the keeper service's key is known at deployment, and the admin is the timelock,
    /// so without this the lane could not draw until governance's first proposal landed.
    function initKeeper(address keeper) external {
        if (msg.sender != deployer || _keeperInitialised) revert NotDeployer();
        _keeperInitialised = true;
        isKeeper[keeper] = true;
        emit KeeperSet(keeper, true);
    }

    /// Two steps: nobody can accept as the zero address, and naming it withdraws an offer.
    function transferAdmin(address to) external onlyAdmin {
        // slither-disable-next-line missing-zero-check
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
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
        (priceE8, updatedAt, unpaused, inBand,) = _valuation(asset, a);
        fresh = priceE8 != 0 && block.timestamp - updatedAt <= a.valuationStaleness && unpaused && inBand;
    }

    /// What `valuationPrice` rests on, for a caller that holds the answer to its own age bound:
    /// the feed answer (zero when it is not positive, is dated after the block, or could not be
    /// read), when it was written, whether the token, its oracle and the access registry are all
    /// unpaused, and whether the pinned pool's mid sits inside the asset's band of the answer. A
    /// holding that cannot move cannot be sold to cover what was drawn against it.
    function valuation(address asset)
        external
        view
        returns (uint256 priceE8, uint256 updatedAt, bool unpaused, bool inBand)
    {
        (priceE8, updatedAt, unpaused, inBand,) = _valuation(asset, registry.get(asset));
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
        bool readable;
        (priceE8, updatedAt, unpaused, inBand, readable) = _valuation(asset, a);
        halt = _drawHalt(asset, a.bandBps, priceE8, updatedAt, unpaused, inBand, readable, maxFeedAge);
    }

    /// USDG value of `raw` at the valuation price, zero when the price is not fresh.
    function valueOf(address asset, uint256 raw) external view returns (uint256 usdg, bool fresh) {
        (uint256 priceE8,, bool ok) = valuationPrice(asset);
        if (!ok) return (0, false);
        AssetRegistry.Asset memory a = registry.get(asset);
        return (Math.mulDiv(raw, priceE8, 10 ** (uint256(a.decimals) + 2)), true);
    }

    /// Mid of the asset's pinned pool, as USD per whole token with eight decimals. Zero for a
    /// pool nobody seeded, and for a StateView that could not be read.
    function poolPriceE8(address asset) public view returns (uint256 priceE8) {
        (priceE8,) = _poolPrice(asset, registry.get(asset));
    }

    /// `sqrtPriceX96` is token1 per token0 in raw units. USDG has six decimals.
    function midE8(uint160 sqrtPriceX96, bool assetIsCurrency0, uint8 decimals) public pure returns (uint256) {
        uint256 s = sqrtPriceX96;
        if (s == 0) return 0;
        uint256 scale = 10 ** (uint256(decimals) + 2);
        if (assetIsCurrency0) return Math.mulDiv(Math.mulDiv(s, s, Q96), scale, Q96);
        return Math.mulDiv(Math.mulDiv(Q96, Q96, s), scale, s);
    }

    /// A read that failed is named as the condition it would have refused on: an unreadable
    /// flag as the pause it may hide, an unreadable feed as no price, an unreadable pool as a
    /// pool with none.
    function _tradePrice(address asset, AssetRegistry.Asset memory a, address account)
        private
        view
        returns (uint256 priceE8)
    {
        (bool oraclePaused, bool tokenPaused, bool accessPaused,) = _flags(asset);
        if (oraclePaused) revert OraclePaused(asset);
        if (tokenPaused) revert TokenPaused(asset);
        if (accessPaused) revert AccessPaused();
        (bool blocked,) = _flag(address(accessRegistry), abi.encodeCall(IAccessRegistry.isBlocked, (account)));
        if (blocked) revert Blocked(account);

        uint256 updatedAt;
        (priceE8, updatedAt,) = _answer(a.feed);
        if (priceE8 == 0) revert BadPrice(asset);
        uint256 age = block.timestamp - updatedAt;
        if (age > a.tradeStaleness) revert StalePrice(asset, age, a.tradeStaleness);

        (uint256 pool,) = _poolPrice(asset, a);
        if (!_agrees(pool, priceE8, a.bandBps)) revert PoolPriceDeviation(asset, pool, priceE8);
    }

    /// `readable` is false when any of the reads behind the answer failed; the answer itself is
    /// then the conservative one, which the collateral vault counts as nothing.
    function _valuation(address asset, AssetRegistry.Asset memory a)
        private
        view
        returns (uint256 priceE8, uint256 updatedAt, bool unpaused, bool inBand, bool readable)
    {
        (priceE8, updatedAt, readable) = _answer(a.feed);
        if (priceE8 == 0) return (0, updatedAt, false, false, readable);
        (bool oraclePaused, bool tokenPaused, bool accessPaused, bool flagsReadable) = _flags(asset);
        unpaused = !oraclePaused && !tokenPaused && !accessPaused;
        (uint256 pool, bool poolReadable) = _poolPrice(asset, a);
        inBand = _agrees(pool, priceE8, a.bandBps);
        readable = flagsReadable && poolReadable;
    }

    /// The aged sample is promoted only once it is `MIN_OBSERVATION_AGE` old, so its lower age
    /// bound holds without a check here. A sample taken while the feed had no answer agrees with
    /// nothing. The pending sample is judged too, at any age, once it was taken in an earlier
    /// block: a draw needs the pool to have agreed with the feed at both of the keeper's last two
    /// readings, not at one a push was held open for. Only keepers write it, so judging it young
    /// hands nobody else a lever. A reading from this block is left alone, as the aged slot is.
    function _drawHalt(
        address asset,
        uint16 bandBps,
        uint256 priceE8,
        uint256 updatedAt,
        bool unpaused,
        bool inBand,
        bool readable,
        uint256 maxFeedAge
    ) private view returns (DrawHalt) {
        if (!readable) return DrawHalt.Unreadable;
        if (priceE8 == 0) return DrawHalt.NoPrice;
        if (!unpaused) return DrawHalt.Paused;
        if (block.timestamp - updatedAt > maxFeedAge) return DrawHalt.FeedStale;
        Sample memory s = aged[asset];
        if (s.at == 0) return DrawHalt.NoObservation;
        if (block.timestamp - s.at > MAX_OBSERVATION_AGE) return DrawHalt.ObservationExpired;
        if (s.feedE8 == 0 || !_agrees(s.poolE8, s.feedE8, bandBps)) return DrawHalt.ObservationOffBand;
        Sample memory q = pending[asset];
        if (q.at != 0 && q.at < block.timestamp) {
            if (q.feedE8 == 0 || !_agrees(q.poolE8, q.feedE8, bandBps)) return DrawHalt.PendingOffBand;
        }
        if (_deviationBps(priceE8, s.feedE8) > MAX_FEED_JUMP_BPS) return DrawHalt.FeedJump;
        if (!inBand) return DrawHalt.SpotOffBand;
        return DrawHalt.None;
    }

    /// The feed's answer and the time it was written: zero when the feed could not be read,
    /// answered nothing positive, or dated the round after the block. The words are taken as
    /// they come rather than through the narrow types, so an answer the feed mangled is still an
    /// answer this contract can refuse on its own terms.
    function _answer(address feed) private view returns (uint256 priceE8, uint256 updatedAt, bool readable) {
        (bool ok, bytes memory data) = feed.staticcall(abi.encodeCall(IAggregatorV3.latestRoundData, ()));
        if (!ok || data.length < 160) return (0, 0, false);
        (, int256 answer,, uint256 at,) = abi.decode(data, (uint256, int256, uint256, uint256, uint256));
        if (answer <= 0 || at > block.timestamp) return (0, at, true);
        return (uint256(answer), at, true);
    }

    /// The token's two pause flags and the access registry's. A flag that cannot be read reads
    /// as raised: a token that cannot say whether it is paused is not one to sell or lend on.
    function _flags(address asset)
        private
        view
        returns (bool oraclePaused, bool tokenPaused, bool accessPaused, bool readable)
    {
        bool oracleReadable;
        bool tokenReadable;
        bool accessReadable;
        (oraclePaused, oracleReadable) = _flag(asset, abi.encodeCall(IRobinhoodStock.oraclePaused, ()));
        (tokenPaused, tokenReadable) = _flag(asset, abi.encodeCall(IRobinhoodStock.tokenPaused, ()));
        (accessPaused, accessReadable) = _flag(address(accessRegistry), abi.encodeCall(IAccessRegistry.paused, ()));
        readable = oracleReadable && tokenReadable && accessReadable;
    }

    function _flag(address target, bytes memory call) private view returns (bool raised, bool readable) {
        (bool ok, bytes memory data) = target.staticcall(call);
        if (!ok || data.length < 32) return (true, false);
        return (abi.decode(data, (uint256)) != 0, true);
    }

    /// The pool's mid, zero for a pool nobody seeded or a StateView that could not be read.
    function _poolPrice(address asset, AssetRegistry.Asset memory a)
        private
        view
        returns (uint256 priceE8, bool readable)
    {
        bytes32 id = keccak256(abi.encode(a.pool));
        (bool ok, bytes memory data) = address(stateView).staticcall(abi.encodeCall(IStateView.getSlot0, (id)));
        if (!ok || data.length < 32) return (0, false);
        uint256 sqrtPriceX96 = abi.decode(data, (uint256));
        if (sqrtPriceX96 > type(uint160).max) return (0, false);
        // forge-lint: disable-next-line(unsafe-typecast)
        return (midE8(uint160(sqrtPriceX96), a.pool.currency0 == asset, a.decimals), true);
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
