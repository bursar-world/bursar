// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Test} from "forge-std/Test.sol";

import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {EscrowResolverStub} from "./Escrow.t.sol";
import {MockReputation} from "./mocks/MockReputation.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";

/// The escrow's governance surface and the events it publishes: the pauser's wiring and the
/// brake, the treasury handover, disclosure grants, and the announcements a reopen and a ruling
/// make. A mutation campaign over the contract found every one of these unchecked by the escrow's
/// own tests: the brake could be commented out, the pauser's guards dropped and the events
/// silenced with nothing here failing. Each case below fails on exactly that change.
contract EscrowGovernanceTest is Test {
    uint16 internal constant FEE_BPS = 250;
    uint16 internal constant RESOLVER_FEE_BPS = 100;
    uint16 internal constant BOND_BPS = 500;
    uint64 internal constant MIN_TTL = 1 hours;
    uint64 internal constant MAX_TTL = 30 days;
    uint64 internal constant DISPUTE_WINDOW = 1 days;
    uint128 internal constant MIN_LOCK = 10_000;
    uint128 internal constant AMOUNT = 1_000e6;
    bytes32 internal constant CAPABILITY = keccak256("inference.completion");

    MockUsdg internal asset;
    MockReputation internal reputation;
    Escrow internal escrow;
    EscrowResolverStub internal stub;

    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");
    address internal successor = makeAddr("successor");
    address internal pauser = makeAddr("timelock");
    address internal resolver = makeAddr("resolver");

    function setUp() public {
        vm.warp(1_780_000_000);
        asset = new MockUsdg();
        reputation = new MockReputation();
        escrow = _deploy();
        reputation.setEscrow(address(escrow));
        stub = new EscrowResolverStub();
        escrow.setResolver(address(stub));

        asset.mint(payer, 1e12);
        asset.mint(payee, 1e12);
        vm.prank(payer);
        asset.approve(address(escrow), type(uint256).max);
        vm.prank(payee);
        asset.approve(address(escrow), type(uint256).max);
    }

    function test_theConstructorAnnouncesTheTreasury() public {
        vm.expectEmit(true, true, false, true);
        emit IEscrow.TreasuryTransferred(address(0), treasury);
        _deploy();
    }

    function test_theDeployerWiresThePauserOnceAndNeverToNobody() public {
        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotDeployer.selector);
        escrow.setPauser(pauser);

        vm.expectRevert(IEscrow.ZeroAddress.selector);
        escrow.setPauser(address(0));

        vm.expectEmit(true, false, false, true, address(escrow));
        emit IEscrow.PauserSet(pauser);
        escrow.setPauser(pauser);
        assertEq(escrow.pauser(), pauser);

        vm.expectRevert(IEscrow.AlreadySet.selector);
        escrow.setPauser(stranger);
        assertEq(escrow.pauser(), pauser, "a second wiring moved the pauser");
    }

    /// Unwired, nobody can pull the brake: the deployer included. Wired, only the pauser can,
    /// in either direction.
    function test_onlyThePauserStopsAndRestartsTheEscrow() public {
        vm.expectRevert(IEscrow.NotPauser.selector);
        escrow.pause();
        assertFalse(escrow.paused());

        escrow.setPauser(pauser);
        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotPauser.selector);
        escrow.pause();

        vm.prank(pauser);
        escrow.pause();
        assertTrue(escrow.paused(), "the brake did not engage");

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotPauser.selector);
        escrow.unpause();
        assertTrue(escrow.paused());

        vm.prank(pauser);
        escrow.unpause();
        assertFalse(escrow.paused(), "the brake did not lift");
    }

    /// The brake stops new locks and new disputes and nothing else. Every exit for money already
    /// held, and every payout already booked, keeps working while it is on.
    function test_theBrakeStopsNewLocksAndDisputesAndNothingElse() public {
        uint256 toTimeOut = _lock();
        uint256 toRelease = _lock();
        uint256 toCancel = _lock();
        uint256 toResolve = _lock();
        vm.prank(payer);
        escrow.dispute(toResolve);

        escrow.setPauser(pauser);
        vm.prank(pauser);
        escrow.pause();

        vm.prank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.lock(payee, CAPABILITY, bytes32(0), "", AMOUNT, _deadline());
        vm.prank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.dispute(toRelease);

        vm.prank(payee);
        escrow.release(toRelease, keccak256("output"), "");
        vm.prank(payee);
        escrow.cancel(toCancel);
        stub.rule(IEscrow(address(escrow)), toResolve, 5_000);
        vm.warp(block.timestamp + MAX_TTL);
        escrow.timeout(toTimeOut);
        escrow.sweepFees();

        assertEq(uint8(escrow.getLock(toRelease).status), uint8(IEscrow.LockStatus.Released));
        assertEq(uint8(escrow.getLock(toCancel).status), uint8(IEscrow.LockStatus.Cancelled));
        assertEq(uint8(escrow.getLock(toResolve).status), uint8(IEscrow.LockStatus.Resolved));
        assertEq(uint8(escrow.getLock(toTimeOut).status), uint8(IEscrow.LockStatus.TimedOut));
        assertEq(asset.balanceOf(address(escrow)), 0, "the brake trapped money an exit should have moved");

        vm.prank(pauser);
        escrow.unpause();
        _lock();
    }

    function test_theTreasuryHandoverAnnouncesBothSteps() public {
        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotTreasury.selector);
        escrow.transferTreasury(successor);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.TreasuryTransferStarted(treasury, successor);
        vm.prank(treasury);
        escrow.transferTreasury(successor);
        assertEq(escrow.treasury(), treasury, "the offer alone moved the treasury");

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotPendingTreasury.selector);
        escrow.acceptTreasury();

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.TreasuryTransferred(treasury, successor);
        vm.prank(successor);
        escrow.acceptTreasury();
        assertEq(escrow.treasury(), successor);
        assertEq(escrow.pendingTreasury(), address(0));
    }

    /// Either party to a disputed lock can publish a slice for a resolver, and nobody else, and
    /// not before the dispute: the grant is an event and the event is the whole of it.
    function test_eitherPartyToADisputedLockGrantsDisclosureAndNobodyElse() public {
        uint256 id = _lock();

        vm.prank(payer);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.grantDisclosure(id, resolver, keccak256("slice"), hex"c0ffee");

        vm.prank(payer);
        escrow.dispute(id);

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotParty.selector);
        escrow.grantDisclosure(id, resolver, keccak256("slice"), hex"c0ffee");

        vm.prank(payer);
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        escrow.grantDisclosure(id, address(0), keccak256("slice"), hex"c0ffee");

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.DisclosureGranted(id, payer, resolver, keccak256("slice"), hex"c0ffee");
        vm.prank(payer);
        escrow.grantDisclosure(id, resolver, keccak256("slice"), hex"c0ffee");

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.DisclosureGranted(id, payee, resolver, keccak256("other"), hex"01");
        vm.prank(payee);
        escrow.grantDisclosure(id, resolver, keccak256("other"), hex"01");
    }

    /// A reopen names the deadline it set, and a ruling names the reward it booked.
    function test_aReopenAndARulingAnnounceWhatTheyDid() public {
        uint256 id = _lock();
        uint64 deadline = escrow.getLock(id).deadline;
        vm.prank(payer);
        escrow.dispute(id);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit IEscrow.DisputeReopened(id, deadline + MIN_TTL);
        stub.giveBack(IEscrow(address(escrow)), id);
        assertEq(escrow.getLock(id).deadline, deadline + MIN_TTL);

        vm.prank(payer);
        escrow.dispute(id);
        uint256 disputeId = stub.disputeIdOf(id);
        uint128 fee = (AMOUNT * RESOLVER_FEE_BPS) / 10_000;

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.ResolverRewarded(id, disputeId, fee);
        stub.rule(IEscrow(address(escrow)), id, 5_000);
        assertEq(stub.rewardCredited(), fee);
    }

    function _deploy() private returns (Escrow) {
        return new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            MIN_LOCK
        );
    }

    function _lock() private returns (uint256) {
        vm.prank(payer);
        return escrow.lock(payee, CAPABILITY, keccak256("input"), "", AMOUNT, _deadline());
    }

    function _deadline() private view returns (uint64) {
        return uint64(block.timestamp + 2 hours);
    }
}
