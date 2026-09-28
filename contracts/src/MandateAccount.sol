// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IEscrow} from "./interfaces/IEscrow.sol";
import {IMandateAccount} from "./interfaces/IMandateAccount.sol";
import {IStockRouter} from "./interfaces/IStockRouter.sol";

contract MandateAccount is IMandateAccount, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant _LIMITS_TYPEHASH = keccak256(
        "Limits(uint128 perCallCap,uint128 dailyCap,uint128 monthlyCap,uint64 dailyWindow,"
        "uint64 monthlyWindow,uint128 approvalThreshold,uint64 validFrom,uint64 validUntil,uint32 classMask,"
        "uint128 totalCap,uint8 lane)"
    );

    bytes32 private constant _SET_LIMITS_TYPEHASH = keccak256(
        "SetLimits(Limits limits,uint256 nonce,uint64 deadline)"
        "Limits(uint128 perCallCap,uint128 dailyCap,uint128 monthlyCap,uint64 dailyWindow,"
        "uint64 monthlyWindow,uint128 approvalThreshold,uint64 validFrom,uint64 validUntil,uint32 classMask,"
        "uint128 totalCap,uint8 lane)"
    );

    bytes32 private constant _SPEND_APPROVAL_TYPEHASH = keccak256(
        "SpendApproval(bytes32 approvalId,address merchant,bytes32 capabilityId," "uint128 amount,uint64 expiry)"
    );

    /// `digest` doubles as the registration flag: an approval the principal never wrote on
    /// chain has none, so the empty-signature path cannot match it.
    uint8 private constant CLASS_HIRE = 1;
    uint8 private constant CLASS_RWA = 2;
    uint8 private constant MAX_LANE = 2;

    struct Approval {
        bytes32 digest;
        bool spent;
    }

    /// What a spend committed and which buckets it came out of. The epochs are what make a
    /// refund creditable to those two buckets and to no others, and they fit beside the
    /// amount in one slot.
    struct SpendRecord {
        uint128 amount;
        uint64 dailyEpoch;
        uint64 monthlyEpoch;
    }

    // Names are fixed by IMandateAccount's getters, so the immutable casing convention gives way.
    // forge-lint: disable-start(screaming-snake-case-immutable)
    address public immutable override settlementAsset;
    address public immutable override escrow;
    // forge-lint: disable-end

    address public override principal;
    bool public override paused;
    bool public override revoked;

    address public override agent;
    uint64 public override version;
    MerchantGate public override merchantGate;

    address public override pendingPrincipal;

    uint128 public override perCallCap;
    uint128 public override approvalThreshold;

    uint64 public override validFrom;
    uint64 public override validUntil;

    bytes32 public override merchantRoot;
    bytes32 public override documentHash;
    uint256 public override nonce;

    mapping(address => bool) public override merchants;
    mapping(bytes32 => bool) public override capabilities;

    uint32 public override classMask;
    uint8 public override lane;
    uint128 public override totalCap;
    uint128 public override totalSpent;

    address public override router;
    bytes32 public override termsCommitment;
    address public override verifier;

    /// Moves when the principal changes hands, which strands every approval the previous
    /// principal registered. Approvals are keyed under it.
    uint64 public override approvalEpoch;

    Window private _daily;
    Window private _monthly;
    mapping(uint64 epoch => mapping(bytes32 => Approval)) private _approvals;
    mapping(uint256 escrowId => SpendRecord) private _spends;

    modifier onlyPrincipal() {
        if (msg.sender != principal) revert NotPrincipal();
        _;
    }

    constructor(address principal_, address agent_, address settlementAsset_, address escrow_, Limits memory limits_)
        EIP712("MandateAccount", "1")
    {
        if (principal_ == address(0) || settlementAsset_ == address(0) || escrow_ == address(0)) revert ZeroAddress();

        principal = principal_;
        agent = agent_;
        settlementAsset = settlementAsset_;
        escrow = escrow_;

        _setLimits(limits_);

        emit AgentUpdated(agent_);
    }

    function spend(SpendRequest calldata request, bytes32[] calldata merchantProof)
        external
        override
        nonReentrant
        returns (uint256 escrowId)
    {
        return _spend(request, merchantProof, false);
    }

    function spendApproved(
        SpendRequest calldata request,
        bytes32[] calldata merchantProof,
        SpendApproval calldata approval,
        bytes calldata signature
    ) external override nonReentrant returns (uint256 escrowId) {
        if (approval.merchant != request.merchant || approval.capabilityId != request.capabilityId) {
            revert ApprovalMismatch();
        }
        // The approved amount is a ceiling: a quote that settles under it still clears.
        if (request.amount > approval.amount) revert ApprovalMismatch();
        if (block.timestamp > approval.expiry) revert ApprovalExpired();

        Approval storage stored = _approvals[approvalEpoch][approval.approvalId];
        if (stored.spent) revert ApprovalSpent();

        bytes32 digest = _approvalDigest(approval);
        if (signature.length == 0) {
            if (stored.digest != digest) revert ApprovalMismatch();
        } else if (!SignatureChecker.isValidSignatureNow(principal, digest, signature)) {
            revert BadSignature();
        }

        stored.spent = true;

        escrowId = _spend(request, merchantProof, true);

        emit ApprovalConsumed(approval.approvalId, escrowId);
    }

    /// The escrow charges a bond to whoever contests an open lock, and this account is the
    /// payer on every lock it opened, so the allowance has to be posted from here or the
    /// principal has no way to contest its own payment. Sized from the escrow's own rate
    /// against the locked amount and cleared afterwards, so nothing usable is left standing.
    function disputeSpend(uint256 escrowId) external override onlyPrincipal nonReentrant {
        IEscrow escrow_ = IEscrow(escrow);
        uint128 bond = _bond(escrow_, escrowId);

        IERC20 asset = IERC20(settlementAsset);
        if (bond != 0) asset.forceApprove(address(escrow_), bond);

        escrow_.dispute(escrowId);

        if (bond != 0) asset.forceApprove(address(escrow_), 0);
    }

    /// No `nonReentrant`: the escrow calls this from inside its own guarded exit paths, and
    /// nothing here moves value, so a guard would only turn a legitimate refund into a revert.
    function creditSpend(uint256 escrowId, uint128 amount) external override {
        if (msg.sender != escrow) revert NotEscrow();
        if (amount == 0) revert ZeroAmount();

        SpendRecord storage record = _spends[escrowId];
        uint128 committed = record.amount;
        // An escrow id this account never locked against has nothing to give back, so a
        // compromised escrow cannot mint allowance out of another payer's lock.
        if (committed == 0) revert UnknownSpend();
        if (amount > committed) revert CreditExceedsSpend();

        // Decremented rather than cleared: a split ruling refunds part of the lock, and the
        // rest can still come back later through a second exit.
        record.amount = committed - amount;

        Window memory daily = _rolled(_daily);
        Window memory monthly = _rolled(_monthly);

        // Epoch equality is the whole test. Same epoch means the bucket that funded this
        // spend is still the live one; a different epoch means the window rolled and the
        // allowance went with it. The floor at zero cannot bind while that holds, since
        // credits inside an epoch never exceed the spends recorded in it, but it keeps a
        // future caller from turning an arithmetic surprise into a stuck refund.
        uint128 total = totalSpent;
        totalSpent = total > amount ? total - amount : 0;

        if (daily.epoch == record.dailyEpoch) {
            daily.spent = daily.spent > amount ? daily.spent - amount : 0;
        }
        if (monthly.epoch == record.monthlyEpoch) {
            monthly.spent = monthly.spent > amount ? monthly.spent - amount : 0;
        }

        _daily = daily;
        _monthly = monthly;

        emit SpendCredited(escrowId, amount, daily.spent, monthly.spent);
    }

    function deposit(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();

        IERC20 asset = IERC20(settlementAsset);
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = asset.balanceOf(address(this));

        // The credited figure is the delta, since a fee-taking asset delivers less than it
        // was asked to move and the mandate is funded for what arrived. An asset that
        // delivers nothing, or more than it was asked to, is rejected outright: the escrow
        // settles every lock at its face amount and survives neither.
        if (balanceAfter < balanceBefore) revert TransferMismatch();
        uint256 received = balanceAfter - balanceBefore;
        if (received == 0 || received > amount) revert TransferMismatch();

        emit Deposited(msg.sender, received);
    }

    function withdraw(address token, address to, uint256 amount) external override onlyPrincipal nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();

        IERC20(token).safeTransfer(to, amount);

        emit Withdrawn(token, to, amount);
    }

    function setAgent(address agent_) external override onlyPrincipal {
        agent = agent_;
        revoked = false;

        emit AgentUpdated(agent_);
    }

    function revokeAgent() external override onlyPrincipal {
        address revokedAgent = agent;

        agent = address(0);
        revoked = true;

        emit AgentRevoked(revokedAgent);
    }

    function setLimits(Limits calldata limits_) external override onlyPrincipal {
        // A limit set the principal writes directly outranks anything signed earlier, so the
        // nonce moves here too and strands authorizations that were held back.
        ++nonce;

        _setLimits(limits_);
    }

    function setLimitsWithAuthorization(
        Limits calldata limits_,
        uint256 nonce_,
        uint64 deadline,
        bytes calldata signature
    ) external override {
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (nonce_ != nonce) revert BadNonce();

        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(_SET_LIMITS_TYPEHASH, _hashLimits(limits_), nonce_, deadline)));
        if (!SignatureChecker.isValidSignatureNow(principal, digest, signature)) revert BadSignature();

        ++nonce;

        _setLimits(limits_);
    }

    function setMerchant(address merchant, bool allowed) external override onlyPrincipal {
        if (merchant == address(0)) revert ZeroAddress();
        // Editing the roster the gate is not reading invites the belief that a merchant was
        // revoked when the live gate still pays it.
        if (merchantGate == MerchantGate.MerkleRoot) revert MerkleGateActive();

        merchants[merchant] = allowed;

        emit MerchantUpdated(merchant, allowed);
    }

    function setMerchantGate(MerchantGate gate, bytes32 root) external override onlyPrincipal {
        if (gate == MerchantGate.MerkleRoot) {
            if (root == bytes32(0)) revert BadMerkleProof();
        } else if (root != bytes32(0)) {
            revert BadMerkleProof();
        }

        merchantGate = gate;
        merchantRoot = root;

        emit MerchantGateUpdated(gate, root);
    }

    function setCapability(bytes32 capabilityId, bool allowed) external override onlyPrincipal {
        capabilities[capabilityId] = allowed;

        emit CapabilityUpdated(capabilityId, allowed);
    }

    function setPaused(bool paused_) external override onlyPrincipal {
        paused = paused_;

        emit PausedUpdated(paused_);
    }

    function setDocumentHash(bytes32 documentHash_) external override onlyPrincipal {
        documentHash = documentHash_;

        emit DocumentHashUpdated(documentHash_);
    }

    function approveSpend(SpendApproval calldata approval) external override onlyPrincipal {
        if (approval.merchant == address(0)) revert ZeroAddress();
        if (approval.amount == 0) revert ZeroAmount();
        // An approval that never expires is a second mandate with no limits attached to it.
        if (block.timestamp > approval.expiry) revert ApprovalExpired();

        Approval storage stored = _approvals[approvalEpoch][approval.approvalId];
        if (stored.spent) revert ApprovalSpent();

        stored.digest = _approvalDigest(approval);

        emit SpendApproved(approval.approvalId, approval.merchant, approval.amount, approval.expiry);
    }

    function revokeApproval(bytes32 approvalId) external override onlyPrincipal {
        Approval storage stored = _approvals[approvalEpoch][approvalId];
        if (stored.spent) revert ApprovalSpent();

        // Burning the id is what reaches an approval that only ever existed as a signature.
        stored.spent = true;

        emit ApprovalRevoked(approvalId);
    }

    function transferPrincipal(address to) external override onlyPrincipal {
        if (to == address(0)) revert ZeroAddress();

        pendingPrincipal = to;

        emit PrincipalTransferStarted(msg.sender, to);
    }

    function acceptPrincipal() external override {
        if (msg.sender != pendingPrincipal) revert NotPendingPrincipal();

        address from = principal;
        principal = msg.sender;
        pendingPrincipal = address(0);

        // Consent does not transfer. Approvals the previous principal registered, and limit
        // changes it signed and held back, would otherwise stay spendable under the new one.
        ++approvalEpoch;
        ++nonce;

        emit PrincipalTransferred(from, msg.sender);
    }

    function previewSpend(address merchant, bytes32 capabilityId, uint128 amount, uint8 spendClass)
        external
        view
        override
        returns (bool allowed, bytes4 reason)
    {
        reason = _reason(spendClass, capabilityId, amount, false, _merchantReason(merchant));
        allowed = reason == bytes4(0);
    }

    function remaining() public view override returns (uint128 perCall, uint128 daily, uint128 monthly) {
        Window memory d = _rolled(_daily);
        Window memory m = _rolled(_monthly);

        perCall = perCallCap;
        daily = d.cap > d.spent ? d.cap - d.spent : 0;
        monthly = m.cap > m.spent ? m.cap - m.spent : 0;
    }

    function remainingTotal() public view override returns (uint128) {
        uint128 cap = totalCap;
        if (cap == 0) return type(uint128).max;
        uint128 spent = totalSpent;
        return cap > spent ? cap - spent : 0;
    }

    function buy(address asset, uint128 usdgIn, uint128 minOut, uint256 quotedPriceE8)
        external
        override
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != agent) revert NotAgent();
        if (asset == address(0)) revert ZeroAddress();

        bytes4 reason = _reason(CLASS_RWA, bytes32(0), usdgIn, false, bytes4(0));
        if (reason != bytes4(0)) _raise(reason);

        address router_ = router;
        if (router_ == address(0)) revert RouterNotSet();

        // Counted like any spend and never credited back: a fill is final.
        _commit(usdgIn);

        IERC20 usdg = IERC20(settlementAsset);
        IERC20 bought = IERC20(asset);
        uint256 heldBefore = bought.balanceOf(address(this));

        usdg.forceApprove(router_, usdgIn);
        IStockRouter(router_).buy(asset, usdgIn, minOut, quotedPriceE8, address(this));
        usdg.forceApprove(router_, 0);

        // Measured, not taken from the router's return, which is the router's own claim.
        amountOut = bought.balanceOf(address(this)) - heldBefore;
        if (amountOut < minOut) revert InsufficientOutput();

        emit Bought(asset, usdgIn, amountOut, quotedPriceE8);
    }

    function setRouter(address router_) external override onlyPrincipal {
        router = router_;
        emit RouterUpdated(router_);
    }

    function setTermsCommitment(bytes32 termsCommitment_, address verifier_) external override onlyPrincipal {
        termsCommitment = termsCommitment_;
        verifier = verifier_;
        emit TermsCommitted(termsCommitment_, verifier_);
    }

    function grantDisclosure(uint256 escrowId, address resolver, bytes32 sliceCommit, bytes calldata ciphertext)
        external
        override
        onlyPrincipal
    {
        IEscrow(escrow).grantDisclosure(escrowId, resolver, sliceCommit, ciphertext);
    }

    function limits() external view override returns (Limits memory) {
        return Limits({
            perCallCap: perCallCap,
            dailyCap: _daily.cap,
            monthlyCap: _monthly.cap,
            dailyWindow: _daily.duration,
            monthlyWindow: _monthly.duration,
            approvalThreshold: approvalThreshold,
            validFrom: validFrom,
            validUntil: validUntil,
            classMask: classMask,
            totalCap: totalCap,
            lane: lane
        });
    }

    /// Reported after the rollover a spend in this block would apply, so a reader never sees
    /// a bucket that is full on paper and empty in practice.
    function window(WindowKind kind) external view override returns (Window memory) {
        return _rolled(kind == WindowKind.Daily ? _daily : _monthly);
    }

    function approvals(bytes32 approvalId) external view override returns (bool registered, bool spent) {
        Approval storage stored = _approvals[approvalEpoch][approvalId];
        return (stored.digest != bytes32(0), stored.spent);
    }

    function creditable(uint256 escrowId) external view override returns (uint128) {
        return _spends[escrowId].amount;
    }

    // forge-lint: disable-next-item(mixed-case-function)
    function DOMAIN_SEPARATOR() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    // forge-lint: disable-next-item(mixed-case-function)
    function LIMITS_TYPEHASH() external pure override returns (bytes32) {
        return _LIMITS_TYPEHASH;
    }

    // forge-lint: disable-next-item(mixed-case-function)
    function SET_LIMITS_TYPEHASH() external pure override returns (bytes32) {
        return _SET_LIMITS_TYPEHASH;
    }

    // forge-lint: disable-next-item(mixed-case-function)
    function SPEND_APPROVAL_TYPEHASH() external pure override returns (bytes32) {
        return _SPEND_APPROVAL_TYPEHASH;
    }

    function merchantLeaf(address merchant) public pure override returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(merchant))));
    }

    function _spend(SpendRequest calldata request, bytes32[] calldata merchantProof, bool approved)
        private
        returns (uint256 escrowId)
    {
        if (msg.sender != agent) revert NotAgent();

        // Stocks settle through `buy`, never through an escrow lock.
        if (request.spendClass > CLASS_HIRE) revert ClassNotAllowed();

        bytes4 reason = _reason(
            request.spendClass,
            request.capabilityId,
            request.amount,
            approved,
            _merchantReason(request.merchant, merchantProof)
        );
        if (reason != bytes4(0)) _raise(reason);

        (Window memory daily, Window memory monthly) = _commit(request.amount);

        // The escrow pulls the exact amount inside lock, so no agent-usable allowance
        // survives this call.
        IERC20(settlementAsset).forceApprove(escrow, request.amount);
        escrowId = IEscrow(escrow)
            .lock(
                request.merchant,
                request.capabilityId,
                request.inputCommit,
                request.inputURI,
                request.amount,
                request.deadline
            );

        // Written after the lock, since the escrow is what assigns the id. Nothing can be
        // credited against an id that does not exist yet: a credit reentered from inside
        // `lock` finds no record and reverts.
        _spends[escrowId] = SpendRecord({amount: request.amount, dailyEpoch: daily.epoch, monthlyEpoch: monthly.epoch});

        emit Spent(escrowId, request.merchant, request.capabilityId, request.amount, daily.spent, monthly.spent);
    }

    /// Mirrors the escrow's own truncation. A bond computed any other way would either leave
    /// the dispute short of allowance or leave a remainder standing against the escrow.
    function _bond(IEscrow escrow_, uint256 escrowId) private view returns (uint128) {
        uint256 amount = escrow_.getLock(escrowId).amount;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128((amount * escrow_.disputeBondBps()) / 10_000);
    }

    /// The caps count committed spend from the moment it is committed. It comes back only
    /// through `creditSpend`, which the escrow calls on an exit that did not pay the merchant.
    /// A mandate cannot be recycled by churning locks that settle.
    function _commit(uint128 amount) private returns (Window memory daily, Window memory monthly) {
        daily = _rolled(_daily);
        monthly = _rolled(_monthly);

        daily.spent += amount;
        monthly.spent += amount;
        _daily = daily;
        _monthly = monthly;
        totalSpent += amount;
    }

    /// One decision function behind `spend`, `buy` and `previewSpend`. It returns the selector
    /// instead of reverting, so a quote can never disagree with the settlement that follows.
    /// A stock purchase has no capability or merchant, so it skips the capability check.
    function _reason(uint8 spendClass, bytes32 capabilityId, uint128 amount, bool approved, bytes4 merchantReason)
        private
        view
        returns (bytes4)
    {
        if (paused) return IsPaused.selector;
        if (revoked) return IsRevoked.selector;
        if (amount == 0) return ZeroAmount.selector;
        if (block.timestamp < validFrom) return NotYetValid.selector;
        if (validUntil != 0 && block.timestamp > validUntil) return Expired.selector;
        if (spendClass > CLASS_RWA || classMask & (uint32(1) << spendClass) == 0) return ClassNotAllowed.selector;
        if (spendClass != CLASS_RWA && !capabilities[capabilityId]) return CapabilityNotAllowed.selector;
        if (amount > perCallCap) return PerCallCapExceeded.selector;

        (, uint128 daily, uint128 monthly) = remaining();
        if (amount > daily) return DailyCapExceeded.selector;
        if (amount > monthly) return MonthlyCapExceeded.selector;
        if (amount > remainingTotal()) return TotalCapExceeded.selector;

        if (merchantReason != bytes4(0)) return merchantReason;
        // Last, so a spend that needs consent and also breaks a cap reports the cap. Consent
        // is a routing instruction; the cap is a refusal.
        if (!approved && amount >= approvalThreshold) return ApprovalRequired.selector;

        return bytes4(0);
    }

    function _merchantReason(address merchant, bytes32[] calldata proof) private view returns (bytes4) {
        if (merchant == address(0)) return ZeroAddress.selector;

        if (merchantGate == MerchantGate.Allowlist) {
            // A proof carried into an allowlist gate is a proof against a root nobody reads.
            if (proof.length != 0) return AllowlistGateActive.selector;
            return merchants[merchant] ? bytes4(0) : MerchantNotAllowed.selector;
        }

        return
            MerkleProof.verifyCalldata(proof, merchantRoot, merchantLeaf(merchant))
                ? bytes4(0)
                : BadMerkleProof.selector;
    }

    /// `previewSpend` carries no proof, so under a Merkle gate the merchant is the one term
    /// the account cannot settle. Every other check still reports, which leaves the caller
    /// with a single question to answer off chain.
    function _merchantReason(address merchant) private view returns (bytes4) {
        if (merchant == address(0)) return ZeroAddress.selector;
        if (merchantGate == MerchantGate.MerkleRoot) return MerkleGateActive.selector;
        return merchants[merchant] ? bytes4(0) : MerchantNotAllowed.selector;
    }

    function _setLimits(Limits memory limits_) private {
        if (limits_.dailyWindow == 0 || limits_.monthlyWindow == 0) revert BadWindow();
        if (limits_.validUntil != 0 && limits_.validUntil <= limits_.validFrom) revert BadValidity();
        // The threshold binds at and above, so zero puts every spend behind the principal's
        // signature. A mandate deployed with the field left at its default would refuse the
        // agent's first call and read as an outage. Zero is refused here, and `1` is the value
        // that puts every spend behind the signature.
        if (limits_.approvalThreshold == 0) revert BadApprovalThreshold();
        if (limits_.classMask == 0 || limits_.classMask >> (CLASS_RWA + 1) != 0) revert BadClassMask();
        if (limits_.lane > MAX_LANE) revert BadLane();

        perCallCap = limits_.perCallCap;
        classMask = limits_.classMask;
        totalCap = limits_.totalCap;
        lane = limits_.lane;
        approvalThreshold = limits_.approvalThreshold;
        validFrom = limits_.validFrom;
        validUntil = limits_.validUntil;

        // Roll first, then re-anchor: a bucket that had already elapsed clears, one that had
        // not carries its spend into the new window. Without the second half, a principal
        // could free a full daily allowance by rewriting the same limits.
        Window memory daily = _rolled(_daily);
        Window memory monthly = _rolled(_monthly);

        daily.cap = limits_.dailyCap;
        daily.duration = limits_.dailyWindow;
        daily.start = uint64(block.timestamp);

        monthly.cap = limits_.monthlyCap;
        monthly.duration = limits_.monthlyWindow;
        monthly.start = uint64(block.timestamp);

        _daily = daily;
        _monthly = monthly;

        ++version;

        emit LimitsUpdated(version, limits_);
    }

    /// Advances `start` by whole periods. The part of the current period that has already
    /// elapsed counts against it. Snapping to now would let
    /// an agent that waits out a window buy itself a fresh one on a schedule of its choosing.
    function _rolled(Window memory w) private view returns (Window memory) {
        if (w.duration == 0) return w;

        uint256 elapsed = block.timestamp - w.start;
        if (elapsed < w.duration) return w;

        unchecked {
            // Truncating first keeps the remainder: the part of the new window that has
            // already run stays on the clock.
            // forge-lint: disable-next-line(divide-before-multiply)
            w.start += uint64((elapsed / w.duration) * w.duration);
            // Epochs count resets, not elapsed periods. A credit only has to know whether the
            // bucket it was drawn from is still the one being spent against.
            ++w.epoch;
        }
        w.spent = 0;

        return w;
    }

    function _hashLimits(Limits memory limits_) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _LIMITS_TYPEHASH,
                limits_.perCallCap,
                limits_.dailyCap,
                limits_.monthlyCap,
                limits_.dailyWindow,
                limits_.monthlyWindow,
                limits_.approvalThreshold,
                limits_.validFrom,
                limits_.validUntil,
                limits_.classMask,
                limits_.totalCap,
                limits_.lane
            )
        );
    }

    /// The domain binds chain and account, so an approval signed for one mandate is not a
    /// signature for another the same principal holds.
    function _approvalDigest(SpendApproval calldata approval) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    _SPEND_APPROVAL_TYPEHASH,
                    approval.approvalId,
                    approval.merchant,
                    approval.capabilityId,
                    approval.amount,
                    approval.expiry
                )
            )
        );
    }

    function _raise(bytes4 reason) private pure {
        assembly ("memory-safe") {
            mstore(0x00, reason)
            revert(0x00, 0x04)
        }
    }
}
