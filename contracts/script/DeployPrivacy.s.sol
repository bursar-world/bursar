// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {CommittedMandateFactory} from "../src/privacy/CommittedMandateFactory.sol";
import {DisclosureRegistry} from "../src/privacy/DisclosureRegistry.sol";
import {SolvencyLog} from "../src/privacy/SolvencyLog.sol";
import {WithinMandateVerifier} from "../src/zk/WithinMandateVerifier.sol";

/// M4 part 1: the within-mandate verifier, a committed-mandate factory per escrow, the disclosure
/// registry and the solvency log. The log's admin is the v2 AdminTimelock from construction; its
/// poster is the key that runs services/solvency.
///
///   BURSAR_TIMELOCK=0x135e… BURSAR_ESCROW=0x4315… BURSAR_ESCROW_V1=0x7D82… BURSAR_POSTER=0x… \
///     forge script script/DeployPrivacy.s.sol --rpc-url $RHC_RPC_URL --keystore $ETH_KEYSTORE \
///     --password-file $ETH_PASSWORD [--broadcast]
///
/// BURSAR_ESCROW_V1 is optional. It adds a factory on the v1 escrow, where the payees registered
/// before v2 still clear the agent-registry gate.
///
/// Both factories give every account the same ceiling: 25 USDG over its life, whatever its terms
/// say, until the multi-party phase 2 replaces the development proving key.
contract DeployPrivacy is Script {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant CEILING = 25e6;

    struct Deployed {
        WithinMandateVerifier verifier;
        CommittedMandateFactory factory;
        CommittedMandateFactory factoryV1;
        DisclosureRegistry disclosures;
        SolvencyLog solvency;
    }

    function run() external returns (Deployed memory d) {
        require(block.chainid == 4663, "not Robinhood Chain");
        address timelock = vm.envAddress("BURSAR_TIMELOCK");
        address escrow = vm.envAddress("BURSAR_ESCROW");
        address escrowV1 = vm.envOr("BURSAR_ESCROW_V1", address(0));
        address poster = vm.envAddress("BURSAR_POSTER");

        vm.startBroadcast();
        d.verifier = new WithinMandateVerifier();
        d.factory = new CommittedMandateFactory(escrow, USDG, address(d.verifier), CEILING);
        if (escrowV1 != address(0)) {
            d.factoryV1 = new CommittedMandateFactory(escrowV1, USDG, address(d.verifier), CEILING);
        }
        d.disclosures = new DisclosureRegistry();
        d.solvency = new SolvencyLog(timelock, poster);
        vm.stopBroadcast();

        console2.log("WithinMandateVerifier", address(d.verifier));
        console2.log("CommittedMandateFactory", address(d.factory));
        console2.log("CommittedMandateFactoryV1Escrow", address(d.factoryV1));
        console2.log("DisclosureRegistry", address(d.disclosures));
        console2.log("SolvencyLog", address(d.solvency));
    }
}
