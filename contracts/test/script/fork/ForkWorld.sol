// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RecordKeys as K} from "../../../script/lib/RecordKeys.sol";

import {AssetRegistry} from "../../../src/rwa/AssetRegistry.sol";
import {IAggregatorV3} from "../../../src/rwa/interfaces/IRwaExternal.sol";
import {World} from "../World.sol";

/// The planned contract set, deployed by the real scripts from its mainnet record, by the record's
/// own deploy key, onto a fork of Robinhood Chain as it stands. The record carries the timelock and
/// the token set over from the live deployment, so those scripts join what they find. What the
/// lanes then touch is live: the feeds, the pinned pools, the access registry, USDG and its issuer
/// controls. Nothing is mocked.
///
///   BURSAR_RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/script/fork/*'
///
/// Without that variable every test here skips, so the offline suite is unaffected. The fork is
/// taken at the latest block, because the public endpoint keeps recent state only, so a run reads
/// the market as it is: a buy needs the equities feeds inside their trade bound, which they are
/// through the 24/5 session and not at weekends.
abstract contract ForkWorld is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// A plain address holding millions of USDG on 4663, used only as a source of test funds
    /// inside the fork.
    address internal constant USDG_WHALE = 0x6bEbb110c9BB93D529d1EAB51D44bcf49ae585D5;
    /// Uniswap v4's manager holds every pool's tokens, which makes it the fork's source of stock.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    /// Forks the chain and copies the mainnet record to a file of this suite's own, so every script
    /// run here writes there and `deployments/` is never touched.
    function _fork(string memory name) internal {
        string memory rpc = vm.envOr("BURSAR_RHC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "BURSAR_RHC_FORK_RPC is unset; it names the Robinhood Chain endpoint these suites fork");
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == 4663, "the fork is not Robinhood Chain");

        _source("script/env/rhc-mainnet-v4.env");
        _set("BURSAR_LOCAL", "0");
        _set("BURSAR_ALLOW_EOA_GOVERNANCE", "i-accept-eoa-governance");
        vm.createDir(RECORDS, true);
        path = string.concat(RECORDS, "/", name, ".json");
        vm.writeFile(path, vm.readFile("deployments/rhc-mainnet-v4.json"));
        _set("BURSAR_RECORD", path);
        deployKey = _readAddress(path, K.DEPLOYER);
    }

    function _usdg(address to, uint256 amount) internal {
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(to, amount);
    }

    function _asset(string memory symbol) internal view returns (address) {
        return _readAddress(path, string.concat(K.RWA_ASSETS, ".", symbol, ".address"));
    }

    /// A stock trades only on a feed inside its trade bound. Out of session the answer is Friday's
    /// close, too old to trade on, so a lane that buys skips out of session.
    function _requireSession(string memory symbol) internal {
        AssetRegistry.Asset memory a = AssetRegistry(_readAddress(path, K.ASSET_REGISTRY)).get(_asset(symbol));
        (,,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        if (block.timestamp - updatedAt <= a.tradeStaleness) return;
        vm.skip(true, string.concat("the ", symbol, " feed is past its trade bound; run this in the 24/5 session"));
    }
}
