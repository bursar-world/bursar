// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {SolvencyLog} from "../../src/privacy/SolvencyLog.sol";

contract SolvencyLogTest is Test {
    SolvencyLog internal solvency;
    address internal admin = address(0xAD);
    address internal poster = address(0x9057);

    function setUp() public {
        vm.roll(100);
        solvency = new SolvencyLog(admin, poster);
    }

    function test_thePosterAppendsEpochsInOrder() public {
        vm.prank(poster);
        solvency.post(1, 99, bytes32(uint256(1)), 10, 20);
        SolvencyLog.Epoch memory e = solvency.epochs(1);
        assertEq(e.root, bytes32(uint256(1)));
        assertEq(e.liabilities, 10);
        assertEq(e.assets, 20);
        assertEq(e.asOfBlock, 99);
        assertEq(solvency.latestEpoch(), 1);

        vm.prank(poster);
        vm.expectRevert(SolvencyLog.StaleEpoch.selector);
        solvency.post(1, 99, bytes32(uint256(2)), 10, 20);

        vm.prank(poster);
        vm.expectRevert(SolvencyLog.FutureBlock.selector);
        solvency.post(2, 100, bytes32(uint256(2)), 10, 20);
    }

    function test_onlyThePosterPostsAndOnlyTheAdminMovesIt() public {
        vm.expectRevert(SolvencyLog.NotPoster.selector);
        solvency.post(1, 1, bytes32(0), 0, 0);

        vm.expectRevert(SolvencyLog.NotAdmin.selector);
        solvency.setPoster(address(this));

        vm.prank(admin);
        solvency.setPoster(address(this));
        solvency.post(1, 1, bytes32(0), 0, 0);

        vm.prank(admin);
        solvency.transferAdmin(address(this));
        solvency.acceptAdmin();
        assertEq(solvency.admin(), address(this));
    }
}
