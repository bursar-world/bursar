// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VmSafe} from "forge-std/Vm.sol";

import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {RwaConfig} from "./RwaConfig.sol";

/// Launch terms of the collateral lane on Robinhood Chain 4663. Development parameters: the
/// caps, haircuts and liquidation terms are on the record's production checklist for review.
library CollateralConfig {
    VmSafe private constant VM = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    error BuybackNotContract(address buyback);

    address internal constant REGISTRY = 0xe77600c2E4597CEC78A3653Fb1f393A0C68c9cD1;
    address internal constant GUARD = 0x341Df9BC51f6329F3B6acC2CF7280eB644eE1120;
    address internal constant FACTORY_V21 = 0x669366d0Ae3C6b51fEDcf451A01bF741Fd2ed08D;
    address internal constant TIMELOCK_V2 = 0x135eF562ac57845AeA1Bb650fc0E74D67A4a866B;
    address internal constant STAKING = 0x3f2a0E7822B30aD928488F053348b137866Cf962;

    uint128 internal constant TOTAL_DEBT_CAP = 100e6;
    uint128 internal constant PER_MANDATE_CAP = 10e6;
    /// A year's spread in basis points: 2% plus 18% at full utilisation.
    uint16 internal constant BASE_RATE_BPS = 200;
    uint16 internal constant SLOPE_BPS = 1_800;

    /// The session bound is the stock feeds' 24 h heartbeat plus two hours; the valuation bound
    /// covers a three-day weekend (docs/14).
    uint32 internal constant SESSION_STALENESS = 93_600;
    uint32 internal constant VALUATION_STALENESS = 360_000;

    /// The Buyback whose price ceiling converts a write-off into BRSR, from `BURSAR_BUYBACK`. The
    /// pool refuses one that does not compound into `STAKING`.
    function buyback() internal view returns (address b) {
        b = VM.envAddress("BURSAR_BUYBACK");
        if (b.code.length == 0) revert BuybackNotContract(b);
    }

    function params() internal pure returns (CollateralVault.Params memory) {
        return CollateralVault.Params({minBorrowHealth: 1.25e18, liquidationTarget: 1.05e18, bountyBps: 500});
    }

    function tiers() internal pure returns (CollateralVault.Tier[] memory t) {
        t = new CollateralVault.Tier[](3);
        t[0] = CollateralVault.Tier(500, 1_000, SESSION_STALENESS, VALUATION_STALENESS, "Treasury fund");
        t[1] = CollateralVault.Tier(2_000, 3_500, SESSION_STALENESS, VALUATION_STALENESS, "Index fund");
        t[2] = CollateralVault.Tier(3_000, 5_000, SESSION_STALENESS, VALUATION_STALENESS, "Single stock");
    }

    function assets() internal pure returns (address[] memory a, uint8[] memory tier) {
        a = new address[](4);
        tier = new uint8[](4);
        (a[0], tier[0]) = (RwaConfig.SGOV, 1);
        (a[1], tier[1]) = (RwaConfig.SPY, 2);
        (a[2], tier[2]) = (RwaConfig.NVDA, 3);
        (a[3], tier[3]) = (RwaConfig.AAPL, 3);
    }
}
