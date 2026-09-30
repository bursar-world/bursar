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
/// haircut of its tier, and only while the feed is inside the tier's valuation bound, the
/// token's oracle is not paused, and the asset's pinned pool trades inside its band of the feed.
/// A position that fails any of these counts zero, which is what stops a mis-scaled or lagging
/// answer, fresh by every timestamp test, from backing a draw.
///
/// Haircuts. Every accepted asset sits in a tier with a market-session haircut and a wider
/// after-hours haircut. After hours is outside the US equities 24/5 session (Monday 01:00 UTC to
/// Saturday 00:00 UTC, the conservative edge across daylight saving), or whenever the feed has
/// been silent longer than the tier's session bound, which catches exchange holidays.
///
/// Health. `health = Σ(value × (1 − haircut)) / debt`, 1e18 = 1.0. A draw or a collateral
/// withdrawal must leave health at or above `minBorrowHealth`. Below 1.0 anyone can call
/// `liquidate`, which sells only the slice of one asset that brings health back to
/// `liquidationTarget`, through the asset's pinned v4 pool, and pays the caller a bounty out of
/// the proceeds. A sale needs a fresh, unpaused trade price inside the pool band, so a stale or
/// paused price defers liquidation rather than selling blind.
///
/// The liquidation trigger leaves the pool test out and counts a fresh position at its feed. A
/// pool can be pushed past its band inside one transaction; a trigger that read it would let
/// anyone zero one position and sell the others for the bounty.
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

    AssetRegistry public immutable registry;
    PriceGuard public immutable guard;
    CreditPool public immutable pool;
    IERC20 public immutable usdg;
    IMandateAccountFactory public immutable factory;

    address public admin;
    address public pendingAdmin;
    Params public params;

    Tier[] private _tiers;
    address[] private _assets;
    /// Tier index plus one; zero means the asset is not accepted as collateral.
    mapping(address asset => uint8) private _tierOf;

    mapping(address mandate => bool) public isLine;
    mapping(address mandate => mapping(address asset => uint256)) public collateralOf;

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
            _setTier(uint8(i), tiers_[i]);
        }
        if (assets_.length != assetTiers_.length) revert BadTier();
        for (uint256 i; i < assets_.length; ++i) {
            _setAssetTier(assets_[i], assetTiers_[i]);
        }
    }

    // --- principal ---

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

    // --- the mandate ---

    /// Called by a lane-1 mandate inside a spend or purchase. Borrows exactly `usdgNeeded` into
    /// the mandate and checks the health that leaves.
    function unparkFor(uint256 usdgNeeded) external override nonReentrant {
        address mandate = msg.sender;
        if (!isLine[mandate]) revert NoLine(mandate);
        _checkLane(mandate);
        uint256 debt = pool.borrow(mandate, usdgNeeded, mandate);
        emit Drawn(mandate, usdgNeeded, debt, _checkDraw(mandate));
    }

    // --- anyone ---

    /// Sells the slice of `asset` that brings the position back to `liquidationTarget`, repays
    /// the pool with the proceeds less the caller's bounty, and writes off any remainder once
    /// the position holds nothing more.
    function liquidate(address mandate, address asset) external nonReentrant returns (uint256 rawSold) {
        uint256 h = health(mandate);
        if (h >= WAD) revert Healthy(h);
        uint256 held = collateralOf[mandate][asset];
        if (held == 0) revert PositionEmpty(mandate, asset);

        // Fresh, unpaused, inside the pool band; reverts otherwise, which defers the sale.
        uint256 priceE8 = guard.exitPrice(asset, address(this));

        rawSold = _sliceToSell(mandate, asset, held, priceE8);
        if (rawSold == 0) revert NothingToSell();
        collateralOf[mandate][asset] = held - rawSold;

        _sellAndSettle(mandate, asset, rawSold, priceE8);
    }

    function _sellAndSettle(address mandate, address asset, uint256 rawSold, uint256 priceE8) private {
        uint256 proceeds = _sell(asset, rawSold, priceE8);
        (uint256 bounty, uint256 repaid) = _settle(mandate, proceeds);
        emit Liquidated(mandate, asset, msg.sender, rawSold, proceeds, bounty, repaid, health(mandate));
    }

    // --- admin ---

    function setParams(Params calldata p) external onlyAdmin {
        _setParams(p);
    }

    function setTier(uint8 tier, Tier calldata t) external onlyAdmin {
        if (tier == _tiers.length) _tiers.push();
        _setTier(tier, t);
    }

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

    // --- reads ---

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

    /// Zero when the asset is not accepted; otherwise the tier index plus one.
    function tierOf(address asset) external view returns (uint8) {
        return _tierOf[asset];
    }

    /// The haircut that applies to `asset` right now and whether it is the after-hours one.
    function haircutOf(address asset) public view returns (uint16 bps, bool afterHours) {
        uint8 t = _tierOf[asset];
        if (t == 0) revert NotCollateral(asset);
        Tier storage tier = _tiers[t - 1];
        (,,, uint256 updatedAt,) = IAggregatorV3(registry.get(asset).feed).latestRoundData();
        uint256 age = updatedAt > block.timestamp ? 0 : block.timestamp - updatedAt;
        afterHours = !inSession(block.timestamp) || age > tier.sessionStaleness;
        bps = afterHours ? tier.afterHoursHaircutBps : tier.sessionHaircutBps;
        // The registry's published collateral haircut can only tighten the tier.
        uint16 floor_ = registry.get(asset).collateralHaircutBps;
        if (floor_ > bps) bps = floor_;
    }

    function positions(address mandate) public view returns (PositionView[] memory out) {
        uint256 n = _assets.length;
        out = new PositionView[](n);
        for (uint256 i; i < n; ++i) {
            (out[i],,) = _position(mandate, _assets[i]);
        }
    }

    /// Collateral value, value after haircuts, debt, room to draw, and health (max when no debt).
    /// Value, adjusted value and room to draw leave out a position whose pool disagrees with its
    /// feed; health is the liquidation trigger and counts it at the feed.
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

    // --- internals ---

    /// One position as `positions` shows it, and the two adjusted values the view leaves out:
    /// what a draw is checked against, counted only while the pool agrees with the feed, and
    /// what the liquidation trigger counts, at the feed whatever the pool says.
    function _position(address mandate, address asset)
        private
        view
        returns (PositionView memory p, uint256 drawAdjusted, uint256 triggerAdjusted)
    {
        p.asset = asset;
        p.tier = _tierOf[asset];
        p.raw = collateralOf[mandate][asset];
        (uint256 priceE8, uint256 updatedAt, bool unpaused, bool inBand) = guard.valuation(asset);
        p.updatedAt = updatedAt;
        p.priceE8 = priceE8;
        if (priceE8 == 0 || p.tier == 0) return (p, 0, 0);
        bool counted = block.timestamp - updatedAt <= _tiers[p.tier - 1].valuationStaleness && unpaused;
        p.fresh = counted && inBand;
        (p.haircutBps,) = haircutOf(asset);
        if (!counted || p.raw == 0) return (p, 0, 0);
        uint256 atFeed = Math.mulDiv(p.raw, priceE8, 10 ** (uint256(registry.get(asset).decimals) + 2));
        triggerAdjusted = Math.mulDiv(atFeed, BPS - p.haircutBps, BPS);
        if (!inBand) return (p, 0, triggerAdjusted);
        p.value = atFeed;
        p.adjusted = triggerAdjusted;
        drawAdjusted = triggerAdjusted;
    }

    function _totals(address mandate)
        private
        view
        returns (uint256 value, uint256 adjusted, uint256 drawAdjusted, uint256 triggerAdjusted)
    {
        uint256 n = _assets.length;
        for (uint256 i; i < n; ++i) {
            (PositionView memory p, uint256 d, uint256 t) = _position(mandate, _assets[i]);
            value += p.value;
            adjusted += p.adjusted;
            drawAdjusted += d;
            triggerAdjusted += t;
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
        (uint16 h,) = haircutOf(asset);
        uint256 gross = Math.mulDiv(params.liquidationTarget, BPS - params.bountyBps, BPS);
        uint256 kept = Math.mulDiv(WAD, BPS - h, BPS);
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
        if (pool.debtOf(mandate) > 0 && _isEmpty(mandate)) pool.writeOff(mandate);
    }

    function _isEmpty(address mandate) private view returns (bool) {
        uint256 n = _assets.length;
        for (uint256 i; i < n; ++i) {
            if (collateralOf[mandate][_assets[i]] != 0) return false;
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

    function _setTier(uint8 index, Tier memory t) private {
        if (
            t.sessionHaircutBps >= BPS || t.afterHoursHaircutBps >= BPS || t.afterHoursHaircutBps < t.sessionHaircutBps
                || t.sessionStaleness == 0 || t.valuationStaleness < t.sessionStaleness
        ) revert BadTier();
        _tiers[index] = t;
        emit TierSet(index, t.name, t.sessionHaircutBps, t.afterHoursHaircutBps);
    }

    function _setAssetTier(address asset, uint8 tier) private {
        registry.get(asset); // registered, keyed on address
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
