// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {Governance} from "./lib/Governance.sol";
import {IAdministered} from "./lib/Handover.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {RwaConfig} from "./lib/RwaConfig.sol";
import {StockListings} from "./lib/StockListings.sol";

import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {IAggregatorV3, IRobinhoodStock, IStateView} from "../src/rwa/interfaces/IRwaExternal.sol";

/// Lists the stocks in `StockListings` on the asset registry and files each in its collateral
/// tier: two proposals a stock, `AssetRegistry.setAsset` and `CollateralVault.setAssetTier`, put
/// to the timelock that administers each contract. One `propose()` run proposes the whole batch,
/// one `approve()` approves it and one `execute()` lands it once the delay has passed; a tier
/// call waits for its listing to execute, in the same run.
///
/// Each stock's token, feed and pinned pool id come from `external.assets.<SYMBOL>` in the record,
/// as `stocks-inventory.mjs` measured them; the terms from `StockListings`. Before anything is
/// proposed the batch is read against the chain: the feed answers with eight decimals, the token
/// is not paused, the pool key hashes to the recorded id and the pool is open. A stock already on
/// the registry on these terms is skipped, so the run can be repeated.
///
/// `record()` writes every listed stock into `rwa.assets` once it is on chain, which the console,
/// the SDK and `VerifyRwa.s.sol` read. `proposals()` prints each proposal's target and data for an
/// operator who sends them by hand.
///
///   forge script script/ListStocks.s.sol --sig "status()"   --rpc-url "$RHC_RPC_URL"
///   forge script script/ListStocks.s.sol --sig "proposals()" --rpc-url "$RHC_RPC_URL"
///   forge script script/ListStocks.s.sol --sig "propose()"  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1" --broadcast
///   forge script script/ListStocks.s.sol --sig "approve()"  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-2" --broadcast
///   forge script script/ListStocks.s.sol --sig "execute()"  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1" --broadcast
///   forge script script/ListStocks.s.sol --sig "record()"   --rpc-url "$RHC_RPC_URL"
contract ListStocks is Governance {
    error FeedNot8Decimals(string symbol, address feed);
    error TokenPaused(string symbol, address token);
    error PoolIdMismatch(string symbol, bytes32 recorded, bytes32 built);
    error PoolNotOpen(string symbol, bytes32 poolId);

    function _calls() internal view override returns (Call[] memory calls) {
        address registry = _upstream(K.ASSET_REGISTRY);
        address vault = _upstream(K.COLLATERAL_VAULT);
        address usdg = _settlementAsset();
        address registryGovernance = _governs(registry);
        address vaultGovernance = _governs(vault);
        StockListings.Listing[] memory listings = StockListings.all();
        calls = new Call[](listings.length * 2);
        for (uint256 i; i < listings.length; ++i) {
            StockListings.Listing memory listing = listings[i];
            (address token, address feed) = _external(listing.symbol);
            AssetRegistry.Asset memory config = StockListings.asset(listing, token, feed, usdg);
            _preflight(listing.symbol, token, config);
            calls[2 * i] = Call(
                registryGovernance,
                registry,
                abi.encodeCall(AssetRegistry.setAsset, (token, config)),
                string.concat("AssetRegistry.setAsset ", listing.symbol)
            );
            calls[2 * i + 1] = Call(
                vaultGovernance,
                vault,
                abi.encodeCall(CollateralVault.setAssetTier, (token, listing.tier)),
                string.concat("CollateralVault.setAssetTier ", listing.symbol, " to tier ", vm.toString(listing.tier))
            );
        }
    }

    /// The token and feed the record names for `symbol`, both with code behind them.
    function _external(string memory symbol) private view returns (address token, address feed) {
        string memory at = string.concat(K.EXTERNAL_ASSETS, ".", symbol);
        token = _upstream(string.concat(at, ".address"));
        feed = _upstream(string.concat(at, ".feed"));
    }

    /// What the registry would check at execution, read now, plus what it cannot: the pool key
    /// the terms build hashes to the id the record measured, and that pool has a price.
    function _preflight(string memory symbol, address token, AssetRegistry.Asset memory config) private view {
        if (IAggregatorV3(config.feed).decimals() != 8) revert FeedNot8Decimals(symbol, config.feed);
        if (IRobinhoodStock(token).tokenPaused()) revert TokenPaused(symbol, token);
        bytes32 built = keccak256(abi.encode(config.pool));
        string memory measured = string.concat(K.EXTERNAL_ASSETS, ".", symbol, ".poolId");
        if (_recorded(measured)) {
            bytes32 recorded = vm.parseJsonBytes32(_json(), measured);
            if (recorded != built) revert PoolIdMismatch(symbol, recorded, built);
        }
        (uint160 sqrtPriceX96,,,) = IStateView(_upstream(K.STATE_VIEW)).getSlot0(built);
        if (sqrtPriceX96 == 0) revert PoolNotOpen(symbol, built);
    }

    /// The timelock that administers `target` on the chain today.
    function _governs(address target) private view returns (address timelock) {
        timelock = IAdministered(target).admin();
        _requireCode(string.concat("the admin of ", vm.toString(target)), timelock);
    }

    function _applied(Call memory call) internal view override returns (bool) {
        bytes4 selector = bytes4(call.data);
        bytes memory args = _args(call.data);
        if (selector == AssetRegistry.setAsset.selector) {
            (address token, AssetRegistry.Asset memory wanted) = abi.decode(args, (address, AssetRegistry.Asset));
            AssetRegistry registry = AssetRegistry(call.target);
            if (!registry.isRegistered(token)) return false;
            AssetRegistry.Asset memory a = registry.get(token);
            return a.feed == wanted.feed && a.eligible == wanted.eligible && a.isStock == wanted.isStock
                && a.bandBps == wanted.bandBps && a.tradeStaleness == wanted.tradeStaleness
                && a.valuationStaleness == wanted.valuationStaleness && a.perTradeCap == wanted.perTradeCap
                && registry.poolId(token) == keccak256(abi.encode(wanted.pool));
        }
        if (selector == CollateralVault.setAssetTier.selector) {
            (address token, uint8 tier) = abi.decode(args, (address, uint8));
            return CollateralVault(call.target).tierOf(token) == tier;
        }
        return false;
    }

    /// A tier can be set only for a registered asset, so the tier call waits for the listing.
    function _ready(Call memory call) internal view override returns (bool) {
        if (bytes4(call.data) != CollateralVault.setAssetTier.selector) return true;
        (address token,) = abi.decode(_args(call.data), (address, uint8));
        return AssetRegistry(_upstream(K.ASSET_REGISTRY)).isRegistered(token);
    }

    /// Each proposal as `AdminTimelock.propose(target, data)` takes it.
    function proposals() external {
        _loadPrefix();
        _requireChain();
        Call[] memory calls = _calls();
        for (uint256 i; i < calls.length; ++i) {
            console2.log(calls[i].label);
            console2.log("  timelock", calls[i].timelock);
            console2.log("  target  ", calls[i].target);
            console2.log(string.concat("  data     ", vm.toString(calls[i].data)));
        }
    }

    /// Writes every stock the registry now lists on the batch's terms into `rwa.assets`.
    function record() external {
        _loadPrefix();
        _requireChain();
        AssetRegistry registry = AssetRegistry(_upstream(K.ASSET_REGISTRY));
        StockListings.Listing[] memory listings = StockListings.all();
        uint256 written;
        for (uint256 i; i < listings.length; ++i) {
            (address token, address feed) = _external(listings[i].symbol);
            if (!registry.isRegistered(token)) {
                console2.log(string.concat("not listed yet: ", listings[i].symbol));
                continue;
            }
            string memory at = string.concat(K.RWA_ASSETS, ".", listings[i].symbol);
            _write(string.concat(at, ".address"), token);
            _write(string.concat(at, ".feed"), feed);
            _writeString(string.concat(at, ".kind"), "stock");
            ++written;
        }
        console2.log("recorded", written, "of", listings.length);
        if (written > 0) console2.log("Next: pnpm --filter @bursar/core codegen, then commit the record");
    }

    function _args(bytes memory data) private pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
    }
}
