// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputation} from "./interfaces/IReputation.sol";

/// Settlement history for payees, written only by the escrow, and the spending cap derived
/// from it.
///
/// Nothing here moves value. The contract holds no settlement asset, has no token balance to
/// account for, and exposes no path that transfers one. The cap it publishes is advice a
/// caller enforces, never money this contract can lose.
contract Reputation is IReputation {
    /// Scores are percentages. Held in uint16 rather than uint8 so widening the scale later
    /// changes a constant instead of the ABI.
    uint16 private constant SCORE_MAX = 100;

    // forge-lint: disable-next-item(screaming-snake-case-immutable)
    address public immutable deployer;

    address public escrow;
    address public admin;
    address public pendingAdmin;

    /// Private because the interface hands back the whole struct, which a generated getter
    /// would flatten into three returns.
    CapCurve private _curve;

    mapping(address payee => Counters) public payeeStats;
    mapping(address payer => mapping(address payee => Counters)) public edges;

    /// `admin_` is the timelock, not the deployer. The deployer keeps one power, wiring the
    /// escrow, and loses it the moment it is used.
    constructor(address admin_, CapCurve memory curve_) {
        if (admin_ == address(0)) revert ZeroAddress();

        deployer = msg.sender;
        admin = admin_;
        _writeCurve(curve_);

        emit AdminTransferred(address(0), admin_);
    }

    /// A payee that paid itself vouched for its own work, so a self-lock moves no counter. The
    /// callback still answers, because the escrow has already settled the lock.
    function onReleased(address payer, address payee) external {
        if (msg.sender != escrow) revert NotEscrow();
        if (payer == payee) return;

        payeeStats[payee].released++;
        edges[payer][payee].released++;

        emit ReleaseCounted(payer, payee);
    }

    function onTimedOut(address payer, address payee) external {
        if (msg.sender != escrow) revert NotEscrow();
        if (payer == payee) return;

        payeeStats[payee].timedOut++;
        edges[payer][payee].timedOut++;

        emit TimeoutCounted(payer, payee);
    }

    function onDisputed(address payer, address payee) external {
        if (msg.sender != escrow) revert NotEscrow();
        if (payer == payee) return;

        payeeStats[payee].disputed++;
        edges[payer][payee].disputed++;

        emit DisputeCounted(payer, payee);
    }

    function setEscrow(address escrow_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (escrow != address(0)) revert AlreadySet();
        if (escrow_ == address(0)) revert ZeroAddress();

        escrow = escrow_;

        emit EscrowSet(escrow_);
    }

    function setCurve(CapCurve calldata curve_) external {
        if (msg.sender != admin) revert NotAdmin();

        _writeCurve(curve_);
    }

    function transferAdmin(address to) external {
        if (msg.sender != admin) revert NotAdmin();
        if (to == address(0)) revert ZeroAddress();

        pendingAdmin = to;

        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();

        emit AdminTransferred(admin, msg.sender);

        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// Truncating division, so a payee crosses a point only once the ratio has actually
    /// reached it. Rounding the other way would hand out headroom a job early.
    function score(address payee) external view returns (uint16) {
        return _score(payeeStats[payee]);
    }

    function capOf(address payee) external view returns (uint128) {
        CapCurve memory c = _curve;

        // Widened before multiplying: capPerScore is a uint128 the admin chooses freely, and
        // a hundred times it can leave the type. The clamp brings the result back in range.
        uint256 cap = uint256(c.baseCap) + uint256(c.capPerScore) * _score(payeeStats[payee]);

        // The cast runs only on the branch where `cap` is at most `maxCap`, itself a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        return cap > c.maxCap ? c.maxCap : uint128(cap);
    }

    function curve() external view returns (CapCurve memory) {
        return _curve;
    }

    function scoreMax() external pure returns (uint16) {
        return SCORE_MAX;
    }

    /// A ceiling below the floor would make `baseCap` unreachable and silently flatten the
    /// curve to a constant. That reads as a misconfiguration, not a policy.
    function _writeCurve(CapCurve memory curve_) private {
        if (curve_.maxCap < curve_.baseCap) revert BadCurve();
        // A zero ceiling caps every payee at nothing, so every lock reverts and the escrow
        // reads as broken rather than closed.
        if (curve_.maxCap == 0) revert BadCurve();
        // A ceiling no score reaches is a figure the curve publishes and never pays.
        if (uint256(curve_.maxCap) > uint256(curve_.baseCap) + uint256(curve_.capPerScore) * SCORE_MAX) {
            revert BadCurve();
        }

        _curve = CapCurve({baseCap: curve_.baseCap, capPerScore: curve_.capPerScore, maxCap: curve_.maxCap});

        emit CurveUpdated(curve_.baseCap, curve_.capPerScore, curve_.maxCap);
    }

    /// Timed-out and disputed locks both count against the payee: from the payer's side a job
    /// that was never delivered and one that was delivered badly are the same failure.
    function _score(Counters memory c) private pure returns (uint16) {
        uint256 settled = uint256(c.released) + c.timedOut + c.disputed;
        if (settled == 0) return 0;

        // `released` is one of the three terms in `settled`, so the quotient never exceeds
        // SCORE_MAX.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16((uint256(c.released) * SCORE_MAX) / settled);
    }
}
