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

    function openDispute(uint256 escrowId, address, address) external returns (uint256 id) {
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
        _escrow.resolve(id, refundBps, 1);
    }

    /// What the registry does when the vote missed quorum.
    function reopen(uint256 id) external {
        _escrow.reopen(id);
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

    /// The deployment's floor, one cent of USDG. It carries a bond at every rate the escrow
    /// accepts, down to one basis point.
    uint128 internal constant MIN_LOCK = 10_000;

    uint128 internal constant AMOUNT = 1_000e6;
    uint128 internal constant BOND = 50e6;
    uint128 internal constant RESOLVER_FEE = 20e6;

    bytes32 internal constant CAPABILITY = keccak256("inference.run");
    bytes32 internal constant INPUT_COMMIT = keccak256("input");
    bytes32 internal constant OUTPUT_COMMIT = keccak256("output");
    bytes32 internal constant SALT = keccak256("salt");

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

    /// The escrow paired with the real registry, for the paths a stub would only restate.
    struct Live {
        Escrow escrow;
        OracleRegistry oracle;
        BRSR bondToken;
        address[3] resolvers;
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
            MIN_LOCK
        );
        stub = new BondResolverStub(IEscrow(address(escrow)));

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(stub));

        _fund(payer, 1_000_000e6);
        _fund(payee, 1_000_000e6);
    }

    function test_payerWhoWinsTheRulingGetsTheBondBack() public {
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

    function test_payerWhoLosesTheRulingForfeitsTheBondIntoTheResolverPot() public {
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

    function test_payeeWhoWinsTheRulingGetsTheBondBackOnTheSameEvenSplit() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        uint256 payeeBefore = asset.balanceOf(payee);
        vm.prank(payee);
        escrow.dispute(id);

        assertEq(asset.balanceOf(payee), payeeBefore - BOND, "payee posts the same bond the payer would");

        // The tie goes to whoever opened the dispute, whichever side that was: half a contested
        // payment is a result, so the disputer keeps its bond.
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.BondReturned(id, payee, BOND);
        stub.rule(id, HALF_BPS);

        assertEq(asset.balanceOf(payee), payeeBefore + 485_100_000, "payee paid and bonded back");
        assertEq(asset.balanceOf(address(stub)), RESOLVER_FEE, "no forfeiture to add to the pot");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "nothing stranded in the escrow");
    }

    function test_payeeWhoLosesTheRulingForfeitsTheBondIntoTheResolverPot() public {
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

    function test_theSameLockCannotBeDisputedTwiceToStackASecondBond() public {
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

    function test_resolvingTwiceCannotPayTheBondTwice() public {
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

    function test_aReopenAfterARulingCannotPayTheBondTwice() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payee);
        escrow.dispute(id);
        stub.rule(id, 0);

        uint256 payeeAfter = asset.balanceOf(payee);

        vm.expectRevert(IEscrow.BadStatus.selector);
        stub.reopen(id);

        assertEq(asset.balanceOf(payee), payeeAfter, "bond stays returned exactly once");
        assertEq(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "escrow holds only its fees");
    }

    function test_aRulingAfterAReopenCannotPayTheBondTwice() public {
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payee);
        escrow.dispute(id);
        stub.reopen(id);

        uint256 payeeAfter = asset.balanceOf(payee);

        vm.expectRevert(IEscrow.BadStatus.selector);
        stub.rule(id, BPS);

        assertEq(asset.balanceOf(payee), payeeAfter, "a late ruling cannot re-pay the bond");
        assertEq(asset.balanceOf(address(escrow)), AMOUNT, "only the reopened principal stays");
    }

    /// Whichever way the dispute closes first, the bond leaves the contract once. `reopenFirst`
    /// decides the order, `refundBps` decides whether a ruling returns the bond or forfeits it.
    function testFuzz_theBondLeavesTheEscrowExactlyOnceUnderEitherExitOrder(uint16 rawRefund, bool reopenFirst) public {
        uint16 refundBps = uint16(bound(uint256(rawRefund), 0, BPS));
        uint256 id = _lock(payer, payee, AMOUNT);

        vm.prank(payer);
        escrow.dispute(id);

        // Measured with the bond already posted, so every leg below is an inflow.
        uint256 payerBefore = asset.balanceOf(payer);
        uint256 payeeBefore = asset.balanceOf(payee);

        if (reopenFirst) {
            stub.reopen(id);
            vm.expectRevert(IEscrow.BadStatus.selector);
            stub.rule(id, refundBps);
        } else {
            stub.rule(id, refundBps);
            vm.expectRevert(IEscrow.BadStatus.selector);
            stub.reopen(id);
        }

        uint256 moved = (asset.balanceOf(payer) - payerBefore) + (asset.balanceOf(payee) - payeeBefore)
            + asset.balanceOf(address(stub));
        uint256 held = reopenFirst ? AMOUNT : 0;

        assertEq(escrow.getLock(id).bond, 0, "bond slot cleared");
        assertEq(asset.balanceOf(address(escrow)), held + escrow.feesAccrued(), "escrow holds only what it owes");
        assertEq(
            moved + held + escrow.feesAccrued(), uint256(AMOUNT) + BOND, "principal and bond leave the escrow once"
        );
    }

    /// What disputing every job costs a payee. A payee that locks its counterparty's money up by
    /// disputing every job pays a bond to do it, and loses the bond every time the ruling says the
    /// job was never delivered.
    function test_loopingLockAndDisputeCostsTheGrieferTheBondEveryRound() public {
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

    function test_aGrieferRunsOutOfBondBudgetBeforeItsTargetRunsOutOfPrincipal() public {
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

    function test_anApprovalSizedForTheLockDoesNotCoverTheDisputeBond() public {
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

    function test_aPayeeWithNoFundsCannotFreezeThePayersMoney() public {
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

    function test_noLockIsTooSmallToCarryABond() public {
        // 19 units at five percent would be 0.95 of a unit, which truncates away. The escrow
        // does not open a lock that small.
        vm.prank(payer);
        vm.expectRevert(IEscrow.BelowMinLock.selector);
        escrow.lock(payee, CAPABILITY, INPUT_COMMIT, "ipfs://in", 19, _deadline());

        uint256 smallest = _lock(payer, payee, MIN_LOCK);
        uint256 payerBefore = asset.balanceOf(payer);

        vm.prank(payer);
        escrow.dispute(smallest);

        assertEq(escrow.getLock(smallest).bond, _bps(MIN_LOCK, BOND_BPS), "the smallest lock prices its dispute");
        assertEq(asset.balanceOf(payer), payerBefore - _bps(MIN_LOCK, BOND_BPS), "and the bond is pulled");
    }

    function test_aZeroBondRateOpensDisputesWithoutPullingAnything() public {
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

    function test_disputingAReleasedLockChargesNoBondAndCannotBeRuledOn() public {
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

        vm.expectRevert(IEscrow.BadStatus.selector);
        stub.reopen(id);
    }

    function test_sweepingFeesCannotReachAPostedBond() public {
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

    function test_aRejectedRewardStillMovesTheForfeitedBondOutOfTheEscrow() public {
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

    function test_theConstructorRejectsABondRateAboveTheCeiling() public {
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
            MIN_LOCK
        );

        Rig memory rig = _deployRig(FEE_BPS, RESOLVER_FEE_BPS, 2_000);
        assertEq(rig.escrow.disputeBondBps(), 2_000, "a fifth of the principal is the most a bond can be");

        uint256 id = _lock(rig.escrow, payer, payee, AMOUNT);
        vm.prank(payer);
        rig.escrow.dispute(id);

        assertEq(rig.escrow.getLock(id).bond, 200e6, "and it is charged in full");
    }

    /// The settlement identity, checked against token balances:
    ///
    ///     refunded + paid + protocolFee + resolverFee + bondLeg == amount + bond
    function testFuzz_everyRulingConservesThePrincipalAndTheBond(
        uint128 rawAmount,
        uint16 rawRefund,
        uint16 rawFee,
        uint16 rawResolverFee,
        uint16 rawBond,
        bool payeeDisputes
    ) public {
        _ruleAndConserve(
            Case({
                amount: uint128(bound(uint256(rawAmount), MIN_LOCK, 1e15)),
                refundBps: uint16(bound(uint256(rawRefund), 0, BPS)),
                feeBps: uint16(bound(uint256(rawFee), 0, 1_000)),
                resolverFeeBps: uint16(bound(uint256(rawResolverFee), 0, 1_000)),
                bondBps: uint16(bound(uint256(rawBond), 0, 2_000)),
                payeeDisputes: payeeDisputes
            })
        );
    }

    function testFuzz_aReopenReturnsTheBondWholeAndKeepsThePrincipalForThePayee(
        uint128 rawAmount,
        uint16 rawBond,
        bool payeeDisputes
    ) public {
        uint128 amount = uint128(bound(uint256(rawAmount), MIN_LOCK, 1e15));
        uint16 bondBps = uint16(bound(uint256(rawBond), 0, 2_000));

        Rig memory rig = _deployRig(FEE_BPS, RESOLVER_FEE_BPS, bondBps);
        asset.mint(payer, 1e16);
        asset.mint(payee, 1e16);

        uint256 id = _lock(rig.escrow, payer, payee, amount);

        address disputer = payeeDisputes ? payee : payer;
        uint256 disputerBefore = asset.balanceOf(disputer);

        vm.prank(disputer);
        rig.escrow.dispute(id);
        rig.stub.reopen(id);

        assertEq(asset.balanceOf(disputer), disputerBefore, "bond returned whole");
        assertEq(uint8(rig.escrow.getLock(id).status), uint8(IEscrow.LockStatus.Locked), "the lock is open again");
        assertEq(rig.escrow.feesAccrued(), 0, "an unheard dispute earns the protocol nothing");
        assertEq(asset.balanceOf(address(rig.stub)), 0, "and the resolvers nothing");
        assertEq(asset.balanceOf(address(rig.escrow)), amount, "the principal waits for the payee");
    }

    /// End to end against the real registry: three resolvers rule that the job was never
    /// delivered, the payee that opened the dispute forfeits, and the bond turns up in what
    /// those three can claim.
    function test_aForfeitedBondIsClaimableByTheResolversThatRuled() public {
        Live memory live = _liveSystem();
        uint256 id = _lock(live.escrow, payer, payee, AMOUNT);

        vm.prank(payee);
        live.escrow.dispute(id);

        uint256 disputeId = live.oracle.disputeIdOf(id);
        for (uint256 i; i < live.resolvers.length; ++i) {
            _commit(live, disputeId, live.resolvers[i], 10);
        }

        vm.warp(live.oracle.getDispute(disputeId).commitEndsAt);
        for (uint256 i; i < live.resolvers.length; ++i) {
            vm.prank(live.resolvers[i]);
            live.oracle.revealVote(disputeId, 10, SALT);
        }

        live.oracle.finalize(disputeId);

        // A median of 10 is a full refund, so the payee that opened the dispute lost it.
        assertEq(uint8(live.escrow.getLock(id).status), uint8(IEscrow.LockStatus.Resolved), "lock settled");
        assertEq(asset.balanceOf(address(live.escrow)), 0, "escrow empty");

        uint256 claimed;
        for (uint256 i; i < live.resolvers.length; ++i) {
            vm.prank(live.resolvers[i]);
            claimed += live.oracle.claimRewards();
        }
        uint256 dust = live.oracle.sweepUnallocated();

        assertEq(claimed + dust, uint256(RESOLVER_FEE) + BOND, "the fee and the forfeited bond, to the unit");
        assertEq(live.oracle.rewardFloat(), 0, "nothing left over in the reward float");
        assertEq(live.oracle.totalBonded(), 300e18, "and no resolver bond was touched to pay it");
        assertEq(asset.balanceOf(address(live.oracle)), 0, "the registry keeps no settlement asset of its own");
        assertEq(live.bondToken.balanceOf(address(live.oracle)), 300e18, "the bonds are held in BRSR and untouched");
    }

    /// Nobody votes, the dispute fails, and the lock goes back to the payee with the bond back
    /// to whichever side opened it. An unheard dispute is never a refund and never a forfeit.
    function test_anUnheardDisputeReturnsTheBondToTheSideThatOpenedIt() public {
        Live memory live = _liveSystem();

        for (uint256 side; side < 2; ++side) {
            address disputer = side == 0 ? payer : payee;
            uint256 id = _lock(live.escrow, payer, payee, AMOUNT);
            uint64 deadline = live.escrow.getLock(id).deadline;
            uint256 before = asset.balanceOf(disputer);

            vm.prank(disputer);
            live.escrow.dispute(id);
            assertEq(asset.balanceOf(disputer), before - BOND, "the bond left with the dispute");

            uint256 disputeId = live.oracle.disputeIdOf(id);
            vm.warp(live.oracle.getDispute(disputeId).commitEndsAt);

            vm.expectEmit(true, true, false, true, address(live.escrow));
            emit IEscrow.BondReturned(id, disputer, BOND);
            live.oracle.failDispute(disputeId);

            IEscrow.Lock memory reopened = live.escrow.getLock(id);
            assertEq(asset.balanceOf(disputer), before, "the bond came back whole");
            assertEq(uint8(reopened.status), uint8(IEscrow.LockStatus.Locked), "the lock reopened");
            assertEq(reopened.bond, 0, "no bond is carried into the reopened lock");
            assertEq(reopened.deadline, deadline + MIN_TTL, "and the payee has its time back");
        }

        assertEq(asset.balanceOf(address(live.escrow)), 2 * uint256(AMOUNT), "only the two principals stay");
        assertEq(live.oracle.rewardFloat(), 0, "an unheard dispute pays no resolver");
    }

    /// Committers who never reveal lose BRSR, and the disputer's bond, which is in the settlement
    /// asset, comes back.
    function test_aFailedDisputeReturnsTheBondWhileTheSilentCommittersAreSlashed() public {
        Live memory live = _liveSystem();
        uint256 id = _lock(live.escrow, payer, payee, AMOUNT);
        uint256 payeeBefore = asset.balanceOf(payee);

        vm.prank(payee);
        live.escrow.dispute(id);

        // Two of three commit, short of the quorum, and neither reveals.
        uint256 disputeId = live.oracle.disputeIdOf(id);
        _commit(live, disputeId, live.resolvers[0], 90);
        _commit(live, disputeId, live.resolvers[1], 90);

        vm.warp(live.oracle.getDispute(disputeId).revealEndsAt);
        live.oracle.failDispute(disputeId);

        assertEq(asset.balanceOf(payee), payeeBefore, "the disputer's bond came back");
        assertEq(live.oracle.getResolver(live.resolvers[0]).slashes, 1, "silence was slashed");
        assertEq(live.oracle.getResolver(live.resolvers[1]).slashes, 1, "silence was slashed");
        assertEq(live.oracle.openVotes(live.resolvers[0]), 0, "and the bonds are free to leave");
        assertEq(asset.balanceOf(address(live.oracle)), 0, "no settlement asset reached the registry");
        assertEq(asset.balanceOf(address(live.escrow)), AMOUNT, "the principal stays with the reopened lock");
    }

    /// The disputer is frozen by the time the vote fails. The lock still reopens and the vote
    /// still closes; the bond waits in the escrow until the disputer can receive it.
    function test_aFrozenDisputerCannotHoldAFailedDisputeOpen() public {
        Live memory live = _liveSystem();
        uint256 id = _lock(live.escrow, payer, payee, AMOUNT);

        vm.prank(payee);
        live.escrow.dispute(id);

        uint256 disputeId = live.oracle.disputeIdOf(id);
        _commit(live, disputeId, live.resolvers[0], 90);

        asset.setFrozen(payee, true);
        vm.warp(live.oracle.getDispute(disputeId).revealEndsAt);
        live.oracle.failDispute(disputeId);

        assertEq(uint8(live.escrow.getLock(id).status), uint8(IEscrow.LockStatus.Locked), "the lock reopened");
        assertEq(live.escrow.owed(payee), BOND, "the bond was booked, not lost");
        assertEq(live.oracle.openVotes(live.resolvers[0]), 0, "the committer's bond is free again");

        asset.setFrozen(payee, false);
        uint256 payeeBefore = asset.balanceOf(payee);
        live.escrow.claim(payee);
        assertEq(asset.balanceOf(payee) - payeeBefore, BOND);
        assertEq(asset.balanceOf(address(live.escrow)), AMOUNT);
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

    function _liveSystem() private returns (Live memory live) {
        address admin = makeAddr("oracleAdmin");
        address sink = makeAddr("slashSink");

        MockReputation rep = new MockReputation();
        live.escrow = new Escrow(
            address(asset),
            address(rep),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            MIN_LOCK
        );
        live.oracle = new OracleRegistry(
            address(asset),
            admin,
            sink,
            IOracleRegistry.Config({
                commitWindow: 1 hours,
                revealWindow: 1 hours,
                unbondingPeriod: 7 days,
                quorum: 3,
                maxVoters: 64,
                maxDeviation: 10,
                slashBps: 500
            })
        );

        // Bonds are BRSR and the floor that admits one is the staking pool's. The rewards are
        // still USDG: the two are different tokens throughout.
        live.bondToken = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: makeAddr("brsrTeam"), treasury: treasury, liquidity: makeAddr("brsrLp")
            })
        );
        Staking pool = new Staking(live.bondToken, asset, admin, sink, treasury, 7 days, 100e18);

        rep.setEscrow(address(live.escrow));
        live.escrow.setResolver(address(live.oracle));
        live.oracle.setEscrow(address(live.escrow));
        live.oracle.setStaking(address(pool));

        live.resolvers = [makeAddr("resolverA"), makeAddr("resolverB"), makeAddr("resolverC")];
        for (uint256 i; i < live.resolvers.length; ++i) {
            live.bondToken.transfer(live.resolvers[i], 100e18);
            vm.startPrank(live.resolvers[i]);
            live.bondToken.approve(address(live.oracle), type(uint256).max);
            live.oracle.register(100e18);
            vm.stopPrank();
        }

        vm.prank(payer);
        asset.approve(address(live.escrow), type(uint256).max);
        vm.prank(payee);
        asset.approve(address(live.escrow), type(uint256).max);
    }

    /// Read the commitment before the prank: a call made while one is armed would spend it, and
    /// the vote would arrive from this test.
    function _commit(Live memory live, uint256 disputeId, address resolver, uint8 score) private {
        bytes32 commitment = live.oracle.commitmentHash(disputeId, resolver, score, SALT);
        vm.prank(resolver);
        live.oracle.commitVote(disputeId, commitment);
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
            MIN_LOCK
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

/// Drives the bonded lifecycle at random so the conservation identity is checked over long runs.
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
        uint128 amount = uint128(bound(uint256(rawAmount), escrow.minLock(), 10_000e6));

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

    function letTheVoteFail(uint256 idSeed) external {
        if (ids.length == 0) return;
        stub.reopen(ids[idSeed % ids.length]);
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
            address(asset), address(reputation), makeAddr("treasury"), 100, 200, 500, 1 hours, 30 days, 1 days, 10_000
        );
        stub = new BondResolverStub(IEscrow(address(escrow)));

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(stub));

        handler = new EscrowDisputeBondsHandler(escrow, asset, stub);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = EscrowDisputeBondsHandler.openLock.selector;
        selectors[1] = EscrowDisputeBondsHandler.rule.selector;
        selectors[2] = EscrowDisputeBondsHandler.letTheVoteFail.selector;
        selectors[3] = EscrowDisputeBondsHandler.releaseLock.selector;
        selectors[4] = EscrowDisputeBondsHandler.timeoutLock.selector;
        selectors[5] = EscrowDisputeBondsHandler.letTheClockRun.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// A bond paid out twice, or a principal paid out twice, shows up here as an escrow
    /// balance below what its open locks account for.
    function invariant_escrowHoldsOpenPrincipalPlusPostedBondsPlusFees() public view {
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

    function invariant_accruedFeesRemainCoveredByTheEscrowBalance() public view {
        assertGe(asset.balanceOf(address(escrow)), escrow.feesAccrued(), "fees are not backed by tokens");
    }
}
