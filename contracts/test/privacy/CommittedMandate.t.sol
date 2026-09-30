// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {CommittedMandateAccount} from "../../src/privacy/CommittedMandateAccount.sol";
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
/// the mandate address the fixture names. The account is placed there with deployCodeTo, so the
/// proofs keep verifying when the account's bytecode changes or coverage instruments it. After a
/// circuit or zkey change, rebuild the fixture: `node circuits/scripts/fixture.mjs`.
contract CommittedMandateTest is Test {
    address internal constant PAYEE = address(0xbeef01);
    address internal constant OTHER = address(0xbeef02);
    uint256 internal constant CEILING = 25e6;
    string internal constant ACCOUNT = "CommittedMandateAccount.sol:CommittedMandateAccount";

    MockUsdg internal asset;
    Escrow internal escrow;
    WithinMandateVerifier internal verifier;
    CommittedMandateAccount internal account;
    DisclosureRegistry internal disclosures;
    address internal stub;

    address internal principal = address(0xA11CE);
    address internal agent = address(0xA6E47);

    string internal fixture;

    function setUp() public {
        fixture = vm.readFile("test/fixtures/within_mandate.json");
        vm.warp(vm.parseJsonUint(fixture, ".now"));

        asset = new MockUsdg();
        address reputation = address(new MockReputation());
        vm.prank(address(0xC0DE03));
        escrow =
            new Escrow(address(asset), reputation, address(0x7EA5), 100, 50, 500, 5 minutes, 7 days, 1 hours, 10_000);
        verifier = new WithinMandateVerifier();
        disclosures = new DisclosureRegistry();

        account = _deployAt(vm.parseJsonAddress(fixture, ".mandate"), CEILING);
        stub = address(new DisputeStub());
        vm.prank(address(0xC0DE03));
        escrow.setResolver(stub);
    }

    /// A funded account with the fixture's terms at `where`. This test contract stands in for the
    /// factory, so it seals the first version itself.
    function _deployAt(address where, uint256 ceiling) internal returns (CommittedMandateAccount deployed) {
        deployed = _etchAccount(where, ceiling);
        deployed.sealInitial(hex"c1f3");
        asset.mint(where, 1_000_000);
    }

    function _etchAccount(address where, uint256 ceiling) internal returns (CommittedMandateAccount) {
        deployCodeTo(
            ACCOUNT,
            abi.encode(
                principal,
                agent,
                address(asset),
                address(escrow),
                address(verifier),
                vm.parseJsonUint(fixture, ".termsCommitment"),
                vm.parseJsonUint(fixture, ".counter"),
                ceiling
            ),
            where
        );
        return CommittedMandateAccount(where);
    }

    function _spend(string memory key)
        internal
        view
        returns (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p)
    {
        s = CommittedMandateAccount.Spend({
            payee: PAYEE,
            capabilityId: vm.parseJsonBytes32(fixture, string.concat(key, ".capabilityId")),
            inputCommit: keccak256("input"),
            inputURI: "",
            amount: uint128(vm.parseJsonUint(fixture, string.concat(key, ".amount"))),
            deadline: uint64(block.timestamp + 1 days),
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

    function _spendOne() internal returns (CommittedMandateAccount.Spend memory s, uint256 id) {
        CommittedMandateAccount.Proof memory p;
        (s, p) = _spend(".spend1");
        vm.warp(s.provenAt);
        vm.prank(agent);
        id = account.spend(s, p);
    }

    function test_theFixtureAccountSitsAtTheFixtureAddress() public view {
        assertEq(address(account), vm.parseJsonAddress(fixture, ".mandate"));
        assertEq(account.factory(), address(this));
        assertEq(account.ceiling(), CEILING);
        assertEq(account.version(), 1);
        // The proofs name a real capability, hashed the way the escrow lock carries it.
        assertEq(vm.parseJsonBytes32(fixture, ".spend1.capabilityId"), keccak256("service:gpu.render:1"));
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
        assertEq(entry.capabilityId, keccak256("service:gpu.render:1"));
        assertEq(account.counter(), s.newCounter);
        assertEq(account.nonce(), 1);
        assertEq(account.lockedTotal(), 80_000);
        assertTrue(account.nullifierUsed(s.nullifier));

        (s, p) = _spend(".spend2");
        vm.prank(agent);
        account.spend(s, p);
        assertEq(account.nonce(), 2);
        assertEq(account.lockedTotal(), 170_000);
        assertEq(asset.balanceOf(address(escrow)), 170_000);
    }

    function test_aProvenSpendReportsTheProofTimeAndTheTermsVersion() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);
        uint256 id = escrow.nextId();
        vm.expectEmit(true, false, false, true, address(account));
        emit CommittedMandateAccount.ProvenSpend(id, s.nullifier, s.newCounter, s.provenAt, 1);
        vm.prank(agent);
        account.spend(s, p);
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

    function test_theLockCarriesOnlyTheProvenCapability() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);

        // A hire under a proof made for a service, and the same id with one bit changed in either
        // half the circuit sees.
        bytes32[3] memory swaps = [
            keccak256("hire:research.summarize:1"),
            s.capabilityId ^ bytes32(uint256(1)),
            s.capabilityId ^ bytes32(uint256(1) << 200)
        ];
        for (uint256 i; i < swaps.length; ++i) {
            CommittedMandateAccount.Spend memory altered = s;
            altered.capabilityId = swaps[i];
            vm.prank(agent);
            vm.expectRevert(CommittedMandateAccount.BadProof.selector);
            account.spend(altered, p);
        }
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

    function test_aProofForOneMandateDoesNotSpendFromAnother() public {
        // Same terms, same counter, same agent: only the address differs, and the proof names it.
        CommittedMandateAccount twin = _deployAt(address(0xacc002), CEILING);
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);

        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.BadProof.selector);
        twin.spend(s, p);

        vm.prank(agent);
        account.spend(s, p);
        (s, p) = _spend(".spend2");
        vm.prank(agent);
        vm.expectRevert(CommittedMandateAccount.BadProof.selector);
        twin.spend(s, p);
        assertEq(twin.nonce(), 0);
        assertEq(asset.balanceOf(address(twin)), 1_000_000);
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

    function test_theCeilingHoldsAgainstValidProofsToo() public {
        // The same account and storage, rebuilt with a lower ceiling, so the fixture's proofs still
        // name it.
        CommittedMandateAccount low = _etchAccount(address(account), 150_000);
        assertEq(low.ceiling(), 150_000);
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);
        vm.prank(agent);
        low.spend(s, p);

        (s, p) = _spend(".spend2");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CommittedMandateAccount.OverCeiling.selector, 170_000, 150_000));
        low.spend(s, p);
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
        // Principal, agent + flags + version, nonce, terms, counter, locked total: every slot below
        // the nullifier map is one of those, and none of them is a cap or a counterparty.
        for (uint256 slot = 0; slot < 8; slot++) {
            uint256 v = uint256(vm.load(address(account), bytes32(slot)));
            assertTrue(v != 100_000 && v != 250_000 && v != 1_000_000 && v != uint256(uint160(PAYEE)));
        }
    }

    function test_theFactoryStandInSealsOnce() public {
        vm.expectRevert(CommittedMandateAccount.AlreadySealed.selector);
        account.sealInitial("x");
        vm.prank(principal);
        vm.expectRevert(CommittedMandateAccount.NotFactory.selector);
        account.sealInitial("x");
        assertEq(account.version(), 1);
    }

    function test_amendReplacesTheTermsAndBumpsTheVersion() public {
        vm.expectEmit(true, false, false, true, address(account));
        emit CommittedMandateAccount.TermsSealed(2, 11, hex"aa");
        vm.prank(principal);
        account.amend(11, 12, 0, hex"aa");
        assertEq(account.termsCommitment(), 11);
        assertEq(account.counter(), 12);
        assertEq(account.version(), 2);

        vm.expectRevert(CommittedMandateAccount.NotPrincipal.selector);
        account.amend(1, 1, 0, "");
    }

    function test_amendCannotMoveTheNonceBack() public {
        (CommittedMandateAccount.Spend memory s, CommittedMandateAccount.Proof memory p) = _spend(".spend1");
        vm.warp(s.provenAt);
        vm.prank(agent);
        account.spend(s, p);
        (s, p) = _spend(".spend2");
        vm.prank(agent);
        account.spend(s, p);

        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CommittedMandateAccount.NonceBehind.selector, 1, 2));
        account.amend(11, 12, 1, hex"aa");

        vm.prank(principal);
        account.amend(11, 12, 2, hex"aa");
        assertEq(account.nonce(), 2);
        // The amendment moves the terms and leaves the ceiling's count alone.
        assertEq(account.lockedTotal(), 170_000);

        vm.prank(principal);
        account.amend(13, 14, 7, hex"bb");
        assertEq(account.nonce(), 7);
        assertEq(account.version(), 3);
    }

    function test_aTimedOutLockRefundsTheBalanceAndLeavesTheCounters() public {
        (CommittedMandateAccount.Spend memory s, uint256 id) = _spendOne();
        vm.warp(s.deadline + 1);
        escrow.timeout(id);

        assertEq(asset.balanceOf(address(account)), 1_000_000);
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.TimedOut));
        _assertCountersUnmoved(s);
    }

    function test_aCancelledLockRefundsTheBalanceAndLeavesTheCounters() public {
        (CommittedMandateAccount.Spend memory s, uint256 id) = _spendOne();
        vm.prank(PAYEE);
        escrow.cancel(id);

        assertEq(asset.balanceOf(address(account)), 1_000_000);
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Cancelled));
        _assertCountersUnmoved(s);
    }

    function test_aRulingForThePayerRefundsTheBalanceAndLeavesTheCounters() public {
        (CommittedMandateAccount.Spend memory s, uint256 id) = _spendOne();
        vm.prank(principal);
        account.disputeSpend(id);
        // The 5% bond left with the dispute.
        assertEq(asset.balanceOf(address(account)), 1_000_000 - 80_000 - 4_000);

        vm.prank(stub);
        escrow.resolve(id, 10_000, 0);

        assertEq(asset.balanceOf(address(account)), 1_000_000);
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Resolved));
        _assertCountersUnmoved(s);
    }

    function _assertCountersUnmoved(CommittedMandateAccount.Spend memory s) internal view {
        assertEq(account.counter(), s.newCounter);
        assertEq(account.nonce(), 1);
        assertEq(account.lockedTotal(), 80_000);
        assertTrue(account.nullifierUsed(s.nullifier));
    }

    function test_onlyTheEscrowCreditsASpend() public {
        vm.expectRevert(CommittedMandateAccount.NotEscrow.selector);
        account.creditSpend(1, 1);
        vm.prank(address(escrow));
        account.creditSpend(1, 1);
    }

    function test_disclosureGrantsNeedADisputedLockAndAParty() public {
        (, uint256 id) = _spendOne();

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

        // The account has no pass-through of its own: the registry is the one route.
        vm.prank(principal);
        (bool ok,) = address(account)
            .call(
                abi.encodeWithSignature(
                    "grantDisclosure(uint256,address,bytes32,bytes)", id, address(0x5E501), bytes32(0), hex"03"
                )
            );
        assertFalse(ok);
    }
}
