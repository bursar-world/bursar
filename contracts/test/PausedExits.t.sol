// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {Staking} from "../src/token/Staking.sol";

import {MockBRSR} from "./mocks/MockBRSR.sol";
import {MockReputation} from "./mocks/MockReputation.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";

/// Every way a party takes its own money out of the core set, walked with the guardian's brake
/// pulled on the escrow, the resolver registry and the agent registry at once and never lifted.
///
/// A pause stops new exposure. A stake, a bond, a refund or a payout that is already owed still
/// leaves, however long the pause lasts.
contract PausedExitsTest is Test {
    uint128 private constant AMOUNT = 20e6;

    /// One percent of a settlement, half a percent of a ruling, five percent posted to contest.
    uint128 private constant FEE = 200_000;
    uint128 private constant RESOLVER_FEE = 100_000;
    uint128 private constant DISPUTE_BOND = 1e6;

    uint128 private constant MIN_STAKE = 5e6;
    uint128 private constant STAKE = 15e6;
    uint128 private constant BOND = 2_000e18;
    uint128 private constant FUNDING = 100e6;

    uint64 private constant MIN_TTL = 5 minutes;
    uint64 private constant WINDOW = 1 hours;
    uint64 private constant UNBONDING_PERIOD = 7 days;

    bytes32 private constant SALT = keccak256("exits.salt");
    bytes32 private constant CAPABILITY = keccak256("service:gpu.render:1");

    MockUsdg private usdg;
    MockBRSR private brsr;
    MockReputation private reputation;
    Staking private staking;
    AdminTimelock private timelock;
    Escrow private escrow;
    OracleRegistry private oracle;
    AgentRegistry private agents;
    MandateAccountFactory private factory;

    address private guardian = makeAddr("guardian");
    address private sink = makeAddr("sink");
    address private treasury = makeAddr("treasury");
    address private payer = makeAddr("payer");
    address private payee = makeAddr("payee");
    address private principal = makeAddr("principal");
    address private agent = makeAddr("agent");

    address private r1;
    address private r2;
    address private r3;

    function setUp() public {
        vm.warp(1_800_000_000);

        usdg = new MockUsdg();
        brsr = new MockBRSR();
        reputation = new MockReputation();
        timelock = new AdminTimelock([makeAddr("signerA"), makeAddr("signerB"), makeAddr("signerC")], guardian, 1 hours);

        escrow = new Escrow(address(usdg), address(reputation), treasury, 100, 50, 500, MIN_TTL, 7 days, WINDOW, 10_000);
        oracle = new OracleRegistry(
            address(usdg),
            address(timelock),
            sink,
            IOracleRegistry.Config({
                commitWindow: WINDOW,
                revealWindow: WINDOW,
                unbondingPeriod: UNBONDING_PERIOD,
                quorum: 2,
                maxVoters: 64,
                maxDeviation: 20,
                slashBps: 1_000
            })
        );
        agents = new AgentRegistry(IERC20(address(usdg)), address(timelock), sink, MIN_STAKE, 1_000);
        staking = new Staking(brsr, usdg, address(timelock), sink, treasury, 7 days, 1_000e18);

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(oracle));
        escrow.setPauser(address(timelock));
        escrow.setRegistry(agents);
        oracle.setEscrow(address(escrow));
        oracle.setStaking(address(staking));
        factory = new MandateAccountFactory(address(escrow), address(usdg));

        usdg.mint(payee, STAKE);
        vm.startPrank(payee);
        usdg.approve(address(agents), type(uint256).max);
        agents.register("render_farm", STAKE);
        vm.stopPrank();

        r1 = _bond("r1");
        r2 = _bond("r2");
        r3 = _bond("r3");
    }

    /// The delay runs from the request, so a registry that refused the request while paused would
    /// hold the stake for as long as the pause lasted and seven days more.
    function test_anAgentTakesItsStakeOutOfARegistryThatStaysPaused() public {
        _pause();

        vm.startPrank(payee);
        // Part of it while still listed, then all of it after standing down.
        agents.requestWithdrawal(STAKE - MIN_STAKE);
        agents.cancelWithdrawal();
        agents.deactivate();
        agents.requestWithdrawal(STAKE);

        vm.warp(block.timestamp + agents.WITHDRAWAL_DELAY());
        agents.executeWithdrawal();
        vm.stopPrank();

        assertTrue(agents.paused(), "the pause lifted");
        assertEq(usdg.balanceOf(payee), STAKE);
        assertEq(agents.stakeOf(payee), 0);
        assertEq(agents.totalStaked(), 0);
    }

    function test_aResolverTakesItsBondAndItsRewardsOutOfARegistryThatStaysPaused() public {
        // A ruling before the brake, so there is a reward waiting behind it.
        uint256 disputeId = _dispute(_lock());
        _commitAll(disputeId, 30);
        _revealAll(disputeId, 30);
        oracle.finalize(disputeId);

        uint256 earned = oracle.rewardsOf(r1);
        assertEq(earned, RESOLVER_FEE / 3);

        _pause();

        vm.startPrank(r1);
        assertEq(oracle.claimRewards(), earned);
        oracle.requestUnbond();
        oracle.cancelUnbond();
        oracle.requestUnbond();

        vm.warp(block.timestamp + UNBONDING_PERIOD);
        oracle.completeUnbond();
        vm.stopPrank();

        assertTrue(oracle.paused(), "the pause lifted");
        assertEq(brsr.balanceOf(r1), BOND);
        assertEq(usdg.balanceOf(r1), earned);
        assertEq(uint8(oracle.getResolver(r1).status), uint8(IOracleRegistry.ResolverStatus.Exited));
    }

    /// A vote sealed before the brake still reveals, rules and pays, and the bonds behind it are
    /// free to leave once it has.
    function test_aDisputeAlreadyOpenIsRuledAndPaidOutWhileEverythingIsPaused() public {
        uint256 id = _lock();
        uint256 disputeId = _dispute(id);
        _commitAll(disputeId, 30);

        _pause();

        _revealAll(disputeId, 30);
        oracle.finalize(disputeId);

        // A score of 30 refunds the payer everything but the resolver fee, and a payer who asked
        // for the money back and got it keeps the bond.
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Resolved));
        assertEq(usdg.balanceOf(payer), AMOUNT - RESOLVER_FEE + DISPUTE_BOND);
        assertEq(usdg.balanceOf(address(escrow)), 0);

        vm.startPrank(r2);
        assertEq(oracle.openVotes(r2), 0);
        oracle.requestUnbond();
        vm.warp(block.timestamp + UNBONDING_PERIOD);
        oracle.completeUnbond();
        vm.stopPrank();

        assertTrue(escrow.paused() && oracle.paused(), "the pause lifted");
        assertEq(brsr.balanceOf(r2), BOND);
    }

    /// No resolver can vote under the brake, so the dispute fails. The bond comes back, the lock
    /// reopens, and the payer's refund is the timeout it always was.
    function test_aDisputeNobodyCouldVoteOnReopensAndTheLockStillRefunds() public {
        uint256 id = _lock();
        uint256 disputeId = _dispute(id);

        _pause();

        vm.warp(oracle.getDispute(disputeId).commitEndsAt);
        oracle.failDispute(disputeId);
        assertEq(usdg.balanceOf(payer), DISPUTE_BOND, "the bond did not come back");

        vm.warp(escrow.getLock(id).deadline + 1);
        escrow.timeout(id);

        assertTrue(escrow.paused() && oracle.paused(), "the pause lifted");
        assertEq(usdg.balanceOf(payer), AMOUNT + DISPUTE_BOND);
        assertEq(usdg.balanceOf(address(escrow)), 0);
    }

    function test_aPayeeIsPaidOutOfAPausedEscrow() public {
        uint256 id = _lock();
        uint256 before = usdg.balanceOf(payee);

        _pause();

        vm.prank(payee);
        escrow.release(id, keccak256("output"), "ipfs://out");
        assertEq(usdg.balanceOf(payee), before + AMOUNT - FEE);

        vm.warp(block.timestamp + WINDOW + 1);
        escrow.finalizeRelease(id);
        assertTrue(escrow.getLock(id).counted, "the release never reached the payee's history");

        escrow.sweepFees();
        assertTrue(escrow.paused(), "the pause lifted");
        assertEq(usdg.balanceOf(treasury), FEE);
    }

    function test_aPayerIsRefundedOutOfAPausedEscrow() public {
        uint256 declined = _lock();
        uint256 expired = _lock();

        _pause();

        vm.prank(payee);
        escrow.cancel(declined);
        assertEq(usdg.balanceOf(payer), AMOUNT);

        vm.warp(escrow.getLock(expired).deadline + 1);
        escrow.timeout(expired);

        assertTrue(escrow.paused(), "the pause lifted");
        assertEq(usdg.balanceOf(payer), 2 * AMOUNT);
        assertEq(usdg.balanceOf(address(escrow)), 0);
    }

    /// A refund the issuer's freeze turned back is booked, and collecting it later is not something
    /// the brake reaches either.
    function test_aBookedPayoutIsClaimedOutOfAPausedEscrow() public {
        uint256 id = _lock();

        usdg.setFrozen(payer, true);
        vm.warp(escrow.getLock(id).deadline + 1);
        escrow.timeout(id);
        assertEq(escrow.owed(payer), AMOUNT);

        _pause();
        usdg.setFrozen(payer, false);

        assertEq(escrow.claim(payer), AMOUNT);
        assertTrue(escrow.paused(), "the pause lifted");
        assertEq(usdg.balanceOf(payer), AMOUNT);
    }

    /// A mandate's funds are its principal's. Neither the brake, nor the mandate's own pause, nor
    /// a revoked agent stands between the principal and the balance.
    function test_aPrincipalEmptiesItsMandateWhileEverythingIsPaused() public {
        MandateAccount account = _mandate();

        vm.prank(agent);
        uint256 id = account.spend(_request(), new bytes32[](0));

        _pause();
        vm.startPrank(principal);
        account.setPaused(true);
        account.revokeAgent();

        // What is idle leaves at once, and what is locked leaves when its deadline refunds it.
        account.withdraw(address(usdg), principal, FUNDING - AMOUNT);
        vm.stopPrank();

        vm.warp(escrow.getLock(id).deadline + 1);
        escrow.timeout(id);

        vm.prank(principal);
        account.withdraw(address(usdg), principal, AMOUNT);

        assertTrue(escrow.paused() && account.paused() && account.revoked(), "a pause lifted");
        assertEq(usdg.balanceOf(principal), FUNDING);
        assertEq(usdg.balanceOf(address(account)), 0);
    }

    /// What the brake is for. Each of these adds exposure, and each is still refused.
    function test_theBrakeStillStopsEveryWayIn() public {
        uint256 open = _lock();
        uint256 disputeId = _dispute(_lock());

        _pause();

        usdg.mint(payer, AMOUNT + DISPUTE_BOND);
        vm.startPrank(payer);
        usdg.approve(address(escrow), AMOUNT + DISPUTE_BOND);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.lock(payee, CAPABILITY, keccak256("input"), "ipfs://in", AMOUNT, uint64(block.timestamp + 1 days));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.dispute(open);
        vm.stopPrank();

        vm.startPrank(payee);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        agents.addStake(1e6);
        agents.deactivate();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        agents.reactivate();
        vm.stopPrank();

        address newcomer = makeAddr("newcomer");
        vm.startPrank(newcomer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        agents.register("newcomer", MIN_STAKE);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        oracle.register(BOND);
        vm.stopPrank();

        bytes32 commitment = oracle.commitmentHash(disputeId, r1, 50, SALT);
        vm.startPrank(r1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        oracle.increaseBond(1e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        oracle.commitVote(disputeId, commitment);
        vm.stopPrank();
    }

    /// The guardian's brake on all three at once, the way an incident would pull it.
    function _pause() private {
        address[] memory targets = new address[](3);
        targets[0] = address(escrow);
        targets[1] = address(oracle);
        targets[2] = address(agents);
        vm.prank(guardian);
        timelock.guardianPause(targets);

        assertTrue(escrow.paused() && oracle.paused() && agents.paused(), "the brake did not land");
    }

    function _bond(string memory label) private returns (address who) {
        who = makeAddr(label);
        brsr.mint(who, BOND);
        vm.startPrank(who);
        brsr.approve(address(oracle), BOND);
        oracle.register(BOND);
        vm.stopPrank();
    }

    function _lock() private returns (uint256 id) {
        usdg.mint(payer, AMOUNT);
        vm.startPrank(payer);
        usdg.approve(address(escrow), AMOUNT);
        id = escrow.lock(payee, CAPABILITY, keccak256("input"), "ipfs://in", AMOUNT, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function _dispute(uint256 id) private returns (uint256 disputeId) {
        usdg.mint(payer, DISPUTE_BOND);
        vm.startPrank(payer);
        usdg.approve(address(escrow), DISPUTE_BOND);
        escrow.dispute(id);
        vm.stopPrank();

        disputeId = oracle.disputeIdOf(id);
    }

    function _commitAll(uint256 disputeId, uint8 score) private {
        address[3] memory resolvers = [r1, r2, r3];
        for (uint256 i; i < 3; ++i) {
            // Hashed before the prank, which the view call would otherwise spend.
            bytes32 commitment = oracle.commitmentHash(disputeId, resolvers[i], score, SALT);
            vm.prank(resolvers[i]);
            oracle.commitVote(disputeId, commitment);
        }
    }

    function _revealAll(uint256 disputeId, uint8 score) private {
        vm.warp(oracle.getDispute(disputeId).commitEndsAt);

        address[3] memory resolvers = [r1, r2, r3];
        for (uint256 i; i < 3; ++i) {
            vm.prank(resolvers[i]);
            oracle.revealVote(disputeId, score, SALT);
        }
    }

    function _mandate() private returns (MandateAccount account) {
        IMandateAccount.Limits memory limits = IMandateAccount.Limits({
            perCallCap: 100e6,
            dailyCap: 500e6,
            monthlyCap: 1_000e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 100e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 3,
            totalCap: 0,
            lane: 0
        });

        vm.startPrank(principal);
        account = MandateAccount(factory.create(principal, agent, SALT, limits));
        account.setCapability(CAPABILITY, true);
        account.setMerchant(payee, true);
        vm.stopPrank();

        usdg.mint(address(account), FUNDING);
    }

    function _request() private view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: payee,
            capabilityId: CAPABILITY,
            inputCommit: keccak256("input"),
            inputURI: "ipfs://in",
            amount: AMOUNT,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }
}
