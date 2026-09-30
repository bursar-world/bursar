// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Counts how escrow locks ended, per payee and per payer-payee edge, and turns the payee
/// aggregate into a spending cap.
///
/// The escrow makes the aggregate poisonable: an expired dust lock refunds the payer in full,
/// so anyone can charge a payee a timeout for the price of gas. A lock whose payer is its own
/// payee moves no counter, so a payee cannot vouch for itself. A consumer that needs an
/// unpoisoned view reads the edges of payers it already recognises. The cap curve is therefore
/// a floor-plus-slope, never the only control on an account.
interface IReputation {
    error AlreadySet();
    error NotDeployer();
    error NotEscrow();
    error NotAdmin();
    error NotPendingAdmin();
    error BadCurve();
    error ZeroAddress();

    struct Counters {
        uint64 released;
        uint64 timedOut;
        uint64 disputed;
    }

    /// `capOf = min(baseCap + capPerScore * score, maxCap)`, with `score` in `[0, scoreMax]`
    /// and `capPerScore` denominated per score point. A linear curve, not tiers: a payee's cap
    /// grows with each settled job instead of jumping at a threshold that is worth gaming.
    /// `maxCap` sits between `baseCap` and `baseCap + capPerScore * scoreMax`, so a perfect
    /// score reaches it.
    struct CapCurve {
        uint128 baseCap;
        uint128 capPerScore;
        uint128 maxCap;
    }

    event EscrowSet(address indexed escrow);
    event CurveUpdated(uint128 baseCap, uint128 capPerScore, uint128 maxCap);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event ReleaseCounted(address indexed payer, address indexed payee);
    event TimeoutCounted(address indexed payer, address indexed payee);
    event DisputeCounted(address indexed payer, address indexed payee);

    function onReleased(address payer, address payee) external;
    function onTimedOut(address payer, address payee) external;
    function onDisputed(address payer, address payee) external;

    /// The escrow takes this address in its own constructor, so the pairing can only be
    /// closed from this side, once, immediately after deployment.
    function setEscrow(address escrow) external;

    function setCurve(CapCurve calldata curve) external;
    function transferAdmin(address to) external;
    function acceptAdmin() external;

    /// Released jobs as a share of all settled jobs, scaled to `[0, scoreMax]`. A payee with
    /// no history scores zero and gets `baseCap`.
    function score(address payee) external view returns (uint16);

    function capOf(address payee) external view returns (uint128);
    function curve() external view returns (CapCurve memory);
    function payeeStats(address payee) external view returns (uint64 released, uint64 timedOut, uint64 disputed);
    function edges(address payer, address payee)
        external
        view
        returns (uint64 released, uint64 timedOut, uint64 disputed);

    function escrow() external view returns (address);
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function deployer() external view returns (address);

    /// 100. Held in uint16 so a future finer scale does not change the ABI.
    function scoreMax() external pure returns (uint16);
}
