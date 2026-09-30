// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {SolvencyLog} from "../../src/privacy/SolvencyLog.sol";

/// ArbSys at address(100), answering the L2 block number the way Robinhood Chain does.
contract MockArbSys {
    uint256 public arbBlockNumber;

    function setBlock(uint256 number) external {
        arbBlockNumber = number;
    }
}

contract SolvencyLogTest is Test {
    SolvencyLog internal solvency;
    MockArbSys internal arbSys = MockArbSys(address(100));
    address internal admin = address(0xAD);
    address internal poster = address(0x9057);
    uint64 internal today;

    function setUp() public {
        vm.warp(1_790_600_000);
        today = uint64(block.timestamp / 1 days);
        // The L1 block number an Arbitrum chain reports as block.number, far behind its own.
        vm.roll(100);
        vm.etch(address(arbSys), address(new MockArbSys()).code);
        arbSys.setBlock(75_630_693);
        solvency = new SolvencyLog(admin, poster);
    }

    function test_thePosterAppendsEpochsInOrder() public {
        vm.prank(poster);
        solvency.post(today - 1, 75_600_000, bytes32(uint256(1)), 10, 20);
        SolvencyLog.Epoch memory e = solvency.epochs(today - 1);
        assertEq(e.root, bytes32(uint256(1)));
        assertEq(e.liabilities, 10);
        assertEq(e.assets, 20);
        assertEq(e.asOfBlock, 75_600_000);
        assertEq(solvency.latestEpoch(), today - 1);

        vm.prank(poster);
        vm.expectRevert(SolvencyLog.StaleEpoch.selector);
        solvency.post(today - 1, 75_630_000, bytes32(uint256(2)), 10, 20);

        // An asOfBlock far above block.number is fine: it is checked against ArbSys, not L1.
        vm.prank(poster);
        solvency.post(today, 75_630_693, bytes32(uint256(2)), 10, 20);
        assertEq(solvency.latestEpoch(), today);
    }

    function test_anEpochAfterTodayIsRefused() public {
        vm.startPrank(poster);
        vm.expectRevert(SolvencyLog.FutureEpoch.selector);
        solvency.post(type(uint64).max, 75_600_000, bytes32(uint256(1)), 10, 20);

        vm.expectRevert(SolvencyLog.FutureEpoch.selector);
        solvency.post(today + 1, 75_600_000, bytes32(uint256(1)), 10, 20);

        // The day it becomes today, it goes through.
        vm.warp(uint256(today + 1) * 1 days);
        solvency.post(today + 1, 75_600_000, bytes32(uint256(1)), 10, 20);
        vm.stopPrank();
        assertEq(solvency.latestEpoch(), today + 1);
    }

    function test_aBlockPastTheChainHeadIsRefused() public {
        vm.prank(poster);
        vm.expectRevert(SolvencyLog.FutureBlock.selector);
        solvency.post(today, 75_630_694, bytes32(uint256(1)), 10, 20);

        arbSys.setBlock(75_630_694);
        vm.prank(poster);
        solvency.post(today, 75_630_694, bytes32(uint256(1)), 10, 20);
    }

    function test_aBlockThatDoesNotMovePastThePreviousEpochIsRefused() public {
        vm.startPrank(poster);
        vm.expectRevert(SolvencyLog.StaleBlock.selector);
        solvency.post(today - 2, 0, bytes32(uint256(1)), 10, 20);

        solvency.post(today - 2, 75_600_000, bytes32(uint256(1)), 10, 20);

        vm.expectRevert(SolvencyLog.StaleBlock.selector);
        solvency.post(today - 1, 75_599_999, bytes32(uint256(2)), 10, 20);
        vm.expectRevert(SolvencyLog.StaleBlock.selector);
        solvency.post(today - 1, 75_600_000, bytes32(uint256(2)), 10, 20);

        solvency.post(today - 1, 75_600_001, bytes32(uint256(2)), 10, 20);
        vm.stopPrank();
        assertEq(solvency.epochs(today - 1).asOfBlock, 75_600_001);
    }

    function test_onlyThePosterPostsAndOnlyTheAdminMovesIt() public {
        vm.expectRevert(SolvencyLog.NotPoster.selector);
        solvency.post(today, 1, bytes32(0), 0, 0);

        vm.expectRevert(SolvencyLog.NotAdmin.selector);
        solvency.setPoster(address(this));

        vm.prank(admin);
        solvency.setPoster(address(this));
        solvency.post(today, 1, bytes32(0), 0, 0);

        vm.prank(admin);
        solvency.transferAdmin(address(this));
        solvency.acceptAdmin();
        assertEq(solvency.admin(), address(this));
    }
}
