// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Staked BRSR underwrites agent credit and is paid the spread the credit lane charges.
///
/// A staker here is taking a position, not making a deposit. When a borrower in the
/// collateralized lane defaults past their own collateral, this pool covers the shortfall
/// before the protocol does, and the cover is taken from the stake itself. Every staker's
/// claim falls by the same proportion when that happens, whatever they were doing at the
/// time. There is no rate, no term, and no guarantee that a stake comes back whole.
///
/// Three properties do the work.
///
/// Claims are held as shares. A share is a fraction of whatever BRSR the pool holds, so a
/// loss lands on everyone at once and needs no per-account bookkeeping to do it.
///
/// Exit is a three-step: request, wait out the unbonding period, then complete. Shares stay
/// in the pool and stay slashable for the whole wait, so leaving ahead of a loss that the
/// capital was already exposed to is not something the timing can buy. The period exists to
/// outlast the gap between a default happening and the shortfall being measured, and the
/// guardian brake stops exits outright while that measurement is running.
///
/// Spread rewards accrue per share and are pulled, never pushed. The spread arrives in USDG
/// at six decimals and the shares it divides are eighteen-decimal BRSR, so the accumulator
/// carries thirty digits of precision and the remainder of every division is carried into the
/// next distribution instead of being dropped.
interface IStaking {
    error NotAdmin();
    error NotPendingAdmin();
    error NotCreditManager();
    error ZeroAddress();
    error ZeroAmount();
    error SameToken();
    error BadConfig();
    error DustAmount();
    error NothingStaked();
    error InsufficientShares();
    error UnbondAlreadyRequested();
    error UnbondNotRequested();
    error UnbondNotMatured();
    error NothingToClaim();

    /// `epoch` is the wipe generation the position was last touched in. A position from an
    /// earlier generation held shares in a pool that was slashed to nothing, so its shares
    /// are worth zero and are cleared the next time it is read for writing. Rewards already
    /// accrued survive that, because they were earned before the loss and are held in USDG,
    /// not in stake.
    ///
    /// `unbondingAt` is when the exit was requested, not when it matures. Maturity is derived
    /// from the live `unbondingPeriod` so a pending request carries no frozen parameter.
    struct Position {
        uint256 shares;
        uint256 unbondingShares;
        uint256 rewardDebt;
        uint256 rewards;
        uint64 unbondingAt;
        uint32 epoch;
    }

    /// A staked balance at or above `minStake` takes `rebateBps` off the facilitator fee on
    /// that party's settlements. Tiers are ordered ascending and read from the top down.
    struct Tier {
        uint256 minStake;
        uint16 rebateBps;
    }

    event Staked(address indexed staker, uint256 amount, uint256 shares);
    event UnbondRequested(address indexed staker, uint256 shares, uint64 maturesAt);
    event UnbondCancelled(address indexed staker, uint256 shares);
    event UnbondCompleted(address indexed staker, uint256 shares, uint256 amount);
    event RewardsDistributed(address indexed from, uint256 amount, uint256 perShare);
    event RewardsUnallocated(address indexed from, uint256 amount);
    event RewardsClaimed(address indexed staker, uint256 amount);
    event UnallocatedSwept(address indexed to, uint256 amount);
    event Compounded(address indexed from, uint256 amount, uint256 totalStaked);
    event Slashed(bytes32 indexed reason, uint256 amount, uint256 remaining);
    event PoolWiped(uint32 indexed epoch, uint256 shares);
    event StakeWiped(address indexed staker, uint32 indexed epoch, uint256 shares);
    event TiersUpdated(Tier[] tiers);
    event UnbondingPeriodUpdated(uint64 period);
    event MinBondUpdated(uint256 amount);
    event BondFloorUpdated(address indexed resolver, uint256 amount);
    event BondingDeniedUpdated(address indexed resolver, bool denied);
    event CreditManagerUpdated(address indexed account);
    event SlashSinkUpdated(address indexed account);
    event TreasuryUpdated(address indexed account);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    /// Pulls `amount` BRSR and mints shares against it at the pool's current value. Reverts
    /// while paused: new first-loss capital must not arrive on top of a loss being measured.
    function stake(uint256 amount) external returns (uint256 shares);

    /// Step one of three. Starts the unbonding clock on `shares`. The shares keep earning the
    /// spread and keep taking losses until the exit completes.
    function requestUnbond(uint256 shares) external;

    /// Step two, the exit. Burns the shares at the pool's value now, not at the value when
    /// the request was made, so anything slashed in between comes out of this withdrawal.
    function completeUnbond() external returns (uint256 amount);

    /// Step two, the other way. Leaves the stake in place and clears the request.
    function cancelUnbond() external;

    /// Pays out the spread the caller has accrued. Pulled rather than pushed so one staker
    /// that cannot receive USDG cannot hold up a distribution for everyone else.
    ///
    /// Pays what has been divided across shares. If rounding leaves a claimant owed a shade
    /// more than that, the remainder stays owed and the next distribution settles it.
    function claimRewards() external returns (uint256 amount);

    /// Posts credit-lane spread, in USDG, to be divided across the shares outstanding. The
    /// remainder of the division is carried, not discarded, so a sequence of distributions
    /// pays out what it took in down to the last micro-dollar.
    ///
    /// With nothing staked there is nobody to divide it between, so the amount is parked for
    /// the treasury instead of reverting. A revert here would fail the settlement that was
    /// trying to pay the spread.
    ///
    /// Callable only by the credit manager, which is the component that charges the spread and
    /// the same one that covers a shortfall out of the pool. It is unset in the live
    /// deployment, because the collateralized lane it belongs to is not built.
    function distribute(uint256 amount) external;

    /// Adds BRSR to the pool without minting shares, which raises what every existing share
    /// is worth. This is where bought-back BRSR lands.
    function compound(uint256 amount) external;

    /// Covers a credit-lane shortfall out of the stake. Callable only by the credit manager,
    /// takes at most what the pool holds, and sends it to the slash sink for conversion.
    /// `reason` names the loan or liquidation the loss came from, so the event can be tied
    /// back to the position that caused it.
    function slash(uint256 amount, bytes32 reason) external returns (uint256 taken);

    /// Sends spread that reached no staker to the treasury. Permissionless: nothing about it
    /// is discretionary.
    function sweepUnallocated() external returns (uint256 amount);

    function setTiers(Tier[] calldata tiers) external;
    function setUnbondingPeriod(uint64 period) external;
    function setMinBond(uint256 amount) external;
    function setBondFloor(address resolver, uint256 amount) external;
    function setBondingDenied(address resolver, bool denied) external;
    function setCreditManager(address account) external;
    function setSlashSink(address account) external;
    function setTreasury(address account) external;
    function transferAdmin(address to) external;
    function acceptAdmin() external;
    function pause() external;
    function unpause() external;

    /// Basis points off the facilitator fee for this party, from the tier its staked balance
    /// reaches. Shares already committed to an exit are excluded: a discount for alignment
    /// should not outlive the alignment.
    function rebateBpsOf(address account) external view returns (uint16);

    /// BRSR a resolver has to bond to vote on disputes. Governance can raise the floor for a
    /// single resolver above the global one, which is the lever for a resolver that has been
    /// slashed before. `OracleRegistry` reads this on registration and again on every vote.
    function minBondOf(address resolver) external view returns (uint256);

    /// Whether `amount` would be an acceptable bond from `resolver` right now. False for a
    /// resolver governance has barred, whatever they are willing to post.
    function isBondable(address resolver, uint256 amount) external view returns (bool);

    function positionOf(address account) external view returns (Position memory);

    /// BRSR the account's shares are worth at the pool's current value, exit requests
    /// included. Zero once a slash has taken the whole pool.
    function stakedValueOf(address account) external view returns (uint256);

    /// The same figure with shares committed to an exit taken out. This is what the tiers
    /// are read against.
    function activeStakeOf(address account) external view returns (uint256);

    function sharesOf(address account) external view returns (uint256);
    function pendingRewards(address account) external view returns (uint256);
    function previewStake(uint256 amount) external view returns (uint256 shares);
    function previewUnbond(uint256 shares) external view returns (uint256 amount);
    function tiers() external view returns (Tier[] memory);

    function stakeToken() external view returns (IERC20);
    function rewardToken() external view returns (IERC20);
    function totalStaked() external view returns (uint256);
    function totalShares() external view returns (uint256);
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
    function minBond() external view returns (uint256);
    function wipeEpoch() external view returns (uint32);
    function creditManager() external view returns (address);
    function slashSink() external view returns (address);
    function treasury() external view returns (address);
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
}
