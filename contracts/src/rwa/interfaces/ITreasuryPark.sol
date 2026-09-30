// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// What a mandate account calls when a spend needs more USDG than it holds.
interface ITreasuryPark {
    /// Sends at least `usdgNeeded` of USDG to the calling mandate, or reverts.
    function unparkFor(uint256 usdgNeeded) external;
}
