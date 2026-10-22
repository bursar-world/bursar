// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";
import {IPoolManager} from "../src/token/Buyback.sol";
import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../src/rwa/StockSpendRouter.sol";

/// Replaces the stock router with one that also sells, built against the registry, the guard and
/// the pool manager the record carries. The previous router stays live for any mandate still
/// pointing at it; the record names it under `rwa.previousStockRouter` and the new one under
/// `rwa.StockSpendRouter`, which the apps read.
///
/// No governance call is involved: the router has no admin, and no administered contract names
/// it. What does change hands is per mandate. A policy lives in the router it was set on, so each
/// mandate's principal adopts the new router with the account's `setRouter` and sets its purchase
/// policy again, plus the sale policy that is new. `repointExample()` does that for the record's
/// public example mandate, from its principal's key, so the console and the SDK have a mandate to
/// demonstrate on the day the record is published.
///
///   forge script script/DeployStockRouter.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" [--broadcast]
///   forge script script/DeployStockRouter.s.sol --sig "repointExample()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payer" [--broadcast]
contract DeployStockRouter is BursarScript {
    string private constant PREVIOUS_ROUTER = ".rwa.previousStockRouter";
    string private constant EXAMPLE = ".exampleMandate.address";

    /// The recorded router already sells, so a second one would only split callers.
    error AlreadySells(address router);
    error NotExamplePrincipal(address mandate, address principal, address caller);

    function run() external returns (StockSpendRouter router) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        AssetRegistry registry = AssetRegistry(_upstream(K.ASSET_REGISTRY));
        PriceGuard guard = PriceGuard(_upstream(K.PRICE_GUARD));
        address poolManager = _upstream(K.POOL_MANAGER);
        address asset = _settlementAsset();
        _expect("guard.registry", address(registry), address(guard.registry()));
        _expect("registry.settlementAsset", asset, registry.settlementAsset());

        // The router being replaced has to be the lane's own, on the same registry and guard, so
        // the new one is a drop-in for every mandate that adopts it.
        address previous = _recordAddress(K.STOCK_ROUTER);
        if (previous != address(0)) {
            _requireCode(K.STOCK_ROUTER, previous);
            _expect("previous router.registry", address(registry), address(StockSpendRouter(previous).registry()));
            _expect("previous router.guard", address(guard), address(StockSpendRouter(previous).guard()));
            if (_sells(previous)) revert AlreadySells(previous);
        }

        vm.startBroadcast(deployer);
        router = new StockSpendRouter(registry, guard, IPoolManager(poolManager));
        vm.stopBroadcast();

        _expect("router.registry", address(registry), address(router.registry()));
        _expect("router.guard", address(guard), address(router.guard()));
        _expect("router.poolManager", poolManager, address(router.poolManager()));
        _expect("router.usdg", asset, address(router.usdg()));

        if (previous != address(0)) _write(PREVIOUS_ROUTER, previous);
        _write(K.STOCK_ROUTER, address(router));

        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("StockSpendRouter", address(router));
        if (previous != address(0)) console2.log("  replaces", previous);
        console2.log("  registry", address(registry));
        console2.log("  guard", address(guard));
        console2.log("Next: repointExample() from the payer, then codegen and the console");
    }

    /// The example mandate's principal points it at the recorded router and allows every stock the
    /// registry lists, for purchase and for sale, at a 1% slippage limit. Repeatable.
    function repointExample() external {
        _loadPrefix();
        _requireChain();
        address mandate = _recordAddress(EXAMPLE);
        _requireCode(EXAMPLE, mandate);
        StockSpendRouter router = StockSpendRouter(_upstream(K.STOCK_ROUTER));
        address principal = IMandateAccount(mandate).principal();
        if (msg.sender != principal) revert NotExamplePrincipal(mandate, principal, msg.sender);

        AssetRegistry registry = router.registry();
        address[] memory all = registry.assets();
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (registry.get(all[i]).isStock) ++n;
        }
        address[] memory stocks = new address[](n);
        bool[] memory allowed = new bool[](n);
        uint256 at;
        for (uint256 i; i < all.length; ++i) {
            if (!registry.get(all[i]).isStock) continue;
            stocks[at] = all[i];
            allowed[at++] = true;
        }

        vm.startBroadcast(principal);
        if (IMandateAccount(mandate).router() != address(router)) IMandateAccount(mandate).setRouter(address(router));
        router.setPolicy(mandate, 100, stocks, allowed);
        router.setSalePolicy(mandate, stocks, allowed);
        vm.stopBroadcast();

        console2.log("example mandate", mandate);
        console2.log("  router", address(router));
        console2.log("  stocks allowed to buy and sell", n);
    }

    /// Whether a router at `at` is one that sells: it answers `custodyOf`.
    function _sells(address at) private view returns (bool) {
        (bool ok, bytes memory answer) = at.staticcall(abi.encodeCall(StockSpendRouter.custodyOf, (address(0))));
        return ok && answer.length == 32;
    }
}
