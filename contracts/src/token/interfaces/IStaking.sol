// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Staked BRSR underwrites agent credit and is paid the spread the credit lane charges.
///
/// A staker here is taking a position, not making a deposit. When a borrower in the
/// collateralized lane defaults past their own collateral, the slasher takes cover for the
/// shortfall out of this pool before anyone else pays, never more than `slashCapBps` of the
/// pool at a time and with that allowance refilling over `slashWindow`, and the lender carries
/// whatever the cap leaves. Every staker's claim falls by the same proportion when that
/// happens, whatever they were doing at the time. There is no rate, no term, and no guarantee
/// that a stake comes back whole.
///
/// Four properties do the work.
///
/// Claims are held as shares. A share is a fraction of whatever BRSR the pool holds, so a
/// loss lands on everyone at once and needs no per-account bookkeeping to do it.
///
/// Exit is a three-step: request, wait out the unbonding period, then complete before the
/// request lapses. The request moves the stake out of the earning pool at its value that
/// block: from then on it earns no spread and no compounds, and it keeps taking every loss
/// until it completes, so leaving ahead of a loss the capital was already exposed to buys
/// nothing. The period exists to outlast the gap between a default happening and the
/// shortfall being measured, and the guardian brake holds exits while that measurement is
/// running, for at most `maxExitHold`: a pause is an outage, never a freeze.
///
/// Losses arrive at a bounded rate. Only the slasher can take stake, never more than
/// `slashCapBps` of the pool at once, and the allowance a slash uses grows back evenly over
/// `slashWindow`.
///
/// Spread rewards accrue per share and are pulled, never pushed. The spread arrives in USDG
/// at six decimals and the shares it divides are eighteen-decimal BRSR, so the accumulator
/// carries thirty digits of precision and the remainder of every division is carried into the
/// next distribution instead of being dropped.
interface IStaking {
    error NotAdmin();
    error NotPendingAdmin();
    error NotCreditManager();
    error NotSlasher();
    error ZeroAddress();
    error ZeroAmount();
    error SameToken();
    error BadConfig();
    error DustAmount();
    error NothingStaked();
    error PoolCollapsed();
    error InsufficientShares();
    error UnbondAlreadyRequested();
    error UnbondNotRequested();
    error UnbondNotMatured();
    error UnbondLapsed(uint64 lapsedAt);
    error ExitsHeld(uint64 until);
    error NothingToClaim();

    /// `shares` earn the spread and every compound. `unbondingShares` are the account's claim
    /// on the stake its exit request moved out of the earning pool; they earn neither and lose
    /// with everyone else.
    ///
    /// `epoch` is the wipe generation the position was last touched in. A position from an
    /// earlier generation held shares in a pool that was slashed to nothing, so its shares
    /// are worth zero and are cleared the next time it is read for writing. Rewards already
    /// accrued survive that, because they were earned before the loss and are held in USDG,
    /// not in stake.
    ///
    /// `unbondingAt` is when the exit was requested, not when it matures. Maturity and lapse
    /// are derived from the live `unbondingPeriod` and `unbondWindow`, so a pending request
    /// carries no frozen parameter. `heldAtRequest` is how long pauses had held exits when the
    /// request was filed; any hold since then is added to the request's window.
    struct Position {
        uint256 shares;
        uint256 unbondingShares;
        uint256 rewardDebt;
        uint256 rewards;
        uint64 unbondingAt;
        uint64 heldAtRequest;
        uint32 epoch;
    }

    /// A staked balance at or above `minStake` takes `rebateBps` off the facilitator fee on
    /// that party's settlements. Tiers are ordered ascending and read from the top down.
    struct Tier {
        uint256 minStake;
        uint16 rebateBps;
    }

    event Staked(address indexed staker, uint256 amount, uint256 shares);
    event UnbondRequested(address indexed staker, uint256 shares, uint256 amount, uint64 maturesAt);
    event UnbondCancelled(address indexed staker, uint256 amount, uint256 shares);
    event UnbondCompleted(address indexed staker, uint256 unbondingShares, uint256 amount);
    event RewardsDistributed(address indexed from, uint256 amount, uint256 perShare);
    event RewardsUnallocated(address indexed from, uint256 amount);
    event RewardsClaimed(address indexed staker, uint256 amount);
    event UnallocatedSwept(address indexed to, uint256 amount);
    event Compounded(address indexed from, uint256 amount, uint256 totalStaked);
    event Slashed(uint256 requested, uint256 taken, uint256 remaining);
    event PoolWiped(uint32 indexed epoch, uint256 shares);
    event StakeWiped(address indexed staker, uint32 indexed epoch, uint256 shares, uint256 unbondingShares);
    event TiersUpdated(Tier[] tiers);
    event UnbondingPeriodUpdated(uint64 period);
    event UnbondWindowUpdated(uint64 window);
    event MaxExitHoldUpdated(uint64 hold);
    event SlashLimitUpdated(uint16 capBps, uint64 window);
    event MinBondUpdated(uint256 amount);
    event BondFloorUpdated(address indexed resolver, uint256 amount);
    event BondingDeniedUpdated(address indexed resolver, bool denied);
    event CreditManagerUpdated(address indexed account);
    event SlasherUpdated(address indexed account);
    event SlashSinkUpdated(address indexed account);
    event TreasuryUpdated(address indexed account);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    /// Pulls `amount` BRSR and mints shares against it at the pool's current value. Reverts
    /// while paused: new first-loss capital must not arrive on top of a loss being measured.
    /// Reverts too while a share is worth less than a millionth of what it was issued at,
    /// because a deposit there would mint shares by the billion per wei.
    function stake(uint256 amount) external returns (uint256 shares);

    /// Step one of three. Moves `shares` out of the earning pool at their value now and starts
    /// the unbonding clock. From this block the stake earns no spread and no compounds, and it
    /// keeps taking losses until the exit completes. A lapsed request is put back to work
    /// first, so the same call files it again.
    function requestUnbond(uint256 shares) external;

    /// Step two, the exit. Pays the request's value now: what the shares were worth when the
    /// request was filed, less every slash since. Open from maturity until the request lapses
    /// `unbondWindow` later, a window that grows by any time a pause spends holding exits.
    function completeUnbond() external returns (uint256 amount);

    /// Step two, the other way. Puts the request's stake back into the earning pool at the
    /// current share price, lapsed or not. Compounds that landed while it was out stay with
    /// the stakers who earned them, so it comes back as fewer shares than it left as.
    function cancelUnbond() external;

    /// Pays out the spread the caller has accrued. Pulled rather than pushed so one staker
    /// that cannot receive USDG cannot hold up a distribution for everyone else.
    ///
    /// Pays what has been divided across shares. If rounding leaves a claimant owed a shade
    /// more than that, the remainder stays owed and the next distribution settles it.
    function claimRewards() external returns (uint256 amount);

    /// Posts credit-lane spread, in USDG, to be divided across the earning shares. The
    /// remainder of the division is carried, not discarded, so a sequence of distributions
    /// pays out what it took in down to the last micro-dollar.
    ///
    /// With nothing earning there is nobody to divide it between, so the amount is parked for
    /// the treasury instead of reverting. A revert here would fail the settlement that was
    /// trying to pay the spread.
    ///
    /// Callable only by the credit manager, the component that charges the spread. It cannot
    /// slash; that is the slasher's.
    function distribute(uint256 amount) external;

    /// Adds BRSR to the earning pool without minting shares, which raises what every earning
    /// share is worth. Exit requests do not share in it. This is where bought-back BRSR lands.
    function compound(uint256 amount) external;

    /// Covers a credit-lane shortfall out of the stake. `loss` is in BRSR wei, the stake token,
    /// not USDG: the caller converts its shortfall before it calls.
    ///
    /// Callable only by the slasher. Takes the smaller of `loss` and `slashAllowance()`, from
    /// every earning share and every pending exit in the same proportion, and sends it to the
    /// slash sink for conversion. The lender carries whatever is not taken. Never reverts for
    /// an empty pool, a zero `loss` or a spent allowance, so a write-off cannot fail on the
    /// pool's state; it returns zero instead.
    ///
    /// A slash that would leave less than a thousandth of the pool takes the rest with it and
    /// wipes the pool. That is only reachable with the cap raised close to the whole pool.
    function slash(uint256 loss) external returns (uint256 taken);

    /// Sends spread that reached no staker to the treasury. Permissionless: nothing about it
    /// is discretionary.
    function sweepUnallocated() external returns (uint256 amount);

    function setTiers(Tier[] calldata tiers) external;
    function setUnbondingPeriod(uint64 period) external;
    function setUnbondWindow(uint64 window) external;
    function setMaxExitHold(uint64 hold) external;
    function setSlashLimit(uint16 capBps, uint64 window) external;
    function setMinBond(uint256 amount) external;
    function setBondFloor(address resolver, uint256 amount) external;
    function setBondingDenied(address resolver, bool denied) external;
    function setCreditManager(address account) external;
    function setSlasher(address account) external;
    function setSlashSink(address account) external;
    function setTreasury(address account) external;
    function transferAdmin(address to) external;
    function acceptAdmin() external;
    function pause() external;
    function unpause() external;

    /// Basis points off the facilitator fee for this party, from the tier its earning stake
    /// reaches. Stake committed to an exit is excluded: a discount for alignment should not
    /// outlive the alignment. Read in the staker's favour by at most one share, so a stake of
    /// exactly a tier's amount reads that tier whatever the share price.
    function rebateBpsOf(address account) external view returns (uint16);

    /// BRSR a resolver has to bond to vote on disputes: the resolver's own floor if governance
    /// set one, the global `minBond` otherwise. The resolver's floor replaces the global one
    /// rather than adding to it, so it stays the requirement for that resolver even after
    /// `setMinBond` moves the global figure past it. It is the lever for a resolver that has
    /// been slashed before. `OracleRegistry` reads this on registration and again on every vote.
    function minBondOf(address resolver) external view returns (uint256);

    /// Whether `amount` would be an acceptable bond from `resolver` right now. False for a
    /// resolver governance has barred, whatever they are willing to post.
    function isBondable(address resolver, uint256 amount) external view returns (bool);

    function positionOf(address account) external view returns (Position memory);

    /// BRSR the account holds in the pool at its current value, a pending exit included. Zero
    /// once a slash has taken the whole pool.
    function stakedValueOf(address account) external view returns (uint256);

    /// The same figure for the earning shares alone. This is what the tiers are read against.
    function activeStakeOf(address account) external view returns (uint256);

    /// What the account's exit request would pay now, when it matures and when it lapses. All
    /// zero with no request pending.
    function unbondOf(address account) external view returns (uint256 amount, uint64 maturesAt, uint64 lapsesAt);

    /// BRSR the slasher can take in this block: the part of `slashCapBps` of the pool that
    /// recent slashes have not used, which grows back at the cap's rate over `slashWindow`.
    function slashAllowance() external view returns (uint256);

    function sharesOf(address account) external view returns (uint256);
    function pendingRewards(address account) external view returns (uint256);
    function previewStake(uint256 amount) external view returns (uint256 shares);
    function previewUnbond(uint256 shares) external view returns (uint256 amount);
    function tiers() external view returns (Tier[] memory);

    function stakeToken() external view returns (IERC20);
    function rewardToken() external view returns (IERC20);

    /// Every BRSR the pool holds for stakers: the earning pool and the exit requests together.
    function totalStaked() external view returns (uint256);

    /// Earning shares. Stake behind a pending exit is counted in `unbondingStaked`, not here.
    function totalShares() external view returns (uint256);

    function unbondingStaked() external view returns (uint256);
    function totalUnbondingShares() external view returns (uint256);
    function accRewardPerShare() external view returns (uint256);

    /// Spread taken in that was too small to divide across the shares outstanding. It is added
    /// to the next distribution.
    function rewardResidual() external view returns (uint256);

    /// USDG divided across shares and not yet claimed. Claims are capped by it, which is what
    /// keeps the rounding in the accumulator from letting early claimants take a micro-dollar
    /// of the spread the late ones are owed.
    ///
    /// Holding this contract's USDG balance to account:
    /// `balance == rewardsBacked + rewardResidual + unallocatedRewards`.
    function rewardsBacked() external view returns (uint256);

    function unallocatedRewards() external view returns (uint256);
    function unbondingPeriod() external view returns (uint64);
    function unbondWindow() external view returns (uint64);
    function maxExitHold() external view returns (uint64);

    /// When the current pause stops holding exits. Zero while unpaused.
    function exitsHeldUntil() external view returns (uint64);

    function slashCapBps() external view returns (uint16);
    function slashWindow() external view returns (uint64);
    function minBond() external view returns (uint256);
    function wipeEpoch() external view returns (uint32);
    function creditManager() external view returns (address);
    function slasher() external view returns (address);
    function slashSink() external view returns (address);
    function treasury() external view returns (address);
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
}
