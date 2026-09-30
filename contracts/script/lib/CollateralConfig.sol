// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CollateralVault} from "../../src/rwa/CollateralVault.sol";

/// Launch terms of the collateral lane: the credit caps, the spread, the haircut tiers and which
/// asset sits in which tier. No addresses: the registry, guard, factory, staking pool and buyback
/// come from the record, and the lender from the environment. Reviewed again before launch.
library CollateralConfig {
    uint128 internal constant TOTAL_DEBT_CAP = 100e6;
    uint128 internal constant PER_MANDATE_CAP = 10e6;
    /// A year's spread in basis points: 2% plus 18% at full utilisation.
    uint16 internal constant BASE_RATE_BPS = 200;
    uint16 internal constant SLOPE_BPS = 1_800;

    /// The session bound is the stock feeds' 24 h heartbeat plus two hours; the valuation bound
    /// covers a three-day weekend.
    uint32 internal constant SESSION_STALENESS = 93_600;
    uint32 internal constant VALUATION_STALENESS = 360_000;

    function params() internal pure returns (CollateralVault.Params memory) {
        return CollateralVault.Params({minBorrowHealth: 1.25e18, liquidationTarget: 1.05e18, bountyBps: 500});
    }

    function tiers() internal pure returns (CollateralVault.Tier[] memory t) {
        t = new CollateralVault.Tier[](3);
        t[0] = CollateralVault.Tier(500, 1_000, SESSION_STALENESS, VALUATION_STALENESS, "Treasury fund");
        t[1] = CollateralVault.Tier(2_000, 3_500, SESSION_STALENESS, VALUATION_STALENESS, "Index fund");
        t[2] = CollateralVault.Tier(3_000, 5_000, SESSION_STALENESS, VALUATION_STALENESS, "Single stock");
    }

    /// Tier numbers count from one, the way the vault reads them. Every asset the registry lists
    /// has a tier here, or the vault could not value or sell it.
    function tierOf(string memory symbol) internal pure returns (uint8) {
        bytes32 s = keccak256(bytes(symbol));
        if (s == keccak256("SGOV")) return 1;
        if (s == keccak256("SPY")) return 2;
        if (s == keccak256("NVDA") || s == keccak256("AAPL")) return 3;
        return 0;
    }
}
