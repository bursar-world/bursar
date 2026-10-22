// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {Endowment} from "../../../src/endowment/Endowment.sol";
import {EndowmentFactory} from "../../../src/endowment/EndowmentFactory.sol";
import {PatronMark} from "../../../src/endowment/PatronMark.sol";
import {AssetRegistry} from "../../../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../../../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../../../src/rwa/StockSpendRouter.sol";

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// An endowment on a fork of Robinhood Chain, against the live router, guard, SPY pool and
/// ERC-8004 registry: the example mandate's agent (#8756) is endowed, its principal invested in
/// SPY, the endowment accepted by the identity's owner, the draw paid into the example mandate,
/// and the sleeve refilled by selling SPY back on the pool.
///
/// Set `BURSAR_RHC_FORK_RPC` to run it; without it every test here skips. The fork is taken at
/// the head unless `BURSAR_RHC_FORK_BLOCK` pins it, and needs the SPY feed inside its trade bound.
contract EndowmentForkTest is Test {
    string internal constant RECORD = "deployments/rhc-mainnet-v6.json";
    IERC721 internal constant IDENTITY = IERC721(0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 internal constant AGENT = 8756;

    EndowmentFactory factory;
    IERC20 usdg;
    address spy;
    address mandate;
    address owner;
    address settlor = makeAddr("settlor");

    function setUp() public {
        string memory rpc = vm.envOr("BURSAR_RHC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "set BURSAR_RHC_FORK_RPC to run the fork suite");
            return;
        }
        uint256 pinned = vm.envOr("BURSAR_RHC_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);
        require(block.chainid == 4663, "the fork is not Robinhood Chain");

        string memory json = vm.readFile(RECORD);
        usdg = IERC20(vm.parseJsonAddress(json, ".settlementAsset"));
        spy = vm.parseJsonAddress(json, ".rwa.assets.SPY.address");
        mandate = vm.parseJsonAddress(json, ".exampleMandate.address");
        owner = IDENTITY.ownerOf(AGENT);

        factory = new EndowmentFactory(
            StockSpendRouter(vm.parseJsonAddress(json, ".rwa.StockSpendRouter")),
            PriceGuard(vm.parseJsonAddress(json, ".rwa.PriceGuard")),
            AssetRegistry(vm.parseJsonAddress(json, ".rwa.AssetRegistry")),
            usdg,
            IDENTITY,
            vm.parseJsonAddress(json, ".roles.treasury"),
            500,
            vm.parseJsonAddress(json, ".roles.guardian"),
            new PatronMark(vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1), "https://app.bursar.world/api/marks/")
        );

        vm.prank(POOL_MANAGER);
        usdg.transfer(settlor, 60e6);
        vm.prank(settlor);
        usdg.approve(address(factory), type(uint256).max);
    }

    function test_fork_anAgentIsEndowedInSpyAndDrawsIntoItsMandate() public {
        Endowment e = _endow();

        vm.prank(owner);
        e.accept(mandate);
        assertEq(e.snapshotsTaken(), 1);
        assertApproxEqRel(e.averageNav(), 60e6, 0.01e18);

        uint256 bought;
        while (usdg.balanceOf(address(e)) > e.sleeveTarget() + 1e6) {
            bought += e.invest();
        }
        assertGt(bought, 0);
        assertEq(IERC20(spy).balanceOf(address(e)), bought);
        Endowment.State memory st = e.state();
        uint256 value = st.nav;
        assertTrue(st.navFresh);
        // Three fills on the live pool, each held to the feed by the router's floor.
        assertApproxEqRel(value, 60e6, 0.015e18);

        _warpKeepingTheFeed(90 days);
        uint256 before = usdg.balanceOf(mandate);
        vm.prank(owner);
        uint256 paid = e.draw();
        assertGt(paid, 0);
        assertEq(usdg.balanceOf(mandate), before + paid - paid / 20);

        uint256 out = e.refill();
        assertGt(out, 0);
        assertLt(IERC20(spy).balanceOf(address(e)), bought);
    }

    function test_fork_onlyTheIdentityOwnerAccepts() public {
        Endowment e = _endow();
        vm.prank(settlor);
        vm.expectRevert(Endowment.NotOwner.selector);
        e.accept(mandate);
    }

    function _endow() internal returns (Endowment e) {
        Endowment.Terms memory t;
        t.agentId = AGENT;
        t.assets = new address[](1);
        t.assets[0] = spy;
        t.weightsBps = new uint16[](1);
        t.weightsBps[0] = 10_000;
        t.drawBps = 400;
        t.earnShareBps = 5_000;
        vm.prank(settlor);
        e = factory.create(t, 60e6);
    }

    /// Moves the clock and has the SPY feed answer as of the new time with its current price, so
    /// the sale meets the guard at a price the pool still agrees with.
    function _warpKeepingTheFeed(uint256 by) internal {
        address feed = AssetRegistry(address(factory.registry())).get(spy).feed;
        (uint80 round, int256 answer, uint256 started,, uint80 answeredIn) = IFeed(feed).latestRoundData();
        vm.warp(block.timestamp + by);
        vm.mockCall(
            feed,
            abi.encodeWithSelector(IFeed.latestRoundData.selector),
            abi.encode(round, answer, started, block.timestamp, answeredIn)
        );
    }
}
