// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {CollateralChecks} from "./VerifyCollateral.s.sol";
import {CoreChecks} from "./VerifyCore.s.sol";
import {PrivacyChecks} from "./VerifyPrivacy.s.sol";
import {RwaChecks} from "./VerifyRwa.s.sol";
import {ShieldedChecks} from "./VerifyShielded.s.sol";
import {StakingChecks} from "./VerifyStaking.s.sol";
import {TokenChecks} from "./VerifyToken.s.sol";
import {WiringChecks} from "./VerifyWiring.s.sol";

/// Every verify script in one run, over the whole record: the core set, the token, staking, the
/// RWA and collateral lanes, committed mandates and shielded settlement, and the governance
/// wiring once the record says the credit pool exists.
///
///   BURSAR_RECORD=deployments/rhc-mainnet-v3.json forge script script/Verify.s.sol --rpc-url "$RHC_RPC_URL"
///
/// With `BURSAR_VERIFY_STRICT=1` anything still owed fails the run too. That is the check the
/// migration ends on.
contract Verify is
    CoreChecks,
    TokenChecks,
    StakingChecks,
    RwaChecks,
    CollateralChecks,
    PrivacyChecks,
    ShieldedChecks,
    WiringChecks
{
    function run() external {
        _begin();
        _checkCore();
        _checkToken();
        _checkStaking();
        _checkRwa();
        _checkCollateral();
        _checkPrivacy();
        _checkShielded();
        // The wiring is governance's and follows the deployment. Checked strictly only once
        // every contract it names is in the record and the batch could have run.
        if (_recordAddress(K.CREDIT_POOL) != address(0) && _envFlag("BURSAR_VERIFY_STRICT")) _checkWiring();
        _end("deployment");
    }
}
