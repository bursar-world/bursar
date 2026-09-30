// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {Reputation} from "../src/Reputation.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../src/interfaces/IMandateAccountFactory.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";
import {IStockRouter} from "../src/interfaces/IStockRouter.sol";
import {Staking} from "../src/token/Staking.sol";
import {MockBRSR} from "./mocks/MockBRSR.sol";
import {MockReputation} from "./mocks/MockReputation.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";

/// A payer contract whose refund hook burns every unit of gas it is given. Under v1 a caller
/// could size `finalize` so the ruling ran out of gas inside the registry's try, the dispute
/// closed as failed, and the escrow timeout later paid this payer in full.
contract HungryPayer {
    function lock(Escrow escrow, MockUsdg asset, address payee, uint128 amount, uint64 deadline)
        external
        returns (uint256)
    {
        asset.approve(address(escrow), amount);
        return escrow.lock(payee, keccak256("capability"), keccak256("input"), "ipfs://job", amount, deadline);
    }

    function dispute(Escrow escrow, MockUsdg asset, uint256 id, uint128 bond) external {
        asset.approve(address(escrow), bond);
        escrow.dispute(id);
    }

    function creditSpend(uint256, uint128) external pure {
        while (true) {}
    }
}

/// Fills at a fixed rate of one stock unit per USDG unit, pulling from the caller.
contract FixedRouter is IStockRouter {
    MockUsdg private immutable USDG;
    MockUsdg public immutable STOCK;
    uint256 public shortfall;

    constructor(MockUsdg usdg) {
        USDG = usdg;
        STOCK = new MockUsdg();
    }

    function setShortfall(uint256 amount) external {
        shortfall = amount;
    }

    function buy(address, uint128 usdgIn, uint128, uint256, address to) external returns (uint256 out) {
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        USDG.transferFrom(msg.sender, address(this), usdgIn);
        out = usdgIn - shortfall;
        STOCK.mint(to, out);
    }
}

/// One test per v2 fix, each written against the behaviour v1 had, so every one of them fails
/// on the v1 bytecode and passes on this one. Labels match the contract review and F7.
contract V2FixesTest is Test {
    uint128 private constant AMOUNT = 1_000e6;
    uint128 private constant DISPUTE_BOND = 50e6;
    uint128 private constant BOND = 2_000e18;
    uint64 private constant WINDOW = 1 hours;
    uint64 private constant MIN_TTL = 5 minutes;
    uint64 private constant DISPUTE_TIMEOUT = 2 days;
    bytes32 private constant SALT = keccak256("v2.salt");
    bytes32 private constant CAPABILITY = keccak256("service:gpu.render:1");

    MockUsdg private usdg;
    MockBRSR private brsr;
    Staking private staking;
    MockReputation private reputation;
    AdminTimelock private timelock;
    Escrow private escrow;
    OracleRegistry private registry;
    MandateAccountFactory private factory;

    address private signerA = makeAddr("signerA");
    address private signerB = makeAddr("signerB");
    address private signerC = makeAddr("signerC");
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
        timelock = new AdminTimelock([signerA, signerB, signerC], guardian, 1 hours);

        escrow = new Escrow(
            address(usdg), address(reputation), treasury, 100, 50, 500, MIN_TTL, 7 days, 1 hours, DISPUTE_TIMEOUT
        );
        registry = new OracleRegistry(
            address(usdg),
            address(timelock),
            sink,
            IOracleRegistry.Config({
                commitWindow: WINDOW,
                revealWindow: WINDOW,
                unbondingPeriod: 7 days,
                quorum: 2,
                maxVoters: 5,
                maxDeviation: 20,
                slashBps: 1_000
            })
        );
        staking = new Staking(brsr, usdg, address(this), sink, treasury, 7 days, 1_000e18);

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(registry));
        escrow.setPauser(address(timelock));
        registry.setEscrow(address(escrow));
        registry.setStaking(address(staking));
        factory = new MandateAccountFactory(address(escrow), address(usdg));

        r1 = _bond("r1");
        r2 = _bond("r2");
        r3 = _bond("r3");
    }

    // D17 ------------------------------------------------------------------------------------

    function test_D17_disputeTimeoutRefusesWhileTheRegistryCanStillRule() public {
        uint256 id = _lockAndDispute(payer);
        uint256 disputeId = registry.disputeIdOf(id);
        _vote(disputeId, 90, 90, 90);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);
        vm.expectRevert(IEscrow.DisputeRulable.selector);
        escrow.disputeTimeout(id);

        registry.finalize(disputeId);
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Resolved));
        assertGt(usdg.balanceOf(payee), 0, "the ruling paid the payee, the timeout did not refund the payer");
    }

    function test_D17_disputeTimeoutStillAnswersARegistryThatCannotBeRead() public {
        MockUsdg asset = new MockUsdg();
        Escrow orphan = new Escrow(
            address(asset), address(new MockReputation()), treasury, 100, 50, 500, MIN_TTL, 7 days, 0, 1 days
        );
        DeadRegistry dead = new DeadRegistry();
        orphan.setResolver(address(dead));

        asset.mint(payer, AMOUNT + DISPUTE_BOND);
        vm.startPrank(payer);
        asset.approve(address(orphan), AMOUNT + DISPUTE_BOND);
        uint256 id = orphan.lock(payee, CAPABILITY, bytes32(0), "", AMOUNT, uint64(block.timestamp + 1 days));
        orphan.dispute(id);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1);
        orphan.disputeTimeout(id);
        assertEq(asset.balanceOf(payer), AMOUNT + DISPUTE_BOND);
    }

    // D14 and D18 / M1 -----------------------------------------------------------------------

    function test_D14_aRulingWithNoSharesTakesNoResolverFee() public {
        uint256 id = _lockAndDispute(payer);
        uint256 disputeId = registry.disputeIdOf(id);
        _vote(disputeId, 0, 50, 100);

        registry.finalize(disputeId);

        assertEq(registry.getDispute(disputeId).rewardShares, 0);
        assertEq(usdg.balanceOf(payer), AMOUNT + DISPUTE_BOND, "the payer lost a fee nobody earned");
        assertEq(registry.unallocatedRewards(), 0);
        assertEq(usdg.balanceOf(address(escrow)), 0);
    }

    function test_D18_aBondWithNoResolverToPayGoesBackToThePayeeDisputer() public {
        uint256 id = _lockAndDispute(payee);
        uint256 disputeId = registry.disputeIdOf(id);
        // No centre, so the payer is refunded in full, which is the opposite of what the payee
        // asked for. With nobody to pay, the bond is not forfeited.
        _vote(disputeId, 0, 50, 100);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.BondReturned(id, payee, DISPUTE_BOND);
        registry.finalize(disputeId);

        assertEq(usdg.balanceOf(payee), DISPUTE_BOND);
        assertEq(registry.rewardFloat(), 0);
    }

    // D19 / H1 -------------------------------------------------------------------------------

    function test_H1_noGasLimitTurnsARulingIntoAFailedDispute() public {
        HungryPayer hungry = new HungryPayer();
        usdg.mint(address(hungry), AMOUNT + DISPUTE_BOND);
        uint256 id = hungry.lock(escrow, usdg, payee, AMOUNT, uint64(block.timestamp + 1 days));
        hungry.dispute(escrow, usdg, id, DISPUTE_BOND);

        uint256 disputeId = registry.disputeIdOf(id);
        // 75% refund, so the ruling calls the payer's refund hook.
        _vote(disputeId, 55, 55, 55);

        for (uint256 gas = 150_000; gas <= 1_500_000; gas += 10_000) {
            uint256 snapshot = vm.snapshotState();

            (bool ok,) = address(registry).call{gas: gas}(abi.encodeCall(OracleRegistry.finalize, (disputeId)));

            IOracleRegistry.DisputeStatus status = registry.getDispute(disputeId).status;
            IEscrow.LockStatus lockStatus = escrow.getLock(id).status;
            if (ok) {
                assertEq(uint8(status), uint8(IOracleRegistry.DisputeStatus.Finalized));
                assertEq(uint8(lockStatus), uint8(IEscrow.LockStatus.Resolved));
            } else {
                assertEq(uint8(status), uint8(IOracleRegistry.DisputeStatus.Revealing), "a reverted finalize moved");
                assertEq(uint8(lockStatus), uint8(IEscrow.LockStatus.Disputed));
            }

            vm.revertToState(snapshot);
        }
    }

    // H2 root and M1 -------------------------------------------------------------------------

    function test_H2_aDisputeNobodyHeardReopensTheLockInsteadOfRefundingIt() public {
        uint256 id = _lockAndDispute(payer);
        uint256 disputeId = registry.disputeIdOf(id);
        uint64 deadline = escrow.getLock(id).deadline;

        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IEscrow.DisputeReopened(id, deadline + MIN_TTL);
        registry.failDispute(disputeId);

        IEscrow.Lock memory reopened = escrow.getLock(id);
        assertEq(uint8(reopened.status), uint8(IEscrow.LockStatus.Locked));
        assertEq(reopened.deadline, deadline + MIN_TTL);
        assertEq(usdg.balanceOf(payer), DISPUTE_BOND, "only the bond came back, never the principal");
        assertEq(usdg.balanceOf(address(escrow)), AMOUNT);

        vm.prank(payee);
        escrow.release(id, keccak256("output"), "ipfs://out");
        assertEq(usdg.balanceOf(payee), AMOUNT - AMOUNT / 100);
    }

    function test_H2_aReopenAfterTheDeadlineStillGivesThePayeeAFullMinTtl() public {
        uint256 id = _lockAndDispute(payer);
        uint256 disputeId = registry.disputeIdOf(id);

        vm.warp(escrow.getLock(id).deadline + 1 hours);
        registry.failDispute(disputeId);

        assertEq(escrow.getLock(id).deadline, block.timestamp + MIN_TTL);
    }

    function test_H2_aLockCanOnlyEverBeDisputedOnce() public {
        uint256 id = _lockAndDispute(payer);
        vm.warp(registry.getDispute(registry.disputeIdOf(id)).revealEndsAt);
        registry.failDispute(registry.disputeIdOf(id));

        usdg.mint(payer, DISPUTE_BOND);
        vm.startPrank(payer);
        usdg.approve(address(escrow), DISPUTE_BOND);
        vm.expectRevert(IOracleRegistry.DisputeAlreadyOpen.selector);
        escrow.dispute(id);
        vm.stopPrank();
    }

    function test_M1_aPayeeDisputerKeepsItsBondWhenNobodyVotes() public {
        uint256 id = _lockAndDispute(payee);
        vm.warp(registry.getDispute(registry.disputeIdOf(id)).revealEndsAt);
        registry.failDispute(registry.disputeIdOf(id));

        assertEq(usdg.balanceOf(payee), DISPUTE_BOND);
        assertEq(registry.rewardFloat(), 0);
    }

    // H3 -------------------------------------------------------------------------------------

    function test_H3_neitherPartyCanVoteOnItsOwnDispute() public {
        address bondedPayer = _bondAs(payer);
        address bondedPayee = _bondAs(payee);
        uint256 id = _lockAndDispute(bondedPayer);
        uint256 disputeId = registry.disputeIdOf(id);

        (address p, address q) = registry.partiesOf(disputeId);
        assertEq(p, payer);
        assertEq(q, payee);

        bytes32 commitment = registry.commitmentHash(disputeId, bondedPayer, 0, SALT);
        vm.prank(bondedPayer);
        vm.expectRevert(IOracleRegistry.PartyCannotVote.selector);
        registry.commitVote(disputeId, commitment);

        commitment = registry.commitmentHash(disputeId, bondedPayee, 100, SALT);
        vm.prank(bondedPayee);
        vm.expectRevert(IOracleRegistry.PartyCannotVote.selector);
        registry.commitVote(disputeId, commitment);
    }

    function test_H3_thePrincipalBehindAMandatePayerCannotVoteEither() public {
        MandateAccount account = _mandate(principal, _limits());
        vm.prank(principal);
        account.setMerchant(payee, true);
        usdg.mint(address(account), AMOUNT + DISPUTE_BOND);

        vm.prank(agent);
        uint256 id = account.spend(_request(10e6, 0), new bytes32[](0));
        vm.prank(principal);
        account.disputeSpend(id);

        _bondAs(principal);
        uint256 disputeId = registry.disputeIdOf(id);
        bytes32 commitment = registry.commitmentHash(disputeId, principal, 0, SALT);
        vm.prank(principal);
        vm.expectRevert(IOracleRegistry.PartyCannotVote.selector);
        registry.commitVote(disputeId, commitment);
    }

    // D20 ------------------------------------------------------------------------------------

    function test_D20_aCurveThatCapsEveryPayeeAtZeroIsRefused() public {
        vm.expectRevert(IReputation.BadCurve.selector);
        new Reputation(address(this), IReputation.CapCurve({baseCap: 0, capPerScore: 0, maxCap: 0}));

        Reputation live =
            new Reputation(address(this), IReputation.CapCurve({baseCap: 25e6, capPerScore: 2.25e6, maxCap: 250e6}));
        vm.expectRevert(IReputation.BadCurve.selector);
        live.setCurve(IReputation.CapCurve({baseCap: 0, capPerScore: 5e6, maxCap: 0}));
    }

    function test_D20_theAgentStakeFloorIsBounded() public {
        AgentRegistry agents = new AgentRegistry(usdg, address(this), sink, 5e6, 1_000);
        uint128 ceiling = agents.MAX_MIN_STAKE();

        agents.setMinStake(ceiling);
        vm.expectRevert(AgentRegistry.BadConfig.selector);
        agents.setMinStake(ceiling + 1);

        vm.expectRevert(AgentRegistry.BadConfig.selector);
        new AgentRegistry(usdg, address(this), sink, ceiling + 1, 1_000);
    }

    // D21 ------------------------------------------------------------------------------------

    function test_D21_votingWindowsMustEndBeforeTheEscrowTimesOut() public {
        IOracleRegistry.Config memory cfg = registry.config();
        cfg.commitWindow = DISPUTE_TIMEOUT / 2;
        cfg.revealWindow = DISPUTE_TIMEOUT / 2;
        cfg.unbondingPeriod = 30 days;

        vm.prank(address(timelock));
        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        registry.setConfig(cfg);

        OracleRegistry fresh = new OracleRegistry(address(usdg), address(timelock), sink, cfg);
        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        fresh.setEscrow(address(escrow));
    }

    // D22 ------------------------------------------------------------------------------------

    function test_D22_onlyThePrincipalCreatesItsAccount() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IMandateAccountFactory.NotPrincipal.selector);
        factory.create(principal, agent, SALT, _limits());

        vm.prank(principal);
        factory.create(principal, agent, SALT, _limits());
        assertEq(factory.accountCount(principal), 1);
    }

    // M3 -------------------------------------------------------------------------------------

    function test_M3_oneSignerCannotCancelAnotherSignersProposal() public {
        vm.prank(signerA);
        uint256 id = timelock.propose(address(registry), abi.encodeCall(OracleRegistry.unpause, ()));

        vm.prank(signerC);
        timelock.cancel(id);
        assertFalse(timelock.getProposal(id).cancelled, "one veto cancelled a proposal it did not write");
        assertEq(timelock.vetoes(id), 1);

        vm.prank(signerC);
        vm.expectRevert(AdminTimelock.AlreadyVetoed.selector);
        timelock.cancel(id);

        vm.prank(signerB);
        timelock.cancel(id);
        assertTrue(timelock.getProposal(id).cancelled, "two vetoes cancel");
    }

    function test_M3_theProposerWithdrawsItsOwnAlone() public {
        vm.prank(signerA);
        uint256 id = timelock.propose(address(registry), abi.encodeCall(OracleRegistry.unpause, ()));

        vm.prank(signerA);
        timelock.cancel(id);
        assertTrue(timelock.getProposal(id).cancelled);
    }

    // M4 -------------------------------------------------------------------------------------

    function test_M4_theGuardianPausesTheEscrowAndTheRegistry() public {
        uint256 open = _lockAndDispute(payer);

        address[] memory targets = new address[](2);
        targets[0] = address(escrow);
        targets[1] = address(registry);
        vm.prank(guardian);
        timelock.guardianPause(targets);

        assertTrue(escrow.paused());
        assertTrue(registry.paused());

        usdg.mint(payer, AMOUNT);
        vm.startPrank(payer);
        usdg.approve(address(escrow), AMOUNT);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.lock(payee, CAPABILITY, bytes32(0), "", AMOUNT, uint64(block.timestamp + 1 days));
        vm.stopPrank();

        uint256 disputeId = registry.disputeIdOf(open);
        bytes32 commitment = registry.commitmentHash(disputeId, r1, 50, SALT);
        vm.prank(r1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.commitVote(disputeId, commitment);

        // Exits stay open. The dispute nobody could vote on reopens, and the payee is paid.
        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        registry.failDispute(disputeId);
        vm.prank(payee);
        escrow.release(open, keccak256("output"), "");
        assertEq(uint8(escrow.getLock(open).status), uint8(IEscrow.LockStatus.Released));
    }

    function test_M4_onlyTheTimelockHoldsTheEscrowBrake() public {
        vm.expectRevert(IEscrow.NotPauser.selector);
        escrow.pause();

        vm.expectRevert(IEscrow.AlreadySet.selector);
        escrow.setPauser(address(this));
    }

    // L3 -------------------------------------------------------------------------------------

    function test_L3_anApprovalDoesNotSurviveAChangeOfPrincipal() public {
        IMandateAccount.Limits memory limits = _limits();
        limits.approvalThreshold = 5e6;
        MandateAccount account = _mandate(principal, limits);
        usdg.mint(address(account), AMOUNT);

        IMandateAccount.SpendApproval memory approval = IMandateAccount.SpendApproval({
            approvalId: keccak256("approval"),
            merchant: payee,
            capabilityId: CAPABILITY,
            amount: 10e6,
            expiry: uint64(block.timestamp + 1 days)
        });

        vm.startPrank(principal);
        account.setMerchant(payee, true);
        account.approveSpend(approval);
        account.transferPrincipal(makeAddr("successor"));
        vm.stopPrank();

        (bool registered,) = account.approvals(approval.approvalId);
        assertTrue(registered, "still standing until the successor accepts");

        vm.prank(makeAddr("successor"));
        account.acceptPrincipal();

        (registered,) = account.approvals(approval.approvalId);
        assertFalse(registered);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalMismatch.selector);
        account.spendApproved(_request(10e6, 0), new bytes32[](0), approval, "");
    }

    // Native class, total and lane ---------------------------------------------------------

    function test_classMaskRefusesAClassThePrincipalDidNotAllow() public {
        IMandateAccount.Limits memory limits = _limits();
        limits.classMask = 1;
        MandateAccount account = _funded(limits);

        (bool allowed, bytes4 reason) = account.previewSpend(payee, CAPABILITY, 1e6, 1);
        assertFalse(allowed);
        assertEq(reason, IMandateAccount.ClassNotAllowed.selector);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ClassNotAllowed.selector);
        account.spend(_request(1e6, 1), new bytes32[](0));

        vm.prank(agent);
        account.spend(_request(1e6, 0), new bytes32[](0));
    }

    function test_classMaskMustNameAKnownClass() public {
        IMandateAccount.Limits memory limits = _limits();
        limits.classMask = 0;
        vm.expectRevert(IMandateAccount.BadClassMask.selector);
        new MandateAccount(principal, agent, address(usdg), address(escrow), limits);

        limits.classMask = 8;
        vm.expectRevert(IMandateAccount.BadClassMask.selector);
        new MandateAccount(principal, agent, address(usdg), address(escrow), limits);
    }

    function test_totalCapBindsAcrossWindowsAndRefundsComeBack() public {
        IMandateAccount.Limits memory limits = _limits();
        limits.totalCap = 15e6;
        MandateAccount account = _funded(limits);

        vm.prank(agent);
        uint256 first = account.spend(_request(10e6, 0), new bytes32[](0));
        assertEq(account.totalSpent(), 10e6);
        assertEq(account.remainingTotal(), 5e6);

        vm.warp(block.timestamp + 40 days);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.TotalCapExceeded.selector);
        account.spend(_request(10e6, 0), new bytes32[](0));

        vm.prank(payee);
        vm.expectRevert(IEscrow.TooLate.selector);
        escrow.cancel(first);
        escrow.timeout(first);
        assertEq(account.totalSpent(), 0, "a refunded lock gives its share of the total back");

        vm.prank(agent);
        account.spend(_request(10e6, 0), new bytes32[](0));
    }

    function test_laneIsStoredAndBounded() public {
        IMandateAccount.Limits memory limits = _limits();
        limits.lane = 2;
        MandateAccount account = new MandateAccount(principal, agent, address(usdg), address(escrow), limits);
        assertEq(account.lane(), 2);
        assertEq(account.limits().lane, 2);

        limits.lane = 3;
        vm.expectRevert(IMandateAccount.BadLane.selector);
        new MandateAccount(principal, agent, address(usdg), address(escrow), limits);
    }

    // Hooks for F9, F13 and F14 ----------------------------------------------------------------

    function test_buyRunsUnderTheRwaClassAndEveryCap() public {
        IMandateAccount.Limits memory limits = _limits();
        MandateAccount account = _funded(limits);
        FixedRouter router = new FixedRouter(usdg);
        address stock = address(router.STOCK());

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ClassNotAllowed.selector);
        account.buy(stock, 1e6, 1e6, 250e8);

        limits.classMask = 7;
        vm.prank(principal);
        account.setLimits(limits);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.RouterNotSet.selector);
        account.buy(stock, 1e6, 1e6, 250e8);

        vm.prank(principal);
        account.setRouter(address(router));

        vm.prank(agent);
        uint256 out = account.buy(stock, 1e6, 1e6, 250e8);
        assertEq(out, 1e6);
        assertEq(router.STOCK().balanceOf(address(account)), 1e6);
        assertEq(usdg.allowance(address(account), address(router)), 0);
        assertEq(account.window(IMandateAccount.WindowKind.Daily).spent, 1e6);

        router.setShortfall(1);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.InsufficientOutput.selector);
        account.buy(stock, 1e6, 1e6, 250e8);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.PerCallCapExceeded.selector);
        account.buy(stock, 200e6, 1, 250e8);
    }

    function test_eitherPartyCanGrantADisclosureOnADisputedLock() public {
        uint256 id = _lockAndDispute(payer);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.DisclosureGranted(id, payee, r1, keccak256("slice"), hex"c0ffee");
        vm.prank(payee);
        escrow.grantDisclosure(id, r1, keccak256("slice"), hex"c0ffee");

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IEscrow.NotParty.selector);
        escrow.grantDisclosure(id, r1, keccak256("slice"), hex"c0ffee");
    }

    // Fixture ----------------------------------------------------------------------------------

    function _bond(string memory label) private returns (address who) {
        who = _bondAs(makeAddr(label));
    }

    function _bondAs(address who) private returns (address) {
        brsr.mint(who, BOND);
        vm.startPrank(who);
        brsr.approve(address(registry), BOND);
        registry.register(BOND);
        vm.stopPrank();
        return who;
    }

    function _lockAndDispute(address disputer) private returns (uint256 id) {
        usdg.mint(payer, AMOUNT);
        vm.startPrank(payer);
        usdg.approve(address(escrow), AMOUNT);
        id = escrow.lock(payee, CAPABILITY, keccak256("input"), "ipfs://in", AMOUNT, uint64(block.timestamp + 1 days));
        vm.stopPrank();

        usdg.mint(disputer, DISPUTE_BOND);
        vm.startPrank(disputer);
        usdg.approve(address(escrow), DISPUTE_BOND);
        escrow.dispute(id);
        vm.stopPrank();
    }

    function _vote(uint256 disputeId, uint8 a, uint8 b, uint8 c) private {
        bytes32 ca = registry.commitmentHash(disputeId, r1, a, SALT);
        bytes32 cb = registry.commitmentHash(disputeId, r2, b, SALT);
        bytes32 cc = registry.commitmentHash(disputeId, r3, c, SALT);
        vm.prank(r1);
        registry.commitVote(disputeId, ca);
        vm.prank(r2);
        registry.commitVote(disputeId, cb);
        vm.prank(r3);
        registry.commitVote(disputeId, cc);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        vm.prank(r1);
        registry.revealVote(disputeId, a, SALT);
        vm.prank(r2);
        registry.revealVote(disputeId, b, SALT);
        vm.prank(r3);
        registry.revealVote(disputeId, c, SALT);
    }

    function _limits() private pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
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
    }

    function _mandate(address owner, IMandateAccount.Limits memory limits) private returns (MandateAccount account) {
        vm.prank(owner);
        account = MandateAccount(factory.create(owner, agent, SALT, limits));
        vm.prank(owner);
        account.setCapability(CAPABILITY, true);
    }

    function _funded(IMandateAccount.Limits memory limits) private returns (MandateAccount account) {
        account = _mandate(principal, limits);
        vm.prank(principal);
        account.setMerchant(payee, true);
        usdg.mint(address(account), AMOUNT);
    }

    function _request(uint128 amount, uint8 spendClass) private view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: payee,
            capabilityId: CAPABILITY,
            inputCommit: keccak256("input"),
            inputURI: "ipfs://in",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: spendClass
        });
    }
}

/// A resolver whose every call reverts, standing in for a registry that has stopped answering.
contract DeadRegistry {
    function openDispute(uint256, address, address) external pure returns (uint256) {
        return 1;
    }

    fallback() external {
        revert();
    }
}
