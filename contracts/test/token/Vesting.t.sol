// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {BRSR} from "../../src/token/BRSR.sol";
import {Vesting} from "../../src/token/Vesting.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";

/// The team allocation and its terms: nothing before the cliff, a straight line to the end of
/// the fourth year, and a revocation that stops the clock without reaching backwards.
contract VestingTest is Test {
    event GrantCreated(address indexed beneficiary, uint128 totalWei, uint64 start);
    event Claimed(address indexed beneficiary, uint128 amountWei);
    event Revoked(address indexed beneficiary, uint128 vestedWei, uint128 forfeitedWei);
    event Swept(uint256 amountWei);

    uint128 internal constant TEAM_ALLOCATION = 100_000_000e18;
    uint128 internal constant GRANT_A = 60_000_000e18;
    uint128 internal constant GRANT_B = 40_000_000e18;

    BRSR internal brsr;
    Vesting internal vesting;

    address internal admin = makeAddr("timelock");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    uint64 internal start;

    function setUp() public {
        // The deployment's circular dependency, reproduced: the token has to mint into an
        // address the vesting contract will occupy, and the vesting contract has to name a
        // token that does not exist yet.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vesting = new Vesting(predicted, admin, treasury);
        brsr = new BRSR(
            IBRSR.Allocation({
                community: makeAddr("community"),
                team: address(vesting),
                treasury: treasury,
                liquidity: makeAddr("liquidity")
            })
        );
        assertEq(address(brsr), predicted);

        start = uint64(block.timestamp);
        _write();
    }

    function _write() internal {
        address[] memory who = new address[](2);
        who[0] = alice;
        who[1] = bob;
        uint128[] memory howMuch = new uint128[](2);
        howMuch[0] = GRANT_A;
        howMuch[1] = GRANT_B;
        vesting.createGrants(who, howMuch, start);
    }

    function test_theWholeTeamAllocationArrivesBeforeAnyGrantIsWritten() public view {
        assertEq(brsr.balanceOf(address(vesting)), TEAM_ALLOCATION);
        assertEq(vesting.outstandingWei(), TEAM_ALLOCATION);
        assertEq(vesting.unallocatedWei(), 0);
        assertEq(vesting.CLIFF(), 365 days);
        assertEq(vesting.DURATION(), 1460 days);
    }

    function test_nothingIsClaimableUntilTheCliff() public {
        assertEq(vesting.claimableOf(alice), 0);

        vm.warp(start + 365 days - 1);
        assertEq(vesting.vestedOf(alice), 0);

        vm.prank(alice);
        vm.expectRevert(Vesting.NothingToClaim.selector);
        vesting.claim();
    }

    /// At the cliff exactly a quarter is claimable in one step, because the line has been
    /// accruing since the start date and the cliff only gates it.
    function test_theCliffReleasesAQuarterInOneStep() public {
        vm.warp(start + 365 days);

        uint256 expected = uint256(GRANT_A) * 365 days / 1460 days;
        assertEq(vesting.vestedOf(alice), expected);
        assertEq(vesting.claimableOf(alice), expected);

        vm.expectEmit(true, false, false, true, address(vesting));
        emit Claimed(alice, uint128(expected));
        vm.prank(alice);
        assertEq(vesting.claim(), uint128(expected));

        assertEq(brsr.balanceOf(alice), expected);
        assertEq(vesting.claimableOf(alice), 0);
        assertEq(vesting.outstandingWei(), TEAM_ALLOCATION - expected);
    }

    function test_accrualIsLinearBetweenTheCliffAndTheEnd() public {
        vm.warp(start + 730 days);
        assertEq(vesting.vestedOf(alice), uint256(GRANT_A) * 730 days / 1460 days);

        vm.warp(start + 1095 days);
        assertEq(vesting.vestedOf(alice), uint256(GRANT_A) * 1095 days / 1460 days);

        vm.warp(start + 1460 days);
        assertEq(vesting.vestedOf(alice), GRANT_A);

        vm.warp(start + 3650 days);
        assertEq(vesting.vestedOf(alice), GRANT_A);
    }

    function test_claimingInStagesPaysTheWholeGrantAndNoMore() public {
        vm.warp(start + 365 days);
        vm.prank(alice);
        vesting.claim();

        vm.warp(start + 900 days);
        vm.prank(alice);
        vesting.claim();

        vm.warp(start + 1460 days);
        vm.prank(alice);
        vesting.claim();

        assertEq(brsr.balanceOf(alice), GRANT_A);

        vm.prank(alice);
        vm.expectRevert(Vesting.NothingToClaim.selector);
        vesting.claim();
    }

    function test_grantsAreBoundToTheirAddress() public {
        vm.warp(start + 1460 days);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Vesting.NoGrant.selector, stranger));
        vesting.claim();

        assertEq(vesting.claimableOf(stranger), 0);
        (uint64 cliffAt, uint64 endsAt) = vesting.scheduleOf(stranger);
        assertEq(cliffAt, 0);
        assertEq(endsAt, 0);
    }

    function test_scheduleReadsBackTheTermItWasWrittenUnder() public view {
        (uint64 cliffAt, uint64 endsAt) = vesting.scheduleOf(alice);
        assertEq(cliffAt, start + 365 days);
        assertEq(endsAt, start + 1460 days);
    }

    /// The property the whole contract exists for: a revocation takes the unvested remainder
    /// and cannot reach what the schedule has already released, claimed or not.
    function test_revocationCannotClawBackVestedTokens() public {
        vm.warp(start + 1095 days);

        uint128 vested = vesting.vestedOf(alice);
        uint128 expectedForfeit = GRANT_A - vested;

        vm.expectEmit(true, false, false, true, address(vesting));
        emit Revoked(alice, vested, expectedForfeit);
        vm.prank(admin);
        assertEq(vesting.revoke(alice), expectedForfeit);

        assertEq(brsr.balanceOf(treasury), 50_000_000e18 + expectedForfeit);
        assertEq(vesting.vestedOf(alice), vested);
        assertEq(vesting.claimableOf(alice), vested);

        // The clock keeps running and the frozen total does not move with it.
        vm.warp(start + 3650 days);
        assertEq(vesting.vestedOf(alice), vested);

        vm.prank(alice);
        assertEq(vesting.claim(), vested);
        assertEq(brsr.balanceOf(alice), vested);
    }

    function test_revocationAfterAPartialClaimLeavesTheRestClaimable() public {
        vm.warp(start + 730 days);
        vm.prank(alice);
        uint128 firstClaim = vesting.claim();

        vm.warp(start + 1095 days);
        uint128 vested = vesting.vestedOf(alice);

        vm.prank(admin);
        vesting.revoke(alice);

        vm.prank(alice);
        assertEq(vesting.claim(), vested - firstClaim);
        assertEq(brsr.balanceOf(alice), vested);
        assertEq(vesting.outstandingWei(), GRANT_B);
    }

    function test_revocationBeforeTheCliffTakesTheWholeGrant() public {
        vm.warp(start + 100 days);

        vm.prank(admin);
        assertEq(vesting.revoke(alice), GRANT_A);

        vm.warp(start + 3650 days);
        assertEq(vesting.vestedOf(alice), 0);
        assertEq(vesting.claimableOf(alice), 0);

        vm.prank(alice);
        vm.expectRevert(Vesting.NothingToClaim.selector);
        vesting.claim();
    }

    function test_revocationIsOneWayAndOnlyTheAdminMakesIt() public {
        vm.warp(start + 500 days);

        vm.prank(stranger);
        vm.expectRevert(Vesting.NotAdmin.selector);
        vesting.revoke(alice);

        vm.prank(admin);
        vesting.revoke(alice);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Vesting.AlreadyRevoked.selector, alice));
        vesting.revoke(alice);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Vesting.NoGrant.selector, stranger));
        vesting.revoke(stranger);
    }

    function test_oneRevocationLeavesTheOtherGrantAlone() public {
        vm.warp(start + 1095 days);

        vm.prank(admin);
        vesting.revoke(alice);

        vm.warp(start + 1460 days);
        assertEq(vesting.vestedOf(bob), GRANT_B);
        vm.prank(bob);
        assertEq(vesting.claim(), GRANT_B);
    }

    function test_theGrantSetIsWrittenOnceAndClosesBehindItself() public {
        address[] memory who = new address[](1);
        who[0] = stranger;
        uint128[] memory howMuch = new uint128[](1);
        howMuch[0] = 1e18;

        vm.expectRevert(Vesting.AlreadyWritten.selector);
        vesting.createGrants(who, howMuch, start);
    }

    function test_onlyTheDeployingAddressWritesTheGrantSet() public {
        Vesting fresh = new Vesting(address(brsr), admin, treasury);

        address[] memory who = new address[](1);
        who[0] = alice;
        uint128[] memory howMuch = new uint128[](1);
        howMuch[0] = 1e18;

        vm.prank(stranger);
        vm.expectRevert(Vesting.NotDeployer.selector);
        fresh.createGrants(who, howMuch, start);
    }

    function test_aGrantSetThisContractCannotPayIsRefused() public {
        Vesting fresh = new Vesting(address(brsr), admin, treasury);

        address[] memory who = new address[](1);
        who[0] = alice;
        uint128[] memory howMuch = new uint128[](1);
        howMuch[0] = 1_000e18;

        vm.expectRevert(abi.encodeWithSelector(Vesting.Underfunded.selector, 1_000e18, 0));
        fresh.createGrants(who, howMuch, start);
    }

    function test_theGrantSetRejectsMalformedInput() public {
        Vesting fresh = new Vesting(address(brsr), admin, treasury);

        address[] memory two = new address[](2);
        two[0] = alice;
        two[1] = bob;
        uint128[] memory one = new uint128[](1);
        one[0] = 1e18;

        vm.expectRevert(abi.encodeWithSelector(Vesting.LengthMismatch.selector, 2, 1));
        fresh.createGrants(two, one, start);

        address[] memory noneAddr = new address[](0);
        uint128[] memory noneAmt = new uint128[](0);
        vm.expectRevert(Vesting.NoGrants.selector);
        fresh.createGrants(noneAddr, noneAmt, start);

        address[] memory who = new address[](1);
        who[0] = alice;
        uint128[] memory howMuch = new uint128[](1);
        howMuch[0] = 1e18;
        vm.expectRevert(Vesting.StartIsZero.selector);
        fresh.createGrants(who, howMuch, 0);

        who[0] = address(0);
        vm.expectRevert(Vesting.ZeroAddress.selector);
        fresh.createGrants(who, howMuch, start);

        who[0] = alice;
        howMuch[0] = 0;
        vm.expectRevert(Vesting.ZeroAmount.selector);
        fresh.createGrants(who, howMuch, start);
    }

    function test_theSameBeneficiaryCannotBeWrittenTwice() public {
        Vesting fresh = new Vesting(address(brsr), admin, treasury);

        address[] memory who = new address[](2);
        who[0] = alice;
        who[1] = alice;
        uint128[] memory howMuch = new uint128[](2);
        howMuch[0] = 1e18;
        howMuch[1] = 1e18;

        vm.expectRevert(abi.encodeWithSelector(Vesting.DuplicateBeneficiary.selector, alice));
        fresh.createGrants(who, howMuch, start);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(Vesting.ZeroAddress.selector);
        new Vesting(address(0), admin, treasury);

        vm.expectRevert(Vesting.ZeroAddress.selector);
        new Vesting(address(brsr), address(0), treasury);

        vm.expectRevert(Vesting.ZeroAddress.selector);
        new Vesting(address(brsr), admin, address(0));
    }

    /// The balance backing live grants is not sweepable at any point in the schedule, which
    /// is the difference between a lock-up and a custody arrangement.
    function test_sweepTakesTheSurplusAndNeverTheGrants() public {
        vm.prank(admin);
        vm.expectRevert(Vesting.NothingUnallocated.selector);
        vesting.sweep();

        vm.prank(treasury);
        brsr.transfer(address(vesting), 7e18);

        vm.prank(stranger);
        vm.expectRevert(Vesting.NotAdmin.selector);
        vesting.sweep();

        uint256 treasuryBefore = brsr.balanceOf(treasury);
        vm.expectEmit(false, false, false, true, address(vesting));
        emit Swept(7e18);
        vm.prank(admin);
        assertEq(vesting.sweep(), 7e18);

        assertEq(brsr.balanceOf(treasury), treasuryBefore + 7e18);
        assertEq(brsr.balanceOf(address(vesting)), TEAM_ALLOCATION);
        assertEq(vesting.outstandingWei(), TEAM_ALLOCATION);
    }

    /// A revocation returns the remainder straight to the treasury, so the surplus a sweep
    /// would find afterwards is nothing.
    function test_aRevokedRemainderIsNotLeftForASweep() public {
        vm.warp(start + 1095 days);
        vm.prank(admin);
        vesting.revoke(alice);

        vm.prank(admin);
        vm.expectRevert(Vesting.NothingUnallocated.selector);
        vesting.sweep();
    }

    function test_adminMovesInTwoSteps() public {
        address next = makeAddr("next");

        vm.prank(stranger);
        vm.expectRevert(Vesting.NotAdmin.selector);
        vesting.transferAdmin(next);

        vm.prank(admin);
        vm.expectRevert(Vesting.ZeroAddress.selector);
        vesting.transferAdmin(address(0));

        vm.prank(admin);
        vesting.transferAdmin(next);
        assertEq(vesting.admin(), admin);
        assertEq(vesting.pendingAdmin(), next);

        vm.prank(stranger);
        vm.expectRevert(Vesting.NotAuthorized.selector);
        vesting.acceptAdmin();

        vm.prank(next);
        vesting.acceptAdmin();
        assertEq(vesting.admin(), next);
        assertEq(vesting.pendingAdmin(), address(0));
    }

    /// Every grant pays out its whole total and never a wei more, whatever schedule it is read
    /// on and however the claims are spaced.
    function testFuzz_aGrantPaysItsTotalAndNoMore(uint128 amount, uint32 firstAt, uint32 secondAt) public {
        uint128 grant = uint128(bound(amount, 1e18, 50_000_000e18));
        uint256 first = bound(firstAt, 0, 2000 days);
        uint256 second = bound(secondAt, 0, 4000 days);

        Vesting fresh = new Vesting(address(brsr), admin, treasury);
        vm.prank(treasury);
        brsr.transfer(address(fresh), grant);

        address[] memory who = new address[](1);
        who[0] = alice;
        uint128[] memory howMuch = new uint128[](1);
        howMuch[0] = grant;
        fresh.createGrants(who, howMuch, start);

        uint256 before = brsr.balanceOf(alice);

        vm.warp(start + first);
        if (fresh.claimableOf(alice) != 0) {
            vm.prank(alice);
            fresh.claim();
        }

        vm.warp(start + first + second);
        if (fresh.claimableOf(alice) != 0) {
            vm.prank(alice);
            fresh.claim();
        }

        uint256 paid = brsr.balanceOf(alice) - before;
        assertLe(paid, grant);
        assertEq(paid, fresh.vestedOf(alice));
        assertEq(brsr.balanceOf(address(fresh)), grant - paid);
        assertEq(fresh.outstandingWei(), grant - paid);

        // Nothing before the cliff, everything after the term.
        if (first + second < 365 days) assertEq(paid, 0);
        if (first >= 1460 days) assertEq(paid, grant);
    }

    /// Revoking at any instant leaves the beneficiary exactly what the line had reached and
    /// the treasury exactly the rest. The two always add back to the grant.
    function testFuzz_revocationSplitsTheGrantAtTheInstantItLands(uint32 revokeAt, uint32 claimAt) public {
        uint256 at = bound(revokeAt, 0, 3000 days);
        uint256 claimDelay = bound(claimAt, 0, 3000 days);

        uint256 treasuryBefore = brsr.balanceOf(treasury);

        vm.warp(start + at);
        uint128 vested = vesting.vestedOf(alice);

        vm.prank(admin);
        uint128 forfeited = vesting.revoke(alice);

        assertEq(uint256(vested) + forfeited, GRANT_A);
        assertEq(brsr.balanceOf(treasury), treasuryBefore + forfeited);

        vm.warp(start + at + claimDelay);
        assertEq(vesting.vestedOf(alice), vested);

        if (vested != 0) {
            vm.prank(alice);
            assertEq(vesting.claim(), vested);
        }
        assertEq(brsr.balanceOf(alice), vested);
        assertEq(vesting.outstandingWei(), GRANT_B);
    }
}

/// The vesting contract under the governance that holds it, so the terms cannot be
/// changed by the key that deployed it.
contract VestingUnderTimelockTest is Test {
    uint64 internal constant PERIOD = 48 hours;

    AdminTimelock internal timelock;
    BRSR internal brsr;
    Vesting internal vesting;

    address internal signerA = makeAddr("signerA");
    address internal signerB = makeAddr("signerB");
    address internal signerC = makeAddr("signerC");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");

    uint64 internal start;

    function setUp() public {
        timelock = new AdminTimelock([signerA, signerB, signerC], guardian, PERIOD);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vesting = new Vesting(predicted, address(timelock), treasury);
        brsr = new BRSR(
            IBRSR.Allocation({
                community: makeAddr("community"),
                team: address(vesting),
                treasury: treasury,
                liquidity: makeAddr("liquidity")
            })
        );

        start = uint64(block.timestamp);
        address[] memory who = new address[](1);
        who[0] = alice;
        uint128[] memory howMuch = new uint128[](1);
        howMuch[0] = 100_000_000e18;
        vesting.createGrants(who, howMuch, start);
    }

    function _pass(bytes memory data) internal returns (bytes memory) {
        vm.prank(signerA);
        uint256 id = timelock.propose(address(vesting), data);
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(signerA);
        return timelock.execute(id);
    }

    function test_theDeployKeyCannotRevokeOrSweep() public {
        vm.expectRevert(Vesting.NotAdmin.selector);
        vesting.revoke(alice);

        vm.expectRevert(Vesting.NotAdmin.selector);
        vesting.sweep();

        vm.expectRevert(Vesting.NotAdmin.selector);
        vesting.transferAdmin(address(this));
    }

    /// A revocation waits out the delay because it cannot be undone. The beneficiary gets the
    /// length of the timelock to see it coming.
    function test_revocationGoesThroughTheDelay() public {
        vm.warp(start + 1095 days);
        uint128 vested = vesting.vestedOf(alice);

        vm.prank(signerA);
        uint256 id = timelock.propose(address(vesting), abi.encodeCall(Vesting.revoke, (alice)));
        vm.prank(signerB);
        timelock.approve(id);

        vm.prank(signerA);
        vm.expectRevert(AdminTimelock.TimelockNotExpired.selector);
        timelock.execute(id);

        vm.warp(block.timestamp + PERIOD);
        vm.prank(signerA);
        timelock.execute(id);

        assertTrue(vesting.grantOf(alice).revokedAt != 0);
        // The forty-eight hours the beneficiary spent waiting still vested.
        assertGt(vesting.vestedOf(alice), vested);
    }

    function test_governanceCanHandTheContractOn() public {
        address multisig = makeAddr("multisig");
        _pass(abi.encodeCall(Vesting.transferAdmin, (multisig)));

        assertEq(vesting.pendingAdmin(), multisig);
        vm.prank(multisig);
        vesting.acceptAdmin();
        assertEq(vesting.admin(), multisig);
    }
}
