// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStaking} from "../../src/token/interfaces/IStaking.sol";

/// Terms the staking pool takes from governance after it is deployed.
library TokenConfig {
    /// The table for the record's staked token: $BURSAR's when the record names it, BRSR's for the
    /// records before it, so a check run against an older record still holds it to its own table.
    function rebateTiers(bool bursar) internal pure returns (IStaking.Tier[] memory) {
        return bursar ? bursarRebateTiers() : brsrRebateTiers();
    }

    /// The fee rebate table on the $BURSAR staking pool. The same four rebates as BRSR's, at five
    /// times the stake: BRSR's opening price was 200 micro-USD and $BURSAR traded near 43 when the
    /// seventh record was planned, so each tier asks about the same dollar amount it did. 125,000
    /// BURSAR for 5% off the facilitator fee, 500,000 for 10%, 2,500,000 for 20% and 12,500,000
    /// for 30%.
    function bursarRebateTiers() internal pure returns (IStaking.Tier[] memory t) {
        t = new IStaking.Tier[](4);
        t[0] = IStaking.Tier({minStake: 125_000e18, rebateBps: 500});
        t[1] = IStaking.Tier({minStake: 500_000e18, rebateBps: 1_000});
        t[2] = IStaking.Tier({minStake: 2_500_000e18, rebateBps: 2_000});
        t[3] = IStaking.Tier({minStake: 12_500_000e18, rebateBps: 3_000});
    }

    /// The fee rebate table on the BRSR staking pools, set there by governance on 2026-09-24 and
    /// carried over unchanged through the sixth record: 25,000 BRSR for 5% off the facilitator fee,
    /// 100,000 for 10%, 500,000 for 20% and 2,500,000 for 30%.
    function brsrRebateTiers() internal pure returns (IStaking.Tier[] memory t) {
        t = new IStaking.Tier[](4);
        t[0] = IStaking.Tier({minStake: 25_000e18, rebateBps: 500});
        t[1] = IStaking.Tier({minStake: 100_000e18, rebateBps: 1_000});
        t[2] = IStaking.Tier({minStake: 500_000e18, rebateBps: 2_000});
        t[3] = IStaking.Tier({minStake: 2_500_000e18, rebateBps: 3_000});
    }
}
