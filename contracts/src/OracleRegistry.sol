// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IOracleRegistry} from "./interfaces/IOracleRegistry.sol";
import {IEscrow} from "./interfaces/IEscrow.sol";
import {IStaking} from "./token/interfaces/IStaking.sol";

/// Bonded resolvers, commit-reveal voting, and the slashing that makes both mean something.
///
/// A dispute has three permissionless exits: `finalize` when the vote produced a result,
/// `failDispute` when it did not, and the escrow's own timeout when this contract never
/// answers at all. Every one of them moves the lock on, which is the property that matters
/// most here. A resolver quorum that can strand a payer's funds is worse than no quorum.
///
/// A failed vote reopens the lock rather than refunding it. Otherwise a payer facing a thin
/// bench could dispute, wait out an empty vote, and take back money for work it received.
///
/// Payment runs the other way through `notifyReward`: the escrow hands back the fee it took
/// from the settled lock, and it lands only on the resolvers whose scores held. Rewards accrue
/// and are claimed, never pushed, so a recipient that reverts on receipt cannot hold up the
/// settlement of the dispute it voted in.
///
/// ## Two assets, and why they are different
///
/// Bonds are posted in BRSR. Rewards arrive in the settlement asset, because they are a cut of a
/// settlement denominated in it. The two balances never touch: `totalBonded` accounts for one,
/// `rewardFloat` for the other, and they are different tokens, so a mistake in the reward path
/// cannot reach a bond.
///
/// Putting the bond in BRSR is what makes the token the security budget of adjudication rather
/// than a claim on one. A resolver that rules badly loses BRSR, and BRSR is the only thing it
/// loses. The cost is real and it is not hedged: the bond is volatile and the disputes it backs
/// are not, so a fall in the token's price lowers what a resolver has at risk against a lock
/// whose value has not moved. Nothing in this contract observes that. Reading a price here
/// would put the dispute layer behind an oracle, which is a dependency the dispute layer
/// otherwise does not have and a surface an attacker would reach for before reaching for a
/// bond.
///
/// The lever instead is governance, and it is held in `Staking`: a global minimum bond, a
/// higher floor for a named resolver, and an outright bar. `commitVote` reads that floor live,
/// on every vote, so raising it benches every resolver below it in the block the change lands
/// without touching a single bond. Topping back up is how they return. That is the whole
/// mitigation, and it is a person watching a market rather than a contract reading one.
contract OracleRegistry is IOracleRegistry, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint8 private constant SCORE_MAX = 100;
    uint16 private constant BPS = 10_000;

    /// Anyone bonded may crowd into a dispute, so the roster bounds the worst case a single
    /// finalisation has to walk. `maxVoters` bounds it again per dispute.
    uint256 private constant MAX_RESOLVERS = 64;

    /// Refund tiers, in score points. A resolver ruling "not delivered" and one ruling
    /// "delivered badly" land on the same refund without having to agree on a number.
    uint8 private constant SCORE_FULL_REFUND = 50;
    uint8 private constant SCORE_HIGH_REFUND = 65;
    uint8 private constant SCORE_LOW_REFUND = 80;

    struct Parties {
        address payer;
        address payee;
    }

    /// What reading a payer's principal may cost. A mandate account answers in a few thousand;
    /// the cap keeps a hostile payer contract from making a vote expensive.
    uint256 private constant PRINCIPAL_READ_GAS = 20_000;

    struct Vote {
        bytes32 commitment;
        uint8 score;
        bool revealed;
        bool rewarded;
    }

    // `settlementAsset` is fixed by IOracleRegistry's getter; `deployer` matches it.
    // forge-lint: disable-start(screaming-snake-case-immutable)
    address public immutable settlementAsset;
    address public immutable deployer;
    // forge-lint: disable-end

    address public escrow;
    address public slashSink;
    address public admin;
    address public pendingAdmin;

    /// The staking pool that holds the bond policy, and the token it is denominated in. Both
    /// arrive together and neither can be moved afterwards: bonds already posted are held in
    /// `bondAsset`, so a second address here would be a second currency in one ledger.
    ///
    /// Unset until the token set is deployed, and unset means no resolver can bond. That is
    /// the correct reading of a dispute layer whose collateral does not exist yet.
    IStaking public staking;
    IERC20 public bondAsset;

    uint128 public totalBonded;
    uint256 public resolverCount;
    uint256 public nextDisputeId = 1;

    /// Settlement asset held against resolver rewards, claimed and unclaimed alike. Bonds are
    /// a different token entirely, so this is the whole of what this contract owes in it.
    uint256 public rewardFloat;
    uint256 public unallocatedRewards;

    /// Disputes a resolver has committed to and that have not settled. Held so a bond cannot
    /// leave while a vote it backs is still live.
    mapping(address resolver => uint32 count) public openVotes;

    mapping(uint256 escrowId => uint256 disputeId) public disputeIdOf;

    Config private _config;
    mapping(address resolver => Resolver record) private _resolvers;
    mapping(uint256 disputeId => Dispute record) private _disputes;
    mapping(uint256 disputeId => address[] committers) private _voters;
    mapping(uint256 disputeId => mapping(address resolver => Vote vote)) private _votes;
    mapping(address resolver => uint256 amount) private _rewards;
    mapping(uint256 disputeId => Parties parties) private _parties;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address asset, address admin_, address slashSink_, Config memory config_) {
        if (asset == address(0) || admin_ == address(0) || slashSink_ == address(0)) revert ZeroAddress();
        _validateConfig(config_);

        settlementAsset = asset;
        deployer = msg.sender;
        admin = admin_;
        slashSink = slashSink_;
        _config = config_;

        emit ConfigUpdated(config_);
        emit SlashSinkUpdated(slashSink_);
        emit AdminTransferred(address(0), admin_);
    }

    function register(uint128 bond) external nonReentrant whenNotPaused {
        Resolver storage resolver = _resolvers[msg.sender];
        if (resolver.status == ResolverStatus.Active || resolver.status == ResolverStatus.Unbonding) {
            revert AlreadyRegistered();
        }
        if (resolverCount >= MAX_RESOLVERS) revert RosterFull();
        if (bond == 0) revert ZeroAmount();

        uint128 credited = _pullBond(bond);
        _requireBondable(msg.sender, credited);

        // An exited resolver keeps its `finalized` and `slashes` history across a re-entry.
        // Bonding restores the record, it does not reset it.
        resolver.bond = credited;
        resolver.unbondingAt = 0;
        resolver.status = ResolverStatus.Active;

        resolverCount += 1;
        totalBonded += credited;

        emit ResolverRegistered(msg.sender, credited);
    }

    function increaseBond(uint128 amount) external nonReentrant whenNotPaused {
        Resolver storage resolver = _resolvers[msg.sender];
        _requireRegistered(resolver);
        if (resolver.status != ResolverStatus.Active) revert NotActive();
        if (amount == 0) revert ZeroAmount();

        uint128 credited = _pullBond(amount);
        // Checked against the total, not the increment. A resolver governance has barred
        // cannot buy its way back one instalment at a time, and a resolver thinned by slashing
        // learns from the revert that the top-up was not enough.
        uint128 total = resolver.bond + credited;
        _requireBondable(msg.sender, total);

        resolver.bond = total;
        totalBonded += credited;

        emit BondIncreased(msg.sender, credited, total);
    }

    function requestUnbond() external {
        Resolver storage resolver = _resolvers[msg.sender];
        _requireRegistered(resolver);
        if (resolver.status == ResolverStatus.Unbonding) revert UnbondAlreadyRequested();

        resolver.status = ResolverStatus.Unbonding;
        resolver.unbondingAt = uint64(block.timestamp);

        emit UnbondRequested(msg.sender, uint64(block.timestamp) + _config.unbondingPeriod);
    }

    function completeUnbond() external nonReentrant {
        Resolver storage resolver = _resolvers[msg.sender];
        if (resolver.status != ResolverStatus.Unbonding) revert UnbondNotRequested();
        if (block.timestamp < uint256(resolver.unbondingAt) + _config.unbondingPeriod) revert UnbondNotMatured();
        // The cooldown alone does not cover a dispute opened moments before the request, so
        // the live vote count is what actually releases the bond.
        if (openVotes[msg.sender] != 0) revert BondLocked();

        uint128 returned = resolver.bond;
        resolver.bond = 0;
        resolver.unbondingAt = 0;
        resolver.status = ResolverStatus.Exited;

        resolverCount -= 1;
        totalBonded -= returned;

        if (returned != 0) bondAsset.safeTransfer(msg.sender, returned);

        emit UnbondCompleted(msg.sender, returned);
    }

    function cancelUnbond() external {
        Resolver storage resolver = _resolvers[msg.sender];
        if (resolver.status != ResolverStatus.Unbonding) revert UnbondNotRequested();

        resolver.status = ResolverStatus.Active;
        resolver.unbondingAt = 0;

        emit UnbondCancelled(msg.sender);
    }

    /// One dispute per lock, ever. A lock reopened after a failed vote cannot be disputed again,
    /// or a payer could hold it frozen one commit window at a time for as long as quorum stays
    /// out of reach.
    function openDispute(uint256 escrowId, address payer, address payee)
        external
        whenNotPaused
        returns (uint256 disputeId)
    {
        if (msg.sender != escrow) revert NotEscrow();
        if (disputeIdOf[escrowId] != 0) revert DisputeAlreadyOpen();

        disputeId = nextDisputeId++;
        disputeIdOf[escrowId] = disputeId;
        _parties[disputeId] = Parties({payer: payer, payee: payee});

        uint64 commitEndsAt = uint64(block.timestamp) + _config.commitWindow;
        Dispute storage dispute = _disputes[disputeId];
        dispute.escrowId = escrowId;
        dispute.openedAt = uint64(block.timestamp);
        dispute.commitEndsAt = commitEndsAt;
        dispute.revealEndsAt = commitEndsAt + _config.revealWindow;
        dispute.status = DisputeStatus.Committing;

        emit DisputeOpened(disputeId, escrowId, commitEndsAt);
    }

    function commitVote(uint256 disputeId, bytes32 commitment) external whenNotPaused {
        // A zero commitment cannot be told apart from an empty slot, and would let a resolver
        // occupy one without ever being able to reveal.
        if (commitment == bytes32(0)) revert NoCommitment();

        Resolver storage resolver = _resolvers[msg.sender];
        _requireRegistered(resolver);
        if (resolver.status != ResolverStatus.Active) revert NotActive();
        // Read live, and this is the whole of the mitigation for a volatile bond. A bond
        // thinned by slashing, or one left below a floor governance has just raised, benches
        // its resolver from the next vote until it is topped back up.
        if (!staking.isBondable(msg.sender, resolver.bond)) revert BondTooSmall();

        Dispute storage dispute = _requireDispute(disputeId);
        if (dispute.status != DisputeStatus.Committing) revert BadStatus();
        if (block.timestamp >= dispute.commitEndsAt) revert CommitWindowClosed();
        if (_votes[disputeId][msg.sender].commitment != bytes32(0)) revert AlreadyCommitted();
        if (dispute.commitCount >= _config.maxVoters) revert RosterFull();
        // A party scoring its own dispute sets the median it is paid by.
        if (_isParty(disputeId, msg.sender)) revert PartyCannotVote();

        _votes[disputeId][msg.sender].commitment = commitment;
        _voters[disputeId].push(msg.sender);
        dispute.commitCount += 1;
        openVotes[msg.sender] += 1;

        emit VoteCommitted(disputeId, msg.sender, dispute.commitCount);
    }

    function revealVote(uint256 disputeId, uint8 score, bytes32 salt) external {
        if (score > SCORE_MAX) revert BadScore();

        Dispute storage dispute = _requireDispute(disputeId);
        if (dispute.status != DisputeStatus.Committing && dispute.status != DisputeStatus.Revealing) {
            revert BadStatus();
        }
        if (block.timestamp < dispute.commitEndsAt) revert CommitWindowOpen();
        if (block.timestamp >= dispute.revealEndsAt) revert RevealWindowClosed();

        Vote storage vote = _votes[disputeId][msg.sender];
        if (vote.commitment == bytes32(0)) revert NoCommitment();
        if (vote.revealed) revert AlreadyRevealed();
        if (vote.commitment != commitmentHash(disputeId, msg.sender, score, salt)) revert BadReveal();

        vote.revealed = true;
        vote.score = score;
        dispute.revealCount += 1;
        // The phase advances on the first reveal, never on a clock read. The status a reader
        // sees is the status the contract enforced.
        if (dispute.status == DisputeStatus.Committing) dispute.status = DisputeStatus.Revealing;

        emit VoteRevealed(disputeId, msg.sender, score);
    }

    function finalize(uint256 disputeId) external nonReentrant {
        Dispute storage dispute = _requireDispute(disputeId);
        if (dispute.status != DisputeStatus.Committing && dispute.status != DisputeStatus.Revealing) {
            revert BadStatus();
        }
        if (block.timestamp < dispute.commitEndsAt) revert CommitWindowOpen();
        // Waiting out a window nobody can add to only delays the payer.
        if (block.timestamp < dispute.revealEndsAt && dispute.revealCount < dispute.commitCount) {
            revert RevealWindowOpen();
        }

        Config memory cfg = _config;
        if (dispute.revealCount < cfg.quorum) revert QuorumNotMet();

        uint8 median = _median(_revealedScores(disputeId, dispute.revealCount));
        uint256 outliers = _outlierCount(disputeId, median, cfg.maxDeviation);

        // A majority sitting outside the deviation band is not a narrow disagreement, it is a
        // vote with no centre. Nobody who merely disagreed is slashed for it, because the
        // contract cannot tell which side was honest; the payer is made whole instead.
        bool suspect = outliers * 2 > dispute.revealCount;
        uint16 refundBps = suspect ? BPS : refundBpsForScore(median);

        dispute.medianScore = median;
        dispute.refundBps = refundBps;
        dispute.status = suspect ? DisputeStatus.Failed : DisputeStatus.Finalized;

        // The guard above admits this call only once the reveal window has closed or every
        // commitment has been revealed, so any silence left here is a choice.
        //
        // Settled before the escrow is called, because the escrow pays the resolver fee back
        // through `notifyReward` inside that same call and the split has to be known by then.
        uint8 shares = _closeVotes(disputeId, median, cfg, true, !suspect);
        dispute.rewardShares = shares;

        // Not wrapped. A ruling the escrow refuses is not a ruling, and closing the dispute
        // anyway would leave the lock to a timeout that refunds the payer in full. Any refusal,
        // including one engineered by starving the call of gas, reverts the whole finalize and
        // leaves the dispute open for the next caller.
        IEscrow(escrow).resolve(dispute.escrowId, refundBps, shares);

        if (suspect) {
            emit DisputeFailed(disputeId, QuorumSuspect.selector);
        } else {
            emit DisputeFinalized(disputeId, median, refundBps, dispute.revealCount);
        }
    }

    function failDispute(uint256 disputeId) external nonReentrant {
        Dispute storage dispute = _requireDispute(disputeId);
        if (dispute.status != DisputeStatus.Committing && dispute.status != DisputeStatus.Revealing) {
            revert BadStatus();
        }

        Config memory cfg = _config;
        if (block.timestamp < dispute.commitEndsAt) revert CommitWindowOpen();
        // Reveals can never outnumber commitments, so a short commit phase settles it early.
        if (dispute.commitCount >= cfg.quorum) {
            if (block.timestamp < dispute.revealEndsAt) revert RevealWindowOpen();
            if (dispute.revealCount >= cfg.quorum) revert BadStatus();
        }

        dispute.status = DisputeStatus.Failed;

        // A dispute doomed by a short commit phase exits the moment that phase ends, which is
        // before anyone could have revealed. Slashing for silence there would punish resolvers
        // for a quorum they had no way to reach, and the caller picks the moment. Silence only
        // counts once the reveal window it belonged to has actually closed.
        _closeVotes(disputeId, 0, cfg, block.timestamp >= dispute.revealEndsAt, false);

        emit DisputeFailed(disputeId, QuorumNotMet.selector);

        // No vote is no ruling, so nothing moves. The lock goes back to the payee with time
        // to deliver, the bond goes back to the disputer, and a dispute nobody could hear is
        // never a refund.
        IEscrow(escrow).reopen(dispute.escrowId);
    }

    /// Not `nonReentrant`. The escrow calls this from inside `resolve`, which `finalize` is
    /// itself waiting on. The guard would already be held, and every settlement that carried a
    /// fee would fail.
    function notifyReward(uint256 disputeId, uint256 amount) external {
        if (msg.sender != escrow) revert NotEscrow();
        if (amount == 0) return;

        // Credits what arrived, not what was claimed. The escrow moves the tokens and names
        // the figure in the same call, and a figure larger than the transfer would pay one
        // dispute's resolvers out of another's unclaimed rewards.
        uint256 balance = IERC20(settlementAsset).balanceOf(address(this));
        uint256 free = balance > rewardFloat ? balance - rewardFloat : 0;
        uint256 credited = amount < free ? amount : free;
        if (credited == 0) return;

        rewardFloat += credited;

        uint8 shares = _disputes[disputeId].rewardShares;
        uint256 perShare = shares == 0 ? 0 : credited / shares;
        if (perShare == 0) {
            // Either the vote produced nobody worth paying, or the pot is smaller than the
            // number of resolvers splitting it. The fee belongs to the sink, not to this
            // contract, and `sweepUnallocated` is how it gets there.
            unallocatedRewards += credited;
            emit RewardsPosted(disputeId, credited, shares, 0);
            return;
        }

        // Bounded by `maxVoters`, which the config caps at the roster size.
        address[] storage roster = _voters[disputeId];
        for (uint256 i; i < roster.length; ++i) {
            address voter = roster[i];
            if (_votes[disputeId][voter].rewarded) _rewards[voter] += perShare;
        }

        // Truncation dust, at most `shares - 1` units, follows the orphaned pots to the sink.
        unallocatedRewards += credited - perShare * shares;

        emit RewardsPosted(disputeId, credited, shares, perShare);
    }

    function claimRewards() external nonReentrant returns (uint256 amount) {
        amount = _rewards[msg.sender];
        if (amount == 0) revert NothingToClaim();

        _rewards[msg.sender] = 0;
        rewardFloat -= amount;

        // An exited resolver still collects what it earned while bonded. The reward was work
        // done, and withholding it would price honest resolvers out of ever leaving.
        IERC20(settlementAsset).safeTransfer(msg.sender, amount);

        emit RewardsClaimed(msg.sender, amount);
    }

    function sweepUnallocated() external nonReentrant returns (uint256 amount) {
        amount = unallocatedRewards;
        if (amount == 0) revert NothingToClaim();

        unallocatedRewards = 0;
        rewardFloat -= amount;

        address sink = slashSink;
        IERC20(settlementAsset).safeTransfer(sink, amount);

        emit UnallocatedSwept(sink, amount);
    }

    function slash(address resolver, uint128 amount) external onlyAdmin nonReentrant {
        if (resolver == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Resolver storage record = _resolvers[resolver];
        _requireRegistered(record);

        uint128 taken = amount > record.bond ? record.bond : amount;
        record.bond -= taken;
        record.slashes += 1;
        totalBonded -= taken;

        if (taken != 0) bondAsset.safeTransfer(slashSink, taken);

        // Dispute id zero: this is a governance ruling, not the outcome of a vote.
        emit ResolverSlashed(resolver, 0, taken);
    }

    function setConfig(Config calldata config_) external onlyAdmin {
        _validateConfig(config_);
        _requireTimeoutOutlastsVote(escrow, config_);
        // Live disputes carry their own window ends, so a change here cannot move a clock that
        // resolvers are already voting against. Quorum and deviation are read at finalisation.
        _config = config_;
        emit ConfigUpdated(config_);
    }

    function setSlashSink(address slashSink_) external onlyAdmin {
        if (slashSink_ == address(0)) revert ZeroAddress();
        slashSink = slashSink_;
        emit SlashSinkUpdated(slashSink_);
    }

    function setEscrow(address escrow_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (escrow != address(0)) revert AlreadySet();
        if (escrow_ == address(0)) revert ZeroAddress();
        _requireTimeoutOutlastsVote(escrow_, _config);

        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    /// Names the staking pool, and with it the token bonds are posted in. One shot, deployer
    /// only, for the same reason `setEscrow` is: the token set is deployed after this contract
    /// and neither constructor can see the other. Re-pointing it later would change the
    /// currency of bonds that are already held.
    ///
    /// The bond token is read off the pool. The asset a resolver posts and the pool whose
    /// floor admits it cannot be two different things.
    function setStaking(address staking_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(staking) != address(0)) revert AlreadySet();
        if (staking_ == address(0)) revert ZeroAddress();

        IStaking pool = IStaking(staking_);
        address bond = address(pool.stakeToken());
        address reward = address(pool.rewardToken());

        // One token in both roles would put bonds and resolver rewards in one balance, and
        // `notifyReward` credits what it holds above what it owes.
        if (bond == settlementAsset) revert StakingAssetMismatch(bond, settlementAsset);
        // The pool pays its stakers the same asset this contract pays its resolvers. A
        // disagreement here means two halves of one deployment settled in different money.
        if (reward != settlementAsset) revert StakingAssetMismatch(reward, settlementAsset);

        staking = pool;
        bondAsset = IERC20(bond);

        emit StakingSet(staking_, bond);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    function paused() public view override(IOracleRegistry, Pausable) returns (bool) {
        return super.paused();
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

    function commitmentHash(uint256 disputeId, address resolver, uint8 score, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(disputeId, resolver, score, salt));
    }

    function refundBpsForScore(uint8 score) public pure returns (uint16) {
        if (score < SCORE_FULL_REFUND) return BPS;
        if (score < SCORE_HIGH_REFUND) return 7_500;
        if (score < SCORE_LOW_REFUND) return 3_500;
        return 0;
    }

    function rulable(uint256 escrowId) external view returns (bool) {
        DisputeStatus status = _disputes[disputeIdOf[escrowId]].status;
        return status == DisputeStatus.Committing || status == DisputeStatus.Revealing;
    }

    function partiesOf(uint256 disputeId) external view returns (address payer, address payee) {
        Parties storage parties = _parties[disputeId];
        return (parties.payer, parties.payee);
    }

    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return _disputes[disputeId];
    }

    function getResolver(address resolver) external view returns (Resolver memory) {
        return _resolvers[resolver];
    }

    function committedBy(uint256 disputeId, address resolver) external view returns (bytes32) {
        return _votes[disputeId][resolver].commitment;
    }

    function revealedBy(uint256 disputeId, address resolver) external view returns (bool revealed, uint8 score) {
        Vote storage vote = _votes[disputeId][resolver];
        return (vote.revealed, vote.score);
    }

    function rewardedBy(uint256 disputeId, address resolver) external view returns (bool) {
        return _votes[disputeId][resolver].rewarded;
    }

    function rewardsOf(address resolver) external view returns (uint256) {
        return _rewards[resolver];
    }

    function voters(uint256 disputeId) external view returns (address[] memory) {
        return _voters[disputeId];
    }

    function config() external view returns (Config memory) {
        return _config;
    }

    function scoreMax() external pure returns (uint8) {
        return SCORE_MAX;
    }

    /// The escrow's `disputeTimeoutPeriod` has to exceed this, or a lock can be timed out from
    /// under a vote that is still running and the resolvers slash each other over an outcome
    /// nobody can act on. The sum cannot overflow: `_validateConfig` holds it below
    /// `unbondingPeriod`, which is itself a uint64.
    function votingPeriod() external view returns (uint64) {
        return _config.commitWindow + _config.revealWindow;
    }

    /// Credits what arrived, not what was asked for. The bond asset is fixed, but a token that
    /// takes a fee on transfer would leave `totalBonded` above the balance actually held, and
    /// the last resolver out would be the one who discovers it.
    function _pullBond(uint128 amount) private returns (uint128) {
        IERC20 asset = bondAsset;
        if (address(asset) == address(0)) revert StakingNotSet();

        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 credited = asset.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();
        return credited.toUint128();
    }

    /// The bond policy lives in the staking pool. This is one read of somebody else's
    /// governance, never a floor kept in two places that can disagree. A resolver governance
    /// has barred is refused whatever it offers, so the error reports both figures: `offered`
    /// at or above `required` means barred, not short.
    function _requireBondable(address resolver, uint128 offered) private view {
        IStaking pool = staking;
        if (!pool.isBondable(resolver, offered)) revert BondNotAccepted(offered, pool.minBondOf(resolver));
    }

    function _requireRegistered(Resolver storage resolver) private view {
        if (resolver.status == ResolverStatus.None || resolver.status == ResolverStatus.Exited) {
            revert NotRegistered();
        }
    }

    function _requireDispute(uint256 disputeId) private view returns (Dispute storage dispute) {
        dispute = _disputes[disputeId];
        if (dispute.status == DisputeStatus.None) revert DisputeNotFound();
    }

    function _revealedScores(uint256 disputeId, uint8 revealCount) private view returns (uint8[] memory scores) {
        scores = new uint8[](revealCount);
        address[] storage roster = _voters[disputeId];
        uint256 found;
        for (uint256 i; i < roster.length; ++i) {
            Vote storage vote = _votes[disputeId][roster[i]];
            if (!vote.revealed) continue;
            scores[found] = vote.score;
            found += 1;
        }
    }

    function _outlierCount(uint256 disputeId, uint8 median, uint8 maxDeviation) private view returns (uint256 count) {
        address[] storage roster = _voters[disputeId];
        for (uint256 i; i < roster.length; ++i) {
            Vote storage vote = _votes[disputeId][roster[i]];
            if (vote.revealed && _deviation(vote.score, median) > maxDeviation) count += 1;
        }
    }

    /// Slashes the silent and the outliers where each is warranted, credits everyone else,
    /// marks who the resolver fee is owed to, and releases the bonds this dispute was holding.
    /// One transfer out, so a hostile sink cannot make finalisation cost per voter.
    ///
    /// `voteStood` says the median is a result rather than noise. It gates the outlier slash
    /// and the reward together, because both rest on the same claim: that the centre of this
    /// vote means something. `punishSilence` is separate, and false while the reveal window is
    /// still open, since a resolver cannot be silent in a window it can still speak in.
    ///
    /// An unrevealed vote carries a zero score, which sits far from most medians. The outlier
    /// term is read only where a score was actually published.
    ///
    /// Returns the number of resolvers the fee splits between.
    function _closeVotes(uint256 disputeId, uint8 median, Config memory cfg, bool punishSilence, bool voteStood)
        private
        returns (uint8 shares)
    {
        address[] storage roster = _voters[disputeId];
        uint128 slashed;

        for (uint256 i; i < roster.length; ++i) {
            address voter = roster[i];
            Vote storage vote = _votes[disputeId][voter];
            Resolver storage resolver = _resolvers[voter];

            openVotes[voter] -= 1;

            bool astray = vote.revealed && _deviation(vote.score, median) > cfg.maxDeviation;
            bool guilty = vote.revealed ? (voteStood && astray) : punishSilence;
            if (!guilty) {
                if (vote.revealed) {
                    resolver.finalized += 1;
                    if (voteStood && !astray) {
                        vote.rewarded = true;
                        shares += 1;
                    }
                }
                continue;
            }

            uint128 amount = uint128((uint256(resolver.bond) * cfg.slashBps) / BPS);
            resolver.bond -= amount;
            resolver.slashes += 1;
            slashed += amount;

            emit ResolverSlashed(voter, disputeId, amount);
        }

        if (slashed != 0) {
            totalBonded -= slashed;
            bondAsset.safeTransfer(slashSink, slashed);
        }
    }

    /// The payer is usually a mandate account, and the person behind it is its principal. A
    /// payer that does not answer `principal()` is taken at its own address alone.
    function _isParty(uint256 disputeId, address voter) private view returns (bool) {
        Parties storage parties = _parties[disputeId];
        if (voter == parties.payer || voter == parties.payee) return true;

        address payer = parties.payer;
        if (payer.code.length == 0) return false;
        (bool ok, bytes memory data) = payer.staticcall{gas: PRINCIPAL_READ_GAS}(abi.encodeWithSignature("principal()"));
        return ok && data.length >= 32 && abi.decode(data, (uint256)) == uint256(uint160(voter));
    }

    /// The escrow's timeout is the payer's exit from a registry that never answers. Inside the
    /// voting windows it would refund a dispute the resolvers are still hearing.
    function _requireTimeoutOutlastsVote(address escrow_, Config memory cfg) private view {
        if (escrow_ == address(0)) return;
        uint256 voting = uint256(cfg.commitWindow) + cfg.revealWindow;
        if (IEscrow(escrow_).disputeTimeoutPeriod() <= voting) revert BadConfig();
    }

    function _deviation(uint8 score, uint8 median) private pure returns (uint8) {
        return score > median ? score - median : median - score;
    }

    /// Insertion sort over at most `maxVoters` entries. On an even split the lower of the two
    /// middle scores wins the rounding, which resolves a tie toward the payer's refund.
    function _median(uint8[] memory scores) private pure returns (uint8) {
        uint256 n = scores.length;
        for (uint256 i = 1; i < n; ++i) {
            uint8 key = scores[i];
            uint256 j = i;
            while (j != 0 && scores[j - 1] > key) {
                scores[j] = scores[j - 1];
                --j;
            }
            scores[j] = key;
        }

        if (n % 2 == 1) return scores[n / 2];
        return uint8((uint16(scores[n / 2 - 1]) + uint16(scores[n / 2])) / 2);
    }

    function _validateConfig(Config memory cfg) private pure {
        if (cfg.commitWindow == 0 || cfg.revealWindow == 0) revert BadConfig();
        if (cfg.quorum == 0 || cfg.maxVoters == 0) revert BadConfig();
        if (cfg.quorum > cfg.maxVoters) revert BadConfig();
        if (cfg.maxVoters > MAX_RESOLVERS) revert BadConfig();
        if (cfg.maxDeviation > SCORE_MAX) revert BadConfig();
        // A zero slash leaves the only cost in the system a no-op while `ResolverSlashed` still
        // fires, which reads as enforcement to anyone watching the logs. Worse than no slash.
        if (cfg.slashBps == 0 || cfg.slashBps > BPS) revert BadConfig();
        // A bond that matures before the dispute it voted in can be settled is not a bond.
        if (uint256(cfg.unbondingPeriod) < uint256(cfg.commitWindow) + cfg.revealWindow) revert BadConfig();
    }
}
