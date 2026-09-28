// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A spending mandate held by one account contract: a principal funds it and writes the
/// limits, an agent spends inside them, and the settlement asset never leaves except
/// through the escrow or a principal withdrawal.
///
/// The merchant of a spend is the payee of the resulting escrow lock: one address, named from
/// the two sides of the trade.
///
/// Every amount is denominated in the settlement asset's own units. That is six decimals on
/// USDG, and the native 18-decimal view of the same balance is never read. It is the same money
/// counted twice.
interface IMandateAccount {
    error NotPrincipal();
    error NotPendingPrincipal();
    error NotAgent();
    error IsPaused();
    error IsRevoked();
    error NotYetValid();
    error Expired();
    error PerCallCapExceeded();
    error DailyCapExceeded();
    error MonthlyCapExceeded();
    error MerchantNotAllowed();
    error CapabilityNotAllowed();
    error BadMerkleProof();
    error MerkleGateActive();
    error AllowlistGateActive();
    error BadWindow();
    error BadValidity();
    error BadApprovalThreshold();
    error ApprovalRequired();
    error ApprovalMismatch();
    error ApprovalExpired();
    error ApprovalSpent();
    error BadSignature();
    error BadNonce();
    error AuthorizationExpired();
    error NotEscrow();
    error UnknownSpend();
    error CreditExceedsSpend();
    error TransferMismatch();
    error ZeroAddress();
    error ZeroAmount();

    /// Both windows bind at once. A spend has to clear the per-call cap and leave room in
    /// the daily and the monthly bucket, so the tighter of the two is what an agent feels.
    enum WindowKind {
        Daily,
        Monthly
    }

    /// Which source of truth decides whether a merchant can be paid. Allowlist reads the
    /// per-address mapping; MerkleRoot reads a proof against `merchantRoot`, which keeps a
    /// large roster off chain. Exactly one is live at a time so a revocation cannot be
    /// worked around through the other.
    enum MerchantGate {
        Allowlist,
        MerkleRoot
    }

    /// `spent` and `start` roll forward lazily on the first spend after the window elapses,
    /// so an idle mandate costs nothing to keep open. `epoch` counts those rollovers. A
    /// refund credited back has to name the bucket its allowance came out of, and once the
    /// window has rolled that bucket is gone.
    struct Window {
        uint128 cap;
        uint128 spent;
        uint64 duration;
        uint64 start;
        uint64 epoch;
    }

    /// The complete limit set, written atomically. Partial updates are not offered: a
    /// principal signing a mandate signs all of it, and `version` pins which one is live.
    ///
    /// `approvalThreshold` is the amount at and above which the principal's consent is
    /// required. Zero is rejected with `BadApprovalThreshold`, because it reads as "no
    /// threshold" and means the opposite: a mandate deployed with the field left at its
    /// default would need a signature for every spend and the agent would look broken. One
    /// asks for consent on everything; any value above `perCallCap` asks for it on nothing.
    struct Limits {
        uint128 perCallCap;
        uint128 dailyCap;
        uint128 monthlyCap;
        uint64 dailyWindow;
        uint64 monthlyWindow;
        uint128 approvalThreshold;
        uint64 validFrom;
        uint64 validUntil;
    }

    struct SpendRequest {
        address merchant;
        bytes32 capabilityId;
        bytes32 inputCommit;
        string inputURI;
        uint128 amount;
        uint64 deadline;
    }

    /// A principal's consent to one spend above `approvalThreshold`. `approvalId` is chosen
    /// by the principal and burned on use, so approvals can be issued out of band and
    /// consumed out of order. `amount` is a ceiling, not an exact match, which lets a
    /// quoted price settle slightly under without a second round trip.
    struct SpendApproval {
        bytes32 approvalId;
        address merchant;
        bytes32 capabilityId;
        uint128 amount;
        uint64 expiry;
    }

    event PrincipalTransferStarted(address indexed from, address indexed to);
    event PrincipalTransferred(address indexed from, address indexed to);
    event AgentUpdated(address indexed agent);
    event AgentRevoked(address indexed agent);
    event LimitsUpdated(uint64 indexed version, Limits limits);
    event MerchantUpdated(address indexed merchant, bool allowed);
    event MerchantGateUpdated(MerchantGate gate, bytes32 merchantRoot);
    event CapabilityUpdated(bytes32 indexed capabilityId, bool allowed);
    event PausedUpdated(bool paused);
    event DocumentHashUpdated(bytes32 indexed documentHash);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Spent(
        uint256 indexed escrowId,
        address indexed merchant,
        bytes32 indexed capabilityId,
        uint128 amount,
        uint128 dailySpent,
        uint128 monthlySpent
    );
    event SpendApproved(bytes32 indexed approvalId, address indexed merchant, uint128 amount, uint64 expiry);
    event ApprovalRevoked(bytes32 indexed approvalId);
    event ApprovalConsumed(bytes32 indexed approvalId, uint256 indexed escrowId);
    event SpendCredited(uint256 indexed escrowId, uint128 amount, uint128 dailySpent, uint128 monthlySpent);

    /// Locks `request.amount` in the escrow against the mandate. Reverts with
    /// `ApprovalRequired` at or above `approvalThreshold`; those spends go through
    /// `spendApproved`.
    ///
    /// `merchantProof` is read only under `MerchantGate.MerkleRoot` and must be empty
    /// otherwise, so a stale proof cannot be smuggled past an allowlist revocation.
    function spend(SpendRequest calldata request, bytes32[] calldata merchantProof) external returns (uint256 escrowId);

    /// Same path, carrying the principal's consent for an above-threshold spend.
    ///
    /// An empty `signature` means the approval was already registered on chain by
    /// `approveSpend`; otherwise it is an EIP-712 signature over `approval`, accepted from
    /// an EOA or through ERC-1271 so a Safe or a cold wallet can authorise without ever
    /// sending a transaction.
    function spendApproved(
        SpendRequest calldata request,
        bytes32[] calldata merchantProof,
        SpendApproval calldata approval,
        bytes calldata signature
    ) external returns (uint256 escrowId);

    function disputeSpend(uint256 escrowId) external;

    /// Returns unspent allowance to the windows a spend was drawn from. The escrow calls it
    /// when a lock exits without paying the merchant in full, so a daily limit is not
    /// consumed by a payment that never happened. Only the escrow can call it, only against
    /// an escrow id this account opened, and for at most what that spend committed.
    ///
    /// A credit that lands after its window has rolled is dropped. The allowance it consumed
    /// expired with the window, and refilling the live bucket would hand the agent budget the
    /// principal never granted. The two windows are judged apart, so a late refund can still
    /// credit the monthly bucket after the daily one has moved on.
    function creditSpend(uint256 escrowId, uint128 amount) external;

    /// Pulls `amount` of the settlement asset from the caller and reports what arrived. A
    /// plain transfer to this address funds the mandate just as well; this exists so funding
    /// is observable.
    ///
    /// An asset that delivers nothing, or more than it was asked to move, reverts with
    /// `TransferMismatch`. The escrow settles every lock at its face amount, so a mandate
    /// funded in a token that does not move exactly what it is told to would pay one
    /// merchant out of another's lock.
    function deposit(uint256 amount) external;

    /// `token` is free so a mistaken airdrop can be swept out. Only the principal calls it.
    function withdraw(address token, address to, uint256 amount) external;

    function setAgent(address agent) external;
    function revokeAgent() external;

    /// Bumps `version` and re-anchors both windows without clearing what was already spent,
    /// so shortening a window cannot retroactively free a bucket.
    function setLimits(Limits calldata limits) external;

    /// Relayed form of `setLimits`. `nonce` is strictly sequential because limit changes are
    /// ordered by intent: a later mandate must not be overtaken by an earlier one that was
    /// signed but held back.
    function setLimitsWithAuthorization(
        Limits calldata limits,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external;

    function setMerchant(address merchant, bool allowed) external;

    /// Switching to `MerkleRoot` requires a non-zero root; switching back to `Allowlist`
    /// requires a zero one. An empty root under a Merkle gate would deny every merchant. That
    /// reads as an outage, not a policy.
    function setMerchantGate(MerchantGate gate, bytes32 merchantRoot) external;

    function setCapability(bytes32 capabilityId, bool allowed) external;
    function setPaused(bool paused) external;

    /// Anchors the hash of the off-chain mandate document this account enforces. The
    /// contract never reads it; it exists so an auditor can tie a decision log to the terms
    /// that were live at the time.
    function setDocumentHash(bytes32 documentHash) external;

    function approveSpend(SpendApproval calldata approval) external;
    function revokeApproval(bytes32 approvalId) external;

    function transferPrincipal(address to) external;
    function acceptPrincipal() external;

    /// What the mandate would decide right now, without spending. `reason` is the selector
    /// of the error `spend` would revert with, or zero when `allowed` is true. The
    /// underwriter quotes this before signing an x402 payment so a refusal costs no gas.
    function previewSpend(address merchant, bytes32 capabilityId, uint128 amount)
        external
        view
        returns (bool allowed, bytes4 reason);

    /// Headroom after lazy window rollover: what an agent can actually spend now, not what the
    /// caps nominally say.
    function remaining() external view returns (uint128 perCall, uint128 daily, uint128 monthly);

    function principal() external view returns (address);
    function pendingPrincipal() external view returns (address);
    function agent() external view returns (address);
    function settlementAsset() external view returns (address);
    function escrow() external view returns (address);
    function paused() external view returns (bool);
    function revoked() external view returns (bool);
    function version() external view returns (uint64);
    function documentHash() external view returns (bytes32);
    function limits() external view returns (Limits memory);
    function window(WindowKind kind) external view returns (Window memory);
    function perCallCap() external view returns (uint128);
    function approvalThreshold() external view returns (uint128);
    function validFrom() external view returns (uint64);
    function validUntil() external view returns (uint64);
    function merchantGate() external view returns (MerchantGate);
    function merchantRoot() external view returns (bytes32);
    function merchants(address merchant) external view returns (bool);
    function capabilities(bytes32 capabilityId) external view returns (bool);
    function approvals(bytes32 approvalId) external view returns (bool registered, bool spent);

    /// What is still creditable against `escrowId`: what that spend committed, less whatever
    /// has already been returned. Zero for an escrow id this account did not open.
    function creditable(uint256 escrowId) external view returns (uint128);
    function nonce() external view returns (uint256);

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// keccak256(
    ///   "Limits(uint128 perCallCap,uint128 dailyCap,uint128 monthlyCap,uint64 dailyWindow,"
    ///   "uint64 monthlyWindow,uint128 approvalThreshold,uint64 validFrom,uint64 validUntil)"
    /// )
    // forge-lint: disable-next-item(mixed-case-function)
    function LIMITS_TYPEHASH() external pure returns (bytes32);

    /// keccak256(
    ///   "SetLimits(Limits limits,uint256 nonce,uint64 deadline)"
    ///   "Limits(uint128 perCallCap,uint128 dailyCap,uint128 monthlyCap,uint64 dailyWindow,"
    ///   "uint64 monthlyWindow,uint128 approvalThreshold,uint64 validFrom,uint64 validUntil)"
    /// )
    /// Referenced struct types follow the primary type in alphabetical order, per EIP-712.
    // forge-lint: disable-next-item(mixed-case-function)
    function SET_LIMITS_TYPEHASH() external pure returns (bytes32);

    /// keccak256(
    ///   "SpendApproval(bytes32 approvalId,address merchant,bytes32 capabilityId,"
    ///   "uint128 amount,uint64 expiry)"
    /// )
    // forge-lint: disable-next-item(mixed-case-function)
    function SPEND_APPROVAL_TYPEHASH() external pure returns (bytes32);

    /// keccak256(bytes.concat(keccak256(abi.encode(merchant)))), the double-hashed leaf that
    /// makes a proof for an internal node impossible to forge.
    function merchantLeaf(address merchant) external pure returns (bytes32);
}
