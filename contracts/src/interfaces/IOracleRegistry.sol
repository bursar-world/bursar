// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IStaking} from "../token/interfaces/IStaking.sol";

/// Bonded resolvers rule on disputed escrow locks by commit-reveal vote.
///
/// The bond is what makes a vote cost something: a resolver that stays silent after
/// committing, or reveals a score far from the median, loses part of it. Commit-reveal is
/// what stops the later voters from copying the earlier ones, which would turn a quorum into
/// a single opinion repeated.
///
/// The bond is only half the incentive. The escrow deducts a resolver fee from every lock it
/// settles on a ruling and sends it back here, where it is split between the resolvers whose
/// scores held.
///
/// Bonds are posted in BRSR and rewards are paid in the settlement asset, so a resolver puts
/// the protocol's own token at risk and is paid out of the settlement it ruled on. Neither is
/// ever native value. How much BRSR a resolver has to post is not held here: it is the staking
/// pool's `minBondOf`, read live on every vote, which is what lets governance raise the floor
/// against a falling token without touching a bond.
interface IOracleRegistry {
    error AlreadyRegistered();
    error NotRegistered();
    error NotActive();
    error NotAdmin();
    error NotPendingAdmin();
    error NotEscrow();
    error AlreadySet();
    error NotDeployer();
    error BondTooSmall();
    error BondNotAccepted(uint128 offered, uint256 required);
    error BondLocked();
    error StakingNotSet();
    error StakingAssetMismatch(address found, address expected);
    error UnbondNotRequested();
    error UnbondAlreadyRequested();
    error UnbondNotMatured();
    error RosterFull();
    error DisputeNotFound();
    error DisputeAlreadyOpen();
    error BadStatus();
    error AlreadyCommitted();
    error NoCommitment();
    error AlreadyRevealed();
    error BadReveal();
    error BadScore();
    error CommitWindowClosed();
    error CommitWindowOpen();
    error RevealWindowClosed();
    error RevealWindowOpen();
    error QuorumNotMet();
    error QuorumSuspect();
    error BadConfig();
    error ZeroAddress();
    error ZeroAmount();
    error NothingToClaim();
    error PartyCannotVote();

    enum ResolverStatus {
        None,
        Active,
        Unbonding,
        Exited
    }

    enum DisputeStatus {
        None,
        Committing,
        Revealing,
        Finalized,
        Failed
    }

    /// `maxDeviation` is in score points, not basis points. If more than half the revealed
    /// scores sit further than that from the median, the vote has no centre and the payer is
    /// refunded in full.
    ///
    /// `maxVoters` has to be at least the roster cap of 64, so every seated resolver can vote
    /// and none can be crowded out by whoever commits first. Both windows are at least ten
    /// minutes long.
    struct Config {
        uint64 commitWindow;
        uint64 revealWindow;
        uint64 unbondingPeriod;
        uint8 quorum;
        uint8 maxVoters;
        uint8 maxDeviation;
        uint16 slashBps;
    }

    /// `unbondingAt` is the timestamp the request was made, not the timestamp it matures;
    /// the maturity moves if governance shortens `unbondingPeriod`, and a resolver should
    /// not be able to freeze the old period by requesting early.
    struct Resolver {
        uint128 bond;
        uint64 unbondingAt;
        uint32 finalized;
        uint32 slashes;
        ResolverStatus status;
    }

    /// `rewardShares` is the number of resolvers that revealed inside the deviation band,
    /// fixed when the vote closes and before the escrow pays the fee back. A dispute that
    /// failed has no shares, and the escrow takes no resolver fee from a ruling with none.
    struct Dispute {
        uint256 escrowId;
        uint64 openedAt;
        uint64 commitEndsAt;
        uint64 revealEndsAt;
        uint8 commitCount;
        uint8 revealCount;
        uint8 medianScore;
        uint16 refundBps;
        uint8 rewardShares;
        DisputeStatus status;
    }

    event ResolverRegistered(address indexed resolver, uint128 bond);
    event BondIncreased(address indexed resolver, uint128 amount, uint128 bond);
    event UnbondRequested(address indexed resolver, uint64 maturesAt);
    event UnbondCancelled(address indexed resolver);
    event UnbondCompleted(address indexed resolver, uint128 returned);
    event ResolverSlashed(address indexed resolver, uint256 indexed disputeId, uint128 amount);
    event DisputeOpened(uint256 indexed disputeId, uint256 indexed escrowId, uint64 commitEndsAt);
    event VoteCommitted(uint256 indexed disputeId, address indexed resolver, uint8 commitCount);
    event VoteRevealed(uint256 indexed disputeId, address indexed resolver, uint8 score);
    event DisputeFinalized(uint256 indexed disputeId, uint8 medianScore, uint16 refundBps, uint8 voterCount);
    event DisputeFailed(uint256 indexed disputeId, bytes4 reason);
    event RewardsPosted(uint256 indexed disputeId, uint256 amount, uint8 shares, uint256 perShare);
    event RewardsClaimed(address indexed resolver, uint256 amount);
    event UnallocatedSwept(address indexed slashSink, uint256 amount);
    event SurplusSwept(address indexed slashSink, uint256 amount);
    event ResolverEvicted(address indexed resolver, uint128 returned);
    event ConfigUpdated(Config config);
    event EscrowSet(address indexed escrow);
    event StakingSet(address indexed staking, address indexed bondAsset);
    event SlashSinkUpdated(address indexed slashSink);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    /// Pulls `bond` BRSR from the caller. Registration is permissionless above the staking
    /// pool's floor for that address; the roster is capped so finalisation stays inside a
    /// block.
    function register(uint128 bond) external;

    /// Tops a bond back up. The resulting total has to clear the floor, so a resolver below it
    /// cannot return in instalments that never reach it.
    function increaseBond(uint128 amount) external;

    /// Stops the resolver being drawn into new disputes and starts the cooldown, which has to
    /// outlast the longest dispute a live vote could still slash.
    function requestUnbond() external;

    /// Returns the bond once the cooldown has matured and no vote it committed is still open.
    function completeUnbond() external;

    /// Returns the resolver to active without touching the bond.
    function cancelUnbond() external;

    /// Opened by the escrow when either party contests a lock that still holds its funds. The
    /// commit window starts immediately, never on the first vote, so a resolver cannot stall
    /// the clock by waiting. The parties are recorded, with the payer's principal as it reads
    /// at this moment, so none of them can vote on its own dispute.
    function openDispute(uint256 escrowId, address payer, address payee) external returns (uint256 disputeId);

    /// The payer, the payee and the payer's principal as it read when the dispute opened, all
    /// three barred from voting on it. `principal` is zero for a payer that did not answer.
    function partiesOf(uint256 disputeId) external view returns (address payer, address payee, address principal);

    /// Stops new bonds, new votes and new disputes. Reveals and both settlement paths stay
    /// open, so a dispute already running still finishes. Callable by the admin, which is the
    /// timelock, so the guardian's brake reaches the registry.
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);

    /// `commitment` is `commitmentHash(disputeId, msg.sender, score, salt)`. The resolver
    /// address is inside the hash so one resolver's commitment cannot be replayed by
    /// another who watched the mempool.
    function commitVote(uint256 disputeId, bytes32 commitment) external;

    function revealVote(uint256 disputeId, uint8 score, bytes32 salt) external;

    /// Permissionless once the reveal window closes, or earlier once every commitment has
    /// been revealed. Takes the median score, slashes the silent and the outliers, and
    /// calls the escrow with the resulting refund split.
    function finalize(uint256 disputeId) external;

    /// Permissionless exit for a dispute that never reached quorum. Reopens the lock through
    /// the escrow, with the bond back to the disputer and a fresh deadline for the payee, so
    /// the lock is never left stranded and an unheard dispute is never a refund.
    function failDispute(uint256 disputeId) external;

    /// Posts the resolver fee the escrow deducted from a settled lock. The escrow transfers
    /// the tokens first and calls this second, inside its own `resolve`. A pot too small to
    /// split between the resolvers who earned it is parked for the sink instead of reverting;
    /// a revert would leave the fee here uncredited until `sweepSurplus`.
    ///
    /// The pot is split evenly between the resolvers that revealed within `maxDeviation` of
    /// the median. Silence and outlier scores earn nothing, which is the same test that
    /// decides slashing.
    function notifyReward(uint256 disputeId, uint256 amount) external;

    /// Pays out everything the caller has accrued across settled disputes. Rewards are pulled
    /// rather than pushed so one resolver that cannot receive tokens cannot block a
    /// settlement for the rest.
    function claimRewards() external returns (uint256 amount);

    /// Sends fees that reached no resolver, plus split dust, to the slash sink. Permissionless
    /// because nothing here is discretionary.
    function sweepUnallocated() external returns (uint256 amount);

    /// Sends settlement asset held beyond `rewardFloat` to the slash sink. Only a transfer
    /// made outside `notifyReward` leaves any. Permissionless for the same reason.
    function sweepSurplus() external returns (uint256 amount);

    function slash(address resolver, uint128 amount) external;

    /// Unseats a resolver with no open vote and returns its bond, so a seat slashed to nothing
    /// or left idle does not hold the capped roster for good. Admin only.
    function evict(address resolver) external;
    // From here to the end marker a setter names its argument after the getter it sets. An
    // interface has no body in which the one could be read for the other.
    // slither-disable-start shadowing-local
    function setConfig(Config calldata config) external;
    function setSlashSink(address slashSink) external;

    /// The mirror of the escrow's own `setResolver`. Neither constructor can name the other, so
    /// both halves of the pairing are closed after deployment, once each, by the same deployer.
    function setEscrow(address escrow) external;

    /// Names the staking pool that holds the bond floor, and with it the token bonds are posted
    /// in. That token is read off the pool. One shot, deployer only: the token set is deployed
    /// after this contract, and re-pointing it later would change the currency of bonds already
    /// held. Until it is called nobody can bond.
    function setStaking(address staking) external;
    // slither-disable-end shadowing-local

    function transferAdmin(address to) external;
    function acceptAdmin() external;

    /// keccak256(abi.encode(disputeId, resolver, score, salt))
    function commitmentHash(uint256 disputeId, address resolver, uint8 score, bytes32 salt)
        external
        pure
        returns (bytes32);

    /// Maps a quality score to the payer's refund share. Stepped rather than linear because
    /// a resolver judging "the job was not done" and one judging "the job was poor" should
    /// not have to agree on a percentage to agree on an outcome.
    function refundBpsForScore(uint8 score) external pure returns (uint16);

    function getDispute(uint256 disputeId) external view returns (Dispute memory);
    function getResolver(address resolver) external view returns (Resolver memory);
    function disputeIdOf(uint256 escrowId) external view returns (uint256);
    function committedBy(uint256 disputeId, address resolver) external view returns (bytes32);
    function revealedBy(uint256 disputeId, address resolver) external view returns (bool revealed, uint8 score);
    function rewardedBy(uint256 disputeId, address resolver) external view returns (bool);
    function rewardsOf(address resolver) external view returns (uint256);
    function voters(uint256 disputeId) external view returns (address[] memory);

    function config() external view returns (Config memory);

    /// The asset resolver rewards are paid in, which is the one the escrow settled the disputed
    /// lock in. Bonds are `bondAsset` and the two are never the same token.
    function settlementAsset() external view returns (address);

    function escrow() external view returns (address);

    /// The address that deployed this contract, and the only one that can close the two
    /// pairings no constructor could: the escrow and the staking pool.
    function deployer() external view returns (address);

    /// The staking pool that answers `isBondable` and `minBondOf`, and the token it denominates
    /// them in. Both are the zero address until `setStaking` runs, and while they are nobody
    /// can bond.
    function staking() external view returns (IStaking);
    function bondAsset() external view returns (IERC20);

    function slashSink() external view returns (address);
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function totalBonded() external view returns (uint128);
    function resolverCount() external view returns (uint256);
    function nextDisputeId() external view returns (uint256);

    /// Settlement asset held for rewards not yet claimed or swept, allocated or not. Bonds are
    /// counted by `totalBonded` and held in a different token, so the two cannot overlap.
    function rewardFloat() external view returns (uint256);
    function unallocatedRewards() external view returns (uint256);

    function scoreMax() external pure returns (uint8);
}
