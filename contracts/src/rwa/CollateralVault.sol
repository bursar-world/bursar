// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMandateAccount} from "../interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../interfaces/IMandateAccountFactory.sol";
import {IPoolManager} from "../token/Buyback.sol";
import {AssetRegistry} from "./AssetRegistry.sol";
import {CreditPool} from "./CreditPool.sol";
import {PriceGuard} from "./PriceGuard.sol";
import {V4Swapper} from "./V4Swapper.sol";
import {IAggregatorV3} from "./interfaces/IRwaExternal.sol";
import {ITreasuryPark} from "./interfaces/ITreasuryPark.sol";

/// The collateral lane. A mandate in lane 1 posts registered stock or treasury tokens here and
/// spends on credit from `CreditPool` against them. Debt exists in this lane and nowhere else:
/// a mandate in any other lane cannot open a line or draw.
///
/// Value. Each position counts at raw × feed (the feed already prices one raw token), less the
/// haircut of its tier, and only while the feed is inside the tier's valuation bound, the token,
/// its oracle and Robinhood's access registry are unpaused, and the asset's pinned pool trades
/// inside its band of the feed. A position that fails any of these counts zero: collateral no
/// one can sell backs nothing, and the pool is what shows up a mis-scaled or lagging answer that
/// is fresh by every timestamp test.
///
/// Haircuts. Every accepted asset sits in a tier with a market-session haircut and a wider
/// after-hours haircut. After hours is outside the US equities 24/5 session (Monday 01:00 UTC to
/// Saturday 00:00 UTC, the conservative edge across daylight saving), or whenever the feed has
/// been silent longer than the tier's session bound, which catches exchange holidays. An asset
/// taken out of its tier with positions still open counts at a 100% haircut, on the registry's
/// valuation bound, and can still be sold out of a line that falls under 1.0.
///
/// Health. `health = Σ(value × (1 − haircut)) / debt` at the haircut that applies now, 1e18 =
/// 1.0. Below 1.0 anyone can call `liquidate`, which sells only the slice of one asset that
/// brings health back to `liquidationTarget`, through the asset's pinned v4 pool, and pays the
/// caller a bounty out of the proceeds. A sale needs a fresh, unpaused trade price inside the
/// pool band, so a stale or paused price defers liquidation rather than selling blind. The
/// trigger leaves the pool test out and counts a fresh position at its feed: a pool can be
/// pushed past its band inside one transaction, and a trigger that read it would let anyone
/// zero one position and sell the others for the bounty.
///
/// Write-off. Once nothing is left that a sale could turn into USDG, the debt is written off and
/// everything the line still holds is seized, every asset and tier alike, into a per-asset pot
/// that only the pool's lender can be paid from. The decision is `_exhausted`, and it never rests
/// on the pool's spot alone.
///
/// A draw or a collateral withdrawal must leave health at or above `minBorrowHealth` with every
/// position at its after-hours haircut, whatever the clock says. Checked at the session haircut,
/// a line drawn to the floor on a Friday would fall under 1.0 at Saturday 00:00 UTC with no move
/// in price. A draw also counts a position only on the guard's draw rule: an aged observation in
/// which the pool agreed with the feed, a feed that has not jumped since it, and, inside the
/// session, a feed no older than the tier's session bound. `drawHalt` names the condition a
/// position fails. Repayments, and withdrawals from a line with no debt, never meet any of it.
///
/// Drawing. A lane-1 mandate names this contract as its `treasuryPark`. When a spend or
/// purchase needs more USDG than the mandate holds, the mandate calls `unparkFor(shortfall)`
/// and this contract borrows exactly that from the pool, into the mandate, inside the same
/// transaction, after checking the resulting health.
contract CollateralVault is ITreasuryPark, V4Swapper, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint8 public constant COLLATERAL_LANE = 1;
    uint256 public constant MAX_BOUNTY_BPS = 1_000;

    struct Tier {
        /// Haircut inside the 24/5 session, in basis points.
        uint16 sessionHaircutBps;
        /// Haircut outside it.
        uint16 afterHoursHaircutBps;
        /// Feed silence past which the after-hours haircut applies on a weekday.
        uint32 sessionStaleness;
        /// Feed age past which a position counts zero.
        uint32 valuationStaleness;
        string name;
    }

    struct Params {
        /// A draw or withdrawal must leave health at or above this. 1e18 = 1.0.
        uint64 minBorrowHealth;
        /// Health a liquidation restores, no more.
        uint64 liquidationTarget;
        /// Share of the sale proceeds paid to the caller of `liquidate`.
        uint16 bountyBps;
    }

    struct PositionView {
        address asset;
        uint8 tier;
        uint256 raw;
        uint256 priceE8;
        uint256 updatedAt;
        bool fresh;
        uint16 haircutBps;
        uint256 value;
        uint256 adjusted;
    }

    /// One position as `positions` shows it, with what the views leave out.
    struct Priced {
        PositionView p;
        /// Priced, unpaused and inside the valuation bound: what the trigger counts.
        bool counted;
        /// The pool's spot agrees with the feed.
        bool inBand;
        uint16 bandBps;
        uint256 atFeed;
        /// What a draw is checked against, counted only on the guard's draw rule.
        uint256 drawAdjusted;
        /// What the liquidation trigger counts, at the feed whatever the pool says.
        uint256 triggerAdjusted;
        PriceGuard.DrawHalt halt;
    }

    AssetRegistry public immutable registry;
    PriceGuard public immutable guard;
    CreditPool public immutable pool;
    IERC20 public immutable usdg;
    IMandateAccountFactory public immutable factory;

    address public admin;
    address public pendingAdmin;
    Params public params;

    /// Tier n is `_tiers[n - 1]`: every tier number this contract takes or returns counts from one,
    /// and zero means the asset is not accepted as collateral.
    Tier[] private _tiers;
    address[] private _assets;
    mapping(address asset => uint8) private _tierOf;

    mapping(address mandate => bool) public isLine;
    mapping(address mandate => mapping(address asset => uint256)) public collateralOf;
    /// Taken from written-off lines and not yet paid to the lender.
    mapping(address asset => uint256) public seized;

    event TierSet(uint8 indexed tier, string name, uint16 sessionHaircutBps, uint16 afterHoursHaircutBps);
    event AssetTierSet(address indexed asset, uint8 tier);
    event ParamsSet(uint64 minBorrowHealth, uint64 liquidationTarget, uint16 bountyBps);
    event LineOpened(address indexed mandate, address indexed principal);
    event Deposited(address indexed mandate, address indexed asset, address indexed from, uint256 raw);
    event Withdrawn(address indexed mandate, address indexed asset, address indexed to, uint256 raw);
    event Drawn(address indexed mandate, uint256 amount, uint256 debt, uint256 health);
    event Liquidated(
        address indexed mandate,
        address indexed asset,
        address indexed caller,
        uint256 rawSold,
        uint256 proceeds,
        uint256 bounty,
        uint256 repaid,
        uint256 healthAfter
    );
    event Seized(address indexed mandate, address indexed asset, uint256 raw);
    event SeizedClaimed(address indexed asset, address indexed lender, uint256 raw);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotPendingAdmin();
    error NotPrincipal();
    error ZeroAddress();
    error ZeroAmount();
    error BadParams();
    error BadTier();
    error NotCollateral(address asset);
    error NotEligible(address asset);
    error NotFactoryAccount(address mandate);
    error NotCollateralLane(address mandate, uint8 lane);
    error NoLine(address mandate);
    error HealthTooLow(uint256 health, uint256 required);
    error Healthy(uint256 health);
    error PositionEmpty(address mandate, address asset);
    error NothingToSell();
    error NothingSeized(address asset);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        AssetRegistry registry_,
        PriceGuard guard_,
        CreditPool pool_,
        IMandateAccountFactory factory_,
        IPoolManager poolManager_,
        address admin_,
        Params memory params_,
        Tier[] memory tiers_,
        address[] memory assets_,
        uint8[] memory assetTiers_
    ) V4Swapper(poolManager_) {
        if (admin_ == address(0) || address(pool_) == address(0) || address(factory_) == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        guard = guard_;
        pool = pool_;
        factory = factory_;
        usdg = pool_.usdg();
        admin = admin_;
        emit AdminTransferred(address(0), admin_);

        _setParams(params_);
        for (uint256 i; i < tiers_.length; ++i) {
            _tiers.push();
            _setTier(uint8(i + 1), tiers_[i]);
        }
        if (assets_.length != assetTiers_.length) revert BadTier();
        for (uint256 i; i < assets_.length; ++i) {
            _setAssetTier(assets_[i], assetTiers_[i]);
        }
    }

    /// Opens the collateral line for a mandate the principal holds. The mandate has to come
    /// from the factory and sit in the collateral lane.
    function openLine(address mandate) external {
        address principal = IMandateAccount(mandate).principal();
        if (msg.sender != principal) revert NotPrincipal();
        _checkLane(mandate);
        if (!_fromFactory(mandate, principal)) revert NotFactoryAccount(mandate);
        isLine[mandate] = true;
        emit LineOpened(mandate, principal);
    }

    /// Anyone may post collateral to an open line. The raw amount that arrives is what counts.
    function deposit(address mandate, address asset, uint256 raw) external nonReentrant {
        if (!isLine[mandate]) revert NoLine(mandate);
        if (raw == 0) revert ZeroAmount();
        if (_tierOf[asset] == 0) revert NotCollateral(asset);
        if (!registry.get(asset).eligible) revert NotEligible(asset);

        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), raw);
        uint256 got = IERC20(asset).balanceOf(address(this)) - before;
        collateralOf[mandate][asset] += got;

        emit Deposited(mandate, asset, msg.sender, got);
    }

    /// The principal takes collateral back, as long as what stays still carries the debt.
    function withdraw(address mandate, address asset, uint256 raw, address to) external nonReentrant {
        if (msg.sender != IMandateAccount(mandate).principal()) revert NotPrincipal();
        if (raw == 0) revert ZeroAmount();
        uint256 held = collateralOf[mandate][asset];
        if (held < raw) revert PositionEmpty(mandate, asset);
        collateralOf[mandate][asset] = held - raw;

        _checkDraw(mandate);

        IERC20(asset).safeTransfer(to, raw);
        emit Withdrawn(mandate, asset, to, raw);
    }

    /// Called by a lane-1 mandate inside a spend or purchase. Borrows exactly `usdgNeeded` into
    /// the mandate and checks the health that leaves.
    function unparkFor(uint256 usdgNeeded) external override nonReentrant {
        address mandate = msg.sender;
        if (!isLine[mandate]) revert NoLine(mandate);
        _checkLane(mandate);
        uint256 debt = pool.borrow(mandate, usdgNeeded, mandate);
        emit Drawn(mandate, usdgNeeded, debt, _checkDraw(mandate));
    }

    /// Sells the slice of `asset` that brings the position back to `liquidationTarget`, repays
    /// the pool with the proceeds less the caller's bounty, and writes off any remainder once
    /// the line holds nothing more to sell.
    function liquidate(address mandate, address asset) external nonReentrant returns (uint256 rawSold) {
        uint256 h = health(mandate);
        if (h >= WAD) revert Healthy(h);
        uint256 held = collateralOf[mandate][asset];
        if (held == 0) revert PositionEmpty(mandate, asset);

        // Dust, left over or posted by anyone, can never be sold for anything. Once nothing else
        // is left the debt is written off here, where a sale could only revert.
        if (_exhausted(mandate)) {
            _writeOff(mandate);
            emit Liquidated(mandate, asset, msg.sender, 0, 0, 0, 0, health(mandate));
            return 0;
        }

        // Fresh, unpaused, inside the pool band; reverts otherwise, which defers the sale.
        uint256 priceE8 = guard.exitPrice(asset, address(this));

        rawSold = _sliceToSell(mandate, asset, held, priceE8);
        if (rawSold == 0) revert NothingToSell();
        collateralOf[mandate][asset] = held - rawSold;

        _sellAndSettle(mandate, asset, rawSold, priceE8);
    }

    /// Pays what write-offs seized in `asset` to the pool's lender, who carried the loss. Anyone
    /// may call it; the lender alone is paid.
    function claimSeized(address asset) external nonReentrant returns (uint256 raw) {
        raw = seized[asset];
        if (raw == 0) revert NothingSeized(asset);
        seized[asset] = 0;
        address lender = pool.lender();
        IERC20(asset).safeTransfer(lender, raw);
        emit SeizedClaimed(asset, lender, raw);
    }

    function _sellAndSettle(address mandate, address asset, uint256 rawSold, uint256 priceE8) private {
        uint256 proceeds = _sell(asset, rawSold, priceE8);
        (uint256 bounty, uint256 repaid) = _settle(mandate, proceeds);
        emit Liquidated(mandate, asset, msg.sender, rawSold, proceeds, bounty, repaid, health(mandate));
    }

    function setParams(Params calldata p) external onlyAdmin {
        _setParams(p);
    }

    /// Replaces tier `tier`, the number `tierOf` answers. One past the last tier adds a tier.
    function setTier(uint8 tier, Tier calldata t) external onlyAdmin {
        if (tier == _tiers.length + 1) _tiers.push();
        _setTier(tier, t);
    }

    /// Moves `asset` into tier `tier`. Zero takes it out of its tier.
    function setAssetTier(address asset, uint8 tier) external onlyAdmin {
        _setAssetTier(asset, tier);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// Inside the US equities 24/5 session by the clock: Monday 01:00 UTC to Saturday 00:00 UTC.
    function inSession(uint256 ts) public pure returns (bool) {
        uint256 dow = (ts / 1 days + 4) % 7; // 0 = Sunday; 1970-01-01 was a Thursday.
        if (dow == 0 || dow == 6) return false;
        if (dow == 1 && ts % 1 days < 1 hours) return false;
        return true;
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    function collateralAssets() external view returns (address[] memory) {
        return _assets;
    }

    /// Zero when the asset is not accepted; otherwise its tier, which is `tiers()[tier - 1]`.
    function tierOf(address asset) external view returns (uint8) {
        return _tierOf[asset];
    }

    /// The haircut that applies to `asset` right now and whether it is the after-hours one.
    function haircutOf(address asset) public view returns (uint16 bps, bool afterHours) {
        uint8 t = _tierOf[asset];
        if (t == 0) revert NotCollateral(asset);
        AssetRegistry.Asset memory a = registry.get(asset);
        (,,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        (bps,, afterHours) = _haircuts(_tiers[t - 1], a.collateralHaircutBps, updatedAt);
    }

    /// Whether a draw would count a position in `asset` right now and, when it would not, the
    /// first condition it fails. `None` means it counts. The same answer for every line.
    function drawHalt(address asset) external view returns (PriceGuard.DrawHalt halt) {
        (,,,, halt) = guard.drawValuation(asset, _drawBound(_tierOf[asset], registry.get(asset).valuationStaleness));
    }

    function positions(address mandate) public view returns (PositionView[] memory out) {
        uint256 n = _assets.length;
        out = new PositionView[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _position(mandate, _assets[i]).p;
        }
    }

    /// Collateral value, value after the haircuts that apply now, debt, room to draw, and health
    /// (max when no debt). Room to draw is what a draw would pass, at after-hours haircuts and on
    /// the guard's draw rule. Value, adjusted value and room to draw leave out a position whose
    /// pool disagrees with its feed; health is the liquidation trigger and counts it at the feed.
    function account(address mandate)
        public
        view
        returns (uint256 value, uint256 adjusted, uint256 debt, uint256 headroom, uint256 healthE18)
    {
        uint256 drawAdjusted;
        uint256 triggerAdjusted;
        (value, adjusted, drawAdjusted, triggerAdjusted) = _totals(mandate);
        debt = pool.debtOf(mandate);
        healthE18 = _ratio(triggerAdjusted, debt);
        uint256 ceiling = Math.mulDiv(drawAdjusted, WAD, params.minBorrowHealth);
        headroom = ceiling > debt ? ceiling - debt : 0;
        uint256 cap = pool.capacityFor(mandate);
        if (headroom > cap) headroom = cap;
    }

    function health(address mandate) public view returns (uint256 healthE18) {
        (,,,, healthE18) = account(mandate);
    }

    function headroomOf(address mandate) external view returns (uint256 headroom) {
        (,,, headroom,) = account(mandate);
    }

    function _position(address mandate, address asset) private view returns (Priced memory x) {
        PositionView memory p = x.p;
        p.asset = asset;
        p.tier = _tierOf[asset];
        p.raw = collateralOf[mandate][asset];
        AssetRegistry.Asset memory a = registry.get(asset);
        x.bandBps = a.bandBps;
        uint32 bound = p.tier == 0 ? a.valuationStaleness : _tiers[p.tier - 1].valuationStaleness;
        (uint256 priceE8, uint256 updatedAt, bool unpaused, bool inBand, PriceGuard.DrawHalt halt) =
            guard.drawValuation(asset, _drawBound(p.tier, a.valuationStaleness));
        p.updatedAt = updatedAt;
        p.priceE8 = priceE8;
        x.inBand = inBand;
        x.halt = halt;
        if (priceE8 == 0) return x;
        uint16 live = uint16(BPS);
        uint16 closed = uint16(BPS);
        if (p.tier != 0) (live, closed,) = _haircuts(_tiers[p.tier - 1], a.collateralHaircutBps, updatedAt);
        p.haircutBps = live;
        x.counted = block.timestamp - updatedAt <= bound && unpaused;
        p.fresh = x.counted && inBand;
        if (!x.counted || p.raw == 0) return x;
        x.atFeed = Math.mulDiv(p.raw, priceE8, 10 ** (uint256(a.decimals) + 2));
        x.triggerAdjusted = Math.mulDiv(x.atFeed, BPS - live, BPS);
        if (!inBand) return x;
        p.value = x.atFeed;
        p.adjusted = x.triggerAdjusted;
        if (halt == PriceGuard.DrawHalt.None) x.drawAdjusted = Math.mulDiv(x.atFeed, BPS - closed, BPS);
    }

    /// The oldest feed answer a draw against `tier` counts right now: the session bound inside
    /// the session, where a feed that has gone quiet is a halt and not just a wider haircut, and
    /// the valuation bound outside it. An untiered asset backs no draw; it gets the registry's.
    function _drawBound(uint8 tier, uint32 registryBound) private view returns (uint32) {
        if (tier == 0) return registryBound;
        Tier storage t = _tiers[tier - 1];
        return inSession(block.timestamp) ? t.sessionStaleness : t.valuationStaleness;
    }

    /// The haircut live now, the after-hours one a draw is checked at, and whether the live one
    /// is the after-hours one. The registry's published collateral haircut can only tighten them.
    function _haircuts(Tier storage t, uint16 floor_, uint256 updatedAt)
        private
        view
        returns (uint16 live, uint16 closed, bool afterHours)
    {
        uint256 age = updatedAt > block.timestamp ? 0 : block.timestamp - updatedAt;
        afterHours = !inSession(block.timestamp) || age > t.sessionStaleness;
        closed = t.afterHoursHaircutBps;
        live = afterHours ? closed : t.sessionHaircutBps;
        if (floor_ > live) live = floor_;
        if (floor_ > closed) closed = floor_;
    }

    function _totals(address mandate)
        private
        view
        returns (uint256 value, uint256 adjusted, uint256 drawAdjusted, uint256 triggerAdjusted)
    {
        uint256 n = _assets.length;
        for (uint256 i; i < n; ++i) {
            Priced memory x = _position(mandate, _assets[i]);
            value += x.p.value;
            adjusted += x.p.adjusted;
            drawAdjusted += x.drawAdjusted;
            triggerAdjusted += x.triggerAdjusted;
        }
    }

    /// Reverts unless what the line can draw against still carries its debt at `minBorrowHealth`.
    function _checkDraw(address mandate) private view returns (uint256 h) {
        (,, uint256 drawAdjusted,) = _totals(mandate);
        h = _ratio(drawAdjusted, pool.debtOf(mandate));
        if (h < params.minBorrowHealth) revert HealthTooLow(h, params.minBorrowHealth);
    }

    function _ratio(uint256 adjusted, uint256 debt) private pure returns (uint256) {
        return debt == 0 ? type(uint256).max : Math.mulDiv(adjusted, WAD, debt);
    }

    /// Raw amount of `asset` whose sale returns health to the target:
    /// x = (T·D − A) / (T(1 − β) − (1 − h)), capped at the position.
    function _sliceToSell(address mandate, address asset, uint256 held, uint256 priceE8)
        private
        view
        returns (uint256 raw)
    {
        uint256 x = _valueToSell(mandate, asset);
        if (x == 0) return 0;
        if (x == type(uint256).max) return held;
        AssetRegistry.Asset memory a = registry.get(asset);
        // The pool band covers the fee and the fill against the feed.
        x = Math.mulDiv(x, BPS + a.bandBps, BPS);
        raw = Math.mulDiv(x, 10 ** (uint256(a.decimals) + 2), priceE8, Math.Rounding.Ceil);
        if (raw > held) raw = held;
    }

    function _valueToSell(address mandate, address asset) private view returns (uint256) {
        (,,, uint256 adjusted) = _totals(mandate);
        uint256 need = Math.mulDiv(params.liquidationTarget, pool.debtOf(mandate), WAD);
        if (need <= adjusted) return 0;
        uint256 gross = Math.mulDiv(params.liquidationTarget, BPS - params.bountyBps, BPS);
        uint256 kept = Math.mulDiv(WAD, BPS - _position(mandate, asset).p.haircutBps, BPS);
        if (gross <= kept) return type(uint256).max;
        return Math.mulDiv(need - adjusted, WAD, gross - kept);
    }

    function _sell(address asset, uint256 raw, uint256 priceE8) private returns (uint256 proceeds) {
        AssetRegistry.Asset memory a = registry.get(asset);
        uint256 minOut = Math.mulDiv(Math.mulDiv(raw, priceE8, 10 ** (uint256(a.decimals) + 2)), BPS - a.bandBps, BPS);
        (, proceeds) = _swap(
            SwapOrder({
                key: a.pool,
                zeroForOne: a.pool.currency0 == asset,
                exactIn: true,
                amount: raw,
                limit: minOut,
                to: address(this)
            })
        );
        // The sale has to leave the pool inside the band as well as find it there, or a push to
        // the band's edge earlier in the transaction lets the fill run past it.
        guard.exitPrice(asset, address(this));
    }

    /// Bounty to the caller, the rest against the debt, any surplus back to the mandate, and a
    /// write-off once the position holds nothing more to sell.
    function _settle(address mandate, uint256 proceeds) private returns (uint256 bounty, uint256 repaid) {
        bounty = Math.mulDiv(proceeds, params.bountyBps, BPS);
        uint256 toRepay = proceeds - bounty;
        uint256 debt = pool.debtOf(mandate);
        if (toRepay > 0 && debt > 0) {
            repaid = toRepay > debt ? debt : toRepay;
            usdg.forceApprove(address(pool), repaid);
            pool.repay(mandate, repaid);
        }
        uint256 surplus = toRepay - repaid;
        if (surplus > 0) usdg.safeTransfer(mandate, surplus);
        if (bounty > 0) usdg.safeTransfer(msg.sender, bounty);
        if (pool.debtOf(mandate) > 0 && _exhausted(mandate)) _writeOff(mandate);
    }

    /// Clears the debt and seizes what the line still holds, every asset and tier alike, into
    /// `seized`. The tokens stay put: a transfer that fails must not hold up the write-off, so
    /// the lender is paid through `claimSeized` once the token lets them move.
    function _writeOff(address mandate) private {
        pool.writeOff(mandate);
        uint256 n = _assets.length;
        for (uint256 i; i < n; ++i) {
            address asset = _assets[i];
            uint256 raw = collateralOf[mandate][asset];
            if (raw == 0) continue;
            collateralOf[mandate][asset] = 0;
            seized[asset] += raw;
            emit Seized(mandate, asset, raw);
        }
    }

    /// Nothing is left that a sale could turn into USDG. A position holds the write-off open
    /// while a sale is still possible: its feed prices it inside the valuation bound, unpaused,
    /// above dust, and the pool agrees with the feed at spot. Dust, whose band floor rounds to
    /// nothing, never does, wherever its pool sits.
    ///
    /// A position that cannot be sold now is read by tier. A tiered one waits: its feed may well
    /// return and its pool recover. An untiered one was dropped by governance and may never price
    /// again, so a feed that is stale or paused ends it. Its pool disagreeing does not, on its
    /// own: a pool can be pushed out of its band and back inside one transaction, and a write-off
    /// that read the spot would let the borrower force one on a saleable line. The pool has to
    /// have disagreed at the guard's aged observation as well, a reading at least
    /// `MIN_OBSERVATION_AGE` old that nobody could have placed in the same block. Without a
    /// valid aged observation the write-off waits for one.
    function _exhausted(address mandate) private view returns (bool) {
        uint256 n = _assets.length;
        for (uint256 i; i < n; ++i) {
            address asset = _assets[i];
            if (collateralOf[mandate][asset] == 0) continue;
            Priced memory x = _position(mandate, asset);
            if (!x.counted) {
                if (x.p.tier != 0) return false;
                continue;
            }
            if (Math.mulDiv(x.atFeed, BPS - x.bandBps, BPS) == 0) continue;
            if (x.inBand || x.p.tier != 0) return false;
            if (x.halt != PriceGuard.DrawHalt.ObservationOffBand) return false;
        }
        return true;
    }

    function _checkLane(address mandate) private view {
        uint8 lane = IMandateAccount(mandate).lane();
        if (lane != COLLATERAL_LANE) revert NotCollateralLane(mandate, lane);
    }

    function _fromFactory(address mandate, address principal) private view returns (bool) {
        address[] memory list = factory.accountsOf(principal);
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == mandate) return true;
        }
        return false;
    }

    function _setParams(Params memory p) private {
        if (p.minBorrowHealth < WAD || p.liquidationTarget <= WAD || p.liquidationTarget > p.minBorrowHealth) {
            revert BadParams();
        }
        if (p.bountyBps > MAX_BOUNTY_BPS) revert BadParams();
        params = p;
        emit ParamsSet(p.minBorrowHealth, p.liquidationTarget, p.bountyBps);
    }

    function _setTier(uint8 tier, Tier memory t) private {
        if (tier == 0 || tier > _tiers.length) revert BadTier();
        if (
            t.sessionHaircutBps >= BPS || t.afterHoursHaircutBps >= BPS || t.afterHoursHaircutBps < t.sessionHaircutBps
                || t.sessionStaleness == 0 || t.valuationStaleness < t.sessionStaleness
        ) revert BadTier();
        _tiers[tier - 1] = t;
        emit TierSet(tier, t.name, t.sessionHaircutBps, t.afterHoursHaircutBps);
    }

    function _setAssetTier(address asset, uint8 tier) private {
        registry.get(asset); // reverts for an unregistered asset
        if (tier > _tiers.length) revert BadTier();
        if (_tierOf[asset] == 0 && tier != 0) {
            bool known;
            for (uint256 i; i < _assets.length; ++i) {
                if (_assets[i] == asset) known = true;
            }
            if (!known) _assets.push(asset);
        }
        _tierOf[asset] = tier;
        emit AssetTierSet(asset, tier);
    }
}
