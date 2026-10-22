// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {EndowmentFactory} from "../src/endowment/EndowmentFactory.sol";
import {PatronMark} from "../src/endowment/PatronMark.sol";
import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../src/rwa/StockSpendRouter.sol";

/// Deploys the endowment factory, and with it the patron marks, against the stock router, guard
/// and registry the record carries and the ERC-8004 identity registry on Robinhood Chain.
///
/// Nothing is administered: the factory has no owner and no administered contract names it, so no
/// proposal is involved. Endowment fees go to the record's treasury; the record's guardian is the
/// one key that can pause an endowment's draw, and it can move nothing.
///
///   forge script script/DeployEndowments.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" [--broadcast]
contract DeployEndowments is BursarScript {
    address private constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    uint16 private constant FEE_BPS = 500;
    string private constant MARK_BASE_URI = "https://app.bursar.world/api/marks/";

    string private constant FACTORY = ".endowments.EndowmentFactory";
    string private constant MARKS = ".endowments.PatronMark";
    string private constant IDENTITY_KEY = ".endowments.IdentityRegistry";
    string private constant FROM_BLOCK = ".endowments.fromBlock";
    string private constant FEE = ".endowments.feeBps";

    function run() external returns (EndowmentFactory factory) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        StockSpendRouter router = StockSpendRouter(_upstream(K.STOCK_ROUTER));
        PriceGuard guard = PriceGuard(_upstream(K.PRICE_GUARD));
        AssetRegistry registry = AssetRegistry(_upstream(K.ASSET_REGISTRY));
        address usdg = _settlementAsset();
        address treasury = _recordAddress(K.TREASURY);
        address guardian = _recordAddress(K.GUARDIAN);
        _requireCode("identity registry", IDENTITY);
        _expect("router.registry", address(registry), address(router.registry()));
        _expect("router.guard", address(guard), address(router.guard()));
        _expect("router.usdg", usdg, address(router.usdg()));

        uint256 fromBlock = _chainBlock();
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        vm.startBroadcast(deployer);
        PatronMark marks = new PatronMark(predicted, MARK_BASE_URI);
        factory = new EndowmentFactory(
            router, guard, registry, IERC20(usdg), IERC721(IDENTITY), treasury, FEE_BPS, guardian, marks
        );
        vm.stopBroadcast();

        _expect("factory.router", address(router), address(factory.router()));
        _expect("marks.factory", address(factory), address(factory.marks().factory()));

        _write(FACTORY, address(factory));
        _write(MARKS, address(factory.marks()));
        _write(IDENTITY_KEY, IDENTITY);
        _write(FROM_BLOCK, fromBlock);
        _write(FEE, uint256(FEE_BPS));

        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("EndowmentFactory", address(factory));
        console2.log("PatronMark", address(factory.marks()));
        console2.log("  router", address(router));
        console2.log("  fees to", treasury);
        console2.log("  guardian", guardian);
    }
}
