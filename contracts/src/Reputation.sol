// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputation} from "./interfaces/IReputation.sol";

/// Settlement history for payees, written only by the escrow, and the spending cap derived
/// from it.
///
/// Nothing here moves value. It holds no tokens and has no path that transfers one. The cap
/// it publishes is advice a caller enforces, never money this contract can lose.
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
    /// would flatten into three returns. The same goes for the weights.
    CapCurve private _curve;
    Weights private _weights;

    mapping(address payee => Counters) public payeeStats;
    mapping(address payer => mapping(address payee => Counters)) public edges;

    /// What the counts cannot say: how much settled, and from how many hands. The edge volume
    /// is kept uncapped so a reader sees the whole relationship; the credit is what the score
    /// reads.
    mapping(address payer => mapping(address payee => uint128)) public edgeVolume;
    mapping(address payee => uint128) public creditOf;

    /// `admin_` is the timelock, not the deployer. The deployer keeps one power, wiring the
    /// escrow, and loses it the moment it is used.
    constructor(address admin_, CapCurve memory curve_, Weights memory weights_) {
        if (admin_ == address(0)) revert ZeroAddress();

        deployer = msg.sender;
        admin = admin_;
        _writeCurve(curve_);
        _writeWeights(weights_);

        emit AdminTransferred(address(0), admin_);
    }

    /// A payee that paid itself vouched for its own work, and a lock under `minScored` is too
    /// small to vouch for anything: a point sold for a cent is a point anyone can buy. Neither
    /// moves a counter, in either direction, so the cheap lock can no more poison a record than
    /// build one. The callback still answers, because the escrow has already settled the lock.
    function onReleased(address payer, address payee, uint128 amount) external {
        if (msg.sender != escrow) revert NotEscrow();
        if (!_scored(payer, payee, amount)) return;

        payeeStats[payee].released++;
        edges[payer][payee].released++;

        emit ReleaseCounted(payer, payee);

        // Credit is the capped edge volume, so only the part of this release that lifts the
        // edge toward its cap is new credit. Past the cap a payer can keep paying and move
        // nothing.
        uint128 cap = _weights.edgeCap;
        uint128 before = edgeVolume[payer][payee];
        uint128 volume = before + amount;
        edgeVolume[payer][payee] = volume;

        uint128 credit = _min(volume, cap) - _min(before, cap);
        if (credit != 0) creditOf[payee] += credit;

        emit ReleaseCredited(payer, payee, amount, credit);
    }

    function onTimedOut(address payer, address payee, uint128 amount) external {
        if (msg.sender != escrow) revert NotEscrow();
        if (!_scored(payer, payee, amount)) return;

        payeeStats[payee].timedOut++;
        edges[payer][payee].timedOut++;

        emit TimeoutCounted(payer, payee);
    }

    function onDisputed(address payer, address payee, uint128 amount) external {
        if (msg.sender != escrow) revert NotEscrow();
        if (!_scored(payer, payee, amount)) return;

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

    function setWeights(Weights calldata weights_) external {
        if (msg.sender != admin) revert NotAdmin();

        _writeWeights(weights_);
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

    /// Truncating division, so a payee crosses a point only once the ratio has reached it.
    /// Rounding the other way would hand out headroom a job early.
    function score(address payee) external view returns (uint16) {
        return _score(payee);
    }

    function capOf(address payee) external view returns (uint128) {
        CapCurve memory c = _curve;

        // Widened before multiplying: capPerScore is a uint128 the admin chooses freely, and
        // a hundred times it can leave the type. The clamp brings the result back in range.
        uint256 cap = uint256(c.baseCap) + uint256(c.capPerScore) * _score(payee);

        // The cast runs only on the branch where `cap` is at most `maxCap`, itself a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        return cap > c.maxCap ? c.maxCap : uint128(cap);
    }

    function curve() external view returns (CapCurve memory) {
        return _curve;
    }

    function weights() external view returns (Weights memory) {
        return _weights;
    }

    function scoreMax() external pure returns (uint16) {
        return SCORE_MAX;
    }

    /// A ceiling below the floor would make `baseCap` unreachable and silently flatten the
    /// curve to a constant.
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

    /// A zero minimum scores a lock at the escrow's floor, and a point that costs a cent is a
    /// point anyone can buy. A zero edge cap credits nothing, so no score could leave zero. Full
    /// credit under one edge is a top a single payer clears with room to spare, when the edge is
    /// the unit of breadth the whole measure counts in.
    function _writeWeights(Weights memory weights_) private {
        if (weights_.minScored == 0 || weights_.edgeCap == 0) revert BadWeights();
        if (weights_.fullCredit < weights_.edgeCap) revert BadWeights();

        _weights = Weights({minScored: weights_.minScored, edgeCap: weights_.edgeCap, fullCredit: weights_.fullCredit});

        emit WeightsUpdated(weights_.minScored, weights_.edgeCap, weights_.fullCredit);
    }

    function _scored(address payer, address payee, uint128 amount) private view returns (bool) {
        return payer != payee && amount >= _weights.minScored;
    }

    /// Timed-out and disputed locks both count against the payee: from the payer's side a job
    /// that was never delivered and one that was delivered badly are the same failure. The
    /// released share is then scaled by the credit earned inside the same division, so the
    /// only rounding is the final floor.
    function _score(address payee) private view returns (uint16) {
        Counters memory c = payeeStats[payee];
        uint256 settled = uint256(c.released) + c.timedOut + c.disputed;
        if (settled == 0) return 0;

        uint128 full = _weights.fullCredit;
        uint256 earned = _min(creditOf[payee], full);

        // `released` is one of the three terms in `settled` and `earned` is at most `full`, so
        // the quotient never exceeds SCORE_MAX. Widened because a count times the scale times a
        // uint128 leaves the type.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16((uint256(c.released) * SCORE_MAX * earned) / (settled * full));
    }

    function _min(uint128 a, uint128 b) private pure returns (uint128) {
        return a < b ? a : b;
    }
}
