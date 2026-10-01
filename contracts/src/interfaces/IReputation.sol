// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Counts how escrow locks ended, per payee and per payer-payee edge, weighs the released ones
/// by the volume and the number of payers behind them, and turns the result into a spending cap.
///
/// A count on its own is cheap to fill: one more address and one lock at the escrow's floor
/// would read as a perfect record. So a lock under `minScored` moves nothing, a released lock
/// also books its amount against the edge it settled on, and a payee's credit is that volume
/// summed over its payers with each edge counted up to `edgeCap`. The score is the released
/// share of settled locks scaled by how much of `fullCredit` the payee has earned, so a full
/// score takes at least `fullCredit / edgeCap` payers, and every unit of the volume behind it
/// paid the escrow's fee on the way through.
///
/// The escrow still makes the aggregate poisonable: an expired lock refunds the payer in full,
/// so anyone can charge a payee a timeout for the price of gas and `minScored` held to the
/// deadline. A lock whose payer is its own payee moves no counter, so a payee cannot vouch for
/// itself. A consumer that needs an unpoisoned view reads the edges of payers it already
/// recognises. The cap curve is therefore a floor-plus-slope, never the only control on an
/// account.
interface IReputation {
    error AlreadySet();
    error NotDeployer();
    error NotEscrow();
    error NotAdmin();
    error NotPendingAdmin();
    error BadCurve();
    error BadWeights();
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

    /// What a point costs, in the settlement asset's units. `minScored` is the smallest lock
    /// that moves a counter either way. `edgeCap` is the most released volume from one payer
    /// that counts toward a payee's credit, and `fullCredit` is the credit at which the released
    /// share counts in full. `fullCredit` is at least `edgeCap`, so the top is reachable at all;
    /// the deployment sets it to four edges.
    struct Weights {
        uint128 minScored;
        uint128 edgeCap;
        uint128 fullCredit;
    }

    event EscrowSet(address indexed escrow);
    event CurveUpdated(uint128 baseCap, uint128 capPerScore, uint128 maxCap);
    event WeightsUpdated(uint128 minScored, uint128 edgeCap, uint128 fullCredit);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event ReleaseCounted(address indexed payer, address indexed payee);
    event TimeoutCounted(address indexed payer, address indexed payee);
    event DisputeCounted(address indexed payer, address indexed payee);

    /// `amount` is the lock's principal and `credit` the part of it that lifted the payee's
    /// credit, which is zero once the edge sits at its cap.
    event ReleaseCredited(address indexed payer, address indexed payee, uint128 amount, uint128 credit);

    /// `amount` is the lock's principal. Under `minScored` each call answers and moves nothing.
    function onReleased(address payer, address payee, uint128 amount) external;
    function onTimedOut(address payer, address payee, uint128 amount) external;
    function onDisputed(address payer, address payee, uint128 amount) external;

    /// The escrow takes this address in its own constructor, so the pairing can only be
    /// closed from this side, once, immediately after deployment.
    function setEscrow(address escrow) external;

    function setCurve(CapCurve calldata curve) external;

    /// `edgeCap` binds the releases counted after the change: credit already booked stays as it
    /// was booked, because recounting it would mean walking every payer a payee has ever had.
    /// `minScored` and `fullCredit` are read live, so each binds the next lock and the next read.
    function setWeights(Weights calldata weights) external;

    function transferAdmin(address to) external;
    function acceptAdmin() external;

    /// Released locks as a share of all settled locks, scaled by `min(credit, fullCredit) /
    /// fullCredit` and to `[0, scoreMax]`, in one division. A payee with no history scores zero
    /// and gets `baseCap`.
    function score(address payee) external view returns (uint16);

    function capOf(address payee) external view returns (uint128);
    function curve() external view returns (CapCurve memory);
    function weights() external view returns (Weights memory);
    function payeeStats(address payee) external view returns (uint64 released, uint64 timedOut, uint64 disputed);
    function edges(address payer, address payee)
        external
        view
        returns (uint64 released, uint64 timedOut, uint64 disputed);

    /// The released volume this payee is credited with: the sum over its payers of each edge's
    /// released volume, counted up to the `edgeCap` in force when each release landed.
    function creditOf(address payee) external view returns (uint128);

    /// The principal of every counted release from `payer` to `payee`, with no cap applied.
    function edgeVolume(address payer, address payee) external view returns (uint128);

    function escrow() external view returns (address);
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function deployer() external view returns (address);

    /// 100. Held in uint16 so a future finer scale does not change the ABI.
    function scoreMax() external pure returns (uint16);
}
