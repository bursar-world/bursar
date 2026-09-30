// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The part of USDG's compliance surface that answers, read by both deploy scripts before a
/// run starts. USDG at 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 on chain 4663 is a diamond
/// proxy: a selector it routes returns a value, and a selector it does not routes to nothing
/// and reverts `FacetNotFound`. That makes the surface testable, and it is why only these two
/// are declared here.
///
/// `paused` stops every transfer at once, so a run that starts into one strands a deployment
/// whose settlement asset cannot move. `isFrozen` is the per-address block: a frozen address
/// reverts every transfer whatever its balance says, and a deployment whose treasury is frozen
/// can never be swept.
///
/// `isBlacklisted` is deliberately absent. It is Circle's name for the block-list read on USDC,
/// and USDG does not answer it. `version` is absent for the same reason: it reverts
/// `FacetNotFound` on this contract, so nothing calls it.
interface IUsdg {
    function paused() external view returns (bool);
    function isFrozen(address account) external view returns (bool);
}
