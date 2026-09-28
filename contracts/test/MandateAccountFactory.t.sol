// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Escrow} from "../src/Escrow.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../src/interfaces/IMandateAccountFactory.sol";

import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockReputation} from "./mocks/MockReputation.sol";

/// A principal funds an account before it exists, so the address it computes has to be the
/// address it gets. Everything here is about that promise: what the salt binds, what it does
/// not, and what happens when two creations collide.
contract MandateFactoryTest is Test {
    MockUsdg internal asset;
    Escrow internal escrow;
    MandateAccountFactory internal factory;

    address internal principal = makeAddr("factoryPrincipal");
    address internal agent = makeAddr("factoryAgent");

    function setUp() public {
        asset = new MockUsdg();

        escrow = new Escrow(
            address(asset),
            address(new MockReputation()),
            makeAddr("factoryTreasury"),
            100,
            100,
            500,
            1 hours,
            30 days,
            1 days,
            3 days
        );

        factory = new MandateAccountFactory(address(escrow), address(asset));
    }

    function test_theAddressAPrincipalComputesIsTheAddressItGets() public {
        IMandateAccount.Limits memory limits = _limits();
        address predicted = factory.predict(principal, agent, bytes32(uint256(1)), limits);

        vm.expectEmit(true, true, true, true, address(factory));
        emit IMandateAccountFactory.Created(predicted, principal, agent, bytes32(uint256(1)));
        vm.prank(principal);
        address account = factory.create(principal, agent, bytes32(uint256(1)), limits);

        assertEq(account, predicted);
    }

    function test_theAccountCarriesTheDeploymentsEscrowAndAsset() public {
        vm.prank(principal);
        MandateAccount account = MandateAccount(factory.create(principal, agent, bytes32(uint256(1)), _limits()));

        assertEq(account.escrow(), address(escrow));
        assertEq(account.settlementAsset(), address(asset));
        assertEq(account.principal(), principal);
        assertEq(account.agent(), agent);
        assertEq(account.perCallCap(), 100e6);
    }

    function test_aSecondCreationOnTheSameSaltIsRefusedWithAReasonRatherThanACreateFailure() public {
        IMandateAccount.Limits memory limits = _limits();
        vm.prank(principal);
        factory.create(principal, agent, bytes32(uint256(1)), limits);

        vm.expectRevert(IMandateAccountFactory.AlreadyDeployed.selector);
        vm.prank(principal);
        factory.create(principal, agent, bytes32(uint256(1)), limits);
    }

    /// The limits are constructor arguments, so two principals asking for the same salt with
    /// different mandates do not collide.
    function test_theSameSaltUnderDifferentLimitsLandsElsewhere() public {
        IMandateAccount.Limits memory tighter = _limits();
        tighter.perCallCap = 50e6;

        vm.prank(principal);
        address first = factory.create(principal, agent, bytes32(uint256(1)), _limits());
        vm.prank(principal);
        address second = factory.create(principal, agent, bytes32(uint256(1)), tighter);

        assertTrue(first != second);
    }

    function test_theSameSaltUnderADifferentAgentLandsElsewhere() public {
        vm.prank(principal);
        address first = factory.create(principal, agent, bytes32(uint256(1)), _limits());
        vm.prank(principal);
        address second = factory.create(principal, makeAddr("otherAgent"), bytes32(uint256(1)), _limits());

        assertTrue(first != second);
    }

    function test_creationRefusesAnAccountNobodyOwns() public {
        vm.expectRevert(IMandateAccountFactory.ZeroAddress.selector);
        factory.create(address(0), agent, bytes32(uint256(1)), _limits());
    }

    /// An account may be created without an agent and have one named later, so the agent is
    /// the one address the factory does not insist on.
    function test_creationWithoutAnAgentIsAllowed() public {
        vm.prank(principal);
        address account = factory.create(principal, address(0), bytes32(uint256(1)), _limits());

        assertEq(MandateAccount(account).agent(), address(0));
    }

    function test_theFactoryRefusesToBeBuiltWithoutAnEscrow() public {
        vm.expectRevert(IMandateAccountFactory.ZeroAddress.selector);
        new MandateAccountFactory(address(0), address(asset));
    }

    function test_theFactoryRefusesToBeBuiltWithoutASettlementAsset() public {
        vm.expectRevert(IMandateAccountFactory.ZeroAddress.selector);
        new MandateAccountFactory(address(escrow), address(0));
    }

    function test_theRosterIsKeptPerPrincipal() public {
        address other = makeAddr("otherPrincipal");

        assertEq(factory.accountCount(principal), 0);
        assertEq(factory.accountsOf(principal).length, 0);

        vm.prank(principal);
        address first = factory.create(principal, agent, bytes32(uint256(1)), _limits());
        vm.prank(principal);
        address second = factory.create(principal, agent, bytes32(uint256(2)), _limits());
        vm.prank(other);
        address theirs = factory.create(other, agent, bytes32(uint256(1)), _limits());

        assertEq(factory.accountCount(principal), 2);
        assertEq(factory.accountsOf(principal)[0], first);
        assertEq(factory.accountsOf(principal)[1], second);

        assertEq(factory.accountCount(other), 1);
        assertEq(factory.accountsOf(other)[0], theirs);
    }

    /// A stranger creating accounts in a principal's name would fill `accountsOf` with limits
    /// the principal never chose. Only the principal creates its own accounts.
    function test_aStrangerCannotCreateAnAccountInAPrincipalsName() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IMandateAccountFactory.NotPrincipal.selector);
        factory.create(principal, agent, bytes32(uint256(1)), _limits());

        assertEq(factory.accountCount(principal), 0);
    }

    function testFuzz_predictionHoldsForAnySalt(bytes32 salt) public {
        IMandateAccount.Limits memory limits = _limits();
        address predicted = factory.predict(principal, agent, salt, limits);

        vm.prank(principal);
        assertEq(factory.create(principal, agent, salt, limits), predicted);
    }

    function _limits() private pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: 100e6,
            dailyCap: 500e6,
            monthlyCap: 5_000e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: type(uint128).max,
            validFrom: 0,
            validUntil: 0,
            classMask: 3,
            totalCap: 0,
            lane: 0
        });
    }
}
