// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The party gate every other contract in the deployment reads before it lets a
/// counterparty take money or a ruling.
///
/// Four functions, and no more. The escrow only needs to know whether a payee may be paid at
/// all, how much collateral stands behind it, and how to take that collateral away; it has no
/// business reading names, withdrawal queues or admin keys. Keeping the surface this
/// narrow is also what lets a minimal deployment run with no registry at all, because a
/// consumer holding `address(0)` here is holding a gate it knows how to skip.
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

    /// `reason` is a fixed-width tag, not prose. A slashing path is paid for by the caller
    /// ruling against a bad party, and an unbounded string is an open invitation to make
    /// that ruling expensive enough to skip.
    function slash(address party, uint256 amount, bytes32 reason) external;
}
