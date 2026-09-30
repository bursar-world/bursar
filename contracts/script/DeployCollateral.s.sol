// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IMandateAccountFactory} from "../src/interfaces/IMandateAccountFactory.sol";
import {IPoolManager} from "../src/token/Buyback.sol";
import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {CreditPool} from "../src/rwa/CreditPool.sol";
import {PriceGuard} from "../src/rwa/PriceGuard.sol";
import {CollateralConfig as C} from "./lib/CollateralConfig.sol";
import {RwaConfig} from "./lib/RwaConfig.sol";

/// The collateral lane (F11): CreditPool, then CollateralVault, then the one-time bind. Reads
/// the registry and guard `CollateralConfig` names, which have to be built from this source
/// (the vault calls `PriceGuard.valuation`), and the v2.1 factory. Admin of both is the v2
/// AdminTimelock from construction; the lender is the deploy key until the operator names another.
///
///   forge script script/DeployCollateral.s.sol --rpc-url $RHC_RPC_URL \
///     --keystore $ETH_KEYSTORE --password-file $ETH_PASSWORD [--broadcast]
contract DeployCollateral is Script {
    struct Deployed {
        CreditPool pool;
        CollateralVault vault;
    }

    function run() external returns (Deployed memory d) {
        require(block.chainid == 4663, "not Robinhood Chain");
        vm.startBroadcast();
        d = deploy(msg.sender);
        vm.stopBroadcast();
        console2.log("CreditPool", address(d.pool));
        console2.log("CollateralVault", address(d.vault));
    }

    function deploy(address lender) public returns (Deployed memory d) {
        return deploy(lender, AssetRegistry(C.REGISTRY), PriceGuard(C.GUARD));
    }

    function deploy(address lender, AssetRegistry registry, PriceGuard guard) public returns (Deployed memory d) {
        d.pool = new CreditPool(
            RwaConfig.USDG,
            C.STAKING,
            C.TIMELOCK_V2,
            lender,
            C.TOTAL_DEBT_CAP,
            C.PER_MANDATE_CAP,
            C.BASE_RATE_BPS,
            C.SLOPE_BPS
        );
        (address[] memory assets, uint8[] memory tiers) = C.assets();
        d.vault = new CollateralVault(
            registry,
            guard,
            d.pool,
            IMandateAccountFactory(C.FACTORY_V21),
            IPoolManager(RwaConfig.POOL_MANAGER),
            C.TIMELOCK_V2,
            C.params(),
            C.tiers(),
            assets,
            tiers
        );
        d.pool.bindVault(address(d.vault));
    }
}
