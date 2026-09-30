// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Escrow} from "../src/Escrow.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";

import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockReputation} from "./mocks/MockReputation.sol";

/// The escrow-facing surface of the oracle registry, plus a seat to rule from. The vote itself
/// is another suite's subject; what matters here is that a ruling reaches the escrow.
contract CreditRulingStub {
    Escrow public immutable ESCROW;

    mapping(uint256 escrowId => uint256 disputeId) public disputeIdOf;

    uint256 public nextDisputeId = 1;
    uint256 public rewarded;

    constructor(Escrow escrow_) {
        ESCROW = escrow_;
    }

    function openDispute(uint256 escrowId, address, address) external returns (uint256 disputeId) {
        disputeId = nextDisputeId++;
        disputeIdOf[escrowId] = disputeId;
    }

    function notifyReward(uint256, uint256 amount) external {
        rewarded += amount;
    }

    function rule(uint256 escrowId, uint16 refundBps) external {
        ESCROW.resolve(escrowId, refundBps, 1);
    }

    function reopen(uint256 escrowId) external {
        ESCROW.reopen(escrowId);
    }
}

/// A payer that is a contract and has no idea what a spending mandate is. The escrow has to
/// refund it anyway.
contract HooklessPayer {
    function lock(Escrow escrow, MockUsdg asset, address payee, uint128 amount, uint64 deadline)
        external
        returns (uint256)
    {
        asset.approve(address(escrow), amount);
        return escrow.lock(payee, keccak256("capability"), keccak256("input"), "ipfs://job", amount, deadline);
    }
}

/// A payer that burns every unit of gas it is handed. The escrow calls the credit hook on the
/// same ruling that pays the payee, so an uncapped call here would let a payer starve its
/// counterparty's settlement and hold the dispute open for good.
contract GreedyPayer {
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
        while (true) {
            // Spin until the stipend runs out.
        }
    }
}

/// The mandate and the escrow are two halves of one limit. The account books a spend against
/// the day's allowance the moment it locks, so every escrow exit that does not pay the merchant
/// has to hand that allowance back. A cancelled job that still costs the mandate its budget is
/// the failure this file exists to catch.
///
/// Windows are set long enough that none of these cases rolls one. A credit that lands after
/// its window has rolled is dropped, and that behaviour belongs to the windows suite.
contract MandateCreditTest is Test {
    uint128 internal constant PER_CALL_CAP = 1_000e6;
    uint128 internal constant DAILY_CAP = 5_000e6;
    uint128 internal constant MONTHLY_CAP = 50_000e6;
    uint128 internal constant LOCK = 1_000e6;
    uint128 internal constant FUNDING = 10_000e6;

    uint16 internal constant FEE_BPS = 100;
    uint16 internal constant RESOLVER_FEE_BPS = 200;
    uint16 internal constant DISPUTE_BOND_BPS = 500;

    uint64 internal constant MIN_TTL = 1 hours;
    uint64 internal constant MAX_TTL = 30 days;
    uint64 internal constant DISPUTE_WINDOW = 1 days;
    uint128 internal constant MIN_LOCK = 10_000;

    bytes32 internal constant CAPABILITY = keccak256("mandate.credit.capability");

    /// 5% of the lock, matching the escrow's own truncation.
    uint128 internal constant BOND = (LOCK * DISPUTE_BOND_BPS) / 10_000;

    /// 2% of the lock, taken off the top of any ruling and never credited back: it was spent.
    uint128 internal constant RESOLVER_FEE = (LOCK * RESOLVER_FEE_BPS) / 10_000;

    MockUsdg internal asset;
    MockReputation internal reputation;
    Escrow internal escrow;
    CreditRulingStub internal resolver;
    MandateAccountFactory internal factory;
    MandateAccount internal account;

    address internal principal = makeAddr("principal");
    address internal agent = makeAddr("agent");
    address internal merchant = makeAddr("merchant");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_700_000_000);

        asset = new MockUsdg();
        reputation = new MockReputation();

        escrow = new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            DISPUTE_BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            MIN_LOCK
        );
        reputation.setEscrow(address(escrow));

        resolver = new CreditRulingStub(escrow);
        escrow.setResolver(address(resolver));

        factory = new MandateAccountFactory(address(escrow), address(asset));
        vm.prank(principal);
        account = MandateAccount(
            factory.create(
                principal,
                agent,
                bytes32(uint256(1)),
                IMandateAccount.Limits({
                    perCallCap: PER_CALL_CAP,
                    dailyCap: DAILY_CAP,
                    monthlyCap: MONTHLY_CAP,
                    dailyWindow: 7 days,
                    monthlyWindow: 90 days,
                    approvalThreshold: type(uint128).max,
                    validFrom: 0,
                    validUntil: 0,
                    classMask: 3,
                    totalCap: 0,
                    lane: 0
                })
            )
        );

        vm.startPrank(principal);
        account.setCapability(CAPABILITY, true);
        account.setMerchant(merchant, true);
        vm.stopPrank();

        asset.mint(address(account), FUNDING);

        // The merchant contests open locks in two cases below, and contesting costs a bond.
        asset.mint(merchant, BOND * 4);
        vm.prank(merchant);
        asset.approve(address(escrow), type(uint256).max);
    }

    function test_cancelHandsTheMandateBackItsAllowance() public {
        uint256 id = _spend();
        assertEq(_dailySpent(), LOCK);

        vm.prank(merchant);
        escrow.cancel(id);

        assertEq(_dailySpent(), 0, "a declined job still cost the mandate its budget");
        assertEq(_monthlySpent(), 0);
        assertEq(account.creditable(id), 0);
        assertEq(asset.balanceOf(address(account)), FUNDING);
    }

    function test_timeoutHandsTheMandateBackItsAllowance() public {
        uint256 id = _spend();

        vm.warp(escrow.getLock(id).deadline + 1);
        escrow.timeout(id);

        assertEq(_dailySpent(), 0, "an unanswered job still cost the mandate its budget");
        assertEq(_monthlySpent(), 0);
        assertEq(asset.balanceOf(address(account)), FUNDING);
    }

    /// The merchant was paid, so the allowance stays spent. Crediting here would let an agent
    /// churn settled locks and spend its daily cap many times over.
    function test_aSettledJobLeavesTheAllowanceSpent() public {
        uint256 id = _spend();

        vm.prank(merchant);
        escrow.release(id, keccak256("output"), "ipfs://out");

        assertEq(_dailySpent(), LOCK);
        assertEq(account.creditable(id), LOCK);
    }

    function test_aRulingCreditsTheRefundedLegAndLeavesTheRestSpent() public {
        uint256 id = _spend();

        vm.prank(merchant);
        escrow.dispute(id);

        resolver.rule(id, 4_000);

        // Two per cent of the lock pays the resolvers, forty per cent of what is left goes
        // back to the payer, and only that leg is allowance the mandate never used.
        uint128 refunded = ((LOCK - RESOLVER_FEE) * 4_000) / 10_000;

        assertEq(_dailySpent(), LOCK - refunded);
        assertEq(_monthlySpent(), LOCK - refunded);
        assertEq(account.creditable(id), LOCK - refunded);
    }

    /// A dispute nobody heard reopens the lock rather than refunding it, so the allowance stays
    /// with the lock until the lock itself exits.
    function test_anUnheardDisputeLeavesTheAllowanceWithTheReopenedLock() public {
        uint256 id = _spend();

        vm.prank(merchant);
        escrow.dispute(id);
        resolver.reopen(id);

        assertEq(_dailySpent(), LOCK, "a reopened lock is still a live spend");
        assertEq(account.creditable(id), LOCK);

        vm.warp(escrow.getLock(id).deadline + 1);
        escrow.timeout(id);

        assertEq(_dailySpent(), 0, "the exit that ended the lock handed the budget back");
        assertEq(asset.balanceOf(address(account)), FUNDING);
    }

    /// Most payers are plain addresses, and a contract payer may have no hook at all. Neither
    /// may be able to hold up its own refund.
    function test_aPayerWithNoCreditHookIsStillRefunded() public {
        HooklessPayer payer = new HooklessPayer();
        asset.mint(address(payer), LOCK);

        uint64 deadline = uint64(block.timestamp) + 2 hours;
        uint256 id = payer.lock(escrow, asset, merchant, LOCK, deadline);

        vm.expectEmit(true, false, false, false, address(escrow));
        emit IEscrow.PayerCreditFailed(id);

        vm.prank(merchant);
        escrow.cancel(id);

        assertEq(asset.balanceOf(address(payer)), LOCK);
    }

    function test_anEoaPayerRefundEmitsNoCreditFailure() public {
        address payer = makeAddr("payer");
        asset.mint(payer, LOCK);

        vm.startPrank(payer);
        asset.approve(address(escrow), LOCK);
        uint256 id = escrow.lock(
            merchant, CAPABILITY, keccak256("input"), "ipfs://job", LOCK, uint64(block.timestamp) + 2 hours
        );
        vm.stopPrank();

        vm.recordLogs();
        vm.prank(merchant);
        escrow.cancel(id);

        bytes32 failure = IEscrow.PayerCreditFailed.selector;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != failure, "a plain address was treated as a mandate");
        }
        assertEq(asset.balanceOf(payer), LOCK);
    }

    /// The account is the payer on every lock it opened, so it is the only address that can
    /// contest one. A bonded dispute it cannot fund is a dispute the principal cannot raise.
    function test_thePrincipalCanContestItsOwnLock() public {
        uint256 id = _spend();

        vm.prank(principal);
        account.disputeSpend(id);

        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Disputed));
        assertEq(escrow.getLock(id).disputer, address(account));
        assertEq(escrow.getLock(id).bond, BOND);
        assertEq(asset.balanceOf(address(account)), FUNDING - LOCK - BOND);
    }

    function test_contestingALockLeavesNoStandingAllowance() public {
        uint256 id = _spend();

        vm.prank(principal);
        account.disputeSpend(id);

        assertEq(asset.allowance(address(account), address(escrow)), 0);
    }

    function test_onlyThePrincipalCanContest() public {
        uint256 id = _spend();

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotPrincipal.selector);
        account.disputeSpend(id);
    }

    function test_aRulingForThePayerReturnsTheBondAndCreditsTheRefund() public {
        uint256 id = _spend();

        vm.prank(principal);
        account.disputeSpend(id);

        resolver.rule(id, 10_000);

        uint128 refunded = LOCK - RESOLVER_FEE;

        assertEq(asset.balanceOf(address(account)), FUNDING - RESOLVER_FEE, "the bond did not come back");
        assertEq(_dailySpent(), RESOLVER_FEE, "the refunded leg was not credited");
        assertEq(account.creditable(id), LOCK - refunded);
    }

    function test_aRulingAgainstThePayerForfeitsTheBondAndCreditsNothing() public {
        uint256 id = _spend();

        vm.prank(principal);
        account.disputeSpend(id);

        resolver.rule(id, 0);

        assertEq(asset.balanceOf(address(account)), FUNDING - LOCK - BOND);
        assertEq(_dailySpent(), LOCK);
        assertEq(resolver.rewarded(), RESOLVER_FEE + BOND, "the forfeited bond did not join the reward");
    }

    /// Ruled inside a gas budget a real transaction would carry. An uncapped hook takes
    /// sixty-three sixty-fourths of whatever is left and the ruling runs out before it can pay
    /// the payee; the stipend leaves the rest of the call untouched.
    function test_aPayerThatBurnsItsStipendCannotStarveTheRuling() public {
        GreedyPayer payer = new GreedyPayer();
        asset.mint(address(payer), LOCK + BOND);

        uint64 deadline = uint64(block.timestamp) + 2 hours;
        uint256 id = payer.lock(escrow, asset, merchant, LOCK, deadline);
        payer.dispute(escrow, asset, id, BOND);

        uint256 payeeBefore = asset.balanceOf(merchant);

        // A split ruling, so the refund leg is non-zero and the hook fires.
        (bool ruled,) = address(resolver).call{gas: 500_000}(abi.encodeCall(CreditRulingStub.rule, (id, uint16(4_000))));
        assertTrue(ruled, "a payer starved the ruling that pays its counterparty");

        uint128 awarded = (LOCK - RESOLVER_FEE) - ((LOCK - RESOLVER_FEE) * 4_000) / 10_000;
        assertEq(asset.balanceOf(merchant) - payeeBefore, awarded - (awarded * FEE_BPS) / 10_000);
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Resolved));
    }

    function _spend() private returns (uint256 id) {
        vm.prank(agent);
        id = account.spend(
            IMandateAccount.SpendRequest({
                merchant: merchant,
                capabilityId: CAPABILITY,
                inputCommit: keccak256("input"),
                inputURI: "ipfs://job",
                amount: LOCK,
                deadline: uint64(block.timestamp) + 2 hours,
                spendClass: 0
            }),
            new bytes32[](0)
        );
    }

    function _dailySpent() private view returns (uint128) {
        return account.window(IMandateAccount.WindowKind.Daily).spent;
    }

    function _monthlySpent() private view returns (uint128) {
        return account.window(IMandateAccount.WindowKind.Monthly).spent;
    }
}
