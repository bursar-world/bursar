// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {CommittedMandateFactory} from "../src/privacy/CommittedMandateFactory.sol";
import {SolvencyLog} from "../src/privacy/SolvencyLog.sol";

/// Asks the chain what `DeployPrivacy.s.sol` asked its simulation: committed accounts lock on the
/// record's escrow, check proofs against the record's verifier, carry the recorded ceiling, and
/// the solvency log answers to the timelock with the recorded poster.
abstract contract PrivacyChecks is Verifier {
    function _checkPrivacy() internal {
        address verifier = _contract(K.VERIFIER);
        address factory = _contract(K.COMMITTED_FACTORY);
        _contract(K.DISCLOSURES);
        address log = _contract(K.SOLVENCY_LOG);
        if (factory == address(0) || log == address(0)) return;

        CommittedMandateFactory f = CommittedMandateFactory(factory);
        _is("CommittedMandateFactory.escrow", _recordAddress(K.ESCROW), f.escrow());
        _is("CommittedMandateFactory.settlementAsset", _settlementAsset(), f.settlementAsset());
        _is("CommittedMandateFactory.verifier", verifier, f.verifier());
        _isUint("CommittedMandateFactory.ceiling", _param("CommittedMandateFactory.ceiling"), f.ceiling());

        SolvencyLog s = SolvencyLog(log);
        _is("SolvencyLog.admin", _recordAddress(K.ADMIN_TIMELOCK), s.admin());
        _is("SolvencyLog.pendingAdmin", address(0), s.pendingAdmin());
        _is("SolvencyLog.poster", _recordAddress(K.SOLVENCY_POSTER), s.poster());
    }
}

/// `forge script script/VerifyPrivacy.s.sol --rpc-url "$RHC_RPC_URL"`, after `DeployPrivacy.s.sol`.
contract VerifyPrivacy is PrivacyChecks {
    function run() external {
        _begin();
        _checkPrivacy();
        _end("privacy");
    }
}
