// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStaking} from "./interfaces/IStaking.sol";

/// First-loss capital for the collateralized lane, the spread that pays it, and the fee
/// rebate a staked balance earns.
///
/// The pool holds BRSR and issues shares against it. Everything a staker owns is a fraction
/// of the pool, so a slash costs every staker the same proportion without touching a single
/// account, and it costs the staker on their way out exactly as much as the one who stayed:
/// shares are burned at the pool's value at the moment of withdrawal, after the unbonding
/// period the request had to sit through.
///
/// Two units live in this contract and they are never mixed. Stake and shares are
/// eighteen-decimal BRSR. Spread is six-decimal USDG, the settlement asset. Gas is ETH and is
/// neither of them. The accumulator between the two carries thirty digits, and the
/// part of a distribution too small to divide is carried into the next one, never lost.
///
/// A slash large enough to take the whole pool is possible: a first-loss pool that cannot be
/// exhausted is not first loss. The wipe generation advances, outstanding shares stop being
/// worth anything, and stale positions are cleared the next time they are touched. Spread already accrued survives, because it
/// was earned before the loss and it is held in USDG, not in stake.
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

    // forge-lint: disable-start(screaming-snake-case-immutable)
    IERC20 public immutable stakeToken;
    IERC20 public immutable rewardToken;
    // forge-lint: disable-end

    address public admin;
    address public pendingAdmin;

    /// The credit lane, and the only party that can take stake. Held apart from `admin` so
    /// the key that covers a shortfall is not the key that sets the parameters.
    address public creditManager;

    /// Where slashed BRSR goes to be converted against the shortfall it is covering.
    address public slashSink;

    address public treasury;

    /// What a resolver has to bond to vote on a dispute, in BRSR, and the lever that answers a
    /// falling token. `OracleRegistry` reads it on registration and again on every vote, so
    /// raising it benches an underbonded resolver in the block the change lands. Zero would
    /// close bonding entirely, which is why neither the constructor nor the setter admits it.
    uint256 public minBond;

    uint256 public totalStaked;
    uint256 public totalShares;
    uint256 public accRewardPerShare;
    uint256 public rewardResidual;
    uint256 public rewardsBacked;
    uint256 public unallocatedRewards;

    uint64 public unbondingPeriod;
    uint32 public wipeEpoch;

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
        // Set at construction, because the dispute layer is wired to this floor and a zero one
        // bars every resolver from bonding at all. A
        // deployment that admitted zero would ship a dispute layer nobody could join for two
        // days.
        if (minBond_ == 0) revert ZeroAmount();

        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
        admin = admin_;
        slashSink = slashSink_;
        treasury = treasury_;
        unbondingPeriod = unbondingPeriod_;
        minBond = minBond_;

        emit AdminTransferred(address(0), admin_);
        emit SlashSinkUpdated(slashSink_);
        emit TreasuryUpdated(treasury_);
        emit UnbondingPeriodUpdated(unbondingPeriod_);
        emit MinBondUpdated(minBond_);
    }

    function stake(uint256 amount) external whenNotPaused nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();

        Position storage position = _settle(msg.sender);

        uint256 credited = _pull(stakeToken, amount);
        shares = _sharesFor(credited);
        // A deposit too small to buy a share at the current price would otherwise be a
        // donation to everyone else.
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
        if (position.unbondingShares != 0) revert UnbondAlreadyRequested();
        if (shares > position.shares) revert InsufficientShares();

        position.unbondingShares = shares;
        position.unbondingAt = uint64(block.timestamp);

        emit UnbondRequested(msg.sender, shares, uint64(block.timestamp) + unbondingPeriod);
    }

    function cancelUnbond() external {
        Position storage position = _settle(msg.sender);
        uint256 shares = position.unbondingShares;
        if (shares == 0) revert UnbondNotRequested();

        position.unbondingShares = 0;
        position.unbondingAt = 0;

        emit UnbondCancelled(msg.sender, shares);
    }

    /// Closed while paused, unlike the agent registry's matured withdrawal. The difference is
    /// what the capital is for: an agent's stake is its own collateral, and this is cover for
    /// somebody else's default. The brake exists precisely to hold it in place while a
    /// shortfall is being measured.
    function completeUnbond() external whenNotPaused nonReentrant returns (uint256 amount) {
        Position storage position = _settle(msg.sender);

        uint256 shares = position.unbondingShares;
        if (shares == 0) revert UnbondNotRequested();
        if (block.timestamp < uint256(position.unbondingAt) + unbondingPeriod) revert UnbondNotMatured();

        // Priced before the pool totals move, and rounded down, so the exit can never take
        // more than its share of what is actually held.
        amount = _stakeFor(shares);

        position.shares -= shares;
        position.unbondingShares = 0;
        position.unbondingAt = 0;
        totalShares -= shares;
        totalStaked -= amount;
        position.rewardDebt = _accrued(position.shares, accRewardPerShare);

        if (amount != 0) stakeToken.safeTransfer(msg.sender, amount);

        emit UnbondCompleted(msg.sender, shares, amount);
    }

    /// Open while paused. Spread already earned is not first-loss capital and holding it back
    /// would punish stakers for a loss the brake was pulled over.
    function claimRewards() external nonReentrant returns (uint256 amount) {
        Position storage position = _settle(msg.sender);

        uint256 owed = position.rewards;
        if (owed == 0) revert NothingToClaim();

        // A claim pays at most what distributions have actually set aside for shares. The
        // accumulator rounds once per distribution and a claim rounds once over the sum of
        // them, so a run of distributions can leave a claimant entitled to a micro-dollar or
        // two more than was divided. Paying it out of somebody else's spread is how a pool
        // like this ends up short for whoever claims last; the remainder stays owed and the
        // next distribution covers it.
        uint256 backed = rewardsBacked;
        amount = owed > backed ? backed : owed;
        if (amount == 0) revert NothingToClaim();

        position.rewards = owed - amount;
        rewardsBacked = backed - amount;
        rewardToken.safeTransfer(msg.sender, amount);

        emit RewardsClaimed(msg.sender, amount);
    }

    /// The credit lane is the only party that pays the spread, so it is the only party that can
    /// post one. Leaving this open let any address move the accumulator that prices every
    /// staker's claim and emit `RewardsDistributed` for the price of a micro-dollar, which is a
    /// receipt a token page would read as protocol revenue reaching stakers.
    ///
    /// `creditManager` is unset in the live deployment, so nothing can call this. That is the
    /// true state of the collateralized lane, not a configuration step left undone: no
    /// contract in this repository opens, prices or liquidates agent credit, and until one
    /// exists there is no spread to pay.
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
        uint256 perShare = (pot * REWARD_PRECISION) / shares;
        uint256 divided = _accrued(shares, perShare);

        accRewardPerShare += perShare;
        rewardsBacked += divided;
        rewardResidual = pot - divided;

        emit RewardsDistributed(msg.sender, credited, perShare);
    }

    function compound(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        // With nothing staked there are no shares to raise the value of, and the BRSR would
        // sit here until the next depositor took all of it.
        if (totalShares == 0) revert NothingStaked();

        uint256 credited = _pull(stakeToken, amount);
        totalStaked += credited;

        emit Compounded(msg.sender, credited, totalStaked);
    }

    function slash(uint256 amount, bytes32 reason) external nonReentrant returns (uint256 taken) {
        if (msg.sender != creditManager) revert NotCreditManager();
        if (amount == 0) revert ZeroAmount();

        uint256 staked = totalStaked;
        if (staked == 0) revert NothingStaked();

        // Caps at the pool instead of reverting. The credit lane is covering a shortfall it
        // has already measured, and a pool that cannot pay all of it still pays what it has.
        taken = amount > staked ? staked : amount;
        uint256 remaining = staked - taken;
        totalStaked = remaining;

        if (remaining == 0) {
            uint32 epoch = wipeEpoch;
            uint256 wiped = totalShares;
            _wipeAcc[epoch] = accRewardPerShare;
            wipeEpoch = epoch + 1;
            totalShares = 0;
            emit PoolWiped(epoch, wiped);
        }

        stakeToken.safeTransfer(slashSink, taken);

        emit Slashed(reason, taken, remaining);
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

    function setMinBond(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ZeroAmount();
        minBond = amount;
        emit MinBondUpdated(amount);
    }

    /// Zero returns the resolver to the global floor.
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
        creditManager = account;
        emit CreditManagerUpdated(account);
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
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    function rebateBpsOf(address account) external view returns (uint16) {
        uint256 value = activeStakeOf(account);
        if (value == 0) return 0;

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
        uint256 required = minBondOf(resolver);
        return required != 0 && amount >= required;
    }

    function positionOf(address account) external view returns (Position memory) {
        return _positions[account];
    }

    function stakedValueOf(address account) public view returns (uint256) {
        Position storage position = _positions[account];
        if (position.epoch != wipeEpoch) return 0;
        return _stakeFor(position.shares);
    }

    function activeStakeOf(address account) public view returns (uint256) {
        Position storage position = _positions[account];
        if (position.epoch != wipeEpoch) return 0;
        return _stakeFor(position.shares - position.unbondingShares);
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

        uint256 lost = position.shares;
        position.shares = 0;
        position.unbondingShares = 0;
        position.unbondingAt = 0;
        position.rewardDebt = 0;
        position.epoch = epoch;

        if (lost != 0) emit StakeWiped(account, epoch, lost);
    }

    /// Credits what arrived, not what was asked for. Neither BRSR nor USDG takes
    /// a fee on transfer, and a pool whose books can drift from its balance is worth the two
    /// extra reads anyway: the last staker out is the one who would discover it.
    function _pull(IERC20 token, uint256 amount) private returns (uint256 credited) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        credited = token.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();
    }

    function _sharesFor(uint256 amount) private view returns (uint256) {
        return (amount * (totalShares + VIRTUAL_SHARES)) / (totalStaked + VIRTUAL_STAKE);
    }

    function _stakeFor(uint256 shares) private view returns (uint256) {
        return (shares * (totalStaked + VIRTUAL_STAKE)) / (totalShares + VIRTUAL_SHARES);
    }

    function _accrued(uint256 shares, uint256 acc) private pure returns (uint256) {
        return (shares * acc) / REWARD_PRECISION;
    }
}
