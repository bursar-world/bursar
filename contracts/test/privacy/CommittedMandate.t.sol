// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {CommittedMandateAccount} from "../../src/privacy/CommittedMandateAccount.sol";
import {CommittedMandateFactory} from "../../src/privacy/CommittedMandateFactory.sol";
import {DisclosureRegistry} from "../../src/privacy/DisclosureRegistry.sol";
import {WithinMandateVerifier} from "../../src/zk/WithinMandateVerifier.sol";

import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockReputation} from "../mocks/MockReputation.sol";

contract DisputeStub {
    uint256 private _next = 1;

    function openDispute(uint256, address, address) external returns (uint256) {
        return _next++;
    }
}

/// The proofs in test/fixtures/within_mandate.json were built by circuits/scripts/fixture.mjs for
/// the account address this setUp produces. A change to the deploy order here moves that address
/// and the fixture has to be rebuilt: `node circuits/scripts/fixture.mjs <address>`.
contract CommittedMandateTest is Test {
    address internal constant PAYEE = address(0xbeef01);
    address internal constant OTHER = address(0xbeef02);
    bytes32 internal constant SALT = bytes32(uint256(7));

    MockUsdg internal asset;
    Escrow internal escrow;
    WithinMandateVerifier internal verifier;
    CommittedMandateFactory internal factory;
    CommittedMandateAccount internal account;
    DisclosureRegistry internal disclosures;

    address internal principal = address(0xA11CE);
    address internal agent = address(0xA6E47);

    string internal fixture;

    function setUp() public {
        fixture = vm.readFile("test/fixtures/within_mandate.json");
        vm.warp(vm.parseJsonUint(fixture, ".now"));

        asset = new MockUsdg();
        escrow = new Escrow(
            address(asset),
            address(new MockReputation()),
            address(0x7EA5),
            100,
            50,
            500,
            5 minutes,
            7 days,
            1 hours,
            2 days
        );
        verifier = new WithinMandateVerifier();
        factory = new CommittedMandateFactory(address(escrow), address(asset), address(verifier));
        disclosures = new DisclosureRegistry();

        vm.prank(principal);
        account = CommittedMandateAccount(
            factory.create(
                principal,
                agent,
                SALT,
                vm.parseJsonUint(fixture, ".termsCommitment"),
                vm.parseJsonUint(fixture, ".counter"),
                hex"c1f3"
            )
        );
        asset.mint(address(account), 1_000_000);
        escrow.setResolver(address(new DisputeStub()));
    }

    function _spend(string memory key)
        internal
        view
        returns (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p)
    {
        s = CommittedMandateAccount.Spend({
            payee: PAYEE,
            capabilityId: keccak256("service:gpu.render:1"),
            inputCommit: keccak256("input"),
            inputURI: "",
            amount: uint128(vm.parseJsonUint(fixture, string.concat(key, ".amount"))),
            deadline: uint64(block.timestamp + 1 days),
            classId: 0,
            provenAt: uint64(vm.parseJsonUint(fixture, string.concat(key, ".provenAt"))),
            newCounter: vm.parseJsonUint(fixture, string.concat(key, ".newCounter")),
            nullifier: vm.parseJsonUint(fixture, string.concat(key, ".nullifier"))
        });
        uint256[] memory a = vm.parseJsonUintArray(fixture, string.concat(key, ".a"));
        uint256[] memory b0 = vm.parseJsonUintArray(fixture, string.concat(key, ".b[0]"));
        uint256[] memory b1 = vm.parseJsonUintArray(fixture, string.concat(key, ".b[1]"));
        uint256[] memory c = vm.parseJsonUintArray(fixture, string.concat(key, ".c"));
        p.a = [a[0], a[1]];
        p.b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.c = [c[0], c[1]];
    }

    function test_theFixtureWasBuiltForThisAccount() public view {
        assertEq(address(account), vm.parseJsonAddress(fixture, ".mandate"));
        assertEq(
            factory.predict(
                principal,
                agent,
                SALT,
                vm.parseJsonUint(fixture, ".termsCommitment"),
                vm.parseJsonUint(fixture, ".counter")
            ),
            address(account)
        );
    }

    function test_aProvenSpendOpensTheLockAndMovesTheCounter() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt - 30);
        vm.prank(agent);
        uint256 id = account.spend(s, p);

        IEscrow.Lock memory entry = escrow.getLock(id);
        assertEq(entry.payer, address(account));
        assertEq(entry.payee, PAYEE);
        assertEq(entry.amount, 80_000);
        assertEq(account.counter(), s.newCounter);
        assertEq(account.nonce(), 1);
        assertTrue(account.nullifierUsed(s.nullifier));

        (s, p) = _spend(".spend2");
        vm.prank(agent);
        account.spend(s, p);
        assertEq(account.nonce(), 2);
        assertEq(asset.balanceOf(address(escrow)), 170_000);
    }

    function test_theVerifierRejectsAlteredInputs() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);

        s.amount = 100_000;
        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.BadProof.selector);
        account.spend(s, p);

        (s, p) = _spend(".spend1");
        s.payee = OTHER;
        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.BadProof.selector);
        account.spend(s, p);

        (s, p) = _spend(".spend1");
        p.a[0] = p.a[0] ^ 1;
        vm.prank(agent);
        vm.expectRevert();
        account.spend(s, p);
    }

    function test_aProofCannotBeReplayedOrUsedOutOfOrder() public {
        (CommittedMandateAccount.Spend memory s1, CommittedMandateAccount.Proof memory p1) = _spend(".spend1");
        (CommittedMandateAccount.Spend memory s2, CommittedMandateAccount.Proof memory p2) = _spend(".spend2");
        vm.warp(s1.provenAt);

        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.BadProof.selector);
        account.spend(s2, p2);

        vm.prank(agent);
        account.spend(s1, p1);

        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.NullifierUsed.selector);
        account.spend(s1, p1);
    }

    function test_theProofTimeHasToBracketTheBlock() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");

        vm.warp(s.provenAt + 1);
        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.BadTime.selector);
        account.spend(s, p);

        vm.warp(s.provenAt - account.NOW_SLACK() - 1);
        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.BadTime.selector);
        account.spend(s, p);
    }

    function test_onlyTheAgentOrPrincipalSpends() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);
        vm.expectRevert(CommittedMandateAccount.NotAgent.selector);
        account.spend(s, p);
    }

    function test_pausedAndRevokedAccountsRefuse() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);

        vm.prank(principal);
        account.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.Paused.selector);
        account.spend(s, p);

        vm.prank(principal);
        account.revoke();
        assertEq(asset.balanceOf(principal), 1_000_000);
        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.Revoked.selector);
        account.spend(s, p);
    }

    function test_storageHoldsNoTerms() public view {
        // principal, agent + flags + version + nonce, terms, counter: every slot below the
        // nullifier map is one of those, and none of them is a cap, a class or a counterparty.
        for (uint256 slot = 0; slot < 8; slot++) {
            bytes32 word = vm.load(address(account), bytes32(slot));
            uint256 v = uint256(word);
            assertTrue(v != 100_000 && v != 250_000 && v != 1_000_000 && v != 3 && v != uint256(uint160(PAYEE)));
        }
    }

    function test_theFactoryRefusesAnotherPrincipalAndSealsOnce() public {
        vm.expectRevert(CommittedMandateFactory.NotPrincipal.selector);
        factory.create(principal, agent, bytes32(uint256(8)), 1, 1, "");

        vm.expectRevert(CommittedMandateAccount.NotFactory.selector);
        account.sealInitial("x");
        assertEq(account.version(), 1);
    }

    function test_amendReplacesTheTermsAndBumpsTheVersion() public {
        vm.prank(principal);
        account.amend(11, 12, 0, hex"aa");
        assertEq(account.termsCommitment(), 11);
        assertEq(account.counter(), 12);
        assertEq(account.version(), 2);

        vm.expectRevert(CommittedMandateAccount.NotPrincipal.selector);
        account.amend(1, 1, 0, "");
    }

    function test_disclosureGrantsNeedADisputedLockAndAParty() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);
        vm.prank(agent);
        uint256 id = account.spend(s, p);

        vm.prank(principal);
        vm.expectRevert(DisclosureRegistry.NotDisputed.selector);
        disclosures.grant(address(escrow), id, address(0x5E501), bytes32(0), hex"01");

        vm.prank(principal);
        account.disputeSpend(id);

        vm.expectRevert(DisclosureRegistry.NotParty.selector);
        disclosures.grant(address(escrow), id, address(0x5E501), bytes32(0), hex"01");

        vm.expectEmit(true, true, true, true, address(disclosures));
        emit DisclosureRegistry.DisclosureGranted(
            address(escrow), id, address(0x5E501), principal, bytes32(uint256(9)), hex"01"
        );
        vm.prank(principal);
        disclosures.grant(address(escrow), id, address(0x5E501), bytes32(uint256(9)), hex"01");

        vm.prank(PAYEE);
        disclosures.grant(address(escrow), id, address(0x5E501), bytes32(0), hex"02");

        vm.prank(principal);
        account.grantDisclosure(id, address(0x5E501), bytes32(0), hex"03");
    }
}
