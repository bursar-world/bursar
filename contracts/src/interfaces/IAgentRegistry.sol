// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The party gate the escrow reads before it opens a lock. The escrow calls `isActive` and
/// `isBlacklisted`; `stakeOf` and `slash` are for readers and governance.
///
/// Amounts are in the settlement asset's own units, six decimals for USDG.
interface IAgentRegistry {
    /// Registered, live, funded to the current floor and not barred. The single question a
    /// consumer should ask, so that a change in what "allowed" means never needs a matching
    /// change in every caller.
    function isActive(address party) external view returns (bool);

    /// Separate from `isActive` because the two answers carry different consequences: an
    /// inactive party may come back, a barred one is a refusal a consumer should surface
    /// instead of retrying.
    function isBlacklisted(address party) external view returns (bool);

    function stakeOf(address party) external view returns (uint256);

    /// `reason` is a fixed-width tag.
    function slash(address party, uint256 amount, bytes32 reason) external;
}
