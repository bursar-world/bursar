// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ListStocks} from "../../script/ListStocks.s.sol";
import {VerifyRwa} from "../../script/VerifyRwa.s.sol";
import {LocalPoolManager} from "../../script/local/LocalPoolManager.sol";
import {Governance} from "../../script/lib/Governance.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {RwaConfig} from "../../script/lib/RwaConfig.sol";
import {StockListings} from "../../script/lib/StockListings.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockFeed, MockStock} from "../rwa/RwaMocks.sol";
import {World} from "./World.sol";

/// The listing batch through the timelock, one step per signer key, against a world whose record
/// names a token, a feed and a priced pool for every stock in `StockListings`: nothing is proposed
/// twice, a tier waits for its listing, and the registry and the vault hold every stock once the
/// delay has passed. A stock whose pool the record mis-names stops the run before anything is sent.
contract ListStocksTest is World {
    uint256 internal constant PRICE_E8 = 382_95000000;

    AdminTimelock internal timelock;
    address[] internal signers;
    AssetRegistry internal registry;
    CollateralVault internal vault;
    StockListings.Listing[] internal listings;
    address[] internal tokens;

    function _prefix() internal pure override returns (string memory) {
        return "LISTSTOCKS_";
    }

    function setUp() public {
        _world("list-stocks");
        _core();
        _token();
        _staking();
        _rwa();
        _collateral();
        timelock = AdminTimelock(_readAddress(path, K.ADMIN_TIMELOCK));
        signers = vm.parseJsonAddressArray(vm.readFile(path), K.SIGNERS);
        registry = AssetRegistry(_readAddress(path, K.ASSET_REGISTRY));
        vault = CollateralVault(_readAddress(path, K.COLLATERAL_VAULT));
        _placeStocks();
        _save();
    }

    /// A token, a feed and a pool at the feed price for each listing, written into the record the
    /// way the inventory writes the live one.
    function _placeStocks() private {
        LocalPoolManager v4 = LocalPoolManager(_readAddress(path, K.POOL_MANAGER));
        address usdg = _readAddress(path, K.SETTLEMENT_ASSET);
        StockListings.Listing[] memory all = StockListings.all();
        for (uint256 i; i < all.length; ++i) {
            listings.push(all[i]);
            MockStock token = new MockStock(all[i].symbol);
            MockFeed feed = new MockFeed();
            feed.set(int256(PRICE_E8), block.timestamp);
            bytes32 poolId =
                keccak256(abi.encode(RwaConfig.pool(address(token), usdg, all[i].fee, all[i].tickSpacing)));
            v4.setPrice(RwaConfig.pool(address(token), usdg, all[i].fee, all[i].tickSpacing), _sqrtPrice(address(token) < usdg));
            token.mint(address(v4), 1_000e18);
            MockUsdg(usdg).mint(address(v4), 100_000e6);
            tokens.push(address(token));

            string memory at = string.concat(K.EXTERNAL_ASSETS, ".", all[i].symbol);
            vm.writeJson(vm.toString(address(token)), path, string.concat(at, ".address"));
            vm.writeJson(vm.toString(address(feed)), path, string.concat(at, ".feed"));
            vm.writeJson('"stock"', path, string.concat(at, ".kind"));
            vm.writeJson(vm.toString(poolId), path, string.concat(at, ".poolId"));
        }
    }

    function _sqrtPrice(bool tokenIs0) private pure returns (uint160) {
        uint256 q192 = 1 << 192;
        uint256 ratio = tokenIs0 ? Math.mulDiv(PRICE_E8, q192, 1e20) : Math.mulDiv(1e20, q192, PRICE_E8);
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(Math.sqrt(ratio));
    }

    function _step(address key, bytes memory call) private {
        _as(key, _pinned(address(new ListStocks())), call);
    }

    function _propose(address key) private {
        _step(key, abi.encodeWithSignature("propose()"));
    }

    function _approve(address key) private {
        _step(key, abi.encodeWithSignature("approve()"));
    }

    function _execute(address key) private {
        _step(key, abi.encodeWithSignature("execute()"));
    }

    /// One test, because every suite built on a world shares its record file between its tests.
    function test_listStocks_listsEveryStockOnceThroughTheTimelock() public {
        _restore();
        uint256 batch = listings.length * 2;
        uint256 before = timelock.proposalCount();
        assertEq(registry.assets().length, RwaConfig.terms().length);

        // A key that is not a signer is refused before anything is broadcast.
        address script = _pinned(address(new ListStocks()));
        vm.expectRevert(abi.encodeWithSelector(Governance.NotSigner.selector, address(timelock), DEPLOYER));
        _as(DEPLOYER, script, abi.encodeWithSignature("propose()"));

        _step(signers[2], abi.encodeWithSignature("status()"));
        _step(signers[2], abi.encodeWithSignature("proposals()"));
        _propose(signers[0]);
        assertEq(timelock.proposalCount(), before + batch);

        // A second run, by the same signer or another, finds every call already proposed.
        _propose(signers[0]);
        _propose(signers[1]);
        assertEq(timelock.proposalCount(), before + batch);

        _approve(signers[1]);
        _approve(signers[1]);
        for (uint256 id = before; id < before + batch; ++id) {
            assertEq(timelock.approvals(id), 2);
        }

        // Run early, execute() sends nothing and fails, so a shell running it stops there.
        address early = _pinned(address(new ListStocks()));
        vm.expectRevert();
        _as(signers[0], early, abi.encodeWithSignature("execute()"));
        assertEq(registry.assets().length, RwaConfig.terms().length);

        // The listing and its tier execute in one run: a tier is ready once its listing landed.
        vm.warp(block.timestamp + timelock.timelockPeriod() + 1);
        _execute(signers[2]);
        assertEq(registry.assets().length, RwaConfig.terms().length + listings.length);
        for (uint256 i; i < listings.length; ++i) {
            AssetRegistry.Asset memory a = registry.get(tokens[i]);
            assertTrue(a.eligible && a.isStock && !a.isTreasury, listings[i].symbol);
            assertEq(a.bandBps, 100);
            assertEq(a.perTradeCap, RwaConfig.STOCK_TRADE_CAP);
            assertEq(a.tradeStaleness, RwaConfig.TRADE_STALENESS);
            assertEq(vault.tierOf(tokens[i]), listings[i].tier, listings[i].symbol);
        }

        // Once everything is applied, every step has nothing to do.
        uint256 after_ = timelock.proposalCount();
        _propose(signers[0]);
        _approve(signers[1]);
        _execute(signers[2]);
        assertEq(timelock.proposalCount(), after_);

        // The record takes every listed stock, and the verifier reads them back.
        _step(signers[2], abi.encodeWithSignature("record()"));
        for (uint256 i; i < listings.length; ++i) {
            assertEq(_readAddress(path, string.concat(K.RWA_ASSETS, ".", listings[i].symbol, ".address")), tokens[i]);
        }
        _check(address(new VerifyRwa()));

        _aMisnamedPoolStopsTheRun();
    }

    /// A pool id the record names that the terms do not build is a listing that would trade in
    /// the wrong pool; the run stops before the first proposal.
    function _aMisnamedPoolStopsTheRun() private {
        _restore();
        string memory key = string.concat(K.EXTERNAL_ASSETS, ".", listings[0].symbol, ".poolId");
        vm.writeJson(vm.toString(bytes32(uint256(1))), path, key);
        address script = _pinned(address(new ListStocks()));
        vm.expectRevert(
            abi.encodeWithSelector(
                ListStocks.PoolIdMismatch.selector,
                listings[0].symbol,
                bytes32(uint256(1)),
                keccak256(
                    abi.encode(
                        RwaConfig.pool(
                            tokens[0], _readAddress(path, K.SETTLEMENT_ASSET), listings[0].fee, listings[0].tickSpacing
                        )
                    )
                )
            )
        );
        _as(signers[0], script, abi.encodeWithSignature("propose()"));
        assertEq(timelock.proposalCount(), 0);
    }
}
