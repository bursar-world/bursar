// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {RwaConfig} from "./lib/RwaConfig.sol";

import {IPoolManager} from "../src/token/Buyback.sol";
import {IMandateAccountFactory} from "../src/interfaces/IMandateAccountFactory.sol";
import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../src/rwa/StockSpendRouter.sol";
import {TreasuryPark} from "../src/rwa/TreasuryPark.sol";
import {RobinhoodStockAdapter} from "../src/rwa/adapters/RobinhoodStockAdapter.sol";
import {UsdgAdapter} from "../src/rwa/adapters/UsdgAdapter.sol";
import {IAccessRegistry, IStateView} from "../src/rwa/interfaces/IRwaExternal.sol";

/// The RWA lane: the asset registry, the price guard, the stock router, and the treasury park with
/// its two adapters. The registry and the park answer to the timelock from their constructors, and
/// the launch assets are written in the registry's constructor, so the deploy key never holds the
/// pen.
///
/// The park takes mandates from the record's factory and from nothing else. Every account that
/// factory creates can unpark inside a spend, so there is one factory in this set and no second
/// one to keep in step.
///
/// Each asset's token and feed come from `external.assets` in the record, and the terms it trades
/// under from `RwaConfig`. On Robinhood Chain the record also carries the id of each asset's pinned
/// pool as it was measured, and the run stops if the key it builds does not hash to it.
///
/// A record that already names the registry, the park and the USDG adapter, with code behind them,
/// carries them over from the deployment it supersedes. Then this run deploys only the three
/// contracts that hold the guard: the guard itself, the stock router and the treasury adapter,
/// built against the carried registry and park. It checks the carried three are the contracts the
/// record implies, and leaves the park's adapter list to governance: the wiring batch enables the
/// new treasury adapter and disables the previous one.
contract DeployRwa is BursarScript {
    struct Deployment {
        AssetRegistry registry;
        PriceGuard guard;
        StockSpendRouter router;
        TreasuryPark park;
        RobinhoodStockAdapter treasuryAdapter;
        UsdgAdapter usdgAdapter;
    }

    error AssetKindMismatch(string symbol, string recorded);
    error PoolIdMismatch(string symbol, bytes32 recorded, bytes32 built);
    error PoolNotOpen(string symbol, bytes32 poolId);
    error OneTreasuryAsset(uint256 found);
    error AssetNotRegistered(string symbol, address token);

    /// The keeper service's key, recorded next to the guard it observes for. RecordKeys names the
    /// shared paths; this one is local to the RWA scripts.
    string private constant GUARD_KEEPER = ".rwa.guardKeeper";

    address private asset;
    address private timelock;
    address private escrow;
    address private factory;
    address private poolManager;
    address private stateView;
    address private accessRegistry;

    uint256 private minObservationAge;
    uint256 private maxObservationAge;
    uint256 private maxFeedJumpBps;
    address private guardKeeper;

    RwaConfig.Term[] private terms;
    address[] private tokens;
    address[] private feeds;
    address private treasuryAsset;

    bool private joining;
    Deployment private d;

    function run() external returns (Deployment memory) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        _load();
        joining = _carried();
        if (joining) _loadCarried();
        _preflight();

        vm.startBroadcast(deployer);
        if (joining) _join();
        else _deploy();
        vm.stopBroadcast();

        _verify();
        _record();
        _report(deployer);
        return d;
    }

    function _load() private {
        asset = _settlementAsset();
        timelock = _timelock();
        escrow = _upstream(K.ESCROW);
        factory = _upstream(K.FACTORY);
        poolManager = _upstream(K.POOL_MANAGER);
        stateView = _upstream(K.STATE_VIEW);
        accessRegistry = _upstream(K.ACCESS_REGISTRY);

        minObservationAge = _envUint("BURSAR_MIN_OBSERVATION_AGE");
        maxObservationAge = _envUint("BURSAR_MAX_OBSERVATION_AGE");
        maxFeedJumpBps = _envUint16("BURSAR_MAX_FEED_JUMP_BPS");
        guardKeeper = _role(GUARD_KEEPER, "BURSAR_GUARD_KEEPER");

        RwaConfig.Term[] memory all = RwaConfig.terms();
        uint256 treasuries;
        for (uint256 i; i < all.length; ++i) {
            RwaConfig.Term memory term = all[i];
            string memory at = string.concat(K.EXTERNAL_ASSETS, ".", term.symbol);
            tokens.push(_upstream(string.concat(at, ".address")));
            feeds.push(_upstream(string.concat(at, ".feed")));

            string memory kind = _recordString(string.concat(at, ".kind"));
            string memory expected = term.isTreasury ? "treasury" : "stock";
            if (keccak256(bytes(kind)) != keccak256(bytes(expected))) revert AssetKindMismatch(term.symbol, kind);
            if (term.isTreasury) {
                ++treasuries;
                treasuryAsset = tokens[i];
            }
            terms.push(term);
        }
        // The park has one treasury adapter, and it is built for the one treasury asset.
        if (treasuries != 1) revert OneTreasuryAsset(treasuries);
    }

    /// Whether the record already carries the registry, the park and the USDG adapter, with code
    /// behind each entry. An entry with no code is a broadcast that never landed and is deployed
    /// afresh, as always.
    function _carried() private view returns (bool) {
        return _recordAddress(K.ASSET_REGISTRY).code.length != 0 && _recordAddress(K.TREASURY_PARK).code.length != 0
            && _recordAddress(K.USDG_ADAPTER).code.length != 0;
    }

    function _loadCarried() private {
        d.registry = AssetRegistry(_recordAddress(K.ASSET_REGISTRY));
        d.park = TreasuryPark(_recordAddress(K.TREASURY_PARK));
        d.usdgAdapter = UsdgAdapter(_recordAddress(K.USDG_ADAPTER));
        _requireCarriedSet();
    }

    /// The carried contracts have to be the ones the record implies, read off the chain before the
    /// guard is built against them: the registry answers to the recorded timelock, settles in the
    /// recorded asset and holds every launch asset on its recorded feed and pinned pool; the park
    /// answers to the same timelock, holds the same asset, admits the recorded factory alone and
    /// lists the carried USDG adapter; and that adapter is the park's. Each identity read is one a
    /// record naming the wrong kind of contract fails by name.
    function _requireCarriedSet() private view {
        _expect("registry.admin", timelock, _identity(address(d.registry), "admin()", "AssetRegistry.admin"));
        _expect("registry.settlementAsset", asset, d.registry.settlementAsset());
        for (uint256 i; i < terms.length; ++i) {
            if (!d.registry.isRegistered(tokens[i])) revert AssetNotRegistered(terms[i].symbol, tokens[i]);
            _expect(string.concat("registry.", terms[i].symbol, ".feed"), feeds[i], d.registry.get(tokens[i]).feed);
            bytes32 built = keccak256(abi.encode(RwaConfig.pool(tokens[i], asset, terms[i].fee, terms[i].tickSpacing)));
            bytes32 pinned = d.registry.poolId(tokens[i]);
            if (pinned != built) revert PoolIdMismatch(terms[i].symbol, pinned, built);
        }

        _expect("park.admin", timelock, _identity(address(d.park), "admin()", "TreasuryPark.admin"));
        _expect("park.usdg", asset, address(d.park.usdg()));
        IMandateAccountFactory[] memory factories = d.park.factories();
        _expectUint("park.factories", 1, factories.length);
        _expect("park.factory", factory, address(factories[0]));
        _expectUint("park.isAdapter.usdg", 1, d.park.isAdapter(address(d.usdgAdapter)) ? 1 : 0);
        _expect("usdgAdapter.park", address(d.park), _identity(address(d.usdgAdapter), "park()", "UsdgAdapter.park"));
        _expect("usdgAdapter.asset", asset, d.usdgAdapter.asset());
    }

    function _identity(address target, string memory signature, string memory what) private view returns (address) {
        return _read(target, abi.encodeWithSignature(signature), what);
    }

    function _preflight() private view {
        if (!joining) {
            _requireUnrecorded(K.ASSET_REGISTRY);
            _requireUnrecorded(K.TREASURY_PARK);
            _requireUnrecorded(K.USDG_ADAPTER);
        }
        _requireUnrecorded(K.PRICE_GUARD);
        _requireUnrecorded(K.STOCK_ROUTER);
        _requireUnrecorded(K.SGOV_ADAPTER);

        // The park admits accounts by asking this factory who created them, so it has to be the
        // factory that builds accounts on this deployment's escrow and asset.
        _expect("factory.escrow", escrow, IMandateAccountFactory(factory).escrow());
        _expect("factory.settlementAsset", asset, IMandateAccountFactory(factory).settlementAsset());

        // Identity reads on the two outside contracts the guard trusts. Either one answering
        // nothing would make every trade in the lane revert with a decode error.
        try IAccessRegistry(accessRegistry).paused() returns (bool) {}
        catch {
            revert NoAnswer("AccessRegistry.paused", accessRegistry);
        }

        for (uint256 i; i < terms.length; ++i) {
            RwaConfig.Term memory term = terms[i];
            bytes32 built = keccak256(abi.encode(RwaConfig.pool(tokens[i], asset, term.fee, term.tickSpacing)));
            string memory measured = string.concat(K.EXTERNAL_ASSETS, ".", term.symbol, ".poolId");
            if (_recorded(measured)) {
                bytes32 recorded = vm.parseJsonBytes32(_json(), measured);
                if (recorded != built) revert PoolIdMismatch(term.symbol, recorded, built);
            }
            // The pinned pool has to be open. A key that hashes to an empty slot is a pool nobody
            // trades in, and the guard would refuse every price it tried to read.
            try IStateView(stateView).getSlot0(built) returns (uint160 sqrtPriceX96, int24, uint24, uint24) {
                if (sqrtPriceX96 == 0) revert PoolNotOpen(term.symbol, built);
            } catch {
                revert NoAnswer("StateView.getSlot0", stateView);
            }
        }
    }

    function _deploy() private {
        address[] memory list = new address[](terms.length);
        AssetRegistry.Asset[] memory configs = new AssetRegistry.Asset[](terms.length);
        for (uint256 i; i < terms.length; ++i) {
            list[i] = tokens[i];
            configs[i] = RwaConfig.asset(terms[i], tokens[i], feeds[i], asset);
        }

        d.registry = new AssetRegistry(timelock, asset, list, configs);
        _deployGuard();

        IMandateAccountFactory[] memory factories = new IMandateAccountFactory[](1);
        factories[0] = IMandateAccountFactory(factory);
        d.park = new TreasuryPark(asset, timelock, factories);
        _deployTreasuryAdapter();
        d.usdgAdapter = new UsdgAdapter(address(d.park), asset, RwaConfig.PARK_PER_MANDATE, RwaConfig.PARK_TOTAL);

        // The adapters take the park's address in their constructors, so the deployer lists them
        // once, here. Every later change is governance's.
        address[] memory adapters = new address[](2);
        adapters[0] = address(d.treasuryAdapter);
        adapters[1] = address(d.usdgAdapter);
        d.park.initAdapters(adapters);
    }

    /// On a carried registry and park, only the three contracts that hold the guard. The park's
    /// adapter list is governance's once the deployer has listed it, so the new treasury adapter
    /// waits for the wiring batch.
    function _join() private {
        _deployGuard();
        _deployTreasuryAdapter();
    }

    function _deployGuard() private {
        d.guard = new PriceGuard(
            d.registry,
            IAccessRegistry(accessRegistry),
            IStateView(stateView),
            minObservationAge,
            maxObservationAge,
            maxFeedJumpBps,
            timelock
        );
        // The guard answers to the timelock, but the keeper service's key is known now and the
        // lane cannot draw until a keeper exists, so the deployer names the first one here, the
        // way it binds the vault and lists the park's adapters.
        d.guard.initKeeper(guardKeeper);
        d.router = new StockSpendRouter(d.registry, d.guard, IPoolManager(poolManager));
    }

    function _deployTreasuryAdapter() private {
        d.treasuryAdapter =
            new RobinhoodStockAdapter(address(d.park), treasuryAsset, d.registry, d.guard, IPoolManager(poolManager));
    }

    function _verify() private view {
        _expect("registry.admin", timelock, d.registry.admin());
        _expect("registry.settlementAsset", asset, d.registry.settlementAsset());
        _expectUint("registry.assets", terms.length, d.registry.assets().length);
        _expect("guard.registry", address(d.registry), address(d.guard.registry()));
        _expect("guard.accessRegistry", accessRegistry, address(d.guard.accessRegistry()));
        _expect("guard.stateView", stateView, address(d.guard.stateView()));
        _expectUint("guard.minObservationAge", minObservationAge, d.guard.MIN_OBSERVATION_AGE());
        _expectUint("guard.maxObservationAge", maxObservationAge, d.guard.MAX_OBSERVATION_AGE());
        _expectUint("guard.maxFeedJumpBps", maxFeedJumpBps, d.guard.MAX_FEED_JUMP_BPS());
        _expect("guard.admin", timelock, d.guard.admin());
        _expect("guard.pendingAdmin", address(0), d.guard.pendingAdmin());
        _expectUint("guard.keeper", 1, d.guard.isKeeper(guardKeeper) ? 1 : 0);
        _expect("router.registry", address(d.registry), address(d.router.registry()));
        _expect("router.guard", address(d.guard), address(d.router.guard()));
        _expect("park.admin", timelock, d.park.admin());
        _expect("park.pendingAdmin", address(0), d.park.pendingAdmin());
        IMandateAccountFactory[] memory factories = d.park.factories();
        _expectUint("park.factories", 1, factories.length);
        _expect("park.factory", factory, address(factories[0]));
        // A carried park lists the previous treasury adapter until the wiring batch switches them.
        if (!joining) {
            _expectUint("park.adapters", 2, d.park.adapters().length);
            _expectUint("park.isAdapter.treasury", 1, d.park.isAdapter(address(d.treasuryAdapter)) ? 1 : 0);
        }
        _expectUint("park.isAdapter.usdg", 1, d.park.isAdapter(address(d.usdgAdapter)) ? 1 : 0);
    }

    function _record() private {
        _write(K.ASSET_REGISTRY, address(d.registry));
        _write(K.PRICE_GUARD, address(d.guard));
        _write(K.STOCK_ROUTER, address(d.router));
        _write(K.TREASURY_PARK, address(d.park));
        for (uint256 i; i < terms.length; ++i) {
            string memory at = string.concat(K.RWA_ASSETS, ".", terms[i].symbol);
            _write(string.concat(at, ".address"), tokens[i]);
            _write(string.concat(at, ".feed"), feeds[i]);
            _writeString(string.concat(at, ".kind"), terms[i].isTreasury ? "treasury" : "stock");
            if (terms[i].isTreasury) {
                _write(string.concat(".rwa.adapters.", terms[i].symbol), address(d.treasuryAdapter));
            }
        }
        _write(K.USDG_ADAPTER, address(d.usdgAdapter));
        // A carried registry and park keep the block their own deployment recorded.
        if (!joining) _write(K.RWA_FROM_BLOCK, _chainBlock());

        _write(GUARD_KEEPER, guardKeeper);
        _write(".parameters.PriceGuard.minObservationAge", minObservationAge);
        _write(".parameters.PriceGuard.maxObservationAge", maxObservationAge);
        _write(".parameters.PriceGuard.maxFeedJumpBps", maxFeedJumpBps);
    }

    function _report(address deployer) private view {
        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("AssetRegistry", address(d.registry));
        if (joining) console2.log("  live, carried over by this run");
        console2.log("PriceGuard", address(d.guard));
        console2.log("  keeper observes every", minObservationAge);
        console2.log("  keeper", guardKeeper);
        console2.log("StockSpendRouter", address(d.router));
        console2.log("TreasuryPark", address(d.park));
        if (joining) console2.log("  live, carried over by this run");
        console2.log("  mandates from", factory);
        console2.log("RobinhoodStockAdapter", address(d.treasuryAdapter));
        if (joining) console2.log("  listed on the park by the wiring batch, which drops the previous one");
        console2.log("UsdgAdapter", address(d.usdgAdapter));
        if (joining) console2.log("  live, carried over by this run");
        console2.log("Next: DeployCollateral.s.sol");
    }
}
