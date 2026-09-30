// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStaking} from "../../src/token/interfaces/IStaking.sol";

/// Terms the staking pool takes from governance after it is deployed.
library TokenConfig {
    /// The fee rebate table on the staking pool this deployment replaces, set there by governance
    /// on 2026-09-24 and carried over unchanged, so a redeploy does not quietly stop the rebate a
    /// staked balance already earns: 25,000 BRSR for 5% off the facilitator fee, 100,000 for 10%,
    /// 500,000 for 20% and 2,500,000 for 30%.
    function rebateTiers() internal pure returns (IStaking.Tier[] memory t) {
        t = new IStaking.Tier[](4);
        t[0] = IStaking.Tier({minStake: 25_000e18, rebateBps: 500});
        t[1] = IStaking.Tier({minStake: 100_000e18, rebateBps: 1_000});
        t[2] = IStaking.Tier({minStake: 500_000e18, rebateBps: 2_000});
        t[3] = IStaking.Tier({minStake: 2_500_000e18, rebateBps: 3_000});
    }
}
