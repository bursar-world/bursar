// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IEscrow} from "./interfaces/IEscrow.sol";
import {IMandateAccount} from "./interfaces/IMandateAccount.sol";
import {IOracleRegistry} from "./interfaces/IOracleRegistry.sol";
import {IReputation} from "./interfaces/IReputation.sol";

/// Holds one payment for the life of one job.
///
/// A payer locks funds against a deadline, the payee releases them by committing to the
/// output it delivered, and every way a job can stall has an exit: the deadline refunds the
/// payer, a cancellation returns the funds early, and a dispute freezes them for a resolver
/// to split.
///
/// Value moves only as the settlement asset fixed at construction, and only through its ERC-20
/// interface. The native balance of this address is gas and is a different asset, so nothing
/// here reads it and no accounting figure can pick up a second view of the same money.
///
/// A lock pays out the moment the payee releases it, so a dispute raised after that has no
/// funds left to split and records only against the payee's history. A dispute freezes money
/// still held; it does not claw back money already paid.
///
/// A dispute the resolvers cannot hear is not a refund either. It goes back to `Locked` with
/// the deadline moved out, and the job finishes the way it would have without the dispute.
///
/// A payout the settlement asset refuses, because its issuer has frozen the recipient, is
/// booked as owed and collected later through `claim`. One frozen party cannot hold a
/// settlement, or the votes counted in it, in place for everyone else.
contract Escrow is IEscrow, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;

    /// The line between "the ruling went my way" and "it did not", for the purpose of
    /// returning a dispute bond. An even split counts as a win for whichever side disputed.
    uint16 private constant HALF_BPS = 5_000;

    /// Ten percent each. Ceilings written into the bytecode, not into a deploy script. Reading
    /// the rates off the verified source is enough to bound them, and together they cannot take
    /// more than a fifth of a disputed lock.
    uint16 private constant MAX_FEE_BPS = 1_000;

    /// Capped at a fifth: a larger bond would price out a party with a sound case and a thin
    /// balance.
    uint16 private constant MAX_DISPUTE_BOND_BPS = 2_000;

    /// What the payer's refund hook is allowed to spend. The measured cost of the mandate
    /// account's own hook is under 25k, so this is several times what an honest one needs, and
    /// it is capped at all because the payer is the one address in a settlement that the escrow
    /// does not choose. Uncapped, a payer contract could burn the gas of every ruling that pays
    /// its counterparty and hold the dispute open for good.
    uint256 private constant CREDIT_GAS = 150_000;

    /// The four legs a ruling cuts a lock into. Carried together because they are derived in
    /// one pass and have to add back up to the principal exactly.
    struct Split {
        uint128 refunded;
        uint128 paid;
        uint128 protocolFee;
        uint128 resolverFee;
    }

    // forge-lint: disable-start(screaming-snake-case-immutable)
    address public immutable settlementAsset;
    address public immutable reputation;
    address public immutable deployer;
    uint64 public immutable minTtl;
    uint64 public immutable maxTtl;
    uint64 public immutable disputeWindow;

    /// Charged against the payee's side of a settlement and against nothing else: a refund,
    /// a timeout and a cancellation all return the payer's funds whole. Immutable, so no key
    /// can raise the rate on a lock that is already open.
    uint16 public immutable feeBps;

    /// Taken off a disputed lock before the split, and paid to the resolvers who ruled on it.
    /// Both sides were party to the dispute, so both sides carry the cost of adjudicating it.
    uint16 public immutable resolverFeeBps;

    /// What it costs to open a dispute, as a share of the locked amount, refunded when the
    /// ruling lands on the disputer's side. Freezing a counterparty's money is otherwise free
    /// and a payee facing an unfavourable deadline would do it every time.
    uint16 public immutable disputeBondBps;

    /// The smallest lock the escrow opens. The constructor holds it at or above the amount
    /// whose dispute bond comes to one unit, so contesting a lock is never free.
    uint128 public immutable minLock;
    // forge-lint: disable-end

    address public resolver;
    address public treasury;

    /// The timelock. It can stop new locks and disputes and nothing else.
    address public pauser;
    address public pendingTreasury;

    /// Optional. While unset the escrow admits any payee, which is what a deployment without
    /// an agent registry needs. Once set it cannot be re-pointed, so a live gate cannot be
    /// swapped for a permissive one.
    IAgentRegistry public registry;

    /// Fees are counted here and swept in a batch rather than transferred per release. At
    /// the chain's gas floor a second ERC-20 transfer costs more than the fee on a small payment.
    ///
    /// Only ever credited from a fee computed against a settling lock, never from a balance
    /// reading, so a sweep cannot reach locked principal or a posted bond.
    uint128 public feesAccrued;

    /// Payouts the settlement asset refused, per recipient. Held apart from every lock, so a
    /// claim pays out of nothing but what a settlement already assigned to that address.
    mapping(address party => uint128 amount) public owed;

    uint256 public nextId = 1;

    mapping(uint256 id => Lock) private _locks;

    constructor(
        address settlementAsset_,
        address reputation_,
        address treasury_,
        uint16 feeBps_,
        uint16 resolverFeeBps_,
        uint16 disputeBondBps_,
        uint64 minTtl_,
        uint64 maxTtl_,
        uint64 disputeWindow_,
        uint128 minLock_
    ) {
        if (settlementAsset_ == address(0) || reputation_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS || resolverFeeBps_ > MAX_FEE_BPS) revert BadFee();
        if (disputeBondBps_ > MAX_DISPUTE_BOND_BPS) revert BadBond();
        // `lock` wants a deadline strictly inside the bounds, so maxTtl == minTtl + 1 admits
        // none and every lock would revert.
        if (uint256(minTtl_) + 1 >= maxTtl_) revert BadTtl();
        if (minLock_ == 0 || (disputeBondBps_ != 0 && _bps(minLock_, disputeBondBps_) == 0)) revert BadMinLock();

        settlementAsset = settlementAsset_;
        reputation = reputation_;
        deployer = msg.sender;
        treasury = treasury_;
        feeBps = feeBps_;
        resolverFeeBps = resolverFeeBps_;
        disputeBondBps = disputeBondBps_;
        minTtl = minTtl_;
        maxTtl = maxTtl_;
        disputeWindow = disputeWindow_;
        minLock = minLock_;

        emit TreasuryTransferred(address(0), treasury_);
    }

    function lock(
        address payee,
        bytes32 capabilityId,
        bytes32 inputCommit,
        string calldata inputURI,
        uint128 amount,
        uint64 deadline
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        // Paying the escrow itself would leave the funds held but attributed to no lock.
        if (payee == address(0) || payee == address(this)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount < minLock) revert BelowMinLock();
        if (uint256(deadline) <= block.timestamp + minTtl || uint256(deadline) >= block.timestamp + maxTtl) {
            revert BadTtl();
        }

        IAgentRegistry registry_ = registry;
        if (address(registry_) != address(0)) {
            if (registry_.isBlacklisted(payee) || !registry_.isActive(payee)) revert PartyNotAllowed();
        }

        // Unlike the reputation writes, which are advisory and tolerate a dead registry, the
        // cap is a control. A cap that disappears when its source stops answering is not one,
        // so this call is allowed to revert the lock.
        if (amount > IReputation(reputation).capOf(payee)) revert PayeeCapExceeded();

        id = nextId++;

        // Written field by field, so the slots that stay zero until release are never
        // touched.
        Lock storage entry = _locks[id];
        entry.payer = msg.sender;
        entry.payee = payee;
        entry.capabilityId = capabilityId;
        entry.inputCommit = inputCommit;
        entry.inputURI = inputURI;
        entry.amount = amount;
        entry.deadline = deadline;
        entry.status = LockStatus.Locked;

        _pullExact(msg.sender, amount);

        emit Locked(id, msg.sender, payee, capabilityId, amount, deadline);
    }

    function release(uint256 id, bytes32 outputCommit, string calldata outputURI) external nonReentrant {
        Lock storage entry = _locks[id];
        if (entry.status != LockStatus.Locked) revert BadStatus();
        if (msg.sender != entry.payee) revert NotPayee();
        if (block.timestamp > entry.deadline) revert TooLate();

        entry.outputCommit = outputCommit;
        entry.outputURI = outputURI;
        // Timestamps leave uint64 some three hundred billion years from now.
        // forge-lint: disable-next-line(unsafe-typecast)
        entry.releasedAt = uint64(block.timestamp);
        entry.status = LockStatus.Released;

        uint128 amount = entry.amount;
        uint128 fee = _fee(amount);
        if (fee != 0) feesAccrued += fee;

        address payer = entry.payer;
        address payee = entry.payee;

        IERC20(settlementAsset).safeTransfer(payee, amount - fee);

        // The release is not yet history. While the dispute window is open the same lock can
        // still be contested, and counting it as released now would leave the payee carrying
        // both a release and a dispute for one job. `finalizeRelease` closes it the other way.
        if (disputeWindow == 0) {
            entry.counted = true;
            _notifyReputation(id, abi.encodeCall(IReputation.onReleased, (payer, payee)));
        }

        emit Released(id, outputCommit);
    }

    function finalizeRelease(uint256 id) external nonReentrant {
        Lock storage entry = _locks[id];
        if (entry.status != LockStatus.Released || entry.counted) revert BadStatus();
        if (block.timestamp <= uint256(entry.releasedAt) + disputeWindow) revert TooEarly();

        entry.counted = true;

        _notifyReputation(id, abi.encodeCall(IReputation.onReleased, (entry.payer, entry.payee)));

        emit ReleaseFinalized(id);
    }

    function timeout(uint256 id) external nonReentrant {
        Lock storage entry = _locks[id];
        if (entry.status != LockStatus.Locked) revert BadStatus();
        if (block.timestamp <= entry.deadline) revert TooEarly();

        entry.status = LockStatus.TimedOut;
        entry.counted = true;

        address payer = entry.payer;

        uint128 amount = entry.amount;

        _pay(payer, amount);
        _notifyReputation(id, abi.encodeCall(IReputation.onTimedOut, (payer, entry.payee)));

        emit TimedOut(id);

        _creditPayer(id, payer, amount);
    }

    function dispute(uint256 id) external nonReentrant whenNotPaused {
        Lock storage entry = _locks[id];
        LockStatus previous = entry.status;
        if (previous != LockStatus.Locked && previous != LockStatus.Released) revert BadStatus();

        address payer = entry.payer;
        address payee = entry.payee;
        address resolver_;

        if (previous == LockStatus.Released) {
            // The payee was paid in the release, so only the payer has a complaint left to
            // make and there is no ruling for a bond to back.
            if (msg.sender != payer) revert NotPayer();
            if (disputeWindow == 0 || block.timestamp > uint256(entry.releasedAt) + disputeWindow) revert TooLate();
        } else {
            // Either side can be the one wronged while the money is still held. A payer that
            // paid for work it did not get, and a payee holding delivered work against a
            // deadline about to refund the payer, both need the same freeze.
            if (msg.sender != payer && msg.sender != payee) revert NotParty();
            // Past the deadline the payer is owed a timeout refund. A dispute there would trade
            // that refund for a ruling, or for a reopen that hands the payee a fresh deadline.
            if (block.timestamp > entry.deadline) revert TooLate();

            // Without an adjudicator a dispute is a unilateral clawback, so refuse to open one
            // the resolver cannot hear. A payee that never delivers is still answered by
            // `timeout`, which needs no resolver.
            resolver_ = resolver;
            if (resolver_ == address(0)) revert NotResolver();
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        entry.disputedAt = uint64(block.timestamp);
        entry.disputer = msg.sender;
        entry.status = LockStatus.Disputed;

        if (previous == LockStatus.Released) {
            // The lock ends here, carrying the dispute instead of the release into the payee's
            // history. One lock, one counter.
            entry.counted = true;
            _notifyReputation(id, abi.encodeCall(IReputation.onDisputed, (payer, payee)));
        } else {
            uint128 bond = _bps(entry.amount, disputeBondBps);
            if (bond != 0) {
                entry.bond = bond;
                _pullExact(msg.sender, bond);
                emit DisputeBonded(id, msg.sender, bond);
            }

            IOracleRegistry(resolver_).openDispute(id, payer, payee);
        }

        emit Disputed(id, msg.sender);
    }

    function cancel(uint256 id) external nonReentrant {
        Lock storage entry = _locks[id];
        if (entry.status != LockStatus.Locked) revert BadStatus();
        if (msg.sender != entry.payee) revert NotPayee();
        if (block.timestamp > entry.deadline) revert TooLate();

        entry.status = LockStatus.Cancelled;

        address payer = entry.payer;
        uint128 amount = entry.amount;

        // No reputation write: declining a job early is not a failure to deliver one, and
        // counting it as such would push payees to let locks run to timeout instead.
        _pay(payer, amount);

        emit Cancelled(id);

        _creditPayer(id, payer, amount);
    }

    /// Conservation, with `bond` the amount the disputer posted at `dispute`:
    ///
    ///     refunded + paid + protocolFee + reward + bondLeg == amount + bond
    ///
    /// `reward` is the resolver fee plus a forfeited bond, and `bondLeg` is the bond going back
    /// to the disputer when the ruling landed on their side, so the bond is counted in exactly
    /// one of them.
    ///
    /// With no shares nobody earned the resolver fee, so it is not taken, and a bond with no
    /// resolver to pay goes back to the disputer whichever way the ruling went.
    function resolve(uint256 id, uint16 refundBps, uint8 shares) external nonReentrant {
        if (msg.sender != resolver) revert NotResolver();
        if (refundBps > BPS) revert BadRefund();

        Lock storage entry = _locks[id];
        // `releasedAt` separates the two kinds of disputed lock. One still holds the money,
        // the other was paid out before the complaint arrived.
        if (entry.status != LockStatus.Disputed || entry.releasedAt != 0) revert BadStatus();

        entry.status = LockStatus.Resolved;
        entry.counted = true;

        uint128 bond = entry.bond;
        entry.bond = 0;

        Split memory split = _split(entry.amount, refundBps, shares != 0);
        if (split.protocolFee != 0) feesAccrued += split.protocolFee;

        // A disputer who asked for the money to move and got it moved was not griefing. An
        // even split counts for whichever side opened the dispute, because half a contested
        // payment is a real result rather than a complaint the resolvers had to sit through.
        bool vindicated = shares == 0 || (entry.disputer == entry.payer ? refundBps >= HALF_BPS : refundBps <= HALF_BPS);

        _pay(entry.payer, split.refunded);
        _pay(entry.payee, split.paid);

        if (bond != 0) {
            if (vindicated) {
                _pay(entry.disputer, bond);
                emit BondReturned(id, entry.disputer, bond);
            } else {
                emit BondForfeited(id, entry.disputer, bond);
            }
        }

        // A ruling that refunds nothing is a job the payee is judged to have delivered, and
        // its history should read that way.
        _notifyReputation(
            id,
            refundBps == 0
                ? abi.encodeCall(IReputation.onReleased, (entry.payer, entry.payee))
                : abi.encodeCall(IReputation.onDisputed, (entry.payer, entry.payee))
        );

        emit Resolved(id, refundBps, split.refunded, split.paid);

        _creditPayer(id, entry.payer, split.refunded);

        uint128 reward = vindicated ? split.resolverFee : split.resolverFee + bond;
        if (reward != 0) _rewardResolvers(id, reward);
    }

    function reopen(uint256 id) external nonReentrant {
        if (msg.sender != resolver) revert NotResolver();

        Lock storage entry = _locks[id];
        if (entry.status != LockStatus.Disputed || entry.releasedAt != 0) revert BadStatus();

        // From whichever is later, so a dispute that outlived the deadline still leaves the
        // payee a full `minTtl` to deliver or decline.
        uint256 from = block.timestamp > entry.deadline ? block.timestamp : entry.deadline;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 deadline = uint64(from + minTtl);

        entry.status = LockStatus.Locked;
        entry.deadline = deadline;

        uint128 bond = entry.bond;
        entry.bond = 0;
        address disputer = entry.disputer;

        if (bond != 0) {
            _pay(disputer, bond);
            emit BondReturned(id, disputer, bond);
        }

        emit DisputeReopened(id, deadline);
    }

    function setResolver(address resolver_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (resolver != address(0)) revert AlreadySet();
        if (resolver_ == address(0)) revert ZeroAddress();

        resolver = resolver_;

        emit ResolverSet(resolver_);
    }

    function setPauser(address pauser_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (pauser != address(0)) revert AlreadySet();
        if (pauser_ == address(0)) revert ZeroAddress();

        pauser = pauser_;

        emit PauserSet(pauser_);
    }

    function pause() external {
        if (msg.sender != pauser) revert NotPauser();
        _pause();
    }

    function unpause() external {
        if (msg.sender != pauser) revert NotPauser();
        _unpause();
    }

    function paused() public view override(IEscrow, Pausable) returns (bool) {
        return super.paused();
    }

    /// Event only. The slice is encrypted to the resolver it names, and the escrow is where
    /// both parties of a lock can publish it.
    function grantDisclosure(uint256 id, address resolver_, bytes32 sliceCommit, bytes calldata ciphertext) external {
        Lock storage entry = _locks[id];
        if (entry.status != LockStatus.Disputed) revert BadStatus();
        if (msg.sender != entry.payer && msg.sender != entry.payee) revert NotParty();
        if (resolver_ == address(0)) revert ZeroAddress();

        emit DisclosureGranted(id, msg.sender, resolver_, sliceCommit, ciphertext);
    }

    function setRegistry(IAgentRegistry registry_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(registry) != address(0)) revert AlreadySet();
        if (address(registry_) == address(0)) revert ZeroAddress();

        registry = registry_;

        emit RegistrySet(address(registry_));
    }

    /// Permissionless: the treasury should not need a hot key to be paid, and anyone willing
    /// to spend the gas can push what is owed to it.
    function sweepFees() external nonReentrant returns (uint128 amount) {
        amount = feesAccrued;
        if (amount == 0) revert ZeroAmount();

        feesAccrued = 0;

        address to = treasury;
        IERC20(settlementAsset).safeTransfer(to, amount);

        emit FeesSwept(to, amount);
    }

    /// Permissionless, and paid to `party` only. A mandate account or the resolver registry has
    /// no call of its own to collect with, and the destination is not the caller's to choose.
    function claim(address party) external nonReentrant returns (uint128 amount) {
        amount = owed[party];
        if (amount == 0) revert ZeroAmount();

        owed[party] = 0;

        IERC20(settlementAsset).safeTransfer(party, amount);

        emit OwedClaimed(party, amount);
    }

    /// Two-step because the treasury is the only address that can name its successor. A
    /// single-step handover to an address nobody controls would strand the protocol's fee
    /// revenue permanently.
    function transferTreasury(address to) external {
        if (msg.sender != treasury) revert NotTreasury();
        if (to == address(0)) revert ZeroAddress();

        pendingTreasury = to;

        emit TreasuryTransferStarted(treasury, to);
    }

    function acceptTreasury() external {
        if (msg.sender != pendingTreasury) revert NotPendingTreasury();

        emit TreasuryTransferred(treasury, msg.sender);

        treasury = msg.sender;
        pendingTreasury = address(0);
    }

    function getLock(uint256 id) external view returns (Lock memory) {
        return _locks[id];
    }

    /// Every exit path pays out what was booked, so an asset that delivers less than it was
    /// asked to move would settle the shortfall out of another payer's lock.
    function _pullExact(address from, uint128 amount) private {
        IERC20 asset = IERC20(settlementAsset);
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = asset.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert TransferMismatch();
    }

    /// The fee moves first and `notifyReward` follows in the same transaction, because the
    /// registry books only what it already holds.
    ///
    /// A refusal there is a broken pairing and must not unwind the ruling: the escrow is the
    /// registry's own caller here, so a revert would propagate back into the finalisation that
    /// produced the ruling and leave the lock frozen over a fee neither party cared about. The
    /// fee has left the lock either way, so the identity above holds on every branch.
    function _rewardResolvers(uint256 id, uint128 amount) private {
        address resolver_ = resolver;
        uint256 disputeId = IOracleRegistry(resolver_).disputeIdOf(id);

        // Nothing arrived, so there is nothing for the registry to book.
        if (!_pay(resolver_, amount)) {
            emit ResolverRewardUncredited(id, disputeId, amount);
            return;
        }

        uint256 before = gasleft();
        try IOracleRegistry(resolver_).notifyReward(disputeId, amount) {
            emit ResolverRewarded(id, disputeId, amount);
        } catch {
            _requireNotStarved(before);
            emit ResolverRewardUncredited(id, disputeId, amount);
        }
    }

    /// Pays `to`, or books the amount as owed to it when the settlement asset refuses the
    /// transfer. USDG reverts every transfer to an address its issuer has frozen, and a
    /// settlement that reverted on one such leg would strand the others with it.
    ///
    /// A transfer that failed for want of gas is the caller's doing, not the recipient's, and
    /// is refused rather than booked, the same way the best-effort calls below treat it.
    function _pay(address to, uint128 amount) private returns (bool paid) {
        if (amount == 0) return true;

        uint256 before = gasleft();
        (bool ok, bytes memory data) = settlementAsset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        // Read the way SafeERC20 reads it: no return data is a success, a returned false is not.
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return true;

        _requireNotStarved(before);
        owed[to] += amount;

        emit PaymentOwed(to, amount);
    }

    /// The resolver fee comes off the top, the refund splits what is left, and the protocol
    /// fee is charged only on the payee's share. Each division's remainder stays in the legs
    /// computed after it, so the four legs sum to `amount` exactly.
    function _split(uint128 amount, uint16 refundBps, bool feeEarned) private view returns (Split memory split) {
        if (feeEarned) split.resolverFee = _bps(amount, resolverFeeBps);

        uint128 divisible = amount - split.resolverFee;
        split.refunded = _bps(divisible, refundBps);

        uint128 awarded = divisible - split.refunded;
        split.protocolFee = _fee(awarded);
        split.paid = awarded - split.protocolFee;
    }

    function _fee(uint128 amount) private view returns (uint128) {
        return _bps(amount, feeBps);
    }

    function _bps(uint128 amount, uint16 rate) private pure returns (uint128) {
        // `amount` is a uint128 and `rate` never exceeds BPS, so the quotient stays in range.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128((uint256(amount) * rate) / BPS);
    }

    /// A payer that books a lock against its own spending limits has to get that allowance
    /// back when the lock exits without paying the payee, or a cancelled job costs a mandate
    /// its budget for the day and nothing returns it.
    ///
    /// Best effort and gas-bounded, for the same reason the reputation write is best effort:
    /// most payers are plain addresses with no hook to call, and a payer that reverts on the
    /// callback must not be able to block the settlement it is a party to. The money has
    /// already moved when this runs.
    function _creditPayer(uint256 id, address payer, uint128 amount) private {
        if (amount == 0 || payer.code.length == 0) return;

        uint256 before = gasleft();
        (bool credited,) = payer.call{gas: CREDIT_GAS}(abi.encodeCall(IMandateAccount.creditSpend, (id, amount)));
        if (credited) return;
        _requireNotStarved(before);
        emit PayerCreditFailed(id);
    }

    /// Reputation is advisory, so a registry that reverts or has been self-destructed out from
    /// under the escrow must never strand settlement. A plain call to a codeless address
    /// succeeds silently, so the code length is checked before the call's success counts.
    function _notifyReputation(uint256 id, bytes memory payload) private {
        bool delivered;
        if (reputation.code.length != 0) {
            uint256 before = gasleft();
            (delivered,) = reputation.call(payload);
            if (!delivered) _requireNotStarved(before);
        }
        if (!delivered) emit ReputationCallbackFailed(id);
    }

    /// A best-effort call that failed is only a failure of the callee if the callee had the gas
    /// it was meant to have. Under the 63/64 rule a caller can pick a gas limit that starves the
    /// callee and still leaves this frame enough to finish, turning a ruling into a silent skip.
    /// A frame left with no more than a sixty-fourth of what it had is that case, so it reverts.
    function _requireNotStarved(uint256 before) private view {
        if (gasleft() <= before / 63) revert InsufficientGas();
    }
}
