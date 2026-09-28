// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Escrow} from "../src/Escrow.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {BRSR} from "../src/token/BRSR.sol";
import {Staking} from "../src/token/Staking.sol";
import {IBRSR} from "../src/token/interfaces/IBRSR.sol";

import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockReputation} from "./mocks/MockReputation.sol";

/// Stands in for the oracle registry so a ruling can be driven from a test without running a
/// commit-reveal round for every case. It answers the three calls the escrow makes on its
/// resolver and books what it was paid, which is the whole of the escrow's side of the reward.
contract BondResolverStub {
    error NotEscrow();
    error RewardRejected();

    IEscrow private _escrow;

    uint256 public nextDisputeId = 1;
    uint256 public rewardTotal;
    uint256 public lastRewardDisputeId;

    /// A registry that refuses the credit. The escrow has already moved the tokens by then,
    /// so it must not put the settlement back.
    bool public rejectRewards;

    mapping(uint256 escrowId => uint256 disputeId) public disputeIdOf;

    constructor(IEscrow escrow_) {
        _escrow = escrow_;
    }

    function openDispute(uint256 escrowId) external returns (uint256 id) {
        if (msg.sender != address(_escrow)) revert NotEscrow();

        id = nextDisputeId++;
        disputeIdOf[escrowId] = id;
    }

    function notifyReward(uint256 disputeId, uint256 amount) external {
        if (msg.sender != address(_escrow)) revert NotEscrow();
        if (rejectRewards) revert RewardRejected();

        lastRewardDisputeId = disputeId;
        rewardTotal += amount;
    }

    function rule(uint256 id, uint16 refundBps) external {
        _escrow.resolve(id, refundBps);
    }

    function setRejectRewards(bool reject) external {
        rejectRewards = reject;
    }

    function escrow() external view returns (address) {
        return address(_escrow);
    }
}

/// The bonded-dispute economics: who gets the bond back, who forfeits it, what a looping
/// griefer pays for the privilege, and the accounting identity that has to survive every one
/// of those paths.
contract EscrowDisputeBondsTest is Test {
    uint16 internal constant FEE_BPS = 100;
    uint16 internal constant RESOLVER_FEE_BPS = 200;
    uint16 internal constant BOND_BPS = 500;
    uint16 internal constant BPS = 10_000;
    uint16 internal constant HALF_BPS = 5_000;

    uint64 internal constant MIN_TTL = 1 hours;
    uint64 internal constant MAX_TTL = 30 days;
    uint64 internal constant DISPUTE_WINDOW = 1 days;
    uint64 internal constant DISPUTE_TIMEOUT = 3 days;

    uint128 internal constant AMOUNT = 1_000e6;
    uint128 internal constant BOND = 50e6;
    uint128 internal constant RESOLVER_FEE = 20e6;

    bytes32 internal constant CAPABILITY = keccak256("inference.run");
    bytes32 internal constant INPUT_COMMIT = keccak256("input");
    bytes32 internal constant OUTPUT_COMMIT = keccak256("output");

    MockUsdg internal asset;
    MockReputation internal reputation;
    Escrow internal escrow;
    BondResolverStub internal stub;

    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal treasury = makeAddr("treasury");

    struct Split {
        uint128 refunded;
        uint128 paid;
        uint128 protocolFee;
        uint128 resolverFee;
    }

    struct Rig {
        Escrow escrow;
        BondResolverStub stub;
        MockReputation reputation;
    }

    /// One fuzzed settlement, carried as a struct because the rates, the amount and the side
    /// that opened the dispute all have to reach the assertions together.
    struct Case {
        uint128 amount;
        uint16 refundBps;
        uint16 feeBps;
        uint16 resolverFeeBps;
        uint16 bondBps;
        bool payeeDisputes;
    }

    struct Ledger {
        uint256 payer;
        uint256 payee;
        uint128 fees;
        uint128 bond;
    }

    function setUp() public {
        // Timestamps start at 1, which leaves no room behind the clock for a dispute window.
        vm.warp(1_700_000_000);

        asset = new MockUsdg();
        reputation = new MockReputation();
        escrow = new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            DISPUTE_TIMEOUT
        );
        stub = new BondResolverStub(IEscrow(address(escrow)));

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(stub));

        _fund(payer, 1_000_000e6);
        _fund(payee, 1_000_000e6);
    }

    function test_PayerWhoWinsTheRulingGetsTheBondBack() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        uint256 payerBefore = asset.balanceOf(payer);
        vm.prank(payer);
        escrow.dispute(id);

        assertEq(asset.balanceOf(payer), payerBefore - BOND, "bond leaves the disputer on dispute");
        assertEq(escrow.getLock(id).bond, BOND, "bond recorded against the lock");
        assertEq(escrow.getLock(id).disputer, payer, "disputer recorded");

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.BondReturned(id, payer, BOND);
        stub.rule(id, HALF_BPS);

        // An even split is the line: the payer asked for the money to move and half of it did.
        assertEq(asset.balanceOf(payer), payerBefore + 490e6, "refund lands and the bond comes home");
        assertEq(asset.balanceOf(payee), 1_000_000e6 + 485_100_000, "payee keeps its half less the fee");
        assertEq(asset.balanceOf(address(stub)), RESOLVER_FEE, "resolvers are paid the fee and nothing else");
        assertEq(escrow.feesAccrued(), 4_900_000, "protocol fee charged on the payee side only");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "nothing stranded in the escrow");
        assertEq(escrow.getLock(id).bond, 0, "bond slot cleared");
    }

    function test_PayerWhoLosesTheRulingForfeitsTheBondIntoTheResolverPot() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        uint256 payerBefore = asset.balanceOf(payer);
        vm.prank(payer);
        escrow.dispute(id);

        // One basis point under the line, which is the whole of the difference between a
        // complaint that moved the ruling and one that did not.
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.BondForfeited(id, payer, BOND);
        stub.rule(id, HALF_BPS - 1);

        assertEq(asset.balanceOf(payer), payerBefore - BOND + 489_902_000, "refund lands, bond does not");
        assertEq(asset.balanceOf(payee), 1_000_000e6 + 485_197_020, "payee paid its share less the fee");
        assertEq(asset.balanceOf(address(stub)), RESOLVER_FEE + BOND, "forfeited bond joins the resolver reward");
        assertEq(stub.rewardTotal(), RESOLVER_FEE + BOND, "registry was told what it received");
        assertEq(escrow.feesAccrued(), 4_900_980, "protocol fee charged on the payee side only");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "nothing stranded in the escrow");
    }

    function test_PayeeWhoWinsTheRulingGetsTheBondBackOnTheSameEvenSplit() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        uint256 payeeBefore = asset.balanceOf(payee);
        vm.prank(payee);
        escrow.dispute(id);

        assertEq(asset.balanceOf(payee), payeeBefore - BOND, "payee posts the same bond the payer would");

        // The tie goes to whoever opened the dispute, whichever side that was. Half a
        // contested payment is a result, not a complaint the resolvers had to sit through.
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.BondReturned(id, payee, BOND);
        stub.rule(id, HALF_BPS);

        assertEq(asset.balanceOf(payee), payeeBefore + 485_100_000, "payee paid and bonded back");
        assertEq(asset.balanceOf(address(stub)), RESOLVER_FEE, "no forfeiture to add to the pot");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "nothing stranded in the escrow");
    }

    function test_PayeeWhoLosesTheRulingForfeitsTheBondIntoTheResolverPot() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        uint256 payeeBefore = asset.balanceOf(payee);
        vm.prank(payee);
        escrow.dispute(id);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.BondForfeited(id, payee, BOND);
        stub.rule(id, HALF_BPS + 1);

        Split memory split = _split(AMOUNT, HALF_BPS + 1, FEE_BPS, RESOLVER_FEE_BPS);
        assertEq(asset.balanceOf(payee), payeeBefore - BOND + split.paid, "payee paid its share, bond gone");
        assertEq(asset.balanceOf(address(stub)), RESOLVER_FEE + BOND, "forfeited bond joins the resolver reward");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "nothing stranded in the escrow");
    }

    function test_DisputeTimeoutReturnsTheBondWholeAndRefundsThePayer() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        uint256 payeeBefore = asset.balanceOf(payee);
        uint256 payerBefore = asset.balanceOf(payer);
        vm.prank(payee);
        escrow.dispute(id);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.BondReturned(id, payee, BOND);
        escrow.disputeTimeout(id);

        // A resolver that never ruled is not the disputer's fault, and the protocol charges
        // nothing for a settlement it did not make.
        assertEq(asset.balanceOf(payee), payeeBefore, "payee is whole, bond and all");
        assertEq(asset.balanceOf(payer), payerBefore + AMOUNT, "payer refunded in full");
        assertEq(asset.balanceOf(address(stub)), 0, "no resolver fee for a vote that never happened");
        assertEq(escrow.feesAccrued(), 0, "no protocol fee either");
        assertEq(asset.balanceOf(address(escrow)), 0, "escrow empty");
    }

    function test_DisputeTimeoutIsTooEarlyOnTheDeadlineAndOpensOneSecondLater() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);
        uint256 openedAt = block.timestamp;

        vm.warp(openedAt + DISPUTE_TIMEOUT);
        vm.expectRevert(IEscrow.TooEarly.selector);
        escrow.disputeTimeout(id);

        vm.warp(openedAt + DISPUTE_TIMEOUT + 1);
        escrow.disputeTimeout(id);

        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Resolved), "dispute closed");
    }

    function test_TheSameLockCannotBeDisputedTwiceToStackASecondBond() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);

        uint256 held = asset.balanceOf(address(escrow));

        vm.prank(payee);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.dispute(id);

        assertEq(asset.balanceOf(address(escrow)), held, "no second bond pulled");
        assertEq(escrow.getLock(id).bond, BOND, "one dispute, one bond");
    }

    function test_ResolvingTwiceCannotPayTheBondTwice() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);
        stub.rule(id, BPS);

        uint256 payerAfter = asset.balanceOf(payer);

        vm.expectRevert(IEscrow.BadStatus.selector);
        stub.rule(id, BPS);

        assertEq(asset.balanceOf(payer), payerAfter, "second ruling moves nothing");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "escrow holds only its fees");
    }

    function test_DisputeTimeoutAfterAResolveCannotPayTheBondTwice() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payee);
        escrow.dispute(id);
        stub.rule(id, 0);

        uint256 payeeAfter = asset.balanceOf(payee);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.disputeTimeout(id);

        assertEq(asset.balanceOf(payee), payeeAfter, "bond stays returned exactly once");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "escrow holds only its fees");
    }

    function test_ResolvingAfterADisputeTimeoutCannotPayTheBondTwice() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payee);
        escrow.dispute(id);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);
        escrow.disputeTimeout(id);

        uint256 payeeAfter = asset.balanceOf(payee);

        vm.expectRevert(IEscrow.BadStatus.selector);
        stub.rule(id, BPS);

        assertEq(asset.balanceOf(payee), payeeAfter, "a late ruling cannot re-pay the bond");
        assertEq(asset.balanceOf(address(escrow)), 0, "escrow empty");
    }

    /// The property the audit asked for: whichever exit fires first closes the lock, and the
    /// bond leaves the contract once. `timeoutFirst` decides the order, `refundBps` decides
    /// whether the first exit returns the bond or forfeits it.
    function testFuzz_TheBondLeavesTheEscrowExactlyOnceUnderEitherExitOrder(uint16 rawRefund, bool timeoutFirst)
        public
    {
        uint16 refundBps = uint16(bound(uint256(rawRefund), 0, BPS));
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);

        // Measured with the bond already posted, so every leg below is an inflow.
        uint256 payerBefore = asset.balanceOf(payer);
        uint256 payeeBefore = asset.balanceOf(payee);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);

        if (timeoutFirst) {
            escrow.disputeTimeout(id);
            vm.expectRevert(IEscrow.BadStatus.selector);
            stub.rule(id, refundBps);
        } else {
            stub.rule(id, refundBps);
            vm.expectRevert(IEscrow.BadStatus.selector);
            escrow.disputeTimeout(id);
        }

        uint256 moved = (asset.balanceOf(payer) - payerBefore) + (asset.balanceOf(payee) - payeeBefore)
            + asset.balanceOf(address(stub));

        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Resolved), "lock is closed");
        assertEq(escrow.getLock(id).bond, 0, "bond slot cleared");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "escrow holds only its fees");
        assertEq(
            moved + escrow.feesAccrued(), uint256(AMOUNT) + BOND, "principal and bond leave the escrow exactly once"
        );
    }

    /// The griefing vector the audit named, priced. A payee that locks its counterparty's
    /// money up by disputing every job now pays a bond to do it, and loses the bond every time
    /// the ruling says the job was never delivered.
    function test_LoopingLockAndDisputeCostsTheGrieferTheBondEveryRound() public {
        uint256 rounds = 10;

        uint256 grieferStart = asset.balanceOf(payee);
        uint256 targetStart = asset.balanceOf(payer);
        uint256 potStart = asset.balanceOf(address(stub));

        for (uint256 i; i < rounds; ++i) {
            uint256 id = _lock(payer, payee, AMOUNT);
            vm.prank(payee);
            escrow.dispute(id);
            stub.rule(id, BPS);
        }

        uint256 grieferCost = grieferStart - asset.balanceOf(payee);
        uint256 targetCost = targetStart - asset.balanceOf(payer);

        // 50 USDG of the griefer's own money per round, against 20 USDG of resolver fee on the
        // side it is attacking. Ten rounds of freezing 1,000 USDG costs 500 USDG to run.
        assertEq(grieferCost, rounds * BOND, "griefer pays the bond every single round");
        assertEq(grieferCost, 500e6, "ten rounds of griefing cost 500 USDG");
        assertEq(targetCost, rounds * RESOLVER_FEE, "the target carries only the resolver fee");
        assertEq(targetCost, 200e6, "and gets the rest of every lock back");
        assertGt(grieferCost, targetCost, "griefing is priced above the damage it does");
        assertEq(
            asset.balanceOf(address(stub)) - potStart,
            rounds * (uint256(BOND) + RESOLVER_FEE),
            "every forfeited bond reached the resolvers"
        );
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "nothing stranded after ten rounds");
    }

    function test_AGrieferRunsOutOfBondBudgetBeforeItsTargetRunsOutOfPrincipal() public {
        address griefer = makeAddr("griefer");
        // Funded for exactly two bonds at this lock size.
        _fund(griefer, 2 * uint256(BOND));

        for (uint256 i; i < 2; ++i) {
            uint256 open = _lock(payer, griefer, AMOUNT);
            vm.prank(griefer);
            escrow.dispute(open);
            stub.rule(open, BPS);
        }

        uint256 id = _lock(payer, griefer, AMOUNT);
        vm.prank(griefer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, griefer, 0, uint256(BOND))
        );
        escrow.dispute(id);

        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Locked), "the lock stays open");
    }

    function test_AnApprovalSizedForTheLockDoesNotCoverTheDisputeBond() public {
        address tight = makeAddr("tight");
        asset.mint(tight, AMOUNT);

        vm.prank(tight);
        asset.approve(address(escrow), AMOUNT);

        vm.prank(tight);
        uint256 id = escrow.lock(payee, CAPABILITY, INPUT_COMMIT, "ipfs://in", AMOUNT, _deadline());

        vm.prank(tight);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(escrow), 0, uint256(BOND))
        );
        escrow.dispute(id);
    }

    function test_APayeeWithNoFundsCannotFreezeThePayersMoney() public {
        address broke = makeAddr("broke");
        vm.prank(broke);
        asset.approve(address(escrow), type(uint256).max);

        uint256 id = _lock(payer, broke, AMOUNT);

        vm.prank(broke);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, broke, 0, uint256(BOND)));
        escrow.dispute(id);

        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Locked), "lock untouched");
        assertEq(asset.balanceOf(address(escrow)), AMOUNT, "escrow holds the principal and no bond");
    }

    function test_TheBondRoundsDownAndADustLockPostsNone() public {
        // 19 units at five percent is 0.95 of a unit, which truncates away.
        uint256 dust = _lock(payer, payee, 19);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.prank(payer);
        escrow.dispute(dust);

        assertEq(escrow.getLock(dust).bond, 0, "no bond on a lock too small to price one");
        assertEq(asset.balanceOf(payer), payerBefore, "and nothing pulled from the disputer");

        // One unit above the boundary the rounding starts to bite.
        uint256 smallest = _lock(payer, payee, 20);
        payerBefore = asset.balanceOf(payer);

        vm.prank(payer);
        escrow.dispute(smallest);

        assertEq(escrow.getLock(smallest).bond, 1, "the first unit of bond appears at 20");
        assertEq(asset.balanceOf(payer), payerBefore - 1, "and the unit is pulled");
    }

    function test_AZeroBondRateOpensDisputesWithoutPullingAnything() public {
        Rig memory rig = _deployRig(FEE_BPS, RESOLVER_FEE_BPS, 0);

        uint256 id = _lock(rig.escrow, payer, payee, AMOUNT);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.prank(payer);
        rig.escrow.dispute(id);

        assertEq(asset.balanceOf(payer), payerBefore, "an unbonded deployment charges nothing to dispute");
        assertEq(rig.escrow.getLock(id).bond, 0, "and books no bond");

        rig.stub.rule(id, BPS);

        assertEq(asset.balanceOf(address(rig.stub)), RESOLVER_FEE, "the resolver pot is the fee alone");
        assertEq(asset.balanceOf(address(rig.escrow)), rig.escrow.feesAccrued(), "nothing stranded");
    }

    function test_DisputingAReleasedLockChargesNoBondAndCannotBeRuledOn() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payee);
        escrow.release(id, OUTPUT_COMMIT, "ipfs://out");

        uint256 payerBefore = asset.balanceOf(payer);

        vm.prank(payer);
        escrow.dispute(id);

        // The money left with the release, so there is no ruling for a bond to back and no
        // split for one to be returned out of.
        assertEq(asset.balanceOf(payer), payerBefore, "no bond on a complaint about money already paid");
        assertEq(escrow.getLock(id).bond, 0, "no bond booked");

        vm.expectRevert(IEscrow.BadStatus.selector);
        stub.rule(id, BPS);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);
        vm.expectRevert(IEscrow.BadStatus.selector);
        escrow.disputeTimeout(id);
    }

    function test_SweepingFeesCannotReachAPostedBond() public {
        uint256 settled = _lock(payer, payee, AMOUNT);
        vm.prank(payee);
        escrow.release(settled, OUTPUT_COMMIT, "ipfs://out");

        uint256 contested = _lock(payer, payee, AMOUNT);
        vm.prank(payee);
        escrow.dispute(contested);

        uint128 fee = escrow.feesAccrued();
        assertEq(fee, 10e6, "one percent of a settled lock");

        escrow.sweepFees();

        assertEq(asset.balanceOf(treasury), fee, "treasury takes the fee and only the fee");
        assertEq(
            asset.balanceOf(address(escrow)), uint256(AMOUNT) + BOND, "the disputed principal and its bond stay put"
        );
        assertEq(escrow.feesAccrued(), 0, "fee balance cleared");

        stub.rule(contested, HALF_BPS);
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "and the lock still settles whole");
    }

    function test_ARejectedRewardStillMovesTheForfeitedBondOutOfTheEscrow() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payee);
        escrow.dispute(id);

        stub.setRejectRewards(true);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.ResolverRewardUncredited(id, 1, RESOLVER_FEE + BOND);
        stub.rule(id, BPS);

        assertEq(stub.rewardTotal(), 0, "the registry refused the credit");
        assertEq(asset.balanceOf(address(stub)), RESOLVER_FEE + BOND, "the tokens went anyway");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "and the escrow is not holding them");
    }

    function test_TheConstructorRejectsABondRateAboveTheCeiling() public {
        vm.expectRevert(IEscrow.BadBond.selector);
        new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            2_001,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            DISPUTE_TIMEOUT
        );

        Rig memory rig = _deployRig(FEE_BPS, RESOLVER_FEE_BPS, 2_000);
        assertEq(rig.escrow.disputeBondBps(), 2_000, "a fifth of the principal is the most a bond can be");

        uint256 id = _lock(rig.escrow, payer, payee, AMOUNT);
        vm.prank(payer);
        rig.escrow.dispute(id);

        assertEq(rig.escrow.getLock(id).bond, 200e6, "and it is charged in full");
    }

    /// The identity from the design note, checked against balances and not against the
    /// contract's own arithmetic:
    ///
    ///     refunded + paid + protocolFee + resolverFee + bondLeg == amount + bond
    function testFuzz_EveryRulingConservesThePrincipalAndTheBond(
        uint128 rawAmount,
        uint16 rawRefund,
        uint16 rawFee,
        uint16 rawResolverFee,
        uint16 rawBond,
        bool payeeDisputes
    ) public {
        _ruleAndConserve(
            Case({
                amount: uint128(bound(uint256(rawAmount), 1, 1e15)),
                refundBps: uint16(bound(uint256(rawRefund), 0, BPS)),
                feeBps: uint16(bound(uint256(rawFee), 0, 1_000)),
                resolverFeeBps: uint16(bound(uint256(rawResolverFee), 0, 1_000)),
                bondBps: uint16(bound(uint256(rawBond), 0, 2_000)),
                payeeDisputes: payeeDisputes
            })
        );
    }

    function testFuzz_ADisputeTimeoutAlwaysReturnsThePrincipalAndTheBondWhole(
        uint128 rawAmount,
        uint16 rawBond,
        bool payeeDisputes
    ) public {
        uint128 amount = uint128(bound(uint256(rawAmount), 1, 1e15));
        uint16 bondBps = uint16(bound(uint256(rawBond), 0, 2_000));

        Rig memory rig = _deployRig(FEE_BPS, RESOLVER_FEE_BPS, bondBps);
        asset.mint(payer, 1e16);
        asset.mint(payee, 1e16);

        uint256 id = _lock(rig.escrow, payer, payee, amount);

        address disputer = payeeDisputes ? payee : payer;
        uint256 disputerBefore = asset.balanceOf(disputer);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.prank(disputer);
        rig.escrow.dispute(id);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT + 1);
        rig.escrow.disputeTimeout(id);

        assertEq(asset.balanceOf(payer), payerBefore + amount, "payer refunded in full");
        assertEq(asset.balanceOf(disputer), disputerBefore + (payeeDisputes ? 0 : amount), "bond returned whole");
        assertEq(rig.escrow.feesAccrued(), 0, "an unheard dispute earns the protocol nothing");
        assertEq(asset.balanceOf(address(rig.stub)), 0, "and the resolvers nothing");
        assertEq(asset.balanceOf(address(rig.escrow)), 0, "escrow empty");
    }

    /// End to end against the real registry: three resolvers rule that the job was never
    /// delivered, the payee that opened the dispute forfeits, and the bond turns up in what
    /// those three can claim.
    function test_AForfeitedBondIsClaimableByTheResolversThatRuled() public {
        address admin = makeAddr("oracleAdmin");
        address sink = makeAddr("slashSink");

        MockReputation rep = new MockReputation();
        Escrow bonded = new Escrow(
            address(asset),
            address(rep),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            DISPUTE_TIMEOUT
        );
        OracleRegistry oracle = new OracleRegistry(
            address(asset),
            admin,
            sink,
            IOracleRegistry.Config({
                commitWindow: 1 hours,
                revealWindow: 1 hours,
                unbondingPeriod: 7 days,
                quorum: 3,
                maxVoters: 5,
                maxDeviation: 10,
                slashBps: 500
            })
        );

        // Bonds are BRSR and the floor that admits one is the staking pool's. The rewards
        // below are still USDG: the two are different tokens throughout.
        BRSR bondToken = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: makeAddr("brsrTeam"), treasury: treasury, liquidity: makeAddr("brsrLp")
            })
        );
        Staking pool = new Staking(bondToken, asset, admin, sink, treasury, 7 days, 100e18);

        rep.setEscrow(address(bonded));
        bonded.setResolver(address(oracle));
        oracle.setEscrow(address(bonded));
        oracle.setStaking(address(pool));

        address[3] memory resolvers = [makeAddr("resolverA"), makeAddr("resolverB"), makeAddr("resolverC")];
        for (uint256 i; i < resolvers.length; ++i) {
            bondToken.transfer(resolvers[i], 100e18);
            vm.startPrank(resolvers[i]);
            bondToken.approve(address(oracle), type(uint256).max);
            oracle.register(100e18);
            vm.stopPrank();
        }

        vm.prank(payer);
        asset.approve(address(bonded), type(uint256).max);
        vm.prank(payee);
        asset.approve(address(bonded), type(uint256).max);

        uint256 id = _lock(bonded, payer, payee, AMOUNT);

        vm.prank(payee);
        bonded.dispute(id);

        uint256 disputeId = oracle.disputeIdOf(id);
        bytes32 salt = keccak256("salt");
        for (uint256 i; i < resolvers.length; ++i) {
            // Read the commitment before the prank: a call made while one is armed would spend
            // it, and the vote would arrive from this test instead of the resolver.
            bytes32 commitment = oracle.commitmentHash(disputeId, resolvers[i], 10, salt);

            vm.prank(resolvers[i]);
            oracle.commitVote(disputeId, commitment);
        }

        vm.warp(oracle.getDispute(disputeId).commitEndsAt);
        for (uint256 i; i < resolvers.length; ++i) {
            vm.prank(resolvers[i]);
            oracle.revealVote(disputeId, 10, salt);
        }

        oracle.finalize(disputeId);

        // A median of 10 is a full refund, so the payee that opened the dispute lost it.
        assertEq(uint8(bonded.getLock(id).status), uint8(IEscrow.LockStatus.Resolved), "lock settled");
        assertEq(asset.balanceOf(address(bonded)), 0, "escrow empty");

        uint256 claimed;
        for (uint256 i; i < resolvers.length; ++i) {
            vm.prank(resolvers[i]);
            claimed += oracle.claimRewards();
        }
        uint256 dust = oracle.sweepUnallocated();

        assertEq(claimed + dust, uint256(RESOLVER_FEE) + BOND, "the fee and the forfeited bond, to the unit");
        assertEq(oracle.rewardFloat(), 0, "nothing left over in the reward float");
        assertEq(oracle.totalBonded(), 300e18, "and no resolver bond was touched to pay it");
        assertEq(asset.balanceOf(address(oracle)), 0, "the registry keeps no settlement asset of its own");
        assertEq(bondToken.balanceOf(address(oracle)), 300e18, "the bonds are held in BRSR and untouched");
    }

    function _fund(address account, uint256 amount) private {
        asset.mint(account, amount);
        vm.prank(account);
        asset.approve(address(escrow), type(uint256).max);
    }

    function _deadline() private view returns (uint64) {
        return uint64(block.timestamp + 7 days);
    }

    function _lock(address from, address to, uint128 amount) private returns (uint256) {
        return _lock(escrow, from, to, amount);
    }

    function _lock(Escrow target, address from, address to, uint128 amount) private returns (uint256 id) {
        vm.prank(from);
        id = target.lock(to, CAPABILITY, INPUT_COMMIT, "ipfs://in", amount, _deadline());
    }

    function _deployRig(uint16 feeBps, uint16 resolverFeeBps, uint16 bondBps) private returns (Rig memory rig) {
        rig.reputation = new MockReputation();
        rig.escrow = new Escrow(
            address(asset),
            address(rig.reputation),
            treasury,
            feeBps,
            resolverFeeBps,
            bondBps,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            DISPUTE_TIMEOUT
        );
        rig.stub = new BondResolverStub(IEscrow(address(rig.escrow)));

        rig.reputation.setEscrow(address(rig.escrow));
        rig.escrow.setResolver(address(rig.stub));

        vm.prank(payer);
        asset.approve(address(rig.escrow), type(uint256).max);
        vm.prank(payee);
        asset.approve(address(rig.escrow), type(uint256).max);
    }

    function _ruleAndConserve(Case memory c) private {
        Rig memory rig = _deployRig(c.feeBps, c.resolverFeeBps, c.bondBps);
        asset.mint(payer, 1e16);
        asset.mint(payee, 1e16);

        uint256 id = _lock(rig.escrow, payer, payee, c.amount);

        vm.prank(c.payeeDisputes ? payee : payer);
        rig.escrow.dispute(id);

        Ledger memory pre = Ledger({
            payer: asset.balanceOf(payer),
            payee: asset.balanceOf(payee),
            fees: rig.escrow.feesAccrued(),
            bond: rig.escrow.getLock(id).bond
        });
        assertEq(pre.bond, _bps(c.amount, c.bondBps), "bond is a share of the principal");

        rig.stub.rule(id, c.refundBps);

        _assertConserved(rig, c, pre);
    }

    function _assertConserved(Rig memory rig, Case memory c, Ledger memory pre) private view {
        Split memory split = _split(c.amount, c.refundBps, c.feeBps, c.resolverFeeBps);
        bool vindicated = c.payeeDisputes ? c.refundBps <= HALF_BPS : c.refundBps >= HALF_BPS;

        uint256 payerGain = asset.balanceOf(payer) - pre.payer;
        uint256 payeeGain = asset.balanceOf(payee) - pre.payee;
        uint256 potGain = asset.balanceOf(address(rig.stub));
        uint128 protocolFee = rig.escrow.feesAccrued() - pre.fees;

        assertEq(protocolFee, split.protocolFee, "protocol fee");
        assertEq(potGain, uint256(split.resolverFee) + (vindicated ? 0 : pre.bond), "resolver fee plus forfeiture");
        assertEq(payerGain, uint256(split.refunded) + (vindicated && !c.payeeDisputes ? pre.bond : 0), "payer leg");
        assertEq(payeeGain, uint256(split.paid) + (vindicated && c.payeeDisputes ? pre.bond : 0), "payee leg");
        assertEq(payerGain + payeeGain + potGain + protocolFee, uint256(c.amount) + pre.bond, "conservation");
        assertEq(asset.balanceOf(address(rig.escrow)), rig.escrow.feesAccrued(), "escrow holds only its fees");
    }

    /// Mirrors the escrow's own division so the fuzz checks the outcome against arithmetic
    /// written independently of it.
    function _split(uint128 amount, uint16 refundBps, uint16 feeBps, uint16 resolverFeeBps)
        private
        pure
        returns (Split memory split)
    {
        split.resolverFee = _bps(amount, resolverFeeBps);

        uint128 divisible = amount - split.resolverFee;
        split.refunded = _bps(divisible, refundBps);

        uint128 awarded = divisible - split.refunded;
        split.protocolFee = _bps(awarded, feeBps);
        split.paid = awarded - split.protocolFee;
    }

    function _bps(uint128 amount, uint16 rate) private pure returns (uint128) {
        return uint128((uint256(amount) * rate) / BPS);
    }
}

/// Drives the bonded lifecycle at random so the conservation identity can be checked against
/// a deep history, not one path at a time.
contract EscrowDisputeBondsHandler is CommonBase, StdCheats, StdUtils {
    bytes32 internal constant CAPABILITY = keccak256("inference.run");
    bytes32 internal constant INPUT_COMMIT = keccak256("input");
    bytes32 internal constant OUTPUT_COMMIT = keccak256("output");

    Escrow public escrow;
    MockUsdg public asset;
    BondResolverStub public stub;

    address[2] public payers;
    address[2] public payees;

    uint256[] public ids;

    constructor(Escrow escrow_, MockUsdg asset_, BondResolverStub stub_) {
        escrow = escrow_;
        asset = asset_;
        stub = stub_;

        payers = [makeAddr("handlerPayerA"), makeAddr("handlerPayerB")];
        payees = [makeAddr("handlerPayeeA"), makeAddr("handlerPayeeB")];

        for (uint256 i; i < 2; ++i) {
            _prepare(payers[i]);
            _prepare(payees[i]);
        }
    }

    function openLock(uint256 actorSeed, uint128 rawAmount, uint8 action) external {
        address payer = payers[actorSeed % 2];
        address payee = payees[actorSeed % 2];
        uint128 amount = uint128(bound(uint256(rawAmount), 1, 10_000e6));

        // Timestamps have three hundred billion years of headroom in uint64.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 deadline = uint64(block.timestamp + 7 days);

        vm.prank(payer);
        uint256 id = escrow.lock(payee, CAPABILITY, INPUT_COMMIT, "ipfs://in", amount, deadline);
        ids.push(id);

        if (action % 3 == 1) {
            vm.prank(payer);
            escrow.dispute(id);
        } else if (action % 3 == 2) {
            vm.prank(payee);
            escrow.dispute(id);
        }
    }

    function rule(uint256 idSeed, uint16 rawRefund) external {
        if (ids.length == 0) return;
        stub.rule(ids[idSeed % ids.length], uint16(bound(uint256(rawRefund), 0, 10_000)));
    }

    function letTheResolverGoSilent(uint256 idSeed) external {
        if (ids.length == 0) return;
        escrow.disputeTimeout(ids[idSeed % ids.length]);
    }

    function releaseLock(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];

        vm.prank(escrow.getLock(id).payee);
        escrow.release(id, OUTPUT_COMMIT, "ipfs://out");
    }

    function timeoutLock(uint256 idSeed) external {
        if (ids.length == 0) return;
        escrow.timeout(ids[idSeed % ids.length]);
    }

    function letTheClockRun(uint256 raw) external {
        vm.warp(block.timestamp + bound(raw, 1 hours, 10 days));
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function _prepare(address actor) private {
        asset.mint(actor, 1e15);
        vm.prank(actor);
        asset.approve(address(escrow), type(uint256).max);
    }
}

contract EscrowDisputeBondsInvariantTest is Test {
    MockUsdg internal asset;
    MockReputation internal reputation;
    Escrow internal escrow;
    BondResolverStub internal stub;
    EscrowDisputeBondsHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);

        asset = new MockUsdg();
        reputation = new MockReputation();
        escrow = new Escrow(
            address(asset), address(reputation), makeAddr("treasury"), 100, 200, 500, 1 hours, 30 days, 1 days, 3 days
        );
        stub = new BondResolverStub(IEscrow(address(escrow)));

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(stub));

        handler = new EscrowDisputeBondsHandler(escrow, asset, stub);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = EscrowDisputeBondsHandler.openLock.selector;
        selectors[1] = EscrowDisputeBondsHandler.rule.selector;
        selectors[2] = EscrowDisputeBondsHandler.letTheResolverGoSilent.selector;
        selectors[3] = EscrowDisputeBondsHandler.releaseLock.selector;
        selectors[4] = EscrowDisputeBondsHandler.timeoutLock.selector;
        selectors[5] = EscrowDisputeBondsHandler.letTheClockRun.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// A bond paid out twice, or a principal paid out twice, shows up here as an escrow
    /// balance below what its open locks account for.
    function invariant_EscrowHoldsOpenPrincipalPlusPostedBondsPlusFees() public view {
        uint256 expected = escrow.feesAccrued();

        uint256 count = handler.idCount();
        for (uint256 id = 1; id <= count; ++id) {
            IEscrow.Lock memory entry = escrow.getLock(id);

            // A lock disputed after its release was already paid out, so only the ones still
            // holding funds count toward the balance.
            bool holdsPrincipal = entry.status == IEscrow.LockStatus.Locked
                || (entry.status == IEscrow.LockStatus.Disputed && entry.releasedAt == 0);

            if (holdsPrincipal) expected += entry.amount;
            expected += entry.bond;
        }

        assertEq(asset.balanceOf(address(escrow)), expected, "escrow balance drifted from its open positions");
    }

    function invariant_AccruedFeesRemainCoveredByTheEscrowBalance() public view {
        assertGe(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "fees are not backed by tokens");
    }
}
