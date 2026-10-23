// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMandateAccount} from "../interfaces/IMandateAccount.sol";
import {AssetRegistry} from "../rwa/AssetRegistry.sol";
import {PriceGuard} from "../rwa/PriceGuard.sol";
import {StockSpendRouter} from "../rwa/StockSpendRouter.sol";
import {PatronMark} from "./PatronMark.sol";

/// An endowment for one agent on the ERC-8004 identity registry.
///
/// The principal is held in listed stocks bought through the stock router, under the same price
/// guard a mandate's purchases meet, plus a USDG sleeve of about ninety days of draw.
///
/// The draw is set once a quarter, on a collar: `drawBps` of the average of the last twelve
/// quarterly valuations, moved at most 5% from the previous quarter's draw, kept between 3% and
/// 6% of what the principal is worth now, held at 4% in the first year, and stopped while the
/// principal is worth less than 80% of what was put in. A gift counts toward the draw only after a
/// full quarter, so a gift timed to a valuation moves nothing. The draw accrues every second and
/// is paid into a mandate the agent's owner names, where the mandate's limits govern the spending.
///
/// Anyone can start an endowment for any registered agent and anyone can give to one. Nothing
/// accrues until the identity's owner accepts. Gifts are irrevocable once accepted. Only an
/// endowment never accepted within 180 days lets each patron take back their share.
///
/// To the router this contract is its own principal, which is what lets it set its trading
/// policy and sell out of its custody without any administered contract naming it.
contract Endowment is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Terms {
        uint256 agentId;
        uint256 successorId;
        address[] assets;
        uint16[] weightsBps;
        uint16 drawBps;
        uint16 earnShareBps;
    }

    struct Wiring {
        StockSpendRouter router;
        PriceGuard guard;
        AssetRegistry registry;
        IERC20 usdg;
        IERC721 identity;
        PatronMark marks;
        address feeTo;
        uint16 feeBps;
        address guardian;
    }

    /// Everything the endowment page shows, in one read.
    struct State {
        uint256 agentId;
        uint256 successorId;
        address mandate;
        bool accepted;
        bool frozen;
        uint256 nav;
        bool navFresh;
        uint256 averageNav;
        uint256 drawPerYear;
        uint256 accrued;
        uint256 cash;
        uint256 sleeveTarget;
        uint256 given;
        uint256 unattributed;
        uint256 earned;
        uint256 earnedToPrincipal;
        uint256 drawn;
        uint256 fees;
        uint256 patrons;
        uint256 snapshotsTaken;
        uint64 createdAt;
        uint64 lastDrawAt;
        uint64 lastActive;
        uint64 unacceptedSince;
        uint256 contributed;
        uint256 pending;
        bool everAccepted;
        bool underwater;
        uint64 lastSnapshotAt;
    }

    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;
    uint256 public constant SNAPSHOTS = 12;
    uint256 public constant SNAPSHOT_INTERVAL = 90 days;
    /// The most a quarter's draw moves from the one before, either way.
    uint256 public constant CHANGE_BPS = 500;
    /// The draw is held between these shares of the principal's value.
    uint256 public constant FLOOR_BPS = 300;
    uint256 public constant CAP_BPS = 600;
    /// The first year draws at most this rate, so a young endowment never draws off one peak.
    uint256 public constant FIRST_YEAR_BPS = 400;
    uint256 public constant FIRST_YEAR_SNAPSHOTS = 4;
    /// Below this share of what was put in, the draw stops until the principal recovers.
    uint256 public constant UNDERWATER_BPS = 8_000;
    /// Cash kept for draws, and the most a draw can owe, measured in days of draw.
    uint256 public constant SLEEVE = 90 days;
    uint256 public constant QUIET = 180 days;
    uint256 public constant REFUND_AFTER = 180 days;
    /// No purchase or sale smaller than a dollar: the pool fee would eat it.
    uint256 public constant MIN_TRADE = 1e6;
    /// The smallest gift that earns a patron mark.
    uint256 public constant MIN_MARK = 1e6;
    uint256 public constant FOUNDING = 100;
    uint16 public constant SLIPPAGE_BPS = 100;

    StockSpendRouter public immutable router;
    PriceGuard public immutable guard;
    AssetRegistry public immutable registry;
    IERC20 public immutable usdg;
    IERC721 public immutable identity;
    PatronMark public immutable marks;
    address public immutable feeTo;
    uint16 public immutable feeBps;
    address public immutable guardian;
    address public immutable settlor;
    uint16 public immutable drawBps;
    uint16 public immutable earnShareBps;
    uint64 public immutable createdAt;

    address[] private _assets;
    uint16[] private _weights;

    uint256 public agentId;
    uint256 public successorId;
    address public mandate;
    bool public accepted;
    bool public frozen;
    bool private _policySet;

    uint64 public unacceptedSince;
    uint64 public lastDrawAt;
    uint64 public lastActive;
    uint64 public lastSnapshotAt;
    uint256 public snapshotsTaken;
    uint256[SNAPSHOTS] private _snapshots;
    /// What the agent is paid a year, set at each valuation.
    uint256 public annualDraw;
    /// Put in since the last valuation; it counts from the next one.
    uint256 public pending;
    /// Draw owed from before the rate last changed, paid ahead of what accrues at the new rate.
    uint256 public banked;
    bool public everAccepted;

    /// The USDG this contract has accounted for. Anything above it arrived without a call here:
    /// a relayed gift from the shielded pool, or a plain transfer.
    uint256 private _accounted;

    uint256 public given;
    uint256 public unattributed;
    uint256 public earned;
    uint256 public earnedToPrincipal;
    uint256 public drawn;
    uint256 public fees;
    uint256 public patrons;
    mapping(address => uint256) public givenBy;
    /// Gifts not yet taken back, the denominator of every refund.
    uint256 public openGifts;

    event Given(address indexed patron, address indexed asset, uint256 amount, uint256 value);
    event Unattributed(uint256 amount, bool creditedToSettlor);
    event Earned(address indexed from, uint256 amount, uint256 toPrincipal, uint256 toAgent);
    event Accepted(uint256 indexed agentId, address indexed owner, address mandate);
    event MandateSet(address mandate);
    event Drawn(address indexed mandate, uint256 amount, uint256 fee);
    event Snapshot(uint256 indexed index, uint256 nav);
    event Invested(address indexed asset, uint256 usdgIn, uint256 amountOut);
    event Refilled(address indexed asset, uint256 amountIn, uint256 usdgOut);
    event Lapsed(uint256 indexed agentId, uint256 indexed successorId);
    event Reclaimed(address indexed patron, uint256 share);
    event SuccessorSet(uint256 successorId);
    event FrozenSet(bool frozen);

    error NotOwner();
    error NotDrawer();
    error NotSettlor();
    error NotGuardian();
    error NotAccepted();
    error AlreadyAccepted();
    error IsFrozen();
    error NotSettlementAsset(address mandate);
    error ZeroAmount();
    error ZeroAddress();
    error NotAnAsset(address asset);
    error NothingToDraw();
    error NothingToInvest();
    error SleeveFull();
    error NothingToSell();
    error StaleValuation(address asset);
    error TooSoon(uint256 at);
    error StillActive(uint256 at);
    error RefundsClosed(uint256 at);
    error NothingGiven();

    constructor(address settlor_, Terms memory t, Wiring memory w) {
        settlor = settlor_;
        agentId = t.agentId;
        successorId = t.successorId;
        _assets = t.assets;
        _weights = t.weightsBps;
        drawBps = t.drawBps;
        earnShareBps = t.earnShareBps;
        router = w.router;
        guard = w.guard;
        registry = w.registry;
        usdg = w.usdg;
        identity = w.identity;
        marks = w.marks;
        feeTo = w.feeTo;
        feeBps = w.feeBps;
        guardian = w.guardian;
        createdAt = uint64(block.timestamp);
        unacceptedSince = uint64(block.timestamp);
    }

    // The router's view of this contract: its own principal, with no agent.

    function principal() external view returns (address) {
        return address(this);
    }

    function agent() external pure returns (address) {
        return address(0);
    }

    // Patrons and earnings.

    function give(uint256 amount) external nonReentrant {
        _giveFrom(msg.sender, msg.sender, amount);
    }

    /// A gift paid by the caller and credited to `patron`: the factory's first gift at creation.
    function giveFor(address patron, uint256 amount) external nonReentrant {
        if (patron == address(0)) revert ZeroAddress();
        _giveFrom(msg.sender, patron, amount);
    }

    /// A gift in kind, of a stock this endowment holds, credited at the feed's valuation.
    function giveStock(address asset, uint256 raw) external nonReentrant {
        if (raw == 0) revert ZeroAmount();
        if (!_isAsset(asset)) revert NotAnAsset(asset);
        _sync();
        (uint256 priceE8,,) = guard.valuationPrice(asset);
        uint256 value = _value(asset, raw, priceE8);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), raw);
        _credit(msg.sender, value);
        emit Given(msg.sender, asset, raw, value);
        _settle();
    }

    /// What the agent earned, paid in by whoever received it. `earnShareBps` of it joins the
    /// principal and the rest goes straight to the agent's mandate.
    function earn(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _sync();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        uint256 toAgent = accepted ? amount - Math.mulDiv(amount, earnShareBps, BPS) : 0;
        uint256 toPrincipal = amount - toAgent;
        earned += amount;
        earnedToPrincipal += toPrincipal;
        pending += toPrincipal;
        if (toAgent != 0) _deposit(toAgent);
        emit Earned(msg.sender, amount, toPrincipal, toAgent);
        _settle();
    }

    // The agent's side.

    function accept(address mandate_) external nonReentrant {
        if (msg.sender != identity.ownerOf(agentId)) revert NotOwner();
        if (accepted) revert AlreadyAccepted();
        _sync();
        _setMandate(mandate_);
        accepted = true;
        everAccepted = true;
        banked = 0;
        lastDrawAt = uint64(block.timestamp);
        lastActive = uint64(block.timestamp);
        emit Accepted(agentId, msg.sender, mandate_);
        if (snapshotsTaken == 0) _trySnapshot();
        _settle();
    }

    function setMandate(address mandate_) external {
        if (msg.sender != identity.ownerOf(agentId)) revert NotOwner();
        if (!accepted) revert NotAccepted();
        _setMandate(mandate_);
    }

    /// Pays what has accrued into the mandate, less the protocol's share. Sent by the identity's
    /// owner or the mandate's agent, and each draw counts as the agent being alive.
    function draw() external nonReentrant returns (uint256 paid) {
        if (!accepted) revert NotAccepted();
        if (frozen) revert IsFrozen();
        if (msg.sender != identity.ownerOf(agentId) && msg.sender != IMandateAccount(mandate).agent()) {
            revert NotDrawer();
        }
        _sync();
        uint256 owed = accrued();
        uint256 cash = usdg.balanceOf(address(this));
        paid = owed < cash ? owed : cash;
        if (paid == 0) revert NothingToDraw();

        if (paid == owed) {
            banked = 0;
            lastDrawAt = uint64(block.timestamp);
        } else if (paid <= banked) {
            banked -= paid;
        } else {
            // A short sleeve pays part of what accrued; the rest stays owed, measured in time.
            uint256 fromTime = paid - banked;
            uint256 timeOwed = owed - banked;
            banked = 0;
            uint256 elapsed = block.timestamp - lastDrawAt;
            if (elapsed > SLEEVE) elapsed = SLEEVE;
            lastDrawAt = uint64(block.timestamp - elapsed + Math.mulDiv(elapsed, fromTime, timeOwed));
        }
        lastActive = uint64(block.timestamp);

        uint256 fee = Math.mulDiv(paid, feeBps, BPS);
        if (fee != 0) usdg.safeTransfer(feeTo, fee);
        _deposit(paid - fee);
        drawn += paid - fee;
        fees += fee;
        emit Drawn(mandate, paid - fee, fee);
        _settle();
    }

    // Keeping the principal. Anyone may call these; each is bounded by the guard and the terms.

    function snapshot() external nonReentrant {
        if (snapshotsTaken != 0 && block.timestamp < lastSnapshotAt + SNAPSHOT_INTERVAL) {
            revert TooSoon(lastSnapshotAt + SNAPSHOT_INTERVAL);
        }
        _sync();
        (uint256 v, bool fresh, address stale) = _nav();
        if (!fresh) revert StaleValuation(stale);
        if (snapshotsTaken == 0 && v == 0) revert ZeroAmount();
        _value(v);
        _settle();
    }

    /// Buys the stock furthest under its weight with the cash above the sleeve, one trade's
    /// worth at a time.
    function invest() external nonReentrant returns (uint256 amountOut) {
        _sync();
        uint256 cash = usdg.balanceOf(address(this));
        uint256 sleeve = sleeveTarget();
        if (cash <= sleeve + MIN_TRADE) revert NothingToInvest();
        address asset = _pick(true, cash - sleeve);
        uint256 usdgIn = cash - sleeve;
        uint256 cap = registry.get(asset).perTradeCap;
        if (usdgIn > cap) usdgIn = cap;

        _ensurePolicy();
        uint256 quote = guard.tradePrice(asset, address(this));
        uint256 before = IERC20(asset).balanceOf(address(this));
        usdg.forceApprove(address(router), usdgIn);
        // The fill is measured below; the router holds it to the feed and the slippage limit.
        // slither-disable-next-line unused-return
        router.buy(asset, uint128(usdgIn), 0, quote, address(this));
        usdg.forceApprove(address(router), 0);
        amountOut = IERC20(asset).balanceOf(address(this)) - before;
        emit Invested(asset, usdgIn, amountOut);
        _settle();
    }

    /// Sells the stock furthest over its weight when the sleeve is below half its target, back
    /// up to the target or one trade's worth.
    function refill() external nonReentrant returns (uint256 usdgOut) {
        _sync();
        uint256 cash = usdg.balanceOf(address(this));
        uint256 target = sleeveTarget();
        if (cash * 2 >= target) revert SleeveFull();
        uint256 need = target - cash;
        address asset = _pick(false, 0);
        if (asset == address(0)) revert NothingToSell();
        uint256 held = IERC20(asset).balanceOf(address(this));

        AssetRegistry.Asset memory a = registry.get(asset);
        uint256 price = guard.exitPrice(asset, address(this));
        if (need > a.perTradeCap) need = a.perTradeCap;
        if (need < MIN_TRADE) need = MIN_TRADE;
        uint256 raw = Math.mulDiv(need, 10 ** (uint256(a.decimals) + 2), price);
        if (raw > held) raw = held;
        if (raw == 0) revert NothingToSell();

        _ensurePolicy();
        IERC20(asset).safeTransfer(router.custodyOf(address(this)), raw);
        usdgOut = router.sell(address(this), asset, uint128(raw), 0, price);
        emit Refilled(asset, raw, usdgOut);
        _settle();
    }

    // When the agent goes quiet.

    /// After 180 days without a draw from the agent's side, the endowment passes to the named
    /// successor, whose owner then accepts it. With no successor it rests: the same owner can
    /// accept it again, and naming a successor passes it on.
    function lapse() external nonReentrant {
        if (!accepted) revert NotAccepted();
        if (block.timestamp < lastActive + QUIET) revert StillActive(lastActive + QUIET);
        uint256 previous = agentId;
        accepted = false;
        banked = 0;
        mandate = address(0);
        unacceptedSince = uint64(block.timestamp);
        if (successorId != 0 && successorId != previous) {
            agentId = successorId;
            successorId = 0;
        }
        emit Lapsed(previous, agentId);
    }

    /// A patron's share of everything held, in kind, from an endowment its agent's owner never
    /// accepted within 180 days: a gift that was never taken up goes back.
    function reclaim() external nonReentrant {
        if (everAccepted || block.timestamp < createdAt + REFUND_AFTER) revert RefundsClosed(createdAt + REFUND_AFTER);
        _sync();
        uint256 share = givenBy[msg.sender];
        if (share == 0) revert NothingGiven();
        uint256 open = openGifts;
        givenBy[msg.sender] = 0;
        openGifts = open - share;

        uint256 cash = Math.mulDiv(usdg.balanceOf(address(this)), share, open);
        if (cash != 0) usdg.safeTransfer(msg.sender, cash);
        for (uint256 i; i < _assets.length; ++i) {
            IERC20 token = IERC20(_assets[i]);
            uint256 part = Math.mulDiv(token.balanceOf(address(this)), share, open);
            if (part != 0) token.safeTransfer(msg.sender, part);
        }
        emit Reclaimed(msg.sender, share);
        _settle();
    }

    function setSuccessor(uint256 successorId_) external {
        if (msg.sender != settlor) revert NotSettlor();
        emit SuccessorSet(successorId_);
        if (!accepted && everAccepted && successorId_ != 0 && successorId_ != agentId) {
            emit Lapsed(agentId, successorId_);
            agentId = successorId_;
            successorId = 0;
            unacceptedSince = uint64(block.timestamp);
            return;
        }
        successorId = successorId_;
    }

    /// Stops and restarts the draw. Moves nothing: principal, cash and refunds are untouched.
    function setFrozen(bool frozen_) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (!frozen && frozen_ && accepted) _bank();
        if (frozen && !frozen_) lastDrawAt = uint64(block.timestamp);
        frozen = frozen_;
        emit FrozenSet(frozen_);
    }

    // Reads.

    function assets() external view returns (address[] memory, uint16[] memory) {
        return (_assets, _weights);
    }

    function averageNav() public view returns (uint256) {
        uint256 n = snapshotsTaken < SNAPSHOTS ? snapshotsTaken : SNAPSHOTS;
        if (n == 0) return 0;
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            sum += _snapshots[i];
        }
        return sum / n;
    }

    function drawPerYear() public view returns (uint256) {
        return annualDraw;
    }

    /// Everything put in: gifts, private gifts and the earnings kept.
    function contributed() public view returns (uint256) {
        return given + unattributed + earnedToPrincipal;
    }

    function accrued() public view returns (uint256) {
        if (!accepted) return 0;
        if (frozen) return banked;
        uint256 elapsed = block.timestamp - lastDrawAt;
        if (elapsed > SLEEVE) elapsed = SLEEVE;
        return banked + Math.mulDiv(annualDraw, elapsed, YEAR);
    }

    function sleeveTarget() public view returns (uint256) {
        return Math.mulDiv(drawPerYear(), SLEEVE, YEAR);
    }

    function state() external view returns (State memory s) {
        s.agentId = agentId;
        s.successorId = successorId;
        s.mandate = mandate;
        s.accepted = accepted;
        s.frozen = frozen;
        (s.nav, s.navFresh,) = _nav();
        s.averageNav = averageNav();
        s.drawPerYear = drawPerYear();
        s.accrued = accrued();
        s.cash = usdg.balanceOf(address(this));
        s.sleeveTarget = sleeveTarget();
        s.given = given;
        s.unattributed = unattributed + (s.cash > _accounted ? s.cash - _accounted : 0);
        s.earned = earned;
        s.earnedToPrincipal = earnedToPrincipal;
        s.drawn = drawn;
        s.fees = fees;
        s.patrons = patrons;
        s.snapshotsTaken = snapshotsTaken;
        s.createdAt = createdAt;
        s.lastDrawAt = lastDrawAt;
        s.lastActive = lastActive;
        s.unacceptedSince = unacceptedSince;
        s.contributed = contributed();
        s.pending = pending;
        s.everAccepted = everAccepted;
        s.underwater = s.nav * BPS < s.contributed * UNDERWATER_BPS;
        s.lastSnapshotAt = lastSnapshotAt;
    }

    // Internals.

    function _giveFrom(address payer, address patron, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        _sync();
        usdg.safeTransferFrom(payer, address(this), amount);
        _credit(patron, amount);
        emit Given(patron, address(usdg), amount, amount);
        _settle();
    }

    function _credit(address patron, uint256 value) private {
        pending += value;
        uint256 before = givenBy[patron];
        givenBy[patron] = before + value;
        given += value;
        openGifts += value;
        if (before < MIN_MARK && before + value >= MIN_MARK) {
            patrons += 1;
            marks.mint(patron, patrons <= FOUNDING);
        }
    }

    /// Takes in USDG that arrived without a call. Before acceptance it is the settlor's, so a
    /// refund can return it; after, it joins the principal unattributed.
    function _sync() private {
        uint256 balance = usdg.balanceOf(address(this));
        if (balance <= _accounted) {
            _accounted = balance;
            return;
        }
        uint256 arrived = balance - _accounted;
        _accounted = balance;
        pending += arrived;
        if (accepted) {
            unattributed += arrived;
        } else {
            givenBy[settlor] += arrived;
            given += arrived;
            openGifts += arrived;
        }
        emit Unattributed(arrived, !accepted);
    }

    function _settle() private {
        _accounted = usdg.balanceOf(address(this));
    }

    function _setMandate(address mandate_) private {
        if (mandate_ == address(0)) revert ZeroAddress();
        if (IMandateAccount(mandate_).settlementAsset() != address(usdg)) revert NotSettlementAsset(mandate_);
        mandate = mandate_;
        emit MandateSet(mandate_);
    }

    function _deposit(uint256 amount) private {
        if (amount == 0) return;
        usdg.forceApprove(mandate, amount);
        IMandateAccount(mandate).deposit(amount);
    }

    /// Records a valuation and sets the next quarter's draw on the collar. What was put in since the
    /// last valuation is left out of this one; the first valuation has nothing to leave out.
    function _value(uint256 v) private {
        uint256 left = snapshotsTaken == 0 ? 0 : pending;
        uint256 counted = v > left ? v - left : 0;
        pending = 0;
        _snapshots[snapshotsTaken % SNAPSHOTS] = counted;
        emit Snapshot(snapshotsTaken, counted);
        snapshotsTaken += 1;
        lastSnapshotAt = uint64(block.timestamp);

        uint256 average = averageNav();
        uint256 next = Math.mulDiv(average, drawBps, BPS);
        if (snapshotsTaken <= FIRST_YEAR_SNAPSHOTS) next = Math.min(next, Math.mulDiv(average, FIRST_YEAR_BPS, BPS));
        uint256 previous = annualDraw;
        if (previous != 0) {
            next = Math.min(Math.max(next, Math.mulDiv(previous, BPS - CHANGE_BPS, BPS)), Math.mulDiv(previous, BPS + CHANGE_BPS, BPS));
        }
        next = Math.min(Math.max(next, Math.mulDiv(counted, FLOOR_BPS, BPS)), Math.mulDiv(counted, CAP_BPS, BPS));
        // Measured against what was put in before the gifts this valuation leaves out, which every
        // contribution counted in `pending` is also part of.
        if (counted * BPS < (contributed() - left) * UNDERWATER_BPS) next = 0;

        // What accrued at the old rate stays owed at the old rate.
        if (accepted && !frozen && previous != next) _bank();
        annualDraw = next;
    }

    function _trySnapshot() private {
        (uint256 v, bool fresh,) = _nav();
        if (fresh && v != 0) _value(v);
    }

    /// Moves what has accrued into `banked`, at most a sleeve of the current rate, and restarts the
    /// clock, so a change of rate neither forgives nor inflates what is already owed.
    function _bank() private {
        banked = Math.min(accrued(), Math.max(banked, Math.mulDiv(annualDraw, SLEEVE, YEAR)));
        lastDrawAt = uint64(block.timestamp);
    }

    function _nav() private view returns (uint256 value, bool fresh, address stale) {
        value = usdg.balanceOf(address(this));
        fresh = true;
        for (uint256 i; i < _assets.length; ++i) {
            address asset = _assets[i];
            uint256 held = IERC20(asset).balanceOf(address(this));
            if (held == 0) continue;
            (uint256 priceE8,, bool ok) = guard.valuationPrice(asset);
            if (!ok && fresh) {
                fresh = false;
                stale = asset;
            }
            value += _value(asset, held, priceE8);
        }
    }

    /// The asset furthest under (`under`) or over its weight, counting `adding` USDG about to be
    /// spent. Unpriced holdings count as nothing, which leaves them out of the choice.
    function _pick(bool under, uint256 adding) private view returns (address best) {
        uint256 n = _assets.length;
        uint256[] memory values = new uint256[](n);
        uint256 total = adding;
        for (uint256 i; i < n; ++i) {
            address asset = _assets[i];
            (uint256 priceE8,,) = guard.valuationPrice(asset);
            values[i] = _value(asset, IERC20(asset).balanceOf(address(this)), priceE8);
            total += values[i];
        }
        uint256 widest;
        if (under) best = _assets[0];
        for (uint256 i; i < n; ++i) {
            uint256 target = Math.mulDiv(total, _weights[i], BPS);
            if (under) {
                uint256 short = target > values[i] ? target - values[i] : 0;
                if (short > widest) (widest, best) = (short, _assets[i]);
            } else if (values[i] != 0) {
                uint256 over = values[i] > target ? values[i] - target : 0;
                if (best == address(0) || over > widest) (widest, best) = (over, _assets[i]);
            }
        }
    }

    function _ensurePolicy() private {
        if (_policySet) return;
        uint256 n = _assets.length;
        bool[] memory yes = new bool[](n);
        for (uint256 i; i < n; ++i) {
            yes[i] = true;
        }
        router.setPolicy(address(this), SLIPPAGE_BPS, _assets, yes);
        router.setSalePolicy(address(this), _assets, yes);
        _policySet = true;
    }

    function _value(address asset, uint256 raw, uint256 priceE8) private view returns (uint256) {
        if (raw == 0 || priceE8 == 0) return 0;
        return Math.mulDiv(raw, priceE8, 10 ** (uint256(registry.get(asset).decimals) + 2));
    }

    function _isAsset(address asset) private view returns (bool) {
        for (uint256 i; i < _assets.length; ++i) {
            if (_assets[i] == asset) return true;
        }
        return false;
    }
}
