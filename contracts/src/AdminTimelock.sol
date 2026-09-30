// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Two-of-three control with a mandatory delay, used as the admin of every contract in the
/// deployment until control is handed to a multisig.
///
/// The delay is the product: two signers agreeing is what authorises a change, and the wait
/// between authorisation and execution is what gives everyone else time to read it and act.
/// A timelock that can execute in the same block is a multisig with extra steps, so the
/// period is fixed at construction, floored, and has no setter.
///
/// The floor is one hour in this development deployment and forty-eight hours at launch. A
/// principal can pause a mandate or pull its funds inside either. A staked party cannot leave
/// inside either: agent stakes, resolver bonds and BRSR stakes take seven days to come out
/// whatever the delay, so for them a pending change is notice, not an exit.
///
/// Proposals carry calldata only. Value moves in the settlement asset, so a treasury
/// transfer is a proposal whose target is the token, and this contract never holds or sends
/// native value.
///
/// The one exception to the delay is the brake. A pause that takes two days to land is not a
/// brake at all, so a guardian key can stop any administered contract in the same block. It
/// can do nothing else: the calldata for that path is built here, not supplied, and it is
/// always `pause()`. Restarting stays a proposal. A stolen guardian key is an outage, not a
/// loss, and rotating the guardian is a proposal too.
contract AdminTimelock {
    error NotSigner();
    error NotGuardian();
    error NotSelf();
    error InvalidSignerIndex();
    error DuplicateSigner();
    error ZeroAddress();
    error BadPeriod();
    error ProposalNotFound();
    error AlreadyApproved();
    error InsufficientApprovals();
    error TimelockNotExpired();
    error ProposalExpired();
    error AlreadyExecuted();
    error AlreadyCancelled();
    error ExecutionFailed();
    error AlreadyVetoed();

    struct Proposal {
        address target;
        bytes data;
        uint64 createdAt;
        uint64 executeAfter;
        bool executed;
        bool cancelled;
    }

    event ProposalCreated(uint256 indexed id, address indexed target, bytes data, uint64 executeAfter);
    event ProposalApproved(uint256 indexed id, address indexed signer, uint256 approvals);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCancelled(uint256 indexed id, address indexed signer);
    event ProposalVetoed(uint256 indexed id, address indexed signer, uint256 vetoes);
    event SignerUpdated(uint256 indexed index, address indexed from, address indexed to);
    event GuardianUpdated(address indexed from, address indexed to);
    event GuardianPaused(address indexed target, address indexed guardian);
    event GuardianPauseSkipped(address indexed target, address indexed guardian, bytes reason);

    uint256 public constant REQUIRED_APPROVALS = 2;
    uint256 public constant SIGNER_COUNT = 3;

    /// One hour in this development deployment. Launch raises it to forty-eight hours, long
    /// enough for anyone watching a mandate to act on a pending change before it lands.
    uint64 public constant MIN_TIMELOCK_PERIOD = 1 hours;

    /// A delay past this stops being governance and starts being an outage.
    uint64 public constant MAX_TIMELOCK_PERIOD = 30 days;

    /// A proposal that has waited out its delay and then sat unexecuted for this long is
    /// stale: the state it was written against has moved, and it has to be proposed again.
    uint64 public constant GRACE_PERIOD = 14 days;

    // Lowercase to sit alongside MIN_TIMELOCK_PERIOD and MAX_TIMELOCK_PERIOD without reading as
    // a third constant.
    // forge-lint: disable-next-item(screaming-snake-case-immutable)
    uint64 public immutable timelockPeriod;

    address[3] public signers;

    /// Holds the brake and nothing else, and is barred from the signer set: the key that has
    /// to be reachable in seconds during an incident is the one most likely to be warm, and a
    /// warm key should not also carry one of the two approvals a change needs.
    address public guardian;

    uint256 public proposalCount;

    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) public hasApproved;
    mapping(uint256 => mapping(address => bool)) public hasVetoed;
    mapping(uint256 => address) public proposerOf;

    modifier onlySigner() {
        if (!isSigner(msg.sender)) revert NotSigner();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier exists(uint256 id) {
        if (_proposals[id].createdAt == 0) revert ProposalNotFound();
        _;
    }

    constructor(address[3] memory initialSigners, address initialGuardian, uint64 period) {
        if (period < MIN_TIMELOCK_PERIOD || period > MAX_TIMELOCK_PERIOD) revert BadPeriod();
        if (initialGuardian == address(0)) revert ZeroAddress();

        for (uint256 i = 0; i < SIGNER_COUNT; ++i) {
            address signer = initialSigners[i];
            if (signer == address(0)) revert ZeroAddress();
            // Duplicates would silently turn two-of-three into two-of-two.
            for (uint256 j = 0; j < i; ++j) {
                if (initialSigners[j] == signer) revert DuplicateSigner();
            }
            signers[i] = signer;
        }

        if (isSigner(initialGuardian)) revert DuplicateSigner();

        guardian = initialGuardian;
        timelockPeriod = period;

        emit GuardianUpdated(address(0), initialGuardian);
    }

    /// Proposing counts as the proposer's approval, so a two-of-three change needs one more
    /// signer and not two.
    function propose(address target, bytes calldata data) external onlySigner returns (uint256 id) {
        if (target == address(0)) revert ZeroAddress();

        id = proposalCount++;
        uint64 executeAfter = uint64(block.timestamp) + timelockPeriod;

        _proposals[id] = Proposal({
            target: target,
            data: data,
            createdAt: uint64(block.timestamp),
            executeAfter: executeAfter,
            executed: false,
            cancelled: false
        });
        hasApproved[id][msg.sender] = true;
        proposerOf[id] = msg.sender;

        emit ProposalCreated(id, target, data, executeAfter);
        emit ProposalApproved(id, msg.sender, 1);
    }

    function approve(uint256 id) external onlySigner exists(id) {
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.cancelled) revert AlreadyCancelled();
        if (hasApproved[id][msg.sender]) revert AlreadyApproved();

        hasApproved[id][msg.sender] = true;

        emit ProposalApproved(id, msg.sender, approvals(id));
    }

    /// Reverts with the target's own error when the call fails, because a bare
    /// `ExecutionFailed` after a two-day wait tells a signer nothing about what to fix.
    function execute(uint256 id) external onlySigner exists(id) returns (bytes memory result) {
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.cancelled) revert AlreadyCancelled();
        if (approvals(id) < REQUIRED_APPROVALS) revert InsufficientApprovals();
        if (block.timestamp < p.executeAfter) revert TimelockNotExpired();
        if (block.timestamp > p.executeAfter + GRACE_PERIOD) revert ProposalExpired();

        p.executed = true;
        result = _call(p.target, p.data);

        emit ProposalExecuted(id);
    }

    /// The proposer withdraws its own proposal alone. Anyone else's takes two vetoes, the same
    /// two signers a change needs, so one key cannot block its own removal or hold a pause in
    /// place by cancelling every unpause.
    function cancel(uint256 id) external onlySigner exists(id) {
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.cancelled) revert AlreadyCancelled();

        if (proposerOf[id] != msg.sender) {
            if (hasVetoed[id][msg.sender]) revert AlreadyVetoed();
            hasVetoed[id][msg.sender] = true;

            uint256 count = vetoes(id);
            emit ProposalVetoed(id, msg.sender, count);
            if (count < REQUIRED_APPROVALS) return;
        }

        p.cancelled = true;

        emit ProposalCancelled(id, msg.sender);
    }

    /// Stops each target in the same block, with no approvals and no delay. Several targets
    /// in one call because an incident that justifies pausing the escrow usually justifies
    /// pausing the registry with it, and doing that across separate transactions leaves a
    /// window in between.
    ///
    /// Each target is paused on its own. One that refuses, because it is already paused, has
    /// no `pause()` or holds no code, is skipped with its reason and the rest still stop: a
    /// brake that fails whole on one entry fails mid-incident.
    ///
    /// The calldata is built here and is always `pause()`, so this grants the brake and never
    /// anything adjacent to it. Unpausing is a proposal like any other, which is the property
    /// that makes this key safe to keep warm.
    function guardianPause(address[] calldata targets) external onlyGuardian {
        for (uint256 i = 0; i < targets.length; ++i) {
            address target = targets[i];
            // An address with no code accepts any call silently, and would read as paused.
            if (target.code.length == 0) {
                emit GuardianPauseSkipped(target, msg.sender, "");
                continue;
            }

            (bool ok, bytes memory reason) = target.call(abi.encodeWithSignature("pause()"));
            if (ok) emit GuardianPaused(target, msg.sender);
            else emit GuardianPauseSkipped(target, msg.sender, reason);
        }
    }

    /// Handing the brake to another key is a delayed change like any other, so a guardian
    /// that turns hostile costs an outage for the length of the timelock and nothing more.
    function setGuardian(address newGuardian) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (newGuardian == address(0)) revert ZeroAddress();
        if (isSigner(newGuardian)) revert DuplicateSigner();

        address from = guardian;
        guardian = newGuardian;

        emit GuardianUpdated(from, newGuardian);
    }

    /// Rotating a key is itself a timelocked change: the only caller accepted is this
    /// contract, reached through `propose`.
    function updateSigner(uint256 index, address newSigner) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (index >= SIGNER_COUNT) revert InvalidSignerIndex();
        if (newSigner == address(0)) revert ZeroAddress();
        if (isSigner(newSigner) || newSigner == guardian) revert DuplicateSigner();

        address from = signers[index];
        signers[index] = newSigner;

        emit SignerUpdated(index, from, newSigner);
    }

    /// Counted over the current signer set, never stored. A rotated-out key does not keep
    /// carrying a proposal it approved before it was replaced.
    function approvals(uint256 id) public view returns (uint256 count) {
        for (uint256 i = 0; i < SIGNER_COUNT; ++i) {
            if (hasApproved[id][signers[i]]) ++count;
        }
    }

    /// Counted over the current signer set, like approvals.
    function vetoes(uint256 id) public view returns (uint256 count) {
        for (uint256 i = 0; i < SIGNER_COUNT; ++i) {
            if (hasVetoed[id][signers[i]]) ++count;
        }
    }

    function isSigner(address account) public view returns (bool) {
        for (uint256 i = 0; i < SIGNER_COUNT; ++i) {
            if (signers[i] == account) return true;
        }
        return false;
    }

    function getSigners() external view returns (address[3] memory) {
        return signers;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    /// What `execute` would do right now. `reason` is the selector of the error it would
    /// revert with, or zero when `ready` is true.
    function canExecute(uint256 id) external view returns (bool ready, bytes4 reason) {
        Proposal storage p = _proposals[id];
        if (p.createdAt == 0) return (false, ProposalNotFound.selector);
        if (p.executed) return (false, AlreadyExecuted.selector);
        if (p.cancelled) return (false, AlreadyCancelled.selector);
        if (approvals(id) < REQUIRED_APPROVALS) return (false, InsufficientApprovals.selector);
        if (block.timestamp < p.executeAfter) return (false, TimelockNotExpired.selector);
        if (block.timestamp > p.executeAfter + GRACE_PERIOD) return (false, ProposalExpired.selector);
        return (true, bytes4(0));
    }

    function expiresAt(uint256 id) external view returns (uint64) {
        Proposal storage p = _proposals[id];
        if (p.createdAt == 0) return 0;
        return p.executeAfter + GRACE_PERIOD;
    }

    /// Passes the target's revert data straight through. A caller that waited out a delay, or
    /// is mid-incident with the brake in hand, needs the reason the target refused rather
    /// than this contract's opinion of it.
    function _call(address target, bytes memory data) private returns (bytes memory result) {
        bool ok;
        (ok, result) = target.call(data);
        if (ok) return result;

        if (result.length == 0) revert ExecutionFailed();
        assembly ("memory-safe") {
            revert(add(result, 0x20), mload(result))
        }
    }
}
