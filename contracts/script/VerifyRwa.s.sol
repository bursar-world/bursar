// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {RwaConfig} from "./lib/RwaConfig.sol";
import {StockListings} from "./lib/StockListings.sol";

import {IMandateAccountFactory} from "../src/interfaces/IMandateAccountFactory.sol";
import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {PriceGuard} from "../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../src/rwa/StockSpendRouter.sol";
import {TreasuryPark} from "../src/rwa/TreasuryPark.sol";
import {RobinhoodStockAdapter} from "../src/rwa/adapters/RobinhoodStockAdapter.sol";
import {UsdgAdapter} from "../src/rwa/adapters/UsdgAdapter.sol";

/// Asks the chain what `DeployRwa.s.sol` asked its simulation: the registry holds every asset on
/// the terms `RwaConfig` sets and the pool the record names, and the park takes mandates from the
/// record's factory alone. A park carried over from the previous deployment lists that
/// deployment's treasury adapter until the wiring batch switches them, which is owed, not wrong.
abstract contract RwaChecks is Verifier {
    function _checkRwa() internal {
        address registry = _contract(K.ASSET_REGISTRY);
        address guard = _contract(K.PRICE_GUARD);
        address router = _contract(K.STOCK_ROUTER);
        address park = _contract(K.TREASURY_PARK);
        address treasuryAdapter = _contract(K.SGOV_ADAPTER);
        address usdgAdapter = _contract(K.USDG_ADAPTER);
        if (registry == address(0) || guard == address(0) || router == address(0) || park == address(0)) return;

        _checkRegistry(AssetRegistry(registry));

        PriceGuard g = PriceGuard(guard);
        _is("PriceGuard.registry", registry, address(g.registry()));
        _is("PriceGuard.accessRegistry", _recordAddress(K.ACCESS_REGISTRY), address(g.accessRegistry()));
        _is("PriceGuard.stateView", _recordAddress(K.STATE_VIEW), address(g.stateView()));
        _checkGuardGovernance(g);
        _isParamAt("PriceGuard.minObservationAge", guard, abi.encodeCall(g.MIN_OBSERVATION_AGE, ()));
        _isParamAt("PriceGuard.maxObservationAge", guard, abi.encodeCall(g.MAX_OBSERVATION_AGE, ()));
        _isParamAt("PriceGuard.maxFeedJumpBps", guard, abi.encodeCall(g.MAX_FEED_JUMP_BPS, ()));
        _is("StockSpendRouter.registry", registry, address(StockSpendRouter(router).registry()));
        _is("StockSpendRouter.guard", guard, address(StockSpendRouter(router).guard()));

        TreasuryPark p = TreasuryPark(park);
        _admin("TreasuryPark", p.admin(), p.pendingAdmin());
        IMandateAccountFactory[] memory factories = p.factories();
        _isUint("TreasuryPark.factories", 1, factories.length);
        if (factories.length == 1) _is("TreasuryPark.factory", _recordAddress(K.FACTORY), address(factories[0]));
        if (treasuryAdapter != address(0)) {
            _checkTreasuryAdapter(p, treasuryAdapter);
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

    /// The park lists the record's treasury adapter and not the previous deployment's, when
    /// `BURSAR_PREVIOUS_RECORD` names a different one on the same park. Until the wiring batch
    /// switches them the previous one is still listed, which is owed.
    function _checkTreasuryAdapter(TreasuryPark p, address adapter) private {
        address previous = _previousAddress(K.SGOV_ADAPTER);
        bool switching =
            previous != address(0) && previous != adapter && _previousAddress(K.TREASURY_PARK) == address(p);
        bool listed = p.isAdapter(adapter);
        _fact("TreasuryPark.isAdapter.SGOV", listed);
        if (!listed && switching && p.isAdapter(previous)) {
            _owe("TreasuryPark still lists the previous treasury adapter: the wiring batch switches it");
            return;
        }
        _isTrue("TreasuryPark does not list the treasury adapter", listed);
        if (switching) _isTrue("TreasuryPark still lists the previous treasury adapter", !p.isAdapter(previous));
    }

    /// The guard answers to the timelock, takes observations from the recorded keeper alone, and
    /// names the timelock's guardian as the one who can remove a keeper without a proposal. A
    /// guard built before it had an admin, the fourth set's, answers neither read: the check says
    /// so and asks nothing else of its governance, since the fifth set's guard replaces it. The
    /// fifth set's guard answers the admin reads and not the guardian one, which the sixth set's
    /// adds; the check says so for it the same way.
    function _checkGuardGovernance(PriceGuard g) private {
        (bool ok, bytes memory answer) = address(g).staticcall(abi.encodeCall(g.admin, ()));
        if (!ok || answer.length != 32) {
            _fact("PriceGuard.admin", "none: built before the guard had an admin or a keeper");
            return;
        }
        _admin("PriceGuard", abi.decode(answer, (address)), g.pendingAdmin());
        address guardKeeper = _recordAddress(".rwa.guardKeeper");
        _fact("PriceGuard.keeper", guardKeeper);
        _isTrue("PriceGuard does not list the recorded keeper", guardKeeper != address(0) && g.isKeeper(guardKeeper));
        (ok, answer) = address(g).staticcall(abi.encodeCall(g.guardian, ()));
        if (!ok || answer.length != 32) {
            _fact("PriceGuard.guardian", "none: built before the guard had a guardian");
            return;
        }
        address guardian = _recordAddress(K.GOVERNANCE48_GUARDIAN);
        if (guardian == address(0)) guardian = _recordAddress(K.GUARDIAN);
        _is("PriceGuard.guardian", guardian, abi.decode(answer, (address)));
    }

    function _checkRegistry(AssetRegistry registry) private {
        address asset = _settlementAsset();
        _admin("AssetRegistry", registry.admin(), registry.pendingAdmin());
        _is("AssetRegistry.settlementAsset", asset, registry.settlementAsset());

        RwaConfig.Term[] memory terms = RwaConfig.terms();
        _isUint("AssetRegistry.assets", terms.length + _checkListings(registry), registry.assets().length);
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

    /// The stocks `ListStocks.s.sol` lists after launch, each on its terms and in its tier once it
    /// is on chain; one the record names and the registry does not hold yet is owed, not wrong.
    /// Returns how many the registry holds.
    function _checkListings(AssetRegistry registry) private returns (uint256 held) {
        address usdg = _settlementAsset();
        address vault = _recordAddress(K.COLLATERAL_VAULT);
        StockListings.Listing[] memory listings = StockListings.all();
        for (uint256 i; i < listings.length; ++i) {
            string memory symbol = listings[i].symbol;
            string memory at = string.concat(K.EXTERNAL_ASSETS, ".", symbol);
            if (!_recorded(string.concat(at, ".address"))) continue;
            address token = _recordAddress(string.concat(at, ".address"));
            if (!registry.isRegistered(token)) {
                _owe(string.concat(symbol, " is not listed yet: ListStocks.s.sol proposes it"));
                continue;
            }
            ++held;
            AssetRegistry.Asset memory a = registry.get(token);
            _is(string.concat(symbol, ".feed"), _recordAddress(string.concat(at, ".feed")), a.feed);
            _isTrue(string.concat(symbol, " is not eligible"), a.eligible);
            _isTrue(string.concat(symbol, " is not a stock"), a.isStock && !a.isTreasury);
            _isUint(string.concat(symbol, ".bandBps"), 100, a.bandBps);
            _isUint(string.concat(symbol, ".perTradeCap"), RwaConfig.STOCK_TRADE_CAP, a.perTradeCap);
            bytes32 built = keccak256(abi.encode(RwaConfig.pool(token, usdg, listings[i].fee, listings[i].tickSpacing)));
            _isTrue(string.concat(symbol, " trades through another pool"), registry.poolId(token) == built);
            string memory recorded = string.concat(K.RWA_ASSETS, ".", symbol, ".address");
            if (_recorded(recorded)) _is(string.concat("rwa.assets.", symbol, ".address"), token, _recordAddress(recorded));
            else _owe(string.concat(symbol, " is listed and not yet in rwa.assets: ListStocks.s.sol record() writes it"));
            if (vault != address(0)) {
                uint8 tier = CollateralVault(vault).tierOf(token);
                if (tier == 0) _owe(string.concat(symbol, " has no collateral tier yet: the batch's second proposal sets it"));
                else _isUint(string.concat("CollateralVault.tierOf(", symbol, ")"), listings[i].tier, tier);
            }
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
