// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// One asset the treasury lane can park idle USDG in. The adapter holds the asset for every
/// mandate; `TreasuryPark` keeps the per-mandate positions and is the only caller of the
/// mutating functions. Every figure is USDG with six decimals, except `raw`, which is in the
/// asset's own units.
interface IParkAsset {
    /// The token held. USDG for the USDG adapter.
    function asset() external view returns (address);

    /// USDG value of `raw` at the valuation price. `fresh` is false, and `usdg` zero, when the
    /// price is older than the asset's valuation bound or the oracle is paused.
    function value(uint256 raw) external view returns (uint256 usdg, uint256 priceE8, uint256 updatedAt, bool fresh);

    /// Taken off `value` before parked funds count as spending power.
    function haircutBps() external view returns (uint16);

    /// Most parked for one mandate, and across all mandates, in USDG at cost.
    function caps() external view returns (uint128 perMandate, uint128 total);

    /// Converts `usdgIn`, already sent to the adapter, into the asset. Reverts under `minOut`.
    function acquire(uint256 usdgIn, uint256 minOut, address beneficiary) external returns (uint256 rawOut);

    /// Sells `raw` and sends at least `minUsdg` to `to`.
    function release(uint256 raw, uint256 minUsdg, address to, address beneficiary) external returns (uint256 usdgOut);

    /// Sells at most `maxRaw` for exactly `usdgOut`, sent to `to`.
    function releaseExact(uint256 usdgOut, uint256 maxRaw, address to, address beneficiary)
        external
        returns (uint256 rawIn);
}
