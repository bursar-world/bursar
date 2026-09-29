// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IEscrow} from "../interfaces/IEscrow.sol";

interface IWithinMandateVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[10] calldata publicSignals
    ) external view returns (bool);
}

/// A mandate whose terms live off chain. The account holds a Poseidon commitment to the terms and
/// a commitment to its running counters, and nothing else about them: no cap, no class mask, no
/// counterparty list and no spend total is in storage or in an event. Every spend carries a
/// Groth16 proof (circuits/src/within_mandate.circom) that it fits the committed terms, and the
/// escrow lock opens only after the verifier accepts it.
///
/// What stays public: the amount and the payee, because the escrow lock and the USDG transfer
/// carry them, and the principal, because it is the address that controls this account.
///
/// The readable terms are sealed to the principal's viewing key and published once as
/// ciphertext in `TermsSealed`, so the principal's console can recover them from the chain alone.
contract CommittedMandateAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error NotPrincipal();
    error NotAgent();
    error NotEscrow();
    error NotFactory();
    error AlreadySealed();
    error Paused();
    error Revoked();
    error BadClass();
    error BadTime();
    error NullifierUsed();
    error BadProof();
    error ZeroAmount();

    event TermsSealed(uint64 indexed version, uint256 termsCommitment, bytes ciphertext);
    event ProvenSpend(uint256 indexed escrowId, uint256 nullifier, uint256 counter);
    event AgentUpdated(address indexed agent);
    event PausedSet(bool paused);
    event MandateRevoked(uint256 swept);
    event Withdrawn(address indexed to, uint256 amount);

    /// The widest gap allowed between the time a proof was built for and the block that lands
    /// it. The proof shows `now <= expiry`, and the account requires `block.timestamp <= now`, so
    /// an expired mandate can never spend; the slack only bounds how far ahead a prover may aim.
    uint64 public constant NOW_SLACK = 15 minutes;

    /// Escrow lanes carry services (0) and agent hires (1).
    uint8 private constant MAX_ESCROW_CLASS = 1;

    // forge-lint: disable-start(screaming-snake-case-immutable)
    address public immutable settlementAsset;
    address public immutable escrow;
    address public immutable verifier;
    address public immutable factory;
    // forge-lint: disable-end

    address public principal;
    address public agent;
    bool public paused;
    bool public revoked;
    uint64 public version;
    uint64 public nonce;

    uint256 public termsCommitment;
    uint256 public counter;

    mapping(uint256 => bool) public nullifierUsed;

    struct Spend {
        address payee;
        bytes32 capabilityId;
        bytes32 inputCommit;
        string inputURI;
        uint128 amount;
        uint64 deadline;
        uint8 classId;
        uint64 provenAt;
        uint256 newCounter;
        uint256 nullifier;
    }

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    modifier onlyPrincipal() {
        if (msg.sender != principal) revert NotPrincipal();
        _;
    }

    constructor(
        address principal_,
        address agent_,
        address settlementAsset_,
        address escrow_,
        address verifier_,
        uint256 termsCommitment_,
        uint256 counter_
    ) {
        if (
            principal_ == address(0) || settlementAsset_ == address(0) || escrow_ == address(0)
                || verifier_ == address(0)
        ) revert ZeroAddress();
        principal = principal_;
        agent = agent_;
        settlementAsset = settlementAsset_;
        escrow = escrow_;
        verifier = verifier_;
        factory = msg.sender;
        termsCommitment = termsCommitment_;
        counter = counter_;
    }

    /// Called once by the factory in the creating transaction, so the first ciphertext is on
    /// chain in the same block as the account and the address does not depend on it.
    function sealInitial(bytes calldata ciphertext) external {
        if (msg.sender != factory) revert NotFactory();
        if (version != 0) revert AlreadySealed();
        version = 1;
        emit TermsSealed(1, termsCommitment, ciphertext);
    }

    function spend(Spend calldata s, Proof calldata proof) external nonReentrant returns (uint256 escrowId) {
        if (msg.sender != agent && msg.sender != principal) revert NotAgent();
        if (revoked) revert Revoked();
        if (paused) revert Paused();
        if (s.amount == 0) revert ZeroAmount();
        if (s.classId > MAX_ESCROW_CLASS) revert BadClass();
        if (s.provenAt < block.timestamp || s.provenAt > block.timestamp + NOW_SLACK) revert BadTime();
        if (nullifierUsed[s.nullifier]) revert NullifierUsed();

        uint256[10] memory signals = [
            uint256(uint160(address(this))),
            termsCommitment,
            counter,
            s.newCounter,
            s.nullifier,
            uint256(s.amount),
            uint256(uint160(s.payee)),
            uint256(s.classId),
            uint256(s.provenAt),
            uint256(nonce)
        ];
        if (!IWithinMandateVerifier(verifier).verifyProof(proof.a, proof.b, proof.c, signals)) revert BadProof();

        nullifierUsed[s.nullifier] = true;
        counter = s.newCounter;
        nonce += 1;

        IERC20 asset = IERC20(settlementAsset);
        asset.forceApprove(escrow, s.amount);
        escrowId = IEscrow(escrow).lock(s.payee, s.capabilityId, s.inputCommit, s.inputURI, s.amount, s.deadline);
        asset.forceApprove(escrow, 0);

        emit ProvenSpend(escrowId, s.nullifier, s.newCounter);
    }

    /// Replaces the terms. The principal knows the counters, so it supplies the counter the new
    /// terms start from; a principal that wants a clean slate commits to zero spend.
    function amend(uint256 termsCommitment_, uint256 counter_, uint64 nonce_, bytes calldata ciphertext)
        external
        onlyPrincipal
    {
        termsCommitment = termsCommitment_;
        counter = counter_;
        nonce = nonce_;
        uint64 next = version + 1;
        version = next;
        emit TermsSealed(next, termsCommitment_, ciphertext);
    }

    /// Refunds land back in the balance. The confidential counters are not credited, because the
    /// account cannot open them; a principal who wants the allowance back amends the counter.
    function creditSpend(uint256, uint128) external view {
        if (msg.sender != escrow) revert NotEscrow();
    }

    function disputeSpend(uint256 escrowId) external onlyPrincipal nonReentrant {
        IEscrow escrow_ = IEscrow(escrow);
        IEscrow.Lock memory entry = escrow_.getLock(escrowId);
        uint256 bond = (uint256(entry.amount) * escrow_.disputeBondBps()) / 10_000;
        IERC20 asset = IERC20(settlementAsset);
        if (bond != 0) asset.forceApprove(escrow, bond);
        escrow_.dispute(escrowId);
        if (bond != 0) asset.forceApprove(escrow, 0);
    }

    /// Passes a disclosure for one resolver through to the escrow, as the payer of the lock.
    function grantDisclosure(uint256 escrowId, address resolver, bytes32 sliceCommit, bytes calldata ciphertext)
        external
        onlyPrincipal
    {
        IEscrow(escrow).grantDisclosure(escrowId, resolver, sliceCommit, ciphertext);
    }

    function setAgent(address agent_) external onlyPrincipal {
        agent = agent_;
        emit AgentUpdated(agent_);
    }

    function setPaused(bool paused_) external onlyPrincipal {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function withdraw(address to, uint256 amount) external onlyPrincipal nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(settlementAsset).safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function revoke() external onlyPrincipal nonReentrant {
        revoked = true;
        IERC20 asset = IERC20(settlementAsset);
        uint256 balance = asset.balanceOf(address(this));
        if (balance != 0) asset.safeTransfer(principal, balance);
        emit MandateRevoked(balance);
    }
}
