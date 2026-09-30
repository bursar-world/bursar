// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {BRSR} from "../../src/token/BRSR.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";

/// Reaches the one internal path that could add supply, which no external caller can. The
/// guard has to hold there, or the fixed supply would be a property of the ABI alone.
contract MintableBRSR is BRSR {
    constructor(Allocation memory to) BRSR(to) {}

    function mintAgain(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract BRSRTest is Test {
    BRSR internal brsr;

    address internal constant COMMUNITY = address(0xC0);
    address internal constant TEAM = address(0x7EA);
    address internal constant TREASURY = address(0x7);
    address internal constant LIQUIDITY = address(0x1);

    function setUp() public {
        brsr = new BRSR(IBRSR.Allocation({community: COMMUNITY, team: TEAM, treasury: TREASURY, liquidity: LIQUIDITY}));
    }

    function test_theFourAllocationsSumToTheWholeSupply() public view {
        assertEq(brsr.balanceOf(COMMUNITY), brsr.TOTAL_SUPPLY() * 80 / 100);
        assertEq(brsr.balanceOf(TEAM), brsr.TOTAL_SUPPLY() * 10 / 100);
        assertEq(brsr.balanceOf(TREASURY), brsr.TOTAL_SUPPLY() * 5 / 100);
        assertEq(brsr.balanceOf(LIQUIDITY), brsr.TOTAL_SUPPLY() * 5 / 100);
        assertEq(brsr.balanceOf(address(brsr)), 0);
        assertEq(
            brsr.balanceOf(COMMUNITY) + brsr.balanceOf(TEAM) + brsr.balanceOf(TREASURY) + brsr.balanceOf(LIQUIDITY),
            brsr.totalSupply()
        );
    }

    function test_deploymentRefusesAZeroRecipient() public {
        vm.expectRevert(IBRSR.ZeroAddress.selector);
        new BRSR(IBRSR.Allocation({community: COMMUNITY, team: address(0), treasury: TREASURY, liquidity: LIQUIDITY}));
    }

    function test_votesNeedDelegationAndCountByTimestamp() public {
        assertEq(brsr.clock(), uint48(block.timestamp));
        assertEq(brsr.getVotes(COMMUNITY), 0);

        vm.prank(COMMUNITY);
        brsr.delegate(COMMUNITY);
        assertEq(brsr.getVotes(COMMUNITY), brsr.balanceOf(COMMUNITY));

        uint256 at = block.timestamp;
        vm.warp(at + 1 days);
        vm.prank(COMMUNITY);
        brsr.transfer(TEAM, 1_000e18);

        assertEq(brsr.getPastVotes(COMMUNITY, at), 800_000_000e18);
        assertEq(brsr.getVotes(COMMUNITY), 800_000_000e18 - 1_000e18);
    }

    function test_permitApprovesWithoutGas() public {
        uint256 key = 0xA11CE;
        address owner = vm.addr(key);

        vm.prank(COMMUNITY);
        brsr.transfer(owner, 10e18);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                brsr.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        owner,
                        address(this),
                        10e18,
                        brsr.nonces(owner),
                        block.timestamp + 1 hours
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        brsr.permit(owner, address(this), 10e18, block.timestamp + 1 hours, v, r, s);
        assertEq(brsr.allowance(owner, address(this)), 10e18);
        assertEq(brsr.nonces(owner), 1);
    }

    /// The supply is fixed by the code path itself: the only mint runs while the total supply is
    /// still zero, and nothing here burns, so the supply never returns to zero to re-open it.
    function test_nothingMintsAfterTheConstructor() public {
        MintableBRSR token = new MintableBRSR(
            IBRSR.Allocation({community: COMMUNITY, team: TEAM, treasury: TREASURY, liquidity: LIQUIDITY})
        );

        vm.expectRevert(IBRSR.SupplyIsFixed.selector);
        token.mintAgain(COMMUNITY, 1);

        vm.expectRevert(IBRSR.SupplyIsFixed.selector);
        token.mintAgain(address(token), 1e18);

        // Burning the whole supply is the only way back to zero, and that re-opens the mint: the
        // guard reads the supply at each mint. The next test checks the shipped token has no burn.
        token.burn(COMMUNITY, token.balanceOf(COMMUNITY));
        token.burn(TEAM, token.balanceOf(TEAM));
        token.burn(TREASURY, token.balanceOf(TREASURY));
        token.burn(LIQUIDITY, token.balanceOf(LIQUIDITY));
        assertEq(token.totalSupply(), 0);

        token.mintAgain(COMMUNITY, 1e18);
        assertEq(token.totalSupply(), 1e18);
    }

    /// The shipped token carries no burn, so the sequence above is unreachable on it.
    function test_theShippedTokenCarriesNoWayToChangeTheSupply() public {
        string[8] memory absent = [
            "mint(address,uint256)",
            "burn(uint256)",
            "burnFrom(address,uint256)",
            "pause()",
            "unpause()",
            "owner()",
            "admin()",
            "upgradeTo(address)"
        ];
        for (uint256 i; i < absent.length; ++i) {
            (bool ok,) = address(brsr).call(abi.encodeWithSignature(absent[i], COMMUNITY, uint256(1)));
            assertFalse(ok);
        }
    }

    function test_theSupplyIsThePublishedSplit() public view {
        assertEq(brsr.TOTAL_SUPPLY(), 1_000_000_000e18);
        assertEq(brsr.COMMUNITY_ALLOCATION(), 800_000_000e18);
        assertEq(brsr.TEAM_ALLOCATION(), 100_000_000e18);
        assertEq(brsr.TREASURY_ALLOCATION(), 50_000_000e18);
        assertEq(brsr.LIQUIDITY_ALLOCATION(), 50_000_000e18);
        assertEq(
            brsr.COMMUNITY_ALLOCATION() + brsr.TEAM_ALLOCATION() + brsr.TREASURY_ALLOCATION()
                + brsr.LIQUIDITY_ALLOCATION(),
            brsr.TOTAL_SUPPLY()
        );
        assertEq(brsr.decimals(), 18);
        assertEq(brsr.name(), "Bursar");
        assertEq(brsr.symbol(), "BRSR");
    }

    function test_deploymentRefusesEveryZeroRecipient() public {
        vm.expectRevert(IBRSR.ZeroAddress.selector);
        new BRSR(IBRSR.Allocation({community: address(0), team: TEAM, treasury: TREASURY, liquidity: LIQUIDITY}));

        vm.expectRevert(IBRSR.ZeroAddress.selector);
        new BRSR(IBRSR.Allocation({community: COMMUNITY, team: TEAM, treasury: address(0), liquidity: LIQUIDITY}));

        vm.expectRevert(IBRSR.ZeroAddress.selector);
        new BRSR(IBRSR.Allocation({community: COMMUNITY, team: TEAM, treasury: TREASURY, liquidity: address(0)}));
    }

    /// Block cadence is not a published constant on every chain, so a forty-eight hour timelock and a
    /// voting period have to be measured the same way. A governor built against this token
    /// must report the same clock.
    function test_votesAreCountedBySeconds() public {
        vm.prank(COMMUNITY);
        brsr.delegate(COMMUNITY);

        uint256 at = block.timestamp;
        vm.warp(at + 48 hours);
        vm.roll(block.number + 1);

        assertEq(brsr.clock(), uint48(block.timestamp));
        assertEq(brsr.getPastTotalSupply(at), brsr.TOTAL_SUPPLY());

        // A lookup at or after the current clock reading reverts, so a proposal cannot be
        // settled against a snapshot that has not closed.
        vm.expectRevert();
        brsr.getPastVotes(COMMUNITY, block.timestamp);
    }

    /// Whatever moves between holders, the supply is the same number it was minted at.
    function testFuzz_transfersNeverChangeTheSupply(uint128 first, uint128 second, address to) public {
        vm.assume(to != address(0));

        uint256 a = bound(first, 0, 800_000_000e18);
        vm.prank(COMMUNITY);
        brsr.transfer(to, a);

        uint256 b = bound(second, 0, brsr.balanceOf(to));
        vm.prank(to);
        brsr.transfer(TREASURY, b);

        assertEq(brsr.totalSupply(), 1_000_000_000e18);
    }
}
