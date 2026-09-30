// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BursarScript} from "../lib/BursarScript.sol";
import {RecordKeys as K} from "../lib/RecordKeys.sol";
import {RwaConfig} from "../lib/RwaConfig.sol";

import {MockUsdg} from "../../test/mocks/MockUsdg.sol";
import {MockAccess, MockFeed, MockStock, MockV4} from "../../test/rwa/RwaMocks.sol";

/// Stands in for Robinhood Chain's outside contracts on a local chain, and writes the record a
/// rehearsal of the deployment starts from.
///
/// USDG is placed at its real address, so the deploy scripts run their Robinhood Chain checks
/// against it unchanged and shielded pools hash the same asset into their scope. The rest are
/// deployed fresh and written into the record's `external` section: one mock that is both the v4
/// pool manager and its StateView, the access registry, and a token and a Chainlink-style feed for
/// each asset, with each pinned pool priced at its feed.
///
/// The record is written from scratch at `BURSAR_RECORD`. It says `"local": true`, so every script
/// that reads it needs `BURSAR_LOCAL=1`, and nothing that reads the mainnet record will accept it.
///
///   anvil --chain-id 4663
///   BURSAR_LOCAL=1 BURSAR_RECORD=cache/bursar/local-4663.json BURSAR_DEPLOYER=<deploy key> \
///     forge script script/local/LocalFixtures.s.sol --rpc-url http://127.0.0.1:8545 \
///     --unlocked --sender <any funded account> --broadcast
contract LocalFixtures is BursarScript {
    uint256 internal constant SGOV_E8 = 101_17856966;
    uint256 internal constant SPY_E8 = 771_21266423;
    uint256 internal constant NVDA_E8 = 180_42000000;
    uint256 internal constant AAPL_E8 = 231_58000000;

    /// What the deploy key holds before the core run: the preflight asks for one USDG.
    uint256 internal constant DEPLOYER_USDG = 10e6;

    struct Fixtures {
        MockV4 v4;
        MockAccess access;
        MockStock[4] tokens;
        MockFeed[4] feeds;
    }

    function run() external returns (Fixtures memory f) {
        _loadPrefix();
        require(_envFlag("BURSAR_LOCAL"), "LocalFixtures writes a rehearsal record and needs BURSAR_LOCAL=1");
        address deployer = _envAddress("BURSAR_DEPLOYER");
        string memory path = _recordPath();
        if (!vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            vm.createDir("cache/bursar", true);
            vm.writeFile(path, _skeleton(deployer));
        }

        _placeUsdg();

        RwaConfig.Term[] memory terms = RwaConfig.terms();
        uint256[4] memory prices = [SGOV_E8, SPY_E8, NVDA_E8, AAPL_E8];

        vm.startBroadcast(msg.sender);
        f.v4 = new MockV4();
        f.access = new MockAccess();
        for (uint256 i; i < 4; ++i) {
            f.tokens[i] = new MockStock(terms[i].symbol);
            f.feeds[i] = new MockFeed();
        }
        for (uint256 i; i < 4; ++i) {
            f.feeds[i].set(int256(prices[i]), block.timestamp);
            address token = address(f.tokens[i]);
            f.v4
                .setPrice(
                    RwaConfig.pool(token, RHC_USDG, terms[i].fee, terms[i].tickSpacing),
                    _sqrtPrice(prices[i], token < RHC_USDG)
                );
            // Depth for every trade a rehearsal makes, on both sides of each pool.
            f.tokens[i].mint(address(f.v4), 1_000_000e18);
        }
        MockUsdg(RHC_USDG).mint(address(f.v4), 10_000_000e6);
        MockUsdg(RHC_USDG).mint(deployer, DEPLOYER_USDG);
        address t3 = _deployLibrary("PoseidonT3.sol:PoseidonT3:prague");
        address t4 = _deployLibrary("PoseidonT4.sol:PoseidonT4:prague");
        vm.stopBroadcast();

        _write(K.POOL_MANAGER, address(f.v4));
        _write(K.STATE_VIEW, address(f.v4));
        _write(K.ACCESS_REGISTRY, address(f.access));
        _write(K.EXTERNAL_POSEIDON_T3, t3);
        _write(K.EXTERNAL_POSEIDON_T4, t4);
        for (uint256 i; i < 4; ++i) {
            string memory at = string.concat(K.EXTERNAL_ASSETS, ".", terms[i].symbol);
            _write(string.concat(at, ".address"), address(f.tokens[i]));
            _write(string.concat(at, ".feed"), address(f.feeds[i]));
            _writeString(string.concat(at, ".kind"), terms[i].isTreasury ? "treasury" : "stock");
        }
        console2.log("local record written to", path);
        console2.log("USDG stand-in at", RHC_USDG);
        console2.log("pool manager and StateView", address(f.v4));
    }

    function _skeleton(address deployer) private view returns (string memory) {
        return string.concat(
            '{"network":"local-',
            vm.toString(block.chainid),
            '","chainId":',
            vm.toString(block.chainid),
            ',"status":"planned","local":true,"dev":true,"rpc":"http://127.0.0.1:8545","explorer":"",',
            '"settlementAsset":"',
            vm.toString(RHC_USDG),
            '","settlementDecimals":6,"deployer":"',
            vm.toString(deployer),
            '","contracts":{},"verifiedOnChain":{}}'
        );
    }

    /// USDG's code at USDG's address. Against a node that is `anvil_setCode`, which lands at once;
    /// the local copy is etched too, so the rest of this run sees the same chain.
    function _placeUsdg() private {
        bytes memory code = address(new MockUsdg()).code;
        if (!vm.isContext(VmSafe.ForgeContext.TestGroup)) {
            vm.rpc("anvil_setCode", string.concat('["', vm.toString(RHC_USDG), '","', vm.toString(code), '"]'));
        }
        vm.etch(RHC_USDG, code);
    }

    /// The Poseidon libraries the shielded pool links against. On Robinhood Chain they are already
    /// deployed and the record names them; here they are deployed once and named the same way.
    function _deployLibrary(string memory name) private returns (address lib) {
        bytes memory code = vm.getCode(name);
        assembly ("memory-safe") {
            lib := create(0, add(code, 0x20), mload(code))
        }
        require(lib != address(0), "a Poseidon library did not deploy");
    }

    /// The pool price of one raw token in raw USDG, from a feed price with eight decimals: the
    /// tokens carry eighteen decimals and USDG six.
    function _sqrtPrice(uint256 priceE8, bool tokenIs0) private pure returns (uint160) {
        uint256 q192 = 1 << 192;
        uint256 ratio = tokenIs0 ? Math.mulDiv(priceE8, q192, 1e20) : Math.mulDiv(1e20, q192, priceE8);
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(Math.sqrt(ratio));
    }
}
