// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The part of Staking the credit pool calls. Governance names the pool there twice: as
/// `creditManager`, to pay the spread in, and as `slasher`, to take stake for a written-off line.
interface ICreditStaking {
    function creditManager() external view returns (address);

    function slasher() external view returns (address);

    /// Pays `amount` USDG of spread to stakers. Only `creditManager` may call it.
    function distribute(uint256 amount) external;

    /// Penalises stakers in BRSR for a written-off line. Takes the smaller of `lossBrsr` and the
    /// slash allowance, which is the part of the window cap (`slashCapBps` of the pool, refilling
    /// over `slashWindow`) that recent slashes have not used. It comes out of every stake pro
    /// rata, pending exits included, and goes to Staking's slash sink. Only `slasher` may call
    /// it. Returns what it took: zero, not a revert, for a zero loss, an empty pool or a spent
    /// allowance.
    ///
    /// The slash does not reimburse the lender. The pool books the whole USDG loss as bad debt
    /// whatever the slash takes, asks for a slash only on the part of it no seized collateral
    /// covers, and the BRSR goes to the slash sink, not to the pool.
    function slash(uint256 lossBrsr) external returns (uint256 taken);
}
