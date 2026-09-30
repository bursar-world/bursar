// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {Reputation} from "../src/Reputation.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";

import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {InflatingERC20} from "./mocks/InflatingERC20.sol";
import {DualViewERC20} from "./mocks/DualViewERC20.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockReputation} from "./mocks/MockReputation.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";
import {RevertingReputation} from "./mocks/RevertingReputation.sol";
import {ShrinkingERC20} from "./mocks/ShrinkingERC20.sol";

/// Stands in for the oracle registry on both sides of the pairing: it receives `openDispute`
/// and `notifyReward` from the escrow, and it is the only address allowed to rule.
///
/// `refuseNotify` models a registry that rejects the booking call after the fee has already
/// moved, which the escrow has to survive without unwinding a ruling.
contract EscrowResolverStub {
    error NotifyRefused();

    mapping(uint256 escrowId => uint256 disputeId) public disputeIdOf;

    uint256 public nextDisputeId = 1;
    uint256 public opened;
    uint256 public rewardCredited;
    uint256 public lastRewardDisputeId;
    bool public refuseNotify;

    function openDispute(uint256 escrowId, address, address) external returns (uint256 disputeId) {
        disputeId = nextDisputeId++;
        disputeIdOf[escrowId] = disputeId;
        ++opened;
    }

    function notifyReward(uint256 disputeId, uint256 amount) external {
        if (refuseNotify) revert NotifyRefused();

        lastRewardDisputeId = disputeId;
        rewardCredited += amount;
    }

    function setRefuseNotify(bool refuse) external {
        refuseNotify = refuse;
    }

    function rule(IEscrow escrow, uint256 id, uint16 refundBps) external {
        escrow.resolve(id, refundBps, 1);
    }

    function giveBack(IEscrow escrow, uint256 id) external {
        escrow.reopen(id);
    }
}

/// Party gate with the answers written directly, so a test can put a payee in any of the four
/// states the escrow distinguishes without standing up a staking registry.
contract EscrowGateStub is IAgentRegistry {
    mapping(address party => bool) public active;
    mapping(address party => bool) public barred;
    mapping(address party => uint256) public stake;

    uint256 public slashCalls;

    function admit(address party) external {
        active[party] = true;
        barred[party] = false;
    }

    function setActive(address party, bool value) external {
        active[party] = value;
    }

    function setBlacklisted(address party, bool value) external {
        barred[party] = value;
    }

    function setStake(address party, uint256 amount) external {
        stake[party] = amount;
    }

    function isActive(address party) external view returns (bool) {
        return active[party];
    }

    function isBlacklisted(address party) external view returns (bool) {
        return barred[party];
    }

    function stakeOf(address party) external view returns (uint256) {
        return stake[party];
    }

    function slash(address, uint256, bytes32) external {
        ++slashCalls;
    }
}

/// Answers the outcome callbacks but refuses the cap. The cap is a control, so a lock read
/// against this has to fail closed.
contract EscrowCapStub {
    error CapUnavailable();

    function onReleased(address, address) external {}

    function onTimedOut(address, address) external {}

    function onDisputed(address, address) external {}

    function capOf(address) external pure returns (uint128) {
        revert CapUnavailable();
    }
}

contract EscrowTest is Test {
    uint16 internal constant FEE_BPS = 250;
    uint16 internal constant RESOLVER_FEE_BPS = 100;
    uint16 internal constant BOND_BPS = 500;
    uint16 internal constant BPS = 10_000;

    uint64 internal constant MIN_TTL = 1 hours;
    uint64 internal constant MAX_TTL = 30 days;
    uint64 internal constant DISPUTE_WINDOW = 1 days;

    /// The deployment's floor, one cent of USDG.
    uint128 internal constant MIN_LOCK = 10_000;

    /// A cap that never binds, so a lifecycle test never has to think about the curve. The
    /// tests that make the cap the subject deploy their own curve.
    uint128 internal constant OPEN_CAP = type(uint128).max;

    uint128 internal constant AMOUNT = 1_000e6;
    bytes32 internal constant CAP_ID = keccak256("inference.completion");
    bytes32 internal constant INPUT_COMMIT = keccak256("input");
    bytes32 internal constant OUTPUT_COMMIT = keccak256("output");

    /// The legs of one ruling, held together so the conservation assertion can name each of them.
    struct ResolveCase {
        uint256 id;
        uint128 bond;
        uint256 payerBefore;
        uint256 payeeBefore;
        uint256 refunded;
        uint256 paid;
        uint256 protocolFee;
        uint256 resolverFee;
        uint256 bondBack;
        uint256 payerLeg;
        uint256 payeeLeg;
        uint256 resolverLeg;
        uint256 feeLeg;
    }

    DualViewERC20 internal asset;
    Reputation internal reputation;
    Escrow internal escrow;
    EscrowResolverStub internal resolverStub;

    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");
    address internal admin = makeAddr("admin");

    function setUp() public {
        // Away from the epoch, so subtracting a window from `block.timestamp` in a test does
        // not underflow.
        vm.warp(1_780_000_000);

        asset = new DualViewERC20();
        asset.mint(payer, 1e24);
        asset.mint(payee, 1e24);
        asset.mint(stranger, 1e24);

        (escrow, reputation, resolverStub) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, DISPUTE_WINDOW);
    }

    function test_constructor_recordsTheConfigurationItWasGiven() public view {
        assertEq(escrow.settlementAsset(), address(asset));
        assertEq(escrow.reputation(), address(reputation));
        assertEq(escrow.treasury(), treasury);
        assertEq(escrow.deployer(), address(this));
        assertEq(escrow.feeBps(), FEE_BPS);
        assertEq(escrow.resolverFeeBps(), RESOLVER_FEE_BPS);
        assertEq(escrow.disputeBondBps(), BOND_BPS);
        assertEq(escrow.minTtl(), MIN_TTL);
        assertEq(escrow.maxTtl(), MAX_TTL);
        assertEq(escrow.disputeWindow(), DISPUTE_WINDOW);
        assertEq(escrow.minLock(), MIN_LOCK);
        assertEq(escrow.nextId(), 1);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(address(escrow.registry()), address(0));
    }

    function test_constructor_rejectsAZeroSettlementAsset() public {
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        new Escrow(
            address(0),
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

    function test_constructor_rejectsAZeroReputationAddress() public {
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        new Escrow(
            address(asset),
            address(0),
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

    function test_constructor_rejectsAZeroTreasury() public {
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        new Escrow(
            address(asset),
            address(reputation),
            address(0),
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            MIN_LOCK
        );
    }

    function test_constructor_acceptsATenPercentFeeAndRejectsOneUnitMore() public {
        Escrow atCeiling = _escrowWith(address(asset), address(reputation), 1_000, 1_000, BOND_BPS, DISPUTE_WINDOW);
        assertEq(atCeiling.feeBps(), 1_000);
        assertEq(atCeiling.resolverFeeBps(), 1_000);

        vm.expectRevert(IEscrow.BadFee.selector);
        _escrowWith(address(asset), address(reputation), 1_001, 1_000, BOND_BPS, DISPUTE_WINDOW);

        vm.expectRevert(IEscrow.BadFee.selector);
        _escrowWith(address(asset), address(reputation), 1_000, 1_001, BOND_BPS, DISPUTE_WINDOW);
    }

    function test_constructor_acceptsATwentyPercentBondAndRejectsOneUnitMore() public {
        Escrow atCeiling = _escrowWith(address(asset), address(reputation), FEE_BPS, RESOLVER_FEE_BPS, 2_000, 0);
        assertEq(atCeiling.disputeBondBps(), 2_000);

        vm.expectRevert(IEscrow.BadBond.selector);
        _escrowWith(address(asset), address(reputation), FEE_BPS, RESOLVER_FEE_BPS, 2_001, 0);
    }

    function test_constructor_rejectsATtlBandNoDeadlineCouldSatisfy() public {
        vm.expectRevert(IEscrow.BadTtl.selector);
        new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            MIN_TTL,
            MIN_TTL + 1,
            DISPUTE_WINDOW,
            MIN_LOCK
        );

        Escrow narrowest = new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            MIN_TTL,
            MIN_TTL + 2,
            DISPUTE_WINDOW,
            MIN_LOCK
        );
        assertEq(narrowest.maxTtl(), MIN_TTL + 2);
    }

    function test_constructor_rejectsAMinimumLockWhoseBondRoundsToZero() public {
        // At five percent the smallest lock that carries a bond of one unit is twenty units.
        vm.expectRevert(IEscrow.BadMinLock.selector);
        _escrowWithMinLock(BOND_BPS, 19);
        assertEq(_escrowWithMinLock(BOND_BPS, 20).minLock(), 20);

        // With no bond to protect, the floor only has to be above zero.
        vm.expectRevert(IEscrow.BadMinLock.selector);
        _escrowWithMinLock(0, 0);
        assertEq(_escrowWithMinLock(0, 1).minLock(), 1);
    }

    function test_constructor_acceptsAZeroDisputeWindow() public {
        (Escrow instant,,) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        assertEq(instant.disputeWindow(), 0);
    }

    function test_lock_pullsExactlyTheAmountAndOpensTheEntry() public {
        uint64 deadline = _deadline();
        uint256 payerBefore = asset.balanceOf(payer);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.Locked(1, payer, payee, CAP_ID, AMOUNT, deadline);

        vm.prank(payer);
        uint256 id = escrow.lock(payee, CAP_ID, INPUT_COMMIT, "ipfs://input", AMOUNT, deadline);

        assertEq(id, 1);
        assertEq(escrow.nextId(), 2);
        assertEq(asset.balanceOf(payer), payerBefore - AMOUNT);
        assertEq(asset.balanceOf(address(escrow)), AMOUNT);
        assertEq(escrow.feesAccrued(), 0);

        IEscrow.Lock memory entry = escrow.getLock(id);
        assertEq(entry.payer, payer);
        assertEq(entry.payee, payee);
        assertEq(entry.disputer, address(0));
        assertEq(entry.capabilityId, CAP_ID);
        assertEq(entry.inputCommit, INPUT_COMMIT);
        assertEq(entry.inputURI, "ipfs://input");
        assertEq(entry.amount, AMOUNT);
        assertEq(entry.deadline, deadline);
        assertEq(entry.releasedAt, 0);
        assertEq(entry.bond, 0);
        assertFalse(entry.counted);
        _assertStatus(id, IEscrow.LockStatus.Locked);
    }

    function test_lock_numbersEntriesFromOneWithoutReuse() public {
        assertEq(_lock(AMOUNT), 1);
        assertEq(_lock(AMOUNT), 2);

        _cancel(escrow, 2);

        assertEq(_lock(AMOUNT), 3);
    }

    function test_lock_rejectsAZeroPayee() public {
        vm.prank(payer);
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        escrow.lock(address(0), CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());
    }

    function test_lock_rejectsTheEscrowItselfAsPayee() public {
        vm.prank(payer);
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        escrow.lock(address(escrow), CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());
    }

    function test_lock_rejectsAZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(IEscrow.ZeroAmount.selector);
        escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", 0, _deadline());
    }

    function test_lock_rejectsADeadlineAtTheMinimumTtlAndAdmitsOneSecondPastIt() public {
        vm.prank(payer);
        vm.expectRevert(IEscrow.BadTtl.selector);
        escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, uint64(block.timestamp + MIN_TTL));

        vm.prank(payer);
        uint256 id = escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, uint64(block.timestamp + MIN_TTL + 1));
        assertEq(id, 1);
    }

    function test_lock_rejectsADeadlineAtTheMaximumTtlAndAdmitsOneSecondShortOfIt() public {
        vm.prank(payer);
        vm.expectRevert(IEscrow.BadTtl.selector);
        escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, uint64(block.timestamp + MAX_TTL));

        vm.prank(payer);
        uint256 id = escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, uint64(block.timestamp + MAX_TTL - 1));
        assertEq(id, 1);
    }

    function test_lock_rejectsADeadlineAlreadyInThePast() public {
        vm.prank(payer);
        vm.expectRevert(IEscrow.BadTtl.selector);
        escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, uint64(block.timestamp - 1));
    }

    function test_lock_admitsThePayeeCapExactlyAndRefusesOneUnitAboveIt() public {
        (Escrow capped,,) = _deploySetWithCurve(
            IReputation.CapCurve({baseCap: 100e6, capPerScore: 1e6, maxCap: 200e6}),
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            0
        );

        vm.prank(payer);
        vm.expectRevert(IEscrow.PayeeCapExceeded.selector);
        capped.lock(payee, CAP_ID, INPUT_COMMIT, "", 100e6 + 1, _deadline());

        uint256 id = _lock(capped, payer, payee, 100e6);
        assertEq(capped.getLock(id).amount, 100e6);
    }

    function test_lock_capRisesWithThePayeesSettlementHistory() public {
        (Escrow capped, Reputation rep,) = _deploySetWithCurve(
            IReputation.CapCurve({baseCap: 100e6, capPerScore: 1e6, maxCap: 200e6}),
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            0
        );

        assertEq(rep.capOf(payee), 100e6);

        _release(capped, _lock(capped, payer, payee, 100e6));

        // One settled job out of one gives the full score, so the cap is the base plus the
        // whole slope.
        assertEq(rep.score(payee), 100);
        assertEq(rep.capOf(payee), 200e6);

        vm.prank(payer);
        vm.expectRevert(IEscrow.PayeeCapExceeded.selector);
        capped.lock(payee, CAP_ID, INPUT_COMMIT, "", 200e6 + 1, _deadline());

        uint256 id = _lock(capped, payer, payee, 200e6);
        assertEq(capped.getLock(id).amount, 200e6);
    }

    function test_lock_fallsClosedWhenTheCapCannotBeRead() public {
        EscrowCapStub silent = new EscrowCapStub();
        Escrow blind = _escrowWith(address(asset), address(silent), FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        _approveToken(asset, address(blind));

        vm.prank(payer);
        vm.expectRevert(EscrowCapStub.CapUnavailable.selector);
        blind.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());
    }

    function test_lock_admitsAnyPayeeWhileNoRegistryIsWired() public {
        assertEq(address(escrow.registry()), address(0));

        uint256 id = _lock(AMOUNT);
        assertEq(escrow.getLock(id).payee, payee);
    }

    function test_lock_refusesAPayeeTheRegistryHasBarred() public {
        (Escrow gated,,) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, DISPUTE_WINDOW);
        EscrowGateStub gate = new EscrowGateStub();
        gated.setRegistry(IAgentRegistry(address(gate)));

        gate.admit(payee);
        assertEq(_lock(gated, payer, payee, AMOUNT), 1);

        gate.setBlacklisted(payee, true);

        vm.prank(payer);
        vm.expectRevert(IEscrow.PartyNotAllowed.selector);
        gated.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());
    }

    function test_lock_refusesAPayeeTheRegistryDoesNotCallActive() public {
        (Escrow gated,,) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, DISPUTE_WINDOW);
        EscrowGateStub gate = new EscrowGateStub();
        gated.setRegistry(IAgentRegistry(address(gate)));

        vm.prank(payer);
        vm.expectRevert(IEscrow.PartyNotAllowed.selector);
        gated.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());

        gate.admit(payee);
        assertEq(_lock(gated, payer, payee, AMOUNT), 1);
    }

    function test_lock_gateReadsTheRealRegistryAndFollowsItOutOfTheActiveSet() public {
        AgentRegistry registry = new AgentRegistry(IERC20(address(asset)), admin, treasury, 100e6, 500);
        (Escrow gated,,) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, DISPUTE_WINDOW);
        gated.setRegistry(IAgentRegistry(address(registry)));

        vm.startPrank(payee);
        asset.approve(address(registry), type(uint256).max);
        registry.register("settlement_payee", 100e6);
        vm.stopPrank();

        assertTrue(registry.isActive(payee));
        assertEq(_lock(gated, payer, payee, AMOUNT), 1);

        vm.prank(payee);
        registry.deactivate();

        vm.prank(payer);
        vm.expectRevert(IEscrow.PartyNotAllowed.selector);
        gated.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());
    }

    function test_setRegistry_isDeployerOnlyAndFiresOnce() public {
        (Escrow gated,,) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, DISPUTE_WINDOW);
        EscrowGateStub gate = new EscrowGateStub();

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotDeployer.selector);
        gated.setRegistry(IAgentRegistry(address(gate)));

        vm.expectRevert(IEscrow.ZeroAddress.selector);
        gated.setRegistry(IAgentRegistry(address(0)));

        vm.expectEmit(true, true, true, true, address(gated));
        emit IEscrow.RegistrySet(address(gate));
        gated.setRegistry(IAgentRegistry(address(gate)));

        EscrowGateStub replacement = new EscrowGateStub();
        vm.expectRevert(IEscrow.AlreadySet.selector);
        gated.setRegistry(IAgentRegistry(address(replacement)));
    }

    function test_setResolver_isDeployerOnlyAndFiresOnce() public {
        Escrow unpaired = _escrowWith(address(asset), address(reputation), FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        EscrowResolverStub stub = new EscrowResolverStub();

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotDeployer.selector);
        unpaired.setResolver(address(stub));

        vm.expectRevert(IEscrow.ZeroAddress.selector);
        unpaired.setResolver(address(0));

        vm.expectEmit(true, true, true, true, address(unpaired));
        emit IEscrow.ResolverSet(address(stub));
        unpaired.setResolver(address(stub));

        EscrowResolverStub replacement = new EscrowResolverStub();
        vm.expectRevert(IEscrow.AlreadySet.selector);
        unpaired.setResolver(address(replacement));
    }

    function test_release_paysThePayeeNetOfTheProtocolFee() public {
        uint256 id = _lock(AMOUNT);
        uint256 payeeBefore = asset.balanceOf(payee);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.Released(id, OUTPUT_COMMIT);

        vm.prank(payee);
        escrow.release(id, OUTPUT_COMMIT, "ipfs://output");

        // 1000 USDG at 250 bps leaves the payee 975 and the treasury 25.
        assertEq(asset.balanceOf(payee) - payeeBefore, 975e6);
        assertEq(escrow.feesAccrued(), 25e6);
        assertEq(asset.balanceOf(address(escrow)), 25e6);

        IEscrow.Lock memory entry = escrow.getLock(id);
        assertEq(entry.outputCommit, OUTPUT_COMMIT);
        assertEq(entry.outputURI, "ipfs://output");
        assertEq(entry.releasedAt, uint64(block.timestamp));
        _assertStatus(id, IEscrow.LockStatus.Released);
    }

    function test_release_conservesTheLockedAmountBetweenPayeeAndTreasury() public {
        uint256 id = _lock(AMOUNT);
        uint256 payeeBefore = asset.balanceOf(payee);

        _release(escrow, id);

        uint256 paid = asset.balanceOf(payee) - payeeBefore;
        assertEq(paid + escrow.feesAccrued(), AMOUNT);
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued());
    }

    function test_release_isThePayeesCallAlone() public {
        uint256 id = _lock(AMOUNT);

        vm.prank(payer);
        vm.expectRevert(IEscrow.NotPayee.selector);
        escrow.release(id, OUTPUT_COMMIT, "");

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotPayee.selector);
        escrow.release(id, OUTPUT_COMMIT, "");
    }

    function test_release_isAcceptedOnTheDeadlineAndRefusedOneSecondLater() public {
        uint256 early = _lock(AMOUNT);
        uint256 late = _lock(AMOUNT);
        uint64 deadline = escrow.getLock(early).deadline;

        vm.warp(deadline);
        _release(escrow, early);
        _assertStatus(early, IEscrow.LockStatus.Released);

        vm.warp(uint256(deadline) + 1);
        vm.prank(payee);
        vm.expectRevert(IEscrow.TooLate.selector);
        escrow.release(late, OUTPUT_COMMIT, "");
    }

    function test_release_cannotBeReplayed() public {
        uint256 id = _lock(AMOUNT);
        _release(escrow, id);

        vm.prank(payee);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.release(id, OUTPUT_COMMIT, "");
    }

    function test_release_onAnUnknownIdReverts() public {
        vm.prank(payee);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.release(42, OUTPUT_COMMIT, "");
    }

    function test_release_countsReputationInlineWhenThereIsNoDisputeWindow() public {
        (Escrow instant, Reputation rep,) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);

        uint256 id = _lock(instant, payer, payee, AMOUNT);
        _release(instant, id);

        (uint64 released,,) = rep.payeeStats(payee);
        assertEq(released, 1);
        assertTrue(instant.getLock(id).counted);

        // Nothing is left for the finaliser to do, so a second count reverts.
        vm.expectRevert(IEscrow.BadStatus.selector);
        instant.finalizeRelease(id);
    }

    function test_release_defersTheReputationWriteUntilTheDisputeWindowCloses() public {
        uint256 id = _lock(AMOUNT);
        _release(escrow, id);

        (uint64 released,,) = reputation.payeeStats(payee);
        assertEq(released, 0);
        assertFalse(escrow.getLock(id).counted);
    }

    function test_release_stillPaysWhenTheReputationRegistryReverts() public {
        RevertingReputation broken = new RevertingReputation();
        Escrow e = _escrowWith(address(asset), address(broken), FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        _approveToken(asset, address(e));

        uint256 id = _lock(e, payer, payee, AMOUNT);
        uint256 payeeBefore = asset.balanceOf(payee);

        vm.expectEmit(true, true, true, true, address(e));
        emit IEscrow.ReputationCallbackFailed(id);

        _release(e, id);

        assertEq(asset.balanceOf(payee) - payeeBefore, AMOUNT - _bps(AMOUNT, FEE_BPS));
        _assertStatus(e, id, IEscrow.LockStatus.Released);
    }

    function test_finalizeRelease_waitsForTheWindowAndThenCountsOnce() public {
        uint256 id = _lock(AMOUNT);
        _release(escrow, id);
        uint64 releasedAt = escrow.getLock(id).releasedAt;

        vm.warp(uint256(releasedAt) + DISPUTE_WINDOW);
        vm.expectRevert(IEscrow.TooEarly.selector);
        escrow.finalizeRelease(id);

        vm.warp(uint256(releasedAt) + DISPUTE_WINDOW + 1);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.ReleaseFinalized(id);

        // Permissionless: the payee has the standing reason to call it, but nobody has to.
        vm.prank(stranger);
        escrow.finalizeRelease(id);

        (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 1);
        assertEq(timedOut, 0);
        assertEq(disputed, 0);

        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.finalizeRelease(id);
    }

    function test_finalizeRelease_rejectsALockThatWasNeverReleased() public {
        uint256 id = _lock(AMOUNT);

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.finalizeRelease(id);
    }

    function test_finalizeRelease_movesNoMoney() public {
        uint256 id = _lock(AMOUNT);
        _release(escrow, id);

        uint256 payeeBefore = asset.balanceOf(payee);
        uint256 escrowBefore = asset.balanceOf(address(escrow));

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        escrow.finalizeRelease(id);

        assertEq(asset.balanceOf(payee), payeeBefore);
        assertEq(asset.balanceOf(address(escrow)), escrowBefore);
    }

    function test_timeout_refundsThePayerInFullAndChargesNothing() public {
        uint256 id = _lock(AMOUNT);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.warp(uint256(escrow.getLock(id).deadline) + 1);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.TimedOut(id);

        // Permissionless, which is the only reason a payer whose payee has gone quiet is not
        // waiting on that payee to act.
        vm.prank(stranger);
        escrow.timeout(id);

        assertEq(asset.balanceOf(payer) - payerBefore, AMOUNT);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(asset.balanceOf(address(escrow)), 0);

        (uint64 released, uint64 timedOut,) = reputation.payeeStats(payee);
        assertEq(released, 0);
        assertEq(timedOut, 1);
        _assertStatus(id, IEscrow.LockStatus.TimedOut);
    }

    function test_timeout_isRefusedOnTheDeadlineAndAdmittedOneSecondLater() public {
        uint256 id = _lock(AMOUNT);
        uint64 deadline = escrow.getLock(id).deadline;

        vm.warp(deadline);
        vm.expectRevert(IEscrow.TooEarly.selector);
        escrow.timeout(id);

        vm.warp(uint256(deadline) + 1);
        escrow.timeout(id);
        _assertStatus(id, IEscrow.LockStatus.TimedOut);
    }

    function test_timeout_cannotBeReplayed() public {
        uint256 id = _lock(AMOUNT);
        vm.warp(uint256(escrow.getLock(id).deadline) + 1);
        escrow.timeout(id);

        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.timeout(id);
    }

    function test_timeout_cannotTakeALockOutFromUnderALiveDispute() public {
        uint256 id = _lock(AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);

        vm.warp(uint256(escrow.getLock(id).deadline) + 1);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.timeout(id);
    }

    function test_cancel_returnsThePayersFundsWholeAndWritesNoHistory() public {
        uint256 id = _lock(AMOUNT);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.Cancelled(id);

        vm.prank(payee);
        escrow.cancel(id);

        assertEq(asset.balanceOf(payer) - payerBefore, AMOUNT);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(asset.balanceOf(address(escrow)), 0);

        (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released + timedOut + disputed, 0);
        _assertStatus(id, IEscrow.LockStatus.Cancelled);
    }

    function test_cancel_isThePayeesCallAlone() public {
        uint256 id = _lock(AMOUNT);

        vm.prank(payer);
        vm.expectRevert(IEscrow.NotPayee.selector);
        escrow.cancel(id);
    }

    function test_cancel_isRefusedOnceTheDeadlineHasPassed() public {
        uint256 id = _lock(AMOUNT);
        vm.warp(uint256(escrow.getLock(id).deadline) + 1);

        vm.prank(payee);
        vm.expectRevert(IEscrow.TooLate.selector);
        escrow.cancel(id);
    }

    function test_cancel_cannotBeReplayed() public {
        uint256 id = _lock(AMOUNT);
        _cancel(escrow, id);

        vm.prank(payee);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.cancel(id);
    }

    function test_dispute_onAnOpenLockPostsTheBondAndFreezesTheFunds() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.DisputeBonded(id, payer, bond);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.Disputed(id, payer);

        vm.prank(payer);
        escrow.dispute(id);

        assertEq(payerBefore - asset.balanceOf(payer), bond);
        assertEq(asset.balanceOf(address(escrow)), uint256(AMOUNT) + bond);
        assertEq(resolverStub.opened(), 1);
        assertEq(resolverStub.disputeIdOf(id), 1);

        IEscrow.Lock memory entry = escrow.getLock(id);
        assertEq(entry.disputer, payer);
        assertEq(entry.bond, bond);
        assertEq(entry.disputedAt, uint64(block.timestamp));
        assertFalse(entry.counted);
        _assertStatus(id, IEscrow.LockStatus.Disputed);
    }

    function test_dispute_onAnOpenLockIsOpenToThePayeeToo() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);
        uint256 payeeBefore = asset.balanceOf(payee);

        vm.prank(payee);
        escrow.dispute(id);

        assertEq(payeeBefore - asset.balanceOf(payee), bond);
        assertEq(escrow.getLock(id).disputer, payee);
    }

    function test_dispute_onAnOpenLockIsClosedToEveryoneElse() public {
        uint256 id = _lock(AMOUNT);

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotParty.selector);
        escrow.dispute(id);
    }

    function test_dispute_isRefusedWhileNoResolverCanHearIt() public {
        Escrow unpaired = _escrowWith(address(asset), address(reputation), FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        _approveToken(asset, address(unpaired));
        uint256 id = _lock(unpaired, payer, payee, AMOUNT);

        vm.prank(payer);
        vm.expectRevert(IEscrow.NotResolver.selector);
        unpaired.dispute(id);
    }

    function test_dispute_takesNoBondWhenTheRateIsZero() public {
        (Escrow unbonded,, EscrowResolverStub stub) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, 0, DISPUTE_WINDOW);
        uint256 id = _lock(unbonded, payer, payee, AMOUNT);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.prank(payer);
        unbonded.dispute(id);

        assertEq(asset.balanceOf(payer), payerBefore);
        assertEq(unbonded.getLock(id).bond, 0);
        assertEq(stub.opened(), 1);
    }

    function test_lock_refusesAnAmountBelowTheMinimumAndTheMinimumCarriesABond() public {
        vm.prank(payer);
        vm.expectRevert(IEscrow.BelowMinLock.selector);
        escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", MIN_LOCK - 1, _deadline());

        uint256 id = _lock(MIN_LOCK);
        vm.prank(payer);
        escrow.dispute(id);

        assertEq(escrow.getLock(id).bond, _bps(MIN_LOCK, BOND_BPS));
        assertGt(escrow.getLock(id).bond, 0, "a dispute on the smallest lock cost nothing");
    }

    function test_dispute_onAnOpenLockIsRefusedOnceTheDeadlineHasPassed() public {
        uint256 onTime = _lock(AMOUNT);
        uint256 late = _lock(AMOUNT);
        uint64 deadline = escrow.getLock(late).deadline;

        // On the deadline the payee can still deliver, so the lock can still be contested.
        vm.warp(deadline);
        vm.prank(payer);
        escrow.dispute(onTime);

        vm.warp(uint256(deadline) + 1);
        vm.prank(payee);
        vm.expectRevert(IEscrow.TooLate.selector);
        escrow.dispute(late);
        vm.prank(payer);
        vm.expectRevert(IEscrow.TooLate.selector);
        escrow.dispute(late);

        // Past the deadline the payer is owed a refund, and a dispute cannot trade it away.
        uint256 payerBefore = asset.balanceOf(payer);
        escrow.timeout(late);
        assertEq(asset.balanceOf(payer) - payerBefore, AMOUNT);
        assertEq(resolverStub.opened(), 1);
    }

    function test_dispute_afterAReleaseIsThePayersAloneAndTakesNoBond() public {
        uint256 id = _lock(AMOUNT);
        _release(escrow, id);

        vm.prank(payee);
        vm.expectRevert(IEscrow.NotPayer.selector);
        escrow.dispute(id);

        uint256 payerBefore = asset.balanceOf(payer);
        uint256 escrowBefore = asset.balanceOf(address(escrow));

        vm.prank(payer);
        escrow.dispute(id);

        assertEq(asset.balanceOf(payer), payerBefore);
        assertEq(asset.balanceOf(address(escrow)), escrowBefore);
        assertEq(escrow.getLock(id).bond, 0);
        assertEq(resolverStub.opened(), 0);

        // The complaint replaces the release in the payee's history.
        (uint64 released,, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 0);
        assertEq(disputed, 1);
        assertTrue(escrow.getLock(id).counted);
    }

    function test_dispute_afterAReleaseIsRefusedOnceTheWindowHasClosed() public {
        uint256 onTime = _lock(AMOUNT);
        uint256 late = _lock(AMOUNT);
        _release(escrow, onTime);
        _release(escrow, late);

        uint64 releasedAt = escrow.getLock(onTime).releasedAt;

        vm.warp(uint256(releasedAt) + DISPUTE_WINDOW);
        vm.prank(payer);
        escrow.dispute(onTime);
        _assertStatus(onTime, IEscrow.LockStatus.Disputed);

        vm.warp(uint256(releasedAt) + DISPUTE_WINDOW + 1);
        vm.prank(payer);
        vm.expectRevert(IEscrow.TooLate.selector);
        escrow.dispute(late);
    }

    function test_dispute_afterAReleaseIsImpossibleWithoutAWindow() public {
        (Escrow instant,,) = _deploySet(FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        uint256 id = _lock(instant, payer, payee, AMOUNT);
        _release(instant, id);

        vm.prank(payer);
        vm.expectRevert(IEscrow.TooLate.selector);
        instant.dispute(id);
    }

    function test_dispute_afterAReleaseEndsTheLockWithNoRulingToMake() public {
        uint256 id = _lock(AMOUNT);
        _release(escrow, id);

        vm.prank(payer);
        escrow.dispute(id);

        vm.expectRevert(IEscrow.BadStatus.selector);
        resolverStub.rule(IEscrow(address(escrow)), id, 10_000);

        vm.expectRevert(IEscrow.BadStatus.selector);
        resolverStub.giveBack(IEscrow(address(escrow)), id);

        vm.prank(payer);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.dispute(id);
    }

    function test_dispute_cannotReopenASettledLock() public {
        uint256 cancelled = _lock(AMOUNT);
        _cancel(escrow, cancelled);

        vm.prank(payer);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.dispute(cancelled);

        uint256 timedOut = _lock(AMOUNT);
        vm.warp(uint256(escrow.getLock(timedOut).deadline) + 1);
        escrow.timeout(timedOut);

        vm.prank(payer);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.dispute(timedOut);
    }

    function test_resolve_splitsAContestedLockIntoFourLegsThatAddUp() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);

        vm.prank(payer);
        escrow.dispute(id);

        uint256 payerBefore = asset.balanceOf(payer);
        uint256 payeeBefore = asset.balanceOf(payee);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.BondForfeited(id, payer, bond);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.Resolved(id, 3_000, 297e6, 675_675_000);

        resolverStub.rule(IEscrow(address(escrow)), id, 3_000);

        // 10 off the top for the resolvers, 297 refunded, 17.325 of protocol fee on the
        // payee's 693, and the 50 bond forfeited into the resolver pot.
        assertEq(asset.balanceOf(payer) - payerBefore, 297e6);
        assertEq(asset.balanceOf(payee) - payeeBefore, 675_675_000);
        assertEq(escrow.feesAccrued(), 17_325_000);
        assertEq(asset.balanceOf(address(resolverStub)), 60e6);
        assertEq(resolverStub.rewardCredited(), 60e6);
        assertEq(297e6 + 675_675_000 + 17_325_000 + 10e6 + 50e6, uint256(AMOUNT) + bond);
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued());

        IEscrow.Lock memory entry = escrow.getLock(id);
        assertEq(entry.bond, 0);
        assertTrue(entry.counted);
        _assertStatus(id, IEscrow.LockStatus.Resolved);
    }

    function test_resolve_returnsTheBondWhenTheRulingGoesTheDisputersWay() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);

        vm.prank(payer);
        escrow.dispute(id);

        uint256 payerBefore = asset.balanceOf(payer);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.BondReturned(id, payer, bond);

        resolverStub.rule(IEscrow(address(escrow)), id, 10_000);

        assertEq(asset.balanceOf(payer) - payerBefore, 990e6 + bond);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(asset.balanceOf(address(resolverStub)), 10e6);
        assertEq(asset.balanceOf(address(escrow)), 0);
    }

    function test_resolve_treatsAnEvenSplitAsAWinForThePayerWhoOpenedIt() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);

        vm.prank(payer);
        escrow.dispute(id);
        uint256 payerBefore = asset.balanceOf(payer);

        resolverStub.rule(IEscrow(address(escrow)), id, 5_000);

        assertEq(asset.balanceOf(payer) - payerBefore, 495e6 + bond);
    }

    function test_resolve_forfeitsThePayersBondOneBasisPointShortOfAnEvenSplit() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);

        vm.prank(payer);
        escrow.dispute(id);
        uint256 payerBefore = asset.balanceOf(payer);

        resolverStub.rule(IEscrow(address(escrow)), id, 4_999);

        assertEq(asset.balanceOf(payer) - payerBefore, _bps(990e6, 4_999));
        assertEq(asset.balanceOf(address(resolverStub)), 10e6 + bond);
    }

    function test_resolve_treatsAnEvenSplitAsAWinForThePayeeWhoOpenedIt() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);

        vm.prank(payee);
        escrow.dispute(id);
        uint256 payeeBefore = asset.balanceOf(payee);

        resolverStub.rule(IEscrow(address(escrow)), id, 5_000);

        uint128 awarded = 990e6 - _bps(990e6, 5_000);
        assertEq(asset.balanceOf(payee) - payeeBefore, uint256(awarded) - _bps(awarded, FEE_BPS) + bond);
    }

    function test_resolve_forfeitsThePayeesBondOneBasisPointPastAnEvenSplit() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);

        vm.prank(payee);
        escrow.dispute(id);
        uint256 payeeBefore = asset.balanceOf(payee);

        resolverStub.rule(IEscrow(address(escrow)), id, 5_001);

        uint128 awarded = 990e6 - _bps(990e6, 5_001);
        assertEq(asset.balanceOf(payee) - payeeBefore, uint256(awarded) - _bps(awarded, FEE_BPS));
        assertEq(asset.balanceOf(address(resolverStub)), 10e6 + bond);
    }

    function test_resolve_recordsAFullAwardToThePayeeAsARelease() public {
        uint256 id = _lock(AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);
        resolverStub.rule(IEscrow(address(escrow)), id, 0);

        (uint64 released,, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 1);
        assertEq(disputed, 0);
    }

    function test_resolve_recordsAnyRefundAgainstThePayee() public {
        uint256 id = _lock(AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);
        resolverStub.rule(IEscrow(address(escrow)), id, 1);

        (uint64 released,, uint64 disputed) = reputation.payeeStats(payee);
        assertEq(released, 0);
        assertEq(disputed, 1);
    }

    function test_resolve_isTheResolversCallAlone() public {
        uint256 id = _lock(AMOUNT);
        vm.prank(payer);
        escrow.dispute(id);

        vm.prank(payer);
        vm.expectRevert(IEscrow.NotResolver.selector);
        escrow.resolve(id, 0, 1);

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotResolver.selector);
        escrow.resolve(id, 10_000, 1);
    }

    function test_resolve_rejectsARefundShareAboveOneHundredPercent() public {
        uint256 id = _lock(AMOUNT);
        vm.prank(payer);
        escrow.dispute(id);

        vm.expectRevert(IEscrow.BadRefund.selector);
        resolverStub.rule(IEscrow(address(escrow)), id, 10_001);

        resolverStub.rule(IEscrow(address(escrow)), id, 10_000);
        _assertStatus(id, IEscrow.LockStatus.Resolved);
    }

    function test_resolve_rejectsALockNobodyContested() public {
        uint256 id = _lock(AMOUNT);

        vm.expectRevert(IEscrow.BadStatus.selector);
        resolverStub.rule(IEscrow(address(escrow)), id, 5_000);
    }

    function test_resolve_cannotBeReplayed() public {
        uint256 id = _lock(AMOUNT);
        vm.prank(payer);
        escrow.dispute(id);
        resolverStub.rule(IEscrow(address(escrow)), id, 2_500);

        vm.expectRevert(IEscrow.BadStatus.selector);
        resolverStub.rule(IEscrow(address(escrow)), id, 2_500);
    }

    function test_resolve_settlesEvenWhenTheResolverRefusesToBookItsReward() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);

        vm.prank(payer);
        escrow.dispute(id);

        resolverStub.setRefuseNotify(true);

        uint256 payerBefore = asset.balanceOf(payer);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.ResolverRewardUncredited(id, 1, 10e6 + bond);

        resolverStub.rule(IEscrow(address(escrow)), id, 0);

        // The fee left the escrow either way, so the conservation identity holds on the
        // branch where the registry refused the booking call.
        assertEq(asset.balanceOf(address(resolverStub)), 10e6 + bond);
        assertEq(resolverStub.rewardCredited(), 0);
        assertEq(asset.balanceOf(payer), payerBefore);
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued());
        _assertStatus(id, IEscrow.LockStatus.Resolved);
    }

    function test_resolve_paysNoResolverRewardWhenThereIsNothingToPay() public {
        (Escrow free,, EscrowResolverStub stub) = _deploySet(0, 0, 0, DISPUTE_WINDOW);
        uint256 id = _lock(free, payer, payee, AMOUNT);

        vm.prank(payer);
        free.dispute(id);

        uint256 payerBefore = asset.balanceOf(payer);
        stub.rule(IEscrow(address(free)), id, 10_000);

        assertEq(asset.balanceOf(payer) - payerBefore, AMOUNT);
        assertEq(asset.balanceOf(address(stub)), 0);
        assertEq(stub.rewardCredited(), 0);
        assertEq(asset.balanceOf(address(free)), 0);
    }

    function test_timeout_booksARefundTheAssetRefusesAndAnyoneCanDeliverItLater() public {
        uint256 id = _lock(AMOUNT);
        asset.setFrozen(payer, true);
        vm.warp(uint256(escrow.getLock(id).deadline) + 1);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.PaymentOwed(payer, AMOUNT);
        escrow.timeout(id);

        _assertStatus(id, IEscrow.LockStatus.TimedOut);
        assertEq(escrow.owed(payer), AMOUNT);
        assertEq(asset.balanceOf(address(escrow)), AMOUNT, "the refund stayed, booked to the payer");

        // Still frozen, so the claim fails and the booking stands.
        vm.expectRevert(abi.encodeWithSelector(MockUsdg.AccountFrozen.selector, payer));
        escrow.claim(payer);
        assertEq(escrow.owed(payer), AMOUNT);

        asset.setFrozen(payer, false);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.OwedClaimed(payer, AMOUNT);
        vm.prank(stranger);
        assertEq(escrow.claim(payer), AMOUNT);

        assertEq(asset.balanceOf(payer) - payerBefore, AMOUNT, "the claim paid the party, not the caller");
        assertEq(escrow.owed(payer), 0);
        assertEq(asset.balanceOf(address(escrow)), 0);

        vm.expectRevert(IEscrow.ZeroAmount.selector);
        escrow.claim(payer);
    }

    function test_cancel_booksTheRefundOfAFrozenPayer() public {
        uint256 id = _lock(AMOUNT);
        asset.setFrozen(payer, true);

        vm.prank(payee);
        escrow.cancel(id);

        _assertStatus(id, IEscrow.LockStatus.Cancelled);
        assertEq(escrow.owed(payer), AMOUNT);
        assertEq(asset.balanceOf(address(escrow)), AMOUNT);
    }

    function test_resolve_booksOnlyTheLegTheAssetRefuses() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);
        vm.prank(payer);
        escrow.dispute(id);

        asset.setFrozen(payee, true);
        uint256 payerBefore = asset.balanceOf(payer);
        resolverStub.rule(IEscrow(address(escrow)), id, 5_000);

        (uint256 refunded, uint256 paid,, uint256 resolverFee) = _expectedSplit(AMOUNT, 5_000);
        _assertStatus(id, IEscrow.LockStatus.Resolved);
        assertEq(asset.balanceOf(payer) - payerBefore, refunded + bond, "the payer's leg and its bond still landed");
        assertEq(escrow.owed(payee), paid, "the frozen payee's leg was booked");
        assertEq(asset.balanceOf(address(resolverStub)), resolverFee);
        assertEq(asset.balanceOf(address(escrow)), paid + escrow.feesAccrued());
    }

    function test_reopen_booksTheBondOfAFrozenDisputer() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);
        vm.prank(payee);
        escrow.dispute(id);

        asset.setFrozen(payee, true);
        resolverStub.giveBack(IEscrow(address(escrow)), id);

        _assertStatus(id, IEscrow.LockStatus.Locked);
        assertEq(escrow.owed(payee), bond);
        assertEq(asset.balanceOf(address(escrow)), uint256(AMOUNT) + bond);
    }

    function test_resolve_booksTheRewardOfAFrozenResolverAndDoesNotAnnounceIt() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);
        vm.prank(payer);
        escrow.dispute(id);

        asset.setFrozen(address(resolverStub), true);
        (,,, uint256 resolverFee) = _expectedSplit(AMOUNT, 0);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.ResolverRewardUncredited(id, 1, uint128(resolverFee) + bond);
        resolverStub.rule(IEscrow(address(escrow)), id, 0);

        _assertStatus(id, IEscrow.LockStatus.Resolved);
        assertEq(escrow.owed(address(resolverStub)), resolverFee + bond);
        assertEq(resolverStub.rewardCredited(), 0, "the registry was told of a reward that never arrived");
    }

    /// A transfer that failed for want of gas is the caller's doing. Every gas limit either
    /// pays the payer or reverts whole, and none of them leaves an IOU behind.
    function test_noGasLimitTurnsARefundIntoAnIou() public {
        uint256 id = _lock(AMOUNT);
        vm.warp(uint256(escrow.getLock(id).deadline) + 1);
        uint256 payerBefore = asset.balanceOf(payer);

        for (uint256 gas = 30_000; gas <= 200_000; gas += 1_000) {
            uint256 snapshot = vm.snapshotState();

            (bool ok,) = address(escrow).call{gas: gas}(abi.encodeCall(Escrow.timeout, (id)));
            assertEq(escrow.owed(payer), 0, "a starved transfer was booked as owed");
            if (ok) assertEq(asset.balanceOf(payer) - payerBefore, AMOUNT);

            vm.revertToState(snapshot);
        }
    }

    function test_aPayeeThatPaysItselfEarnsNoHistory() public {
        vm.prank(payee);
        vm.expectRevert(IEscrow.BelowMinLock.selector);
        escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", 1, _deadline());

        uint256 released = _lock(escrow, payee, payee, MIN_LOCK);
        _release(escrow, released);
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        escrow.finalizeRelease(released);

        uint256 timedOut = _lock(escrow, payee, payee, MIN_LOCK);
        vm.warp(uint256(escrow.getLock(timedOut).deadline) + 1);
        escrow.timeout(timedOut);

        (uint64 releasedCount, uint64 timedOutCount, uint64 disputedCount) = reputation.payeeStats(payee);
        assertEq(uint256(releasedCount) + timedOutCount + disputedCount, 0, "a self-lock moved a counter");
        assertEq(reputation.score(payee), 0);
        assertTrue(escrow.getLock(released).counted);
        assertTrue(escrow.getLock(timedOut).counted);
    }

    function test_sweepFees_paysTheTreasuryOnlyWhatSettlementsAccrued() public {
        uint256 id = _lock(AMOUNT);
        _release(escrow, id);

        uint128 fees = escrow.feesAccrued();
        assertEq(fees, 25e6);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEscrow.FeesSwept(treasury, fees);

        // Permissionless, so the treasury never needs a hot key to be paid.
        vm.prank(stranger);
        uint128 swept = escrow.sweepFees();

        assertEq(swept, fees);
        assertEq(asset.balanceOf(treasury), fees);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(asset.balanceOf(address(escrow)), 0);

        vm.expectRevert(IEscrow.ZeroAmount.selector);
        escrow.sweepFees();
    }

    function test_sweepFees_cannotReachALiveLock() public {
        uint256 live = _lock(AMOUNT);
        uint256 settled = _lock(AMOUNT);
        _release(escrow, settled);

        uint128 fees = escrow.feesAccrued();
        escrow.sweepFees();

        assertEq(asset.balanceOf(treasury), fees);
        assertEq(asset.balanceOf(address(escrow)), AMOUNT);

        // The principal the sweep could not touch is still there to pay the payee with.
        uint256 payeeBefore = asset.balanceOf(payee);
        _release(escrow, live);
        assertEq(asset.balanceOf(payee) - payeeBefore, AMOUNT - fees);
    }

    function test_sweepFees_cannotReachAPostedBond() public {
        uint256 id = _lock(AMOUNT);
        uint128 bond = _bps(AMOUNT, BOND_BPS);

        vm.prank(payer);
        escrow.dispute(id);

        vm.expectRevert(IEscrow.ZeroAmount.selector);
        escrow.sweepFees();

        assertEq(asset.balanceOf(address(escrow)), uint256(AMOUNT) + bond);
    }

    function test_sweepFees_ignoresTokensSentToTheEscrowByHand() public {
        uint256 id = _lock(AMOUNT);
        _release(escrow, id);

        vm.prank(stranger);
        asset.transfer(address(escrow), 500e6);

        uint128 fees = escrow.feesAccrued();
        uint128 swept = escrow.sweepFees();

        // The ledger decides what leaves, so the donation stays where it landed.
        assertEq(swept, fees);
        assertEq(asset.balanceOf(treasury), fees);
        assertEq(asset.balanceOf(address(escrow)), 500e6);
    }

    function test_treasuryHandoverTakesTwoSteps() public {
        address next = makeAddr("nextTreasury");

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotTreasury.selector);
        escrow.transferTreasury(next);

        vm.prank(treasury);
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        escrow.transferTreasury(address(0));

        vm.prank(treasury);
        escrow.transferTreasury(next);
        assertEq(escrow.pendingTreasury(), next);
        assertEq(escrow.treasury(), treasury);

        vm.prank(stranger);
        vm.expectRevert(IEscrow.NotPendingTreasury.selector);
        escrow.acceptTreasury();

        vm.prank(next);
        escrow.acceptTreasury();
        assertEq(escrow.treasury(), next);
        assertEq(escrow.pendingTreasury(), address(0));

        uint256 id = _lock(AMOUNT);
        _release(escrow, id);
        escrow.sweepFees();
        assertEq(asset.balanceOf(next), 25e6);
        assertEq(asset.balanceOf(treasury), 0);
    }

    /// A consumer holds an `IEscrow`. The fee surface has to be reachable through it, or every
    /// integration that wants to read what is owed, push it to the treasury, or hand the treasury
    /// over has to drop to the concrete type and take the whole contract with it.
    function test_theFeeSurfaceIsReachableThroughTheInterface() public {
        IEscrow held = IEscrow(address(escrow));

        uint256 id = _lock(AMOUNT);
        _release(escrow, id);

        assertEq(held.feesAccrued(), 25e6);
        assertEq(held.treasury(), treasury);
        assertEq(held.pendingTreasury(), address(0));

        address next = makeAddr("interfaceTreasury");
        vm.prank(treasury);
        held.transferTreasury(next);
        assertEq(held.pendingTreasury(), next);

        vm.prank(next);
        held.acceptTreasury();
        assertEq(held.treasury(), next);

        assertEq(held.sweepFees(), 25e6);
        assertEq(asset.balanceOf(next), 25e6);
        assertEq(held.feesAccrued(), 0);
    }

    function test_aReentrantTokenCannotReleaseALockItIsStillFunding() public {
        (Escrow e, ReentrantERC20 token) = _reentrantSet();

        string memory uri = "ipfs://output";
        token.arm(address(e), abi.encodeCall(IEscrow.release, (1, OUTPUT_COMMIT, uri)));

        uint256 payeeBefore = token.balanceOf(payee);

        vm.prank(payer);
        uint256 id = e.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());

        assertEq(id, 1);
        assertFalse(token.callbackSucceeded());
        assertTrue(
            token.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "the guard, not the token, rejected the reentrant call"
        );
        assertEq(token.balanceOf(payee), payeeBefore, "the reentrant release paid nobody");
        assertEq(token.balanceOf(address(e)), AMOUNT);
        assertEq(uint256(e.getLock(id).status), uint256(IEscrow.LockStatus.Locked));
    }

    function test_aReentrantTokenCannotOpenASecondLockDuringAPayout() public {
        (Escrow e, ReentrantERC20 token) = _reentrantSet();

        vm.prank(payer);
        uint256 id = e.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());

        string memory input = "";
        token.arm(address(e), abi.encodeCall(IEscrow.lock, (payee, CAP_ID, INPUT_COMMIT, input, AMOUNT, _deadline())));

        vm.prank(payee);
        e.release(id, OUTPUT_COMMIT, "ipfs://output");

        assertFalse(token.callbackSucceeded());
        assertTrue(
            token.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "the guard, not the token, rejected the reentrant call"
        );
        assertEq(e.nextId(), 2);
        assertEq(token.balanceOf(address(e)), _bps(AMOUNT, FEE_BPS));
    }

    function test_aShortPullingTokenCannotOpenALock() public {
        FeeOnTransferERC20 token = new FeeOnTransferERC20();
        token.mint(payer, 1e24);

        Escrow e = _escrowWith(address(token), address(new MockReputation()), FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        vm.prank(payer);
        token.approve(address(e), type(uint256).max);

        vm.prank(payer);
        vm.expectRevert(IEscrow.TransferMismatch.selector);
        e.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());

        assertEq(token.balanceOf(address(e)), 0);
        assertEq(e.nextId(), 1);
    }

    function test_anOverCreditingTokenCannotOpenALock() public {
        InflatingERC20 token = new InflatingERC20();
        token.mint(payer, 1e24);

        Escrow e = _escrowWith(address(token), address(new MockReputation()), FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        vm.prank(payer);
        token.approve(address(e), type(uint256).max);

        vm.prank(payer);
        vm.expectRevert(IEscrow.TransferMismatch.selector);
        e.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());
    }

    function test_aTokenThatCanTakeTheBalanceBackCannotOpenALock() public {
        ShrinkingERC20 token = new ShrinkingERC20();
        token.mint(payer, 1e24);

        Escrow e = _escrowWith(address(token), address(new MockReputation()), FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        vm.prank(payer);
        token.approve(address(e), type(uint256).max);

        vm.prank(payer);
        e.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());
        assertEq(token.balanceOf(address(e)), AMOUNT);

        token.arm(address(e));

        vm.prank(payer);
        vm.expectRevert(IEscrow.TransferMismatch.selector);
        e.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, _deadline());
    }

    function test_aForcedNativeBalanceChangesNothingTheEscrowPays() public {
        uint256 id = _lock(AMOUNT);

        // A settlement asset that publishes the same balance again, scaled up by 1e12.
        assertEq(asset.nativeBalanceOf(address(escrow)), uint256(AMOUNT) * asset.NATIVE_DECIMAL_SCALE());

        vm.deal(address(escrow), 100 ether);

        uint256 payeeBefore = asset.balanceOf(payee);
        _release(escrow, id);

        assertEq(asset.balanceOf(payee) - payeeBefore, AMOUNT - _bps(AMOUNT, FEE_BPS));
        assertEq(escrow.sweepFees(), _bps(AMOUNT, FEE_BPS));
        assertEq(asset.balanceOf(address(escrow)), 0);
        assertEq(address(escrow).balance, 100 ether);
    }

    function testFuzz_lockAndReleaseConserveTheLockedAmount(uint128 amount) public {
        amount = uint128(bound(amount, MIN_LOCK, 1e18));

        uint256 payerBefore = asset.balanceOf(payer);
        uint256 payeeBefore = asset.balanceOf(payee);

        uint256 id = _lock(amount);
        _release(escrow, id);

        uint256 paid = asset.balanceOf(payee) - payeeBefore;
        uint256 fee = escrow.feesAccrued();

        assertEq(payerBefore - asset.balanceOf(payer), amount);
        assertEq(paid + fee, amount);
        assertEq(asset.balanceOf(address(escrow)), fee);
    }

    function testFuzz_timeoutAndCancelReturnEveryUnit(uint128 amount, bool byTimeout) public {
        amount = uint128(bound(amount, MIN_LOCK, 1e18));

        uint256 payerBefore = asset.balanceOf(payer);
        uint256 id = _lock(amount);

        if (byTimeout) {
            vm.warp(uint256(escrow.getLock(id).deadline) + 1);
            escrow.timeout(id);
        } else {
            _cancel(escrow, id);
        }

        assertEq(asset.balanceOf(payer), payerBefore);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(asset.balanceOf(address(escrow)), 0);
    }

    function testFuzz_resolve_conservesThePrincipalAndTheBond(uint128 amount, uint16 refundBps, bool payerDisputes)
        public
    {
        amount = uint128(bound(amount, MIN_LOCK, 1e18));
        refundBps = uint16(bound(refundBps, 0, 10_000));

        // Carried in one struct because the five legs plus the two snapshots do not fit on
        // the stack alongside the fuzz parameters.
        ResolveCase memory c;
        c.id = _lock(amount);

        vm.prank(payerDisputes ? payer : payee);
        escrow.dispute(c.id);

        c.bond = escrow.getLock(c.id).bond;
        c.payerBefore = asset.balanceOf(payer);
        c.payeeBefore = asset.balanceOf(payee);

        resolverStub.rule(IEscrow(address(escrow)), c.id, refundBps);

        (c.refunded, c.paid, c.protocolFee, c.resolverFee) = _expectedSplit(amount, refundBps);
        c.bondBack = (payerDisputes ? refundBps >= 5_000 : refundBps <= 5_000) ? c.bond : 0;
        c.payerLeg = asset.balanceOf(payer) - c.payerBefore;
        c.payeeLeg = asset.balanceOf(payee) - c.payeeBefore;
        c.resolverLeg = asset.balanceOf(address(resolverStub));
        c.feeLeg = escrow.feesAccrued();

        assertEq(c.payerLeg, c.refunded + (payerDisputes ? c.bondBack : 0), "payer leg");
        assertEq(c.payeeLeg, c.paid + (payerDisputes ? 0 : c.bondBack), "payee leg");
        assertEq(c.resolverLeg, c.resolverFee + (c.bond - c.bondBack), "resolver leg");
        assertEq(c.feeLeg, c.protocolFee, "protocol leg");
        assertEq(c.payerLeg + c.payeeLeg + c.resolverLeg + c.feeLeg, uint256(amount) + c.bond, "conservation");
        assertEq(asset.balanceOf(address(escrow)), c.feeLeg, "escrow keeps only unswept fees");
    }

    function testFuzz_lock_admitsADeadlineOnlyStrictlyInsideTheTtlBand(uint64 offset) public {
        uint256 deadline = bound(uint256(offset), 0, uint256(MAX_TTL) + 2 hours) + block.timestamp;
        bool admissible = deadline > block.timestamp + MIN_TTL && deadline < block.timestamp + MAX_TTL;

        if (!admissible) {
            vm.prank(payer);
            vm.expectRevert(IEscrow.BadTtl.selector);
            escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, uint64(deadline));
            return;
        }

        vm.prank(payer);
        uint256 id = escrow.lock(payee, CAP_ID, INPUT_COMMIT, "", AMOUNT, uint64(deadline));
        assertEq(escrow.getLock(id).deadline, uint64(deadline));
    }

    function testFuzz_sweepFees_leavesEveryLiveLockFullyFunded(uint128 live, uint128 settled) public {
        live = uint128(bound(live, MIN_LOCK, 1e18));
        settled = uint128(bound(settled, MIN_LOCK, 1e18));

        uint256 liveId = _lock(live);
        _release(escrow, _lock(settled));

        uint128 fees = escrow.feesAccrued();
        if (fees == 0) {
            vm.expectRevert(IEscrow.ZeroAmount.selector);
            escrow.sweepFees();
        } else {
            assertEq(escrow.sweepFees(), fees);
        }

        assertEq(asset.balanceOf(address(escrow)), live);
        assertEq(escrow.getLock(liveId).amount, live);

        uint256 payeeBefore = asset.balanceOf(payee);
        _release(escrow, liveId);
        assertEq(asset.balanceOf(payee) - payeeBefore, live - _bps(live, FEE_BPS));
    }

    function _deploySet(uint16 feeBps_, uint16 resolverFeeBps_, uint16 bondBps_, uint64 disputeWindow_)
        private
        returns (Escrow e, Reputation rep, EscrowResolverStub stub)
    {
        return _deploySetWithCurve(
            IReputation.CapCurve({baseCap: OPEN_CAP, capPerScore: 0, maxCap: OPEN_CAP}),
            feeBps_,
            resolverFeeBps_,
            bondBps_,
            disputeWindow_
        );
    }

    function _deploySetWithCurve(
        IReputation.CapCurve memory curve_,
        uint16 feeBps_,
        uint16 resolverFeeBps_,
        uint16 bondBps_,
        uint64 disputeWindow_
    ) private returns (Escrow e, Reputation rep, EscrowResolverStub stub) {
        rep = new Reputation(admin, curve_);
        e = _escrowWith(address(asset), address(rep), feeBps_, resolverFeeBps_, bondBps_, disputeWindow_);
        rep.setEscrow(address(e));

        stub = new EscrowResolverStub();
        e.setResolver(address(stub));

        _approveToken(asset, address(e));
    }

    function _escrowWith(
        address asset_,
        address reputation_,
        uint16 feeBps_,
        uint16 resolverFeeBps_,
        uint16 bondBps_,
        uint64 disputeWindow_
    ) private returns (Escrow) {
        return new Escrow(
            asset_,
            reputation_,
            treasury,
            feeBps_,
            resolverFeeBps_,
            bondBps_,
            MIN_TTL,
            MAX_TTL,
            disputeWindow_,
            MIN_LOCK
        );
    }

    function _escrowWithMinLock(uint16 bondBps_, uint128 minLock_) private returns (Escrow) {
        return new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            bondBps_,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            minLock_
        );
    }

    function _reentrantSet() private returns (Escrow e, ReentrantERC20 token) {
        token = new ReentrantERC20();
        token.mint(payer, 1e24);
        token.mint(payee, 1e24);

        MockReputation rep = new MockReputation();
        e = _escrowWith(address(token), address(rep), FEE_BPS, RESOLVER_FEE_BPS, BOND_BPS, 0);
        rep.setEscrow(address(e));

        _approveToken(IERC20(address(token)), address(e));
    }

    function _approveToken(IERC20 token, address spender) private {
        address[3] memory parties = [payer, payee, stranger];
        for (uint256 i; i < parties.length; ++i) {
            vm.prank(parties[i]);
            token.approve(spender, type(uint256).max);
        }
    }

    function _lock(uint128 amount) private returns (uint256) {
        return _lock(escrow, payer, payee, amount);
    }

    function _lock(Escrow e, address from, address to, uint128 amount) private returns (uint256 id) {
        vm.prank(from);
        id = e.lock(to, CAP_ID, INPUT_COMMIT, "ipfs://input", amount, _deadline());
    }

    function _release(Escrow e, uint256 id) private {
        vm.prank(e.getLock(id).payee);
        e.release(id, OUTPUT_COMMIT, "ipfs://output");
    }

    function _cancel(Escrow e, uint256 id) private {
        vm.prank(e.getLock(id).payee);
        e.cancel(id);
    }

    function _deadline() private view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    function _assertStatus(uint256 id, IEscrow.LockStatus expected) private view {
        _assertStatus(escrow, id, expected);
    }

    function _assertStatus(Escrow e, uint256 id, IEscrow.LockStatus expected) private view {
        assertEq(uint256(e.getLock(id).status), uint256(expected), "lock status");
    }

    function _bps(uint128 amount, uint16 rate) private pure returns (uint128) {
        return uint128((uint256(amount) * rate) / BPS);
    }

    /// The split is restated from the specification. The fuzz assertions then check the arithmetic
    /// as well as the conservation.
    function _expectedSplit(uint128 amount, uint16 refundBps)
        private
        view
        returns (uint256 refunded, uint256 paid, uint256 protocolFee, uint256 resolverFee)
    {
        resolverFee = (uint256(amount) * escrow.resolverFeeBps()) / BPS;

        uint256 divisible = amount - resolverFee;
        refunded = (divisible * refundBps) / BPS;

        uint256 awarded = divisible - refunded;
        protocolFee = (awarded * escrow.feeBps()) / BPS;
        paid = awarded - protocolFee;
    }
}

/// Drives the escrow through random orderings of the whole lifecycle. Transitions that are
/// invalid at the moment they are attempted are counted and skipped, so a run spends its depth
/// changing state.
contract EscrowLifecycleHandler is Test {
    /// Mirrors the band the invariant fixture deploys with.
    uint64 private constant MIN_TTL = 1 hours;
    uint64 private constant MAX_TTL = 30 days;

    bytes32 private constant CAP_ID = keccak256("invariant.capability");

    Escrow private immutable escrow;
    MockUsdg private immutable asset;
    EscrowResolverStub private immutable stub;

    address[3] private actors;
    uint256[] private ids;

    uint256 public rejected;

    constructor(Escrow escrow_, MockUsdg asset_, EscrowResolverStub stub_, address[3] memory actors_) {
        escrow = escrow_;
        asset = asset_;
        stub = stub_;
        actors = actors_;

        for (uint256 i; i < actors_.length; ++i) {
            asset_.mint(actors_[i], 1e30);
            vm.prank(actors_[i]);
            asset_.approve(address(escrow_), type(uint256).max);
        }
    }

    function lockJob(uint256 payerSeed, uint256 payeeSeed, uint128 amount, uint64 ttl) external {
        uint128 value = uint128(bound(uint256(amount), escrow.minLock(), 1e18));
        uint64 deadline = uint64(block.timestamp + bound(uint256(ttl), MIN_TTL + 1, MAX_TTL - 1));

        vm.prank(_actor(payerSeed));
        try escrow.lock(_actor(payeeSeed), CAP_ID, bytes32(0), "", value, deadline) returns (uint256 id) {
            ids.push(id);
        } catch {
            ++rejected;
        }
    }

    function releaseJob(uint256 idSeed) external {
        (uint256 id, IEscrow.Lock memory entry) = _pick(idSeed);
        if (id == 0) return;

        vm.prank(entry.payee);
        try escrow.release(id, bytes32("output"), "") {}
        catch {
            ++rejected;
        }
    }

    function finalizeJob(uint256 idSeed) external {
        (uint256 id,) = _pick(idSeed);
        if (id == 0) return;

        try escrow.finalizeRelease(id) {}
        catch {
            ++rejected;
        }
    }

    function timeoutJob(uint256 idSeed) external {
        (uint256 id,) = _pick(idSeed);
        if (id == 0) return;

        try escrow.timeout(id) {}
        catch {
            ++rejected;
        }
    }

    function cancelJob(uint256 idSeed) external {
        (uint256 id, IEscrow.Lock memory entry) = _pick(idSeed);
        if (id == 0) return;

        vm.prank(entry.payee);
        try escrow.cancel(id) {}
        catch {
            ++rejected;
        }
    }

    function disputeJob(uint256 idSeed, bool byPayer) external {
        (uint256 id, IEscrow.Lock memory entry) = _pick(idSeed);
        if (id == 0) return;

        vm.prank(byPayer ? entry.payer : entry.payee);
        try escrow.dispute(id) {}
        catch {
            ++rejected;
        }
    }

    function resolveJob(uint256 idSeed, uint16 refundBps) external {
        (uint256 id,) = _pick(idSeed);
        if (id == 0) return;

        try stub.rule(IEscrow(address(escrow)), id, uint16(bound(uint256(refundBps), 0, 10_000))) {}
        catch {
            ++rejected;
        }
    }

    /// The issuer's freeze, on any side of a settlement. Every exit still has to land, with the
    /// frozen share booked for later.
    function freeze(uint256 actorSeed, bool frozen) external {
        asset.setFrozen(_actor(actorSeed), frozen);
    }

    function claimOwed(uint256 actorSeed) external {
        try escrow.claim(_actor(actorSeed)) returns (uint128) {}
        catch {
            ++rejected;
        }
    }

    function owedTotal() external view returns (uint256 total) {
        for (uint256 i; i < actors.length; ++i) {
            total += escrow.owed(actors[i]);
        }
    }

    function sweep() external {
        try escrow.sweepFees() returns (uint128) {}
        catch {
            ++rejected;
        }
    }

    function skipAhead(uint64 delta) external {
        vm.warp(block.timestamp + bound(uint256(delta), 1 hours, 10 days));
    }

    function lockCount() external view returns (uint256) {
        return ids.length;
    }

    function _pick(uint256 seed) private view returns (uint256 id, IEscrow.Lock memory entry) {
        if (ids.length == 0) return (0, entry);

        id = ids[seed % ids.length];
        entry = escrow.getLock(id);
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }
}

contract EscrowSolvencyInvariantTest is Test {
    MockUsdg internal asset;
    Escrow internal escrow;
    EscrowLifecycleHandler internal handler;

    function setUp() public {
        vm.warp(1_780_000_000);

        asset = new MockUsdg();

        Reputation rep = new Reputation(
            address(this), IReputation.CapCurve({baseCap: type(uint128).max, capPerScore: 0, maxCap: type(uint128).max})
        );
        escrow = new Escrow(
            address(asset), address(rep), makeAddr("invariantTreasury"), 250, 100, 500, 1 hours, 30 days, 1 days, 10_000
        );
        rep.setEscrow(address(escrow));

        EscrowResolverStub stub = new EscrowResolverStub();
        escrow.setResolver(address(stub));

        address[3] memory actors = [makeAddr("alpha"), makeAddr("beta"), makeAddr("gamma")];
        handler = new EscrowLifecycleHandler(escrow, asset, stub, actors);

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = EscrowLifecycleHandler.lockJob.selector;
        selectors[1] = EscrowLifecycleHandler.releaseJob.selector;
        selectors[2] = EscrowLifecycleHandler.finalizeJob.selector;
        selectors[3] = EscrowLifecycleHandler.timeoutJob.selector;
        selectors[4] = EscrowLifecycleHandler.cancelJob.selector;
        selectors[5] = EscrowLifecycleHandler.disputeJob.selector;
        selectors[6] = EscrowLifecycleHandler.resolveJob.selector;
        selectors[7] = EscrowLifecycleHandler.freeze.selector;
        selectors[8] = EscrowLifecycleHandler.claimOwed.selector;
        selectors[9] = EscrowLifecycleHandler.sweep.selector;
        selectors[10] = EscrowLifecycleHandler.skipAhead.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// The balance is fully accounted for at every point in the lifecycle: principal still
    /// held, bonds posted against a live ruling, fees booked but not yet swept, and payouts
    /// booked to a frozen party. Anything else in the balance would be value the escrow cannot
    /// pay out, and anything missing would be a lock it can no longer honour.
    function invariant_escrowHoldsTheLivePrincipalAndTheUnsweptFees() public view {
        uint256 held;
        uint256 last = escrow.nextId();

        for (uint256 id = 1; id < last; ++id) {
            IEscrow.Lock memory entry = escrow.getLock(id);

            if (entry.status == IEscrow.LockStatus.Locked) {
                held += entry.amount;
            } else if (entry.status == IEscrow.LockStatus.Disputed && entry.releasedAt == 0) {
                held += uint256(entry.amount) + entry.bond;
            }
        }

        assertEq(asset.balanceOf(address(escrow)), held + escrow.feesAccrued() + handler.owedTotal());
    }

    function invariant_aSettledLockNeverCarriesABondForward() public view {
        uint256 last = escrow.nextId();

        for (uint256 id = 1; id < last; ++id) {
            IEscrow.Lock memory entry = escrow.getLock(id);
            if (entry.status == IEscrow.LockStatus.Resolved) assertEq(entry.bond, 0);
        }
    }
}
