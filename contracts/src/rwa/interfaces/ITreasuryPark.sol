// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// What a mandate account calls when a spend needs more USDG than it holds.
interface ITreasuryPark {
    /// Sells parked assets for exactly `usdgNeeded` and sends it to the calling mandate.
    function unparkFor(uint256 usdgNeeded) external;
}
