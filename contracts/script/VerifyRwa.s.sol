// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {RwaConfig} from "./lib/RwaConfig.sol";

import {IMandateAccountFactory} from "../src/interfaces/IMandateAccountFactory.sol";
import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../src/rwa/StockSpendRouter.sol";
import {TreasuryPark} from "../src/rwa/TreasuryPark.sol";
import {RobinhoodStockAdapter} from "../src/rwa/adapters/RobinhoodStockAdapter.sol";
import {UsdgAdapter} from "../src/rwa/adapters/UsdgAdapter.sol";

/// Asks the chain what `DeployRwa.s.sol` asked its simulation: the registry holds every asset on
/// the terms `RwaConfig` sets and the pool the record names, and the park takes mandates from the
/// record's factory alone.
abstract contract RwaChecks is Verifier {
    function _checkRwa() internal {
        address registry = _contract(K.ASSET_REGISTRY);
        address guard = _contract(K.PRICE_GUARD);
        address router = _contract(K.STOCK_ROUTER);
        address park = _contract(K.TREASURY_PARK);
        address treasuryAdapter = _contract(K.SGOV_ADAPTER);
        address usdgAdapter = _contract(K.USDG_ADAPTER);
        if (registry == address(0) || guard == address(0) || router == address(0) || park == address(0)) return;

        address timelock = _recordAddress(K.ADMIN_TIMELOCK);
        _checkRegistry(AssetRegistry(registry), timelock);

        PriceGuard g = PriceGuard(guard);
        _is("PriceGuard.registry", registry, address(g.registry()));
        _is("PriceGuard.accessRegistry", _recordAddress(K.ACCESS_REGISTRY), address(g.accessRegistry()));
        _is("PriceGuard.stateView", _recordAddress(K.STATE_VIEW), address(g.stateView()));
        _is("PriceGuard.admin", timelock, g.admin());
        _is("PriceGuard.pendingAdmin", address(0), g.pendingAdmin());
        address guardKeeper = _recordAddress(".rwa.guardKeeper");
        _fact("PriceGuard.keeper", guardKeeper);
        _isTrue("PriceGuard does not list the recorded keeper", guardKeeper != address(0) && g.isKeeper(guardKeeper));
        _isParamAt("PriceGuard.minObservationAge", guard, abi.encodeCall(g.MIN_OBSERVATION_AGE, ()));
        _isParamAt("PriceGuard.maxObservationAge", guard, abi.encodeCall(g.MAX_OBSERVATION_AGE, ()));
        _isParamAt("PriceGuard.maxFeedJumpBps", guard, abi.encodeCall(g.MAX_FEED_JUMP_BPS, ()));
        _is("StockSpendRouter.registry", registry, address(StockSpendRouter(router).registry()));
        _is("StockSpendRouter.guard", guard, address(StockSpendRouter(router).guard()));

        TreasuryPark p = TreasuryPark(park);
        _is("TreasuryPark.admin", timelock, p.admin());
        _is("TreasuryPark.pendingAdmin", address(0), p.pendingAdmin());
        IMandateAccountFactory[] memory factories = p.factories();
        _isUint("TreasuryPark.factories", 1, factories.length);
        if (factories.length == 1) _is("TreasuryPark.factory", _recordAddress(K.FACTORY), address(factories[0]));
        if (treasuryAdapter != address(0)) {
            _isTrue("TreasuryPark does not list the treasury adapter", p.isAdapter(treasuryAdapter));
            _is("RobinhoodStockAdapter.park", park, RobinhoodStockAdapter(treasuryAdapter).park());
            _is(
                "RobinhoodStockAdapter.asset",
                _recordAddress(".rwa.assets.SGOV.address"),
                RobinhoodStockAdapter(treasuryAdapter).asset()
            );
            _is("RobinhoodStockAdapter.guard", guard, address(RobinhoodStockAdapter(treasuryAdapter).guard()));
        }
        if (usdgAdapter != address(0)) {
            _isTrue("TreasuryPark does not list the USDG adapter", p.isAdapter(usdgAdapter));
            _is("UsdgAdapter.park", park, UsdgAdapter(usdgAdapter).park());
            _is("UsdgAdapter.asset", _settlementAsset(), UsdgAdapter(usdgAdapter).asset());
        }
    }

    function _checkRegistry(AssetRegistry registry, address timelock) private {
        address asset = _settlementAsset();
        _is("AssetRegistry.admin", timelock, registry.admin());
        _is("AssetRegistry.pendingAdmin", address(0), registry.pendingAdmin());
        _is("AssetRegistry.settlementAsset", asset, registry.settlementAsset());

        RwaConfig.Term[] memory terms = RwaConfig.terms();
        _isUint("AssetRegistry.assets", terms.length, registry.assets().length);
        for (uint256 i; i < terms.length; ++i) {
            string memory at = string.concat(K.RWA_ASSETS, ".", terms[i].symbol);
            address token = _recordAddress(string.concat(at, ".address"));
            _is(
                string.concat("rwa.assets.", terms[i].symbol, ".address"),
                _recordAddress(string.concat(K.EXTERNAL_ASSETS, ".", terms[i].symbol, ".address")),
                token
            );
            if (!registry.isRegistered(token)) {
                _mismatch(string.concat(terms[i].symbol, " is not registered"));
                continue;
            }
            AssetRegistry.Asset memory a = registry.get(token);
            _is(string.concat(terms[i].symbol, ".feed"), _recordAddress(string.concat(at, ".feed")), a.feed);
            _isTrue(string.concat(terms[i].symbol, " is not eligible"), a.eligible);
            _isUint(string.concat(terms[i].symbol, ".bandBps"), terms[i].bandBps, a.bandBps);
            _isUint(string.concat(terms[i].symbol, ".perTradeCap"), terms[i].perTradeCap, a.perTradeCap);
            _isUint(string.concat(terms[i].symbol, ".totalCap"), terms[i].totalCap, a.totalCap);
            bytes32 built = keccak256(abi.encode(RwaConfig.pool(token, asset, terms[i].fee, terms[i].tickSpacing)));
            _isTrue(string.concat(terms[i].symbol, " trades through another pool"), registry.poolId(token) == built);
        }
    }
}

/// `forge script script/VerifyRwa.s.sol --rpc-url "$RHC_RPC_URL"`, after `DeployRwa.s.sol`.
contract VerifyRwa is RwaChecks {
    function run() external {
        _begin();
        _checkRwa();
        _end("rwa");
    }
}
