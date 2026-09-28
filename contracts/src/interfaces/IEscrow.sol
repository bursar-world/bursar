// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentRegistry} from "./IAgentRegistry.sol";

/// Holds a payment for the life of one job: a payer locks, the payee releases by committing
/// to the output, and anything that stalls exits through timeout or dispute.
///
/// The settlement asset is fixed at construction, so a lock carries no token field and there
/// is no path by which a caller can name a different one.
interface IEscrow {
    error ZeroAddress();
    error ZeroAmount();
    error BadTtl();
    error BadStatus();
    error BadRefund();
    error BadBond();
    error NotPayer();
    error NotPayee();
    error NotParty();
    error NotResolver();
    error TooEarly();
    error TooLate();
    error AlreadySet();
    error NotDeployer();
    error TransferMismatch();
    error PartyNotAllowed();
    error PayeeCapExceeded();
    error NotTreasury();
    error NotPendingTreasury();
    error BadFee();

    enum LockStatus {
        None,
        Locked,
        Released,
        TimedOut,
        Disputed,
        Cancelled,
        Resolved
    }

    /// `counted` records that this lock has already moved a reputation counter. One lock is
    /// worth one counter, and a release contested inside the dispute window has to pick which
    /// one, and it never writes both.
    struct Lock {
        address payer;
        address payee;
        address disputer;
        bytes32 capabilityId;
        bytes32 inputCommit;
        bytes32 outputCommit;
        string inputURI;
        string outputURI;
        uint128 amount;
        uint64 deadline;
        uint64 releasedAt;
        uint128 bond;
        uint64 disputedAt;
        LockStatus status;
        bool counted;
    }

    event Locked(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        bytes32 capabilityId,
        uint128 amount,
        uint64 deadline
    );
    event Released(uint256 indexed id, bytes32 outputCommit);
    event ReleaseFinalized(uint256 indexed id);
    event TimedOut(uint256 indexed id);
    event Disputed(uint256 indexed id, address indexed opener);
    event DisputeBonded(uint256 indexed id, address indexed disputer, uint128 bond);
    event BondReturned(uint256 indexed id, address indexed disputer, uint128 bond);
    event BondForfeited(uint256 indexed id, address indexed disputer, uint128 bond);
    event ResolverRewarded(uint256 indexed id, uint256 indexed disputeId, uint128 amount);
    event ResolverRewardUncredited(uint256 indexed id, uint256 indexed disputeId, uint128 amount);
    event Cancelled(uint256 indexed id);
    event Resolved(uint256 indexed id, uint16 refundBps, uint128 refunded, uint128 paid);
    event ResolverSet(address indexed resolver);
    event RegistrySet(address indexed registry);
    event ReputationCallbackFailed(uint256 indexed id);
    event PayerCreditFailed(uint256 indexed id);
    event TreasuryTransferStarted(address indexed from, address indexed to);
    event TreasuryTransferred(address indexed from, address indexed to);
    event FeesSwept(address indexed to, uint128 amount);

    /// Pulls `amount` from the caller and opens a lock the payee can settle until `deadline`.
    /// The deadline has to sit strictly inside `[minTtl, maxTtl]` so neither side can create
    /// a lock that is impossible to answer or one that ties funds up indefinitely.
    ///
    /// Two admission checks stand in front of the transfer: the payee has to be allowed to
    /// trade by the agent registry, when one is wired, and `amount` has to sit inside the cap
    /// the payee's settlement history has earned.
    function lock(
        address payee,
        bytes32 capabilityId,
        bytes32 inputCommit,
        string calldata inputURI,
        uint128 amount,
        uint64 deadline
    ) external returns (uint256 id);

    /// Payee claims the lock by committing to the delivered output. Payment moves in the
    /// same call; there is no second step the payer has to take for the payee to be paid.
    function release(uint256 id, bytes32 outputCommit, string calldata outputURI) external;

    /// Records the release against the payee's history once the dispute window has closed
    /// without a complaint. Permissionless, and the payee has the standing reason to call it:
    /// the cap that gates the next lock is read off exactly these counters.
    function finalizeRelease(uint256 id) external;

    /// Permissionless once the deadline passes. Refunds the payer in full.
    function timeout(uint256 id) external;

    /// Contests a lock. Either party may contest one that is still open; only the payer may
    /// contest one released inside `disputeWindow`, and that late complaint is recorded
    /// against the payee's history and not ruled on, because the money has already moved.
    ///
    /// Contesting an open lock posts a bond of `disputeBondBps` of the locked amount, which
    /// comes back only if the ruling lands on the disputer's side of the split.
    function dispute(uint256 id) external;

    /// Payee declines the job before the deadline and returns the funds. Cheaper for both
    /// sides than letting the lock run to timeout.
    function cancel(uint256 id) external;

    /// Splits a disputed lock. `refundBps` is the payer's share of what is left after the
    /// resolver fee; the remainder goes to the payee. Only the resolver calls this.
    function resolve(uint256 id, uint16 refundBps) external;

    /// Permissionless refund of a dispute the resolver never ruled on. Without it, a
    /// resolver that stops answering would hold the payer's funds forever. The bond comes
    /// back whole: silence upstream is not the disputer's fault.
    function disputeTimeout(uint256 id) external;

    /// Neither contract can name the other at construction, so the pairing is closed afterwards
    /// from both sides: this call and the resolver's own `setEscrow`. One shot, deployer only,
    /// so it cannot be re-pointed later.
    function setResolver(address resolver) external;

    /// Turns on the party gate, once and permanently. Leaving it unset keeps the registry
    /// optional, which is what a minimal deployment wants.
    function setRegistry(IAgentRegistry registry) external;

    /// Pushes the fees a run of settlements has accrued to the treasury. Permissionless: the
    /// treasury should not need a hot key to be paid, and the destination is not the caller's
    /// to choose.
    function sweepFees() external returns (uint128 amount);

    /// Names the treasury's successor. Only the treasury itself may call it, because a
    /// one-step handover to an address nobody controls would strand the fee revenue. The
    /// successor takes the seat by calling `acceptTreasury`.
    function transferTreasury(address to) external;

    function acceptTreasury() external;

    function getLock(uint256 id) external view returns (Lock memory);

    /// Fees booked against settled locks and not yet swept. Only ever credited from a fee
    /// computed against a settling lock, so it can never reach locked principal or a bond.
    function feesAccrued() external view returns (uint128);

    function treasury() external view returns (address);
    function pendingTreasury() external view returns (address);

    function settlementAsset() external view returns (address);
    function reputation() external view returns (address);
    function resolver() external view returns (address);
    function registry() external view returns (IAgentRegistry);
    function feeBps() external view returns (uint16);
    function resolverFeeBps() external view returns (uint16);
    function disputeBondBps() external view returns (uint16);
    function minTtl() external view returns (uint64);
    function maxTtl() external view returns (uint64);
    function disputeWindow() external view returns (uint64);
    function disputeTimeoutPeriod() external view returns (uint64);
    function nextId() external view returns (uint256);
}
