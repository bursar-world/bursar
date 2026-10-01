// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStaking} from "./interfaces/IStaking.sol";

/// Staked BRSR behind the collateral lane: it earns the credit pool's spread and is slashed
/// when the pool writes off a line. A staked balance also earns a fee rebate.
///
/// The pool holds BRSR and issues shares against it. Everything a staker owns is a fraction
/// of the pool, so a slash costs every staker the same proportion without touching a single
/// account. An exit request moves its stake into a second pool that earns nothing and loses
/// alongside the first, so the staker on their way out pays for a loss exactly as much as the
/// one who stayed, and stops collecting the moment they ask to leave.
///
/// Two units live in this contract and they are never mixed. Stake and shares are
/// eighteen-decimal BRSR. Spread is six-decimal USDG, the settlement asset. Gas is ETH and is
/// neither of them. The accumulator between the two carries thirty digits, and the
/// part of a distribution too small to divide is carried into the next one, never lost.
///
/// The slasher takes stake when a line is written off, at most `slashCapBps` of the pool at a
/// time and at the rate the cap refills over `slashWindow`. The BRSR goes to the slash sink;
/// the lender carries the whole USDG loss either way. With the cap raised to the whole pool a
/// single slash can take all of it: the wipe generation advances, outstanding shares stop
/// being worth anything, and stale positions are cleared the next time they are touched.
/// Spread already accrued survives, because it was earned before the loss and it is held in
/// USDG, not in stake.
contract Staking is IStaking, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// The facilitator fee has a floor at the measured gas cost of a settlement. A
    /// rebate that could take the whole fee would put the facilitator underwater on every
    /// call the largest holder makes.
    uint16 public constant MAX_REBATE_BPS = 5_000;

    uint256 private constant MAX_TIERS = 8;

    /// Has to outlast the gap between a borrower defaulting and the shortfall being measured,
    /// or the exit queue becomes a way to read the news before the pool does.
    uint64 public constant MIN_UNBONDING_PERIOD = 7 days;
    uint64 public constant MAX_UNBONDING_PERIOD = 90 days;

    /// How long a matured request stays open. Long enough to act on, short enough that one
    /// request cannot be held as a standing option to leave in the block a loss is announced.
    uint64 public constant MIN_UNBOND_WINDOW = 1 days;
    uint64 public constant MAX_UNBOND_WINDOW = 30 days;

    /// How far into a pause matured exits stay closed.
    uint64 public constant MIN_EXIT_HOLD = 1 days;
    uint64 public constant MAX_EXIT_HOLD = 30 days;

    uint64 public constant MIN_SLASH_WINDOW = 1 days;
    uint64 public constant MAX_SLASH_WINDOW = 90 days;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    /// Spread is six-decimal USDG divided across eighteen-decimal shares. Thirty digits keeps
    /// the per-share figure meaningful at a pool size of the entire supply and a distribution
    /// of a single micro-dollar, and leaves the largest product this contract computes,
    /// shares times the accumulator, five orders of magnitude short of overflowing.
    uint256 private constant REWARD_PRECISION = 1e30;

    /// The pool is quoted against one extra unit of stake and a thousand extra shares that
    /// nobody owns. It prices the first share sensibly and it makes the donation attack on an
    /// empty pool cost a thousand times what it could take, which is the standard defence and
    /// the reason `compound` can be left open to anyone.
    uint256 private constant VIRTUAL_SHARES = 1e3;
    uint256 private constant VIRTUAL_STAKE = 1;

    /// A slash that would leave less than a thousandth of the pool takes the rest as well. The
    /// remainder is worth nothing to the stakers who just lost the other 99.9%, and left in place
    /// it would price the next deposit's shares against a few wei.
    uint256 private constant DUST_RATIO = 1e3;

    /// Shares are issued at a thousand per wei. Past a billion per wei, a millionth of that
    /// price, the pool takes no new stake: every deposit would mint shares by the billion and
    /// the spread would divide into nothing.
    uint256 private constant MAX_SHARES_PER_WEI = 1e9;

    // forge-lint: disable-start(screaming-snake-case-immutable)
    IERC20 public immutable stakeToken;
    IERC20 public immutable rewardToken;
    // forge-lint: disable-end

    address public admin;
    address public pendingAdmin;

    /// The credit pool, and the only party that can pay the spread in.
    address public creditManager;

    /// The only party that can take stake, and only as fast as the slash cap allows. Held apart
    /// from `admin` so the key that sets the parameters cannot also take stake.
    address public slasher;

    /// Where slashed BRSR goes. None of it returns to the lender.
    address public slashSink;

    address public treasury;

    /// What a resolver has to bond to vote on a dispute, in BRSR, and the lever that answers a
    /// falling token. `OracleRegistry` reads it on registration and again on every vote, so
    /// raising it benches an underbonded resolver in the block the change lands, except one
    /// governance has given a floor of its own. Zero would admit a one-wei bond, which is why
    /// neither the constructor nor the setter accepts it.
    uint256 public minBond;

    uint256 public totalStaked;
    uint256 public totalShares;

    /// The stake behind pending exit requests, part of `totalStaked`, and the claims on it.
    uint256 public unbondingStaked;
    uint256 public totalUnbondingShares;

    uint256 public accRewardPerShare;
    uint256 public rewardResidual;
    uint256 public rewardsBacked;
    uint256 public unallocatedRewards;

    uint64 public unbondingPeriod;
    uint64 public unbondWindow;
    uint64 public maxExitHold;
    uint64 public exitsHeldUntil;
    uint64 public slashWindow;
    uint16 public slashCapBps;
    uint32 public wipeEpoch;

    uint64 private _pausedAt;

    /// Seconds exits have spent held by pauses that have since lifted. A request's window grows
    /// by whatever this adds while it is pending, so a pause never costs a staker the request it
    /// was holding.
    uint64 private _heldBefore;

    /// The fraction of the pool recent slashes have used, in WAD, and when it was last brought
    /// up to date. It drains at the cap's rate over `slashWindow`.
    uint128 private _slashLoad;
    uint64 private _slashLoadAt;

    mapping(address resolver => uint256 floor) private _bondFloor;
    mapping(address resolver => bool denied) public bondingDenied;

    mapping(address staker => Position position) private _positions;

    /// The accumulator as it stood when each generation of the pool was wiped out. A position
    /// left behind in that generation is owed what it had accrued up to that point and
    /// nothing that was distributed after it.
    mapping(uint32 epoch => uint256 acc) private _wipeAcc;

    Tier[] private _tiers;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        IERC20 stakeToken_,
        IERC20 rewardToken_,
        address admin_,
        address slashSink_,
        address treasury_,
        uint64 unbondingPeriod_,
        uint256 minBond_
    ) {
        if (
            address(stakeToken_) == address(0) || address(rewardToken_) == address(0) || admin_ == address(0)
                || slashSink_ == address(0) || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        // One token in both roles would let a distribution be counted as stake and a slash
        // pay out as spread.
        if (address(stakeToken_) == address(rewardToken_)) revert SameToken();
        if (unbondingPeriod_ < MIN_UNBONDING_PERIOD || unbondingPeriod_ > MAX_UNBONDING_PERIOD) revert BadConfig();
        if (minBond_ == 0) revert ZeroAmount();

        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
        admin = admin_;
        slashSink = slashSink_;
        treasury = treasury_;
        unbondingPeriod = unbondingPeriod_;
        minBond = minBond_;

        // A week for each: to complete a matured exit, to hold exits into a pause, and for the
        // slash allowance to refill. No single slash takes more than a tenth of the pool.
        unbondWindow = 7 days;
        maxExitHold = 7 days;
        slashCapBps = 1_000;
        slashWindow = 7 days;

        emit AdminTransferred(address(0), admin_);
        emit SlashSinkUpdated(slashSink_);
        emit TreasuryUpdated(treasury_);
        emit UnbondingPeriodUpdated(unbondingPeriod_);
        emit UnbondWindowUpdated(7 days);
        emit MaxExitHoldUpdated(7 days);
        emit SlashLimitUpdated(1_000, 7 days);
        emit MinBondUpdated(minBond_);
    }

    function stake(uint256 amount) external whenNotPaused nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        if (_collapsed()) revert PoolCollapsed();

        Position storage position = _settle(msg.sender);

        uint256 credited = _pull(stakeToken, amount);
        shares = _sharesFor(credited);
        // A deposit too small to buy a share at the current price would otherwise be a
        // donation to everyone else.
        // slither-disable-next-line incorrect-equality
        if (shares == 0) revert DustAmount();

        totalStaked += credited;
        totalShares += shares;
        position.shares += shares;
        position.rewardDebt = _accrued(position.shares, accRewardPerShare);

        emit Staked(msg.sender, credited, shares);
    }

    function requestUnbond(uint256 shares) external {
        if (shares == 0) revert ZeroAmount();

        Position storage position = _settle(msg.sender);
        if (position.unbondingShares != 0) {
            if (block.timestamp < _lapsesAt(position)) revert UnbondAlreadyRequested();
            _returnToPool(msg.sender, position);
        }
        if (shares > position.shares) revert InsufficientShares();

        // Priced now and rounded down, like any exit. From this block the stake earns nothing,
        // and the unbonding pool it moves into takes its share of every slash.
        uint256 amount = _stakeFor(shares);
        uint256 claim = _unbondingSharesFor(amount);
        // The same refusal for an exit too small to hold one claim on the unbonding pool.
        // slither-disable-next-line incorrect-equality
        if (claim == 0) revert DustAmount();

        totalShares -= shares;
        position.shares -= shares;
        position.rewardDebt = _accrued(position.shares, accRewardPerShare);

        unbondingStaked += amount;
        totalUnbondingShares += claim;
        position.unbondingShares = claim;
        position.unbondingAt = uint64(block.timestamp);
        position.heldAtRequest = _heldSoFar();

        emit UnbondRequested(msg.sender, shares, amount, uint64(block.timestamp) + unbondingPeriod);
    }

    function cancelUnbond() external {
        Position storage position = _settle(msg.sender);
        if (position.unbondingShares == 0) revert UnbondNotRequested();

        _returnToPool(msg.sender, position);
    }

    /// Closed while paused, unlike the agent registry's matured withdrawal, but only for
    /// `maxExitHold` into the pause. The difference is what the capital is for: an agent's
    /// stake is its own collateral, and this one is slashed for somebody else's default. The
    /// brake exists to hold it in place while a shortfall is being measured, and a measurement
    /// that has not finished in that time is not one the stakers can be made to wait on forever.
    function completeUnbond() external nonReentrant returns (uint256 amount) {
        uint64 heldUntil = exitsHeldUntil;
        if (block.timestamp < heldUntil) revert ExitsHeld(heldUntil);

        Position storage position = _settle(msg.sender);

        uint256 claim = position.unbondingShares;
        if (claim == 0) revert UnbondNotRequested();
        if (block.timestamp < uint256(position.unbondingAt) + unbondingPeriod) revert UnbondNotMatured();
        uint256 lapsesAt = _lapsesAt(position);
        // forge-lint: disable-next-line(unsafe-typecast)
        if (block.timestamp >= lapsesAt) revert UnbondLapsed(uint64(lapsesAt));

        // Rounded down, so the exit can never take more than its share of what the unbonding
        // pool holds.
        amount = _unbondingValue(claim);

        unbondingStaked -= amount;
        totalUnbondingShares -= claim;
        totalStaked -= amount;
        _clearRequest(position);

        if (amount != 0) stakeToken.safeTransfer(msg.sender, amount);

        emit UnbondCompleted(msg.sender, claim, amount);
    }

    /// Open while paused. Spread already earned cannot be slashed, and holding it back would
    /// punish stakers for a loss the brake was pulled over.
    function claimRewards() external nonReentrant returns (uint256 amount) {
        Position storage position = _settle(msg.sender);

        uint256 owed = position.rewards;
        if (owed == 0) revert NothingToClaim();

        // A claim pays at most what distributions have set aside for shares. The accumulator
        // rounds once per distribution and a claim rounds once over the sum of them, so a run
        // of distributions can leave a claimant entitled to a micro-dollar or two more than was
        // divided. Paying it out of somebody else's spread is how a pool like this ends up
        // short for whoever claims last; the remainder stays owed and the next distribution
        // covers it.
        uint256 backed = rewardsBacked;
        amount = owed > backed ? backed : owed;
        if (amount == 0) revert NothingToClaim();

        position.rewards = owed - amount;
        rewardsBacked = backed - amount;
        rewardToken.safeTransfer(msg.sender, amount);

        emit RewardsClaimed(msg.sender, amount);
    }

    /// The credit lane is the only party that pays the spread, so it is the only party that can
    /// post one. Left open, this would let any address move the accumulator that prices every
    /// staker's claim and emit `RewardsDistributed` for the price of a micro-dollar, which is a
    /// receipt a token page would read as protocol revenue reaching stakers.
    ///
    /// Nothing can call this until governance names the credit lane's pool as `creditManager`.
    function distribute(uint256 amount) external nonReentrant {
        if (msg.sender != creditManager) revert NotCreditManager();
        if (amount == 0) revert ZeroAmount();

        uint256 credited = _pull(rewardToken, amount);

        uint256 shares = totalShares;
        if (shares == 0) {
            unallocatedRewards += credited;
            emit RewardsUnallocated(msg.sender, credited);
            return;
        }

        // The carry from the last division goes back in first, so a stream of distributions
        // too small to move the accumulator on their own still reaches the stakers once they
        // add up to a share's worth.
        uint256 pot = credited + rewardResidual;
        uint256 perShare = Math.mulDiv(pot, REWARD_PRECISION, shares);
        uint256 divided = _accrued(shares, perShare);

        accRewardPerShare += perShare;
        rewardsBacked += divided;
        rewardResidual = pot - divided;

        emit RewardsDistributed(msg.sender, credited, perShare);
    }

    function compound(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        // With nothing earning there are no shares to raise the value of, and the BRSR would
        // sit here until the next depositor took all of it.
        if (totalShares == 0) revert NothingStaked();

        uint256 credited = _pull(stakeToken, amount);
        totalStaked += credited;

        emit Compounded(msg.sender, credited, totalStaked);
    }

    function slash(uint256 loss) external nonReentrant returns (uint256 taken) {
        if (msg.sender != slasher) revert NotSlasher();

        uint256 staked = totalStaked;
        uint256 load = _slashLoadNow();
        uint256 cap = _slashCap();
        // An empty pool or a spent allowance slashes nothing. It is not a reason for the
        // write-off that called this to fail.
        if (loss == 0 || staked == 0 || load >= cap) return 0;

        taken = Math.min(loss, Math.mulDiv(staked, cap - load, WAD));
        // The allowance left rounds to nothing.
        // slither-disable-next-line incorrect-equality
        if (taken == 0) return 0;

        uint256 remaining = staked - taken;
        if (remaining * DUST_RATIO < staked) {
            taken = staked;
            remaining = 0;
        }

        // Charged as a fraction of the pool it hit and rounded up, so a run of small slashes
        // cannot add up to more than the cap between them.
        // forge-lint: disable-next-line(unsafe-typecast)
        _slashLoad = uint128(load + Math.mulDiv(taken, WAD, staked, Math.Rounding.Ceil));
        _slashLoadAt = uint64(block.timestamp);

        // Zero only when the slash took the whole pool, by subtraction or by the dust rule above.
        // slither-disable-next-line incorrect-equality
        if (remaining == 0) {
            _wipe();
        } else {
            // Pro rata between the two pools, so an exit in flight loses the same fraction as
            // the stake that stayed.
            unbondingStaked -= Math.mulDiv(taken, unbondingStaked, staked);
            totalStaked = remaining;
        }

        stakeToken.safeTransfer(slashSink, taken);

        emit Slashed(loss, taken, remaining);
    }

    function sweepUnallocated() external nonReentrant returns (uint256 amount) {
        amount = unallocatedRewards;
        if (amount == 0) revert NothingToClaim();

        unallocatedRewards = 0;
        address to = treasury;
        rewardToken.safeTransfer(to, amount);

        emit UnallocatedSwept(to, amount);
    }

    /// Ascending in both columns, so the tier a balance reaches is the best one it qualifies
    /// for and reading from the top down is enough to find it.
    function setTiers(Tier[] calldata newTiers) external onlyAdmin {
        uint256 count = newTiers.length;
        if (count > MAX_TIERS) revert BadConfig();

        delete _tiers;
        for (uint256 i; i < count; ++i) {
            Tier calldata tier = newTiers[i];
            if (tier.minStake == 0) revert BadConfig();
            if (tier.rebateBps == 0 || tier.rebateBps > MAX_REBATE_BPS) revert BadConfig();
            if (i != 0 && (tier.minStake <= newTiers[i - 1].minStake || tier.rebateBps <= newTiers[i - 1].rebateBps)) {
                revert BadConfig();
            }
            _tiers.push(tier);
        }

        emit TiersUpdated(newTiers);
    }

    /// Applies to requests already pending, in both directions. A staker cannot freeze the
    /// old period by requesting an exit ahead of the change.
    function setUnbondingPeriod(uint64 period) external onlyAdmin {
        if (period < MIN_UNBONDING_PERIOD || period > MAX_UNBONDING_PERIOD) revert BadConfig();
        unbondingPeriod = period;
        emit UnbondingPeriodUpdated(period);
    }

    /// Applies to requests already pending, the same way the period does.
    function setUnbondWindow(uint64 window) external onlyAdmin {
        if (window < MIN_UNBOND_WINDOW || window > MAX_UNBOND_WINDOW) revert BadConfig();
        unbondWindow = window;
        emit UnbondWindowUpdated(window);
    }

    /// Takes effect from the next pause. The one already running keeps the hold it started
    /// with, so a proposal cannot stretch it.
    function setMaxExitHold(uint64 hold) external onlyAdmin {
        if (hold < MIN_EXIT_HOLD || hold > MAX_EXIT_HOLD) revert BadConfig();
        maxExitHold = hold;
        emit MaxExitHoldUpdated(hold);
    }

    /// The allowance recent slashes used is carried over as it stands and drains at the new
    /// rate from here, so a change can neither hand the slasher a fresh allowance nor take back
    /// what has already refilled.
    function setSlashLimit(uint16 capBps, uint64 window) external onlyAdmin {
        if (capBps == 0 || capBps > BPS || window < MIN_SLASH_WINDOW || window > MAX_SLASH_WINDOW) {
            revert BadConfig();
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        _slashLoad = uint128(_slashLoadNow());
        _slashLoadAt = uint64(block.timestamp);
        slashCapBps = capBps;
        slashWindow = window;
        emit SlashLimitUpdated(capBps, window);
    }

    function setMinBond(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ZeroAmount();
        minBond = amount;
        emit MinBondUpdated(amount);
    }

    /// Replaces the global floor for this resolver, in either direction. Zero returns the
    /// resolver to the global floor.
    function setBondFloor(address resolver, uint256 amount) external onlyAdmin {
        if (resolver == address(0)) revert ZeroAddress();
        _bondFloor[resolver] = amount;
        emit BondFloorUpdated(resolver, amount);
    }

    function setBondingDenied(address resolver, bool denied) external onlyAdmin {
        if (resolver == address(0)) revert ZeroAddress();
        bondingDenied[resolver] = denied;
        emit BondingDeniedUpdated(resolver, denied);
    }

    function setCreditManager(address account) external onlyAdmin {
        // Zero leaves nobody able to post spread, which is how a pool starts.
        // slither-disable-next-line missing-zero-check
        creditManager = account;
        emit CreditManagerUpdated(account);
    }

    /// Zero leaves nobody able to slash, which is the state a pool starts in.
    function setSlasher(address account) external onlyAdmin {
        // Zero clears the role.
        // slither-disable-next-line missing-zero-check
        slasher = account;
        emit SlasherUpdated(account);
    }

    function setSlashSink(address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        slashSink = account;
        emit SlashSinkUpdated(account);
    }

    function setTreasury(address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        treasury = account;
        emit TreasuryUpdated(account);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();

        address previous = admin;
        admin = msg.sender;
        pendingAdmin = address(0);

        emit AdminTransferred(previous, msg.sender);
    }

    function pause() external onlyAdmin {
        _pause();
        _pausedAt = uint64(block.timestamp);
        exitsHeldUntil = uint64(block.timestamp) + maxExitHold;
    }

    function unpause() external onlyAdmin {
        _heldBefore = _heldSoFar();
        _pausedAt = 0;
        exitsHeldUntil = 0;
        _unpause();
    }

    function rebateBpsOf(address account) external view returns (uint16) {
        Position storage position = _positions[account];
        if (position.epoch != wipeEpoch || position.shares == 0) return 0;

        // Read with one share more than the account holds. A deposit buys a whole number of
        // shares and the pool keeps the fraction it paid for, so once a compound has moved the
        // price off a round number a stake of exactly a tier's amount is worth a shade less
        // than the tier. The extra share gives back that fraction and never more than one
        // share's worth.
        uint256 value = _stakeFor(position.shares + 1);
        for (uint256 i = _tiers.length; i != 0; --i) {
            Tier storage tier = _tiers[i - 1];
            if (value >= tier.minStake) return tier.rebateBps;
        }
        return 0;
    }

    function minBondOf(address resolver) public view returns (uint256) {
        uint256 floor = _bondFloor[resolver];
        return floor == 0 ? minBond : floor;
    }

    function isBondable(address resolver, uint256 amount) external view returns (bool) {
        if (bondingDenied[resolver]) return false;
        return amount >= minBondOf(resolver);
    }

    function positionOf(address account) external view returns (Position memory) {
        return _positions[account];
    }

    function stakedValueOf(address account) external view returns (uint256) {
        Position storage position = _positions[account];
        if (position.epoch != wipeEpoch) return 0;
        return _stakeFor(position.shares) + _unbondingValue(position.unbondingShares);
    }

    function activeStakeOf(address account) external view returns (uint256) {
        Position storage position = _positions[account];
        if (position.epoch != wipeEpoch) return 0;
        return _stakeFor(position.shares);
    }

    function unbondOf(address account) external view returns (uint256 amount, uint64 maturesAt, uint64 lapsesAt) {
        Position storage position = _positions[account];
        if (position.epoch != wipeEpoch || position.unbondingShares == 0) return (0, 0, 0);

        amount = _unbondingValue(position.unbondingShares);
        maturesAt = position.unbondingAt + unbondingPeriod;
        // forge-lint: disable-next-line(unsafe-typecast)
        lapsesAt = uint64(_lapsesAt(position));
    }

    function slashAllowance() external view returns (uint256) {
        uint256 load = _slashLoadNow();
        uint256 cap = _slashCap();
        return load >= cap ? 0 : Math.mulDiv(totalStaked, cap - load, WAD);
    }

    function sharesOf(address account) external view returns (uint256) {
        Position storage position = _positions[account];
        return position.epoch == wipeEpoch ? position.shares : 0;
    }

    function pendingRewards(address account) external view returns (uint256) {
        Position storage position = _positions[account];
        uint256 acc = position.epoch == wipeEpoch ? accRewardPerShare : _wipeAcc[position.epoch];
        uint256 accrued = _accrued(position.shares, acc);
        uint256 owed = accrued > position.rewardDebt ? accrued - position.rewardDebt : 0;
        return position.rewards + owed;
    }

    function previewStake(uint256 amount) external view returns (uint256) {
        return _sharesFor(amount);
    }

    function previewUnbond(uint256 shares) external view returns (uint256) {
        return _stakeFor(shares);
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    function bondFloorOf(address resolver) external view returns (uint256) {
        return _bondFloor[resolver];
    }

    /// Credits every reward the position has earned and brings its debt up to date, then
    /// clears it if it belongs to a generation of the pool that was slashed to nothing.
    ///
    /// Ordering matters: the reward is settled against the accumulator as it stood when that
    /// generation ended, which is what stops a wiped position from drawing on distributions
    /// made to the stakers who came after it.
    function _settle(address account) private returns (Position storage position) {
        position = _positions[account];

        uint32 epoch = wipeEpoch;
        uint256 acc = position.epoch == epoch ? accRewardPerShare : _wipeAcc[position.epoch];
        uint256 accrued = _accrued(position.shares, acc);
        if (accrued > position.rewardDebt) position.rewards += accrued - position.rewardDebt;

        if (position.epoch == epoch) {
            position.rewardDebt = accrued;
            return position;
        }

        uint256 shares = position.shares;
        uint256 claim = position.unbondingShares;
        position.shares = 0;
        position.rewardDebt = 0;
        position.epoch = epoch;
        _clearRequest(position);

        if (shares != 0 || claim != 0) emit StakeWiped(account, epoch, shares, claim);
    }

    /// Puts a request's stake back to work at today's share price. Compounds that landed while
    /// it was out raised that price, so it buys back fewer shares than it left as and the
    /// difference stays with the stakers who earned it.
    function _returnToPool(address account, Position storage position) private {
        uint256 claim = position.unbondingShares;
        uint256 amount = _unbondingValue(claim);
        // Priced before the stake moves back, against the earning pool as it stands.
        uint256 shares = _sharesFor(amount);

        unbondingStaked -= amount;
        totalUnbondingShares -= claim;
        _clearRequest(position);

        totalShares += shares;
        position.shares += shares;
        position.rewardDebt = _accrued(position.shares, accRewardPerShare);

        emit UnbondCancelled(account, amount, shares);
    }

    function _clearRequest(Position storage position) private {
        position.unbondingShares = 0;
        position.unbondingAt = 0;
        position.heldAtRequest = 0;
    }

    function _wipe() private {
        uint32 epoch = wipeEpoch;
        uint256 wiped = totalShares;
        _wipeAcc[epoch] = accRewardPerShare;
        wipeEpoch = epoch + 1;
        totalStaked = 0;
        totalShares = 0;
        unbondingStaked = 0;
        totalUnbondingShares = 0;
        emit PoolWiped(epoch, wiped);
    }

    /// Returns what the balance gained. Neither BRSR nor USDG takes a fee on transfer, and a
    /// pool whose books can drift from its balance is worth the two extra reads anyway: the
    /// last staker out is the one who would discover it.
    function _pull(IERC20 token, uint256 amount) private returns (uint256 credited) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        credited = token.balanceOf(address(this)) - before;
        // The delta this one transfer made; a token that delivered nothing is refused.
        // slither-disable-next-line incorrect-equality
        if (credited == 0) revert ZeroAmount();
    }

    function _lapsesAt(Position storage position) private view returns (uint256) {
        return uint256(position.unbondingAt) + unbondingPeriod + unbondWindow + (_heldSoFar() - position.heldAtRequest);
    }

    /// Seconds pauses have held exits, the one running included. It stops growing when the
    /// hold ends, whether or not the pause has.
    function _heldSoFar() private view returns (uint64) {
        uint64 until = exitsHeldUntil;
        // Zero while no pause is holding exits. `unpause` writes it back.
        // slither-disable-next-line incorrect-equality
        if (until == 0) return _heldBefore;
        uint64 t = uint64(block.timestamp);
        return _heldBefore + (t < until ? t : until) - _pausedAt;
    }

    function _slashCap() private view returns (uint256) {
        return (uint256(slashCapBps) * WAD) / BPS;
    }

    function _slashLoadNow() private view returns (uint256) {
        uint256 load = _slashLoad;
        // No slash has used any allowance, so there is nothing to drain.
        // slither-disable-next-line incorrect-equality
        if (load == 0) return 0;
        uint256 drained = Math.mulDiv(_slashCap(), block.timestamp - _slashLoadAt, slashWindow);
        return load > drained ? load - drained : 0;
    }

    function _collapsed() private view returns (bool) {
        return totalShares + VIRTUAL_SHARES > MAX_SHARES_PER_WEI * (totalStaked - unbondingStaked + VIRTUAL_STAKE);
    }

    function _sharesFor(uint256 amount) private view returns (uint256) {
        return Math.mulDiv(amount, totalShares + VIRTUAL_SHARES, totalStaked - unbondingStaked + VIRTUAL_STAKE);
    }

    function _stakeFor(uint256 shares) private view returns (uint256) {
        return Math.mulDiv(shares, totalStaked - unbondingStaked + VIRTUAL_STAKE, totalShares + VIRTUAL_SHARES);
    }

    /// The unbonding pool takes no deposits and no compounds, only requests and slashes, so it
    /// needs no virtual offset: the first request in an empty one sets the price at a claim per
    /// wei, and the last claim out takes whatever is left.
    function _unbondingSharesFor(uint256 amount) private view returns (uint256) {
        uint256 supply = totalUnbondingShares;
        // An empty unbonding pool, counted in claims and not in tokens held.
        // slither-disable-next-line incorrect-equality
        return supply == 0 ? amount : Math.mulDiv(amount, supply, unbondingStaked);
    }

    function _unbondingValue(uint256 claim) private view returns (uint256) {
        uint256 supply = totalUnbondingShares;
        // An empty unbonding pool, counted in claims and not in tokens held.
        // slither-disable-next-line incorrect-equality
        return supply == 0 ? 0 : Math.mulDiv(claim, unbondingStaked, supply);
    }

    function _accrued(uint256 shares, uint256 acc) private pure returns (uint256) {
        return Math.mulDiv(shares, acc, REWARD_PRECISION);
    }
}
