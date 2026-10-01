// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IEscrow} from "../interfaces/IEscrow.sol";

// The verifier is written by snarkjs, which declares no interface. Every proof the tests
// verify reaches it through this one.
// slither-disable-next-line missing-inheritance
interface IWithinMandateVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[11] calldata publicSignals
    ) external view returns (bool);
}

/// A mandate whose terms live off chain. The account holds a Poseidon commitment to the terms and
/// a commitment to its running counters, and nothing else about them: no committed cap,
/// capability list, counterparty list or counter value is in storage or in an event; `ceiling`
/// and `lockedTotal` below are the public exceptions. Every spend carries a Groth16 proof
/// (circuits/src/within_mandate.circom) that it fits the committed terms, and the escrow lock
/// opens only after the verifier accepts it.
///
/// What stays public: the amount, the payee and the capability of each spend, because the escrow
/// lock carries them; the time each proof was made for; and the principal, because it is the
/// address that controls this account.
///
/// Until the proving key has a multi-party setup, the terms are not the only limit. Every account
/// carries a ceiling fixed by its factory, and `lockedTotal` counts everything it has ever locked
/// against it, so even a proof forged with a compromised key cannot move more than the ceiling.
///
/// The readable terms are sealed to the principal's viewing key and published as ciphertext in
/// `TermsSealed`, so the principal's console can recover them from the chain alone. Disclosure for
/// a disputed lock goes through DisclosureRegistry, which takes the principal's grant directly.
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
    error BadTime();
    error NullifierUsed();
    error BadProof();
    error ZeroAmount();
    error OverCeiling(uint256 lockedTotal, uint256 ceiling);
    error NonceBehind(uint64 nonce, uint64 current);

    event TermsSealed(uint64 indexed version, uint256 termsCommitment, bytes ciphertext);
    event ProvenSpend(uint256 indexed escrowId, uint256 nullifier, uint256 counter, uint64 provenAt, uint64 version);
    event AgentUpdated(address indexed agent);
    event PausedSet(bool paused);
    event MandateRevoked(uint256 swept);
    event Withdrawn(address indexed to, uint256 amount);

    /// The widest gap allowed between the time a proof was built for and the block that lands
    /// it. The proof shows `now <= expiry`, and the account requires `block.timestamp <= now`, so
    /// an expired mandate can never spend; the slack only bounds how far ahead a prover may aim.
    uint64 public constant NOW_SLACK = 15 minutes;

    // forge-lint: disable-start(screaming-snake-case-immutable)
    address public immutable settlementAsset;
    address public immutable escrow;
    address public immutable verifier;
    address public immutable factory;
    /// The most this account can ever lock, whatever the terms or the proofs say.
    uint256 public immutable ceiling;
    // forge-lint: disable-end

    address public principal;
    address public agent;
    bool public paused;
    bool public revoked;
    uint64 public version;
    uint64 public nonce;

    uint256 public termsCommitment;
    uint256 public counter;

    /// Every amount this account has locked, never reduced: refunds and amendments leave it where
    /// it is, so the ceiling bounds the account's whole life.
    uint256 public lockedTotal;

    mapping(uint256 => bool) public nullifierUsed;

    struct Spend {
        address payee;
        bytes32 capabilityId;
        bytes32 inputCommit;
        string inputURI;
        uint128 amount;
        uint64 deadline;
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
        uint256 counter_,
        uint256 ceiling_
    ) {
        if (
            principal_ == address(0) || settlementAsset_ == address(0) || escrow_ == address(0)
                || verifier_ == address(0)
        ) revert ZeroAddress();
        principal = principal_;
        // No agent is a valid start: the principal can spend itself and name one later.
        // slither-disable-next-line missing-zero-check
        agent = agent_;
        settlementAsset = settlementAsset_;
        escrow = escrow_;
        verifier = verifier_;
        factory = msg.sender;
        ceiling = ceiling_;
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
        if (s.provenAt < block.timestamp || s.provenAt > block.timestamp + NOW_SLACK) revert BadTime();
        if (nullifierUsed[s.nullifier]) revert NullifierUsed();
        uint256 locked = lockedTotal + s.amount;
        if (locked > ceiling) revert OverCeiling(locked, ceiling);

        // A capability id is 32 bytes and a field element is not, so the circuit takes it in halves.
        uint256 capability = uint256(s.capabilityId);
        uint256[11] memory signals = [
            uint256(uint160(address(this))),
            termsCommitment,
            counter,
            s.newCounter,
            s.nullifier,
            uint256(s.amount),
            uint256(uint160(s.payee)),
            capability >> 128,
            uint256(uint128(capability)),
            uint256(s.provenAt),
            uint256(nonce)
        ];
        if (!IWithinMandateVerifier(verifier).verifyProof(proof.a, proof.b, proof.c, signals)) revert BadProof();

        nullifierUsed[s.nullifier] = true;
        counter = s.newCounter;
        nonce += 1;
        lockedTotal = locked;

        IERC20 asset = IERC20(settlementAsset);
        asset.forceApprove(escrow, s.amount);
        escrowId = IEscrow(escrow).lock(s.payee, s.capabilityId, s.inputCommit, s.inputURI, s.amount, s.deadline);
        asset.forceApprove(escrow, 0);

        emit ProvenSpend(escrowId, s.nullifier, s.newCounter, s.provenAt, version);
    }

    /// Replaces the terms. The principal knows the counters, so it supplies the counter the new
    /// terms start from. The nonce cannot go back: proofs and their nullifiers are numbered by it,
    /// so a rewound nonce would collide with nullifiers already spent and could revive a proof made
    /// for an earlier counter.
    function amend(uint256 termsCommitment_, uint256 counter_, uint64 nonce_, bytes calldata ciphertext)
        external
        onlyPrincipal
    {
        if (nonce_ < nonce) revert NonceBehind(nonce_, nonce);
        termsCommitment = termsCommitment_;
        counter = counter_;
        nonce = nonce_;
        uint64 next = version + 1;
        version = next;
        emit TermsSealed(next, termsCommitment_, ciphertext);
    }

    /// Refunds (a timeout, a cancellation, a ruling for the payer) land back in the balance and
    /// change nothing else. The confidential counter stays where the proof left it, because the
    /// account cannot open it, and `lockedTotal` stays too. A principal who wants the refunded
    /// allowance back amends the terms with a counter that leaves the refund out; the ceiling
    /// still counts it.
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

    function setAgent(address agent_) external onlyPrincipal {
        // Zero removes the agent and leaves the principal as the only spender.
        // slither-disable-next-line missing-zero-check
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
