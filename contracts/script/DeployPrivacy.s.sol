// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {CommittedMandateFactory} from "../src/privacy/CommittedMandateFactory.sol";
import {DisclosureRegistry} from "../src/privacy/DisclosureRegistry.sol";
import {SolvencyLog} from "../src/privacy/SolvencyLog.sol";
import {WithinMandateVerifier} from "../src/zk/WithinMandateVerifier.sol";

/// Committed mandates and what surrounds them: the within-mandate proof verifier, a factory for
/// accounts that lock on the record's escrow, the disclosure registry parties use to show one
/// resolver one slice of a dispute, and the solvency log.
///
/// The log answers to the timelock from its constructor, and its poster is the key that runs the
/// solvency service, named in `BURSAR_SOLVENCY_POSTER`. The other three have no admin.
///
/// Every committed account gets the same ceiling: what it may lock over its whole life, whatever
/// its terms say, while the proving key rests on a single-contributor setup.
contract DeployPrivacy is BursarScript {
    uint256 internal constant CEILING = 25e6;

    struct Deployment {
        WithinMandateVerifier verifier;
        CommittedMandateFactory factory;
        DisclosureRegistry disclosures;
        SolvencyLog solvency;
    }

    address private asset;
    address private timelock;
    address private escrow;
    address private poster;

    Deployment private d;

    function run() external returns (Deployment memory) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        asset = _settlementAsset();
        timelock = _timelock();
        escrow = _upstream(K.ESCROW);
        _refuseRetired("BURSAR_POSTER", "BURSAR_SOLVENCY_POSTER");
        // This set has one escrow, so it gets one committed factory.
        _refuseRetired("BURSAR_ESCROW_V1", "nothing: this set has one escrow");
        poster = _role(K.SOLVENCY_POSTER, "BURSAR_SOLVENCY_POSTER");

        _requireUnrecorded(K.VERIFIER);
        _requireUnrecorded(K.COMMITTED_FACTORY);
        _requireUnrecorded(K.DISCLOSURES);
        _requireUnrecorded(K.SOLVENCY_LOG);
        // A committed account locks on this escrow in the settlement asset it names, so the two
        // have to be the record's.
        _expect("escrow.settlementAsset", asset, IEscrow(escrow).settlementAsset());

        vm.startBroadcast(deployer);
        d.verifier = new WithinMandateVerifier();
        d.factory = new CommittedMandateFactory(escrow, asset, address(d.verifier), CEILING);
        d.disclosures = new DisclosureRegistry();
        d.solvency = new SolvencyLog(timelock, poster);
        vm.stopBroadcast();

        _expect("factory.escrow", escrow, d.factory.escrow());
        _expect("factory.settlementAsset", asset, d.factory.settlementAsset());
        _expect("factory.verifier", address(d.verifier), d.factory.verifier());
        _expectUint("factory.ceiling", CEILING, d.factory.ceiling());
        _expect("solvency.admin", timelock, d.solvency.admin());
        _expect("solvency.poster", poster, d.solvency.poster());

        _write(K.VERIFIER, address(d.verifier));
        _write(K.COMMITTED_FACTORY, address(d.factory));
        _write(K.DISCLOSURES, address(d.disclosures));
        _write(K.SOLVENCY_LOG, address(d.solvency));
        _write(K.SOLVENCY_POSTER, poster);
        _write(K.PRIVACY_FROM_BLOCK, _chainBlock());
        _writeAmount(".parameters.CommittedMandateFactory.ceiling", CEILING);

        console2.log("WithinMandateVerifier", address(d.verifier));
        console2.log("CommittedMandateFactory", address(d.factory));
        console2.log("DisclosureRegistry", address(d.disclosures));
        console2.log("SolvencyLog", address(d.solvency));
        console2.log("  poster", poster);
        console2.log("Next: DeployShielded.s.sol");
        return d;
    }
}
