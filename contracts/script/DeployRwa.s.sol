// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IPoolManager} from "../src/token/Buyback.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {IMandateAccountFactory} from "../src/interfaces/IMandateAccountFactory.sol";
import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../src/rwa/StockSpendRouter.sol";
import {TreasuryPark} from "../src/rwa/TreasuryPark.sol";
import {RobinhoodStockAdapter} from "../src/rwa/adapters/RobinhoodStockAdapter.sol";
import {UsdgAdapter} from "../src/rwa/adapters/UsdgAdapter.sol";
import {IAccessRegistry, IStateView} from "../src/rwa/interfaces/IRwaExternal.sol";
import {RwaConfig} from "./lib/RwaConfig.sol";

/// The RWA lane (asset registry, price guard, stock router, treasury park and its two adapters)
/// and a factory for accounts that unpark inside a spend. Admin of the registry and the park is
/// the v2 AdminTimelock from construction. The park takes mandates from that factory and from the
/// live v2 and v2.1 factories, and from nothing else.
///
///   BURSAR_TIMELOCK=0x135e… BURSAR_ESCROW=0x4315… forge script script/DeployRwa.s.sol \
///     --rpc-url $RHC_RPC_URL --keystore $ETH_KEY --password-file $ETH_PASSWORD [--broadcast]
contract DeployRwa is Script {
    struct Deployed {
        AssetRegistry registry;
        PriceGuard guard;
        StockSpendRouter router;
        TreasuryPark park;
        RobinhoodStockAdapter sgovAdapter;
        UsdgAdapter usdgAdapter;
        MandateAccountFactory factory;
    }

    function run() external returns (Deployed memory d) {
        require(block.chainid == 4663, "not Robinhood Chain");
        address timelock = vm.envAddress("BURSAR_TIMELOCK");
        address escrow = vm.envAddress("BURSAR_ESCROW");

        vm.startBroadcast();
        d = deploy(timelock, escrow);
        vm.stopBroadcast();

        console2.log("AssetRegistry", address(d.registry));
        console2.log("PriceGuard", address(d.guard));
        console2.log("StockSpendRouter", address(d.router));
        console2.log("TreasuryPark", address(d.park));
        console2.log("RobinhoodStockAdapter.SGOV", address(d.sgovAdapter));
        console2.log("UsdgAdapter", address(d.usdgAdapter));
        console2.log("MandateAccountFactory", address(d.factory));
    }

    function deploy(address timelock, address escrow) public returns (Deployed memory d) {
        (address[] memory list, AssetRegistry.Asset[] memory configs) = RwaConfig.assets();
        d.registry = new AssetRegistry(timelock, RwaConfig.USDG, list, configs);
        require(d.registry.poolId(RwaConfig.SGOV) == RwaConfig.SGOV_POOL_ID, "SGOV pool");
        require(d.registry.poolId(RwaConfig.SPY) == RwaConfig.SPY_POOL_ID, "SPY pool");
        require(d.registry.poolId(RwaConfig.NVDA) == RwaConfig.NVDA_POOL_ID, "NVDA pool");
        require(d.registry.poolId(RwaConfig.AAPL) == RwaConfig.AAPL_POOL_ID, "AAPL pool");

        d.guard =
            new PriceGuard(d.registry, IAccessRegistry(RwaConfig.ACCESS_REGISTRY), IStateView(RwaConfig.STATE_VIEW));
        IPoolManager pm = IPoolManager(RwaConfig.POOL_MANAGER);
        d.router = new StockSpendRouter(d.registry, d.guard, pm);
        d.factory = new MandateAccountFactory(escrow, RwaConfig.USDG);
        IMandateAccountFactory[] memory factories = new IMandateAccountFactory[](3);
        factories[0] = IMandateAccountFactory(RwaConfig.FACTORY_V2);
        factories[1] = IMandateAccountFactory(RwaConfig.FACTORY_V21);
        factories[2] = d.factory;
        d.park = new TreasuryPark(RwaConfig.USDG, timelock, factories);
        d.sgovAdapter = new RobinhoodStockAdapter(address(d.park), RwaConfig.SGOV, d.registry, d.guard, pm);
        d.usdgAdapter =
            new UsdgAdapter(address(d.park), RwaConfig.USDG, RwaConfig.SGOV_PER_MANDATE, RwaConfig.SGOV_TOTAL);
        address[] memory adapters = new address[](2);
        adapters[0] = address(d.sgovAdapter);
        adapters[1] = address(d.usdgAdapter);
        d.park.initAdapters(adapters);
    }
}
