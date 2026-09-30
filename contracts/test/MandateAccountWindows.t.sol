// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Escrow} from "../src/Escrow.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {Reputation} from "../src/Reputation.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";

/// Stands in for the escrow on the two calls the windows depend on: it takes the locked
/// amount at `lock`, and it hands allowance back through `creditSpend`.
///
/// The real escrow is exercised at the end of this file. Everything before that is about the
/// two buckets and nothing else, so the lock path here carries no deadline bounds, no
/// reputation cap and no dispute machinery to trip over while the window under test rolls.
contract WindowEscrowStub {
    using SafeERC20 for IERC20;

    error NotHolding();

    IERC20 public asset;
    uint256 public nextId = 1;

    mapping(uint256 id => address) public payerOf;
    mapping(uint256 id => address) public payeeOf;
    mapping(uint256 id => uint128) public heldOf;

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    function lock(address payee, bytes32, bytes32, string calldata, uint128 amount, uint64)
        external
        returns (uint256 id)
    {
        id = nextId++;
        payerOf[id] = msg.sender;
        payeeOf[id] = payee;
        heldOf[id] = amount;

        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// The money leg and the accounting leg together, which is how every real exit that did
    /// not pay the merchant behaves: the funds go back to the payer and the mandate is told
    /// which lock they came from.
    function refund(IMandateAccount account, uint256 id, uint128 amount) external {
        uint128 held = heldOf[id];
        if (held < amount) revert NotHolding();

        heldOf[id] = held - amount;
        asset.safeTransfer(payerOf[id], amount);

        account.creditSpend(id, amount);
    }

    /// The accounting leg alone, for the tests that probe the mandate's own guards on ids it
    /// never opened and on amounts it never committed.
    function forwardCredit(IMandateAccount account, uint256 id, uint128 amount) external {
        account.creditSpend(id, amount);
    }
}

/// Drives the mandate through arbitrary interleavings of spends, refunds, clock jumps and
/// limit rewrites, and keeps a shadow ledger of what each window epoch was told to hold.
///
/// The ledger stays naive: it adds on a settled spend and subtracts on a refund that landed
/// in the same epoch. If the account's own lazy rollover ever disagrees with it,
/// either a bucket is carrying spend from a window that already closed, or a refund refilled
/// one that had moved on.
contract MandateWindowsHandler is Test {
    MandateAccount public account;
    WindowEscrowStub public stub;
    MockUsdg public token;
    address public principal;
    address[3] public merchants;

    bytes32 public constant CAPABILITY = keccak256("mandate.windows");

    uint256 public spends;
    uint256 public refusals;
    uint256 public credits;
    uint256 public retunes;
    uint256 public totalLocked;
    uint256 public totalReturned;

    /// A spend the mandate refused although it fitted every cap that was live when it was
    /// quoted. The caps are the backstop, so this has to stay at zero.
    uint256 public unjustifiedRefusals;

    /// A settled spend left a bucket carrying more than the cap that admitted it.
    bool public overspent;

    /// A refund returned more allowance to an epoch than that epoch ever committed, which is
    /// spend going negative by another name.
    bool public overcredited;

    mapping(uint64 epoch => uint256) public committedDaily;
    mapping(uint64 epoch => uint256) public creditedDaily;
    mapping(uint64 epoch => uint256) public committedMonthly;
    mapping(uint64 epoch => uint256) public creditedMonthly;

    uint256[] private _ids;
    mapping(uint256 id => uint64) private _dailyEpochOf;
    mapping(uint256 id => uint64) private _monthlyEpochOf;

    constructor(
        MandateAccount account_,
        WindowEscrowStub stub_,
        MockUsdg token_,
        address principal_,
        address[3] memory merchants_
    ) {
        account = account_;
        stub = stub_;
        token = token_;
        principal = principal_;
        merchants = merchants_;
    }

    function spend(uint256 amountSeed, uint256 merchantSeed) external {
        IMandateAccount.Limits memory live = account.limits();
        // One unit past the per-call cap, so most draws settle and the sequence still probes
        // the first amount each cap is supposed to block.
        uint128 amount = uint128(bound(amountSeed, 1, uint256(live.perCallCap) + 1));
        address merchant = merchants[merchantSeed % merchants.length];

        (, uint128 dailyRoom, uint128 monthlyRoom) = account.remaining();
        bool fits = amount <= live.perCallCap && amount <= dailyRoom && amount <= monthlyRoom;

        // Funding is not what this suite is testing, so the mandate is never short.
        token.mint(address(account), amount);

        try account.spend(_request(merchant, amount), new bytes32[](0)) returns (uint256 id) {
            ++spends;
            totalLocked += amount;

            IMandateAccount.Window memory daily = account.window(IMandateAccount.WindowKind.Daily);
            IMandateAccount.Window memory monthly = account.window(IMandateAccount.WindowKind.Monthly);

            if (daily.spent > daily.cap || monthly.spent > monthly.cap) overspent = true;

            committedDaily[daily.epoch] += amount;
            committedMonthly[monthly.epoch] += amount;

            _dailyEpochOf[id] = daily.epoch;
            _monthlyEpochOf[id] = monthly.epoch;
            _ids.push(id);
        } catch {
            ++refusals;
            if (fits) ++unjustifiedRefusals;
        }
    }

    function refund(uint256 idSeed, uint256 amountSeed) external {
        if (_ids.length == 0) return;

        uint256 id = _ids[idSeed % _ids.length];
        uint128 open = account.creditable(id);
        if (open == 0) return;

        uint128 amount = uint128(bound(amountSeed, 1, open));

        stub.refund(account, id, amount);

        ++credits;
        totalReturned += amount;

        // Read after the call: `creditSpend` persists the same rollover it judged the epoch
        // against, so these are the epochs the account itself compared.
        IMandateAccount.Window memory daily = account.window(IMandateAccount.WindowKind.Daily);
        IMandateAccount.Window memory monthly = account.window(IMandateAccount.WindowKind.Monthly);

        if (daily.epoch == _dailyEpochOf[id]) {
            creditedDaily[daily.epoch] += amount;
            if (creditedDaily[daily.epoch] > committedDaily[daily.epoch]) overcredited = true;
        }
        if (monthly.epoch == _monthlyEpochOf[id]) {
            creditedMonthly[monthly.epoch] += amount;
            if (creditedMonthly[monthly.epoch] > committedMonthly[monthly.epoch]) overcredited = true;
        }
    }

    /// Weighted onto the edges of both periods. A uniform jump almost never lands on the
    /// second a window turns over, and that second is where the accounting is thinnest.
    function warp(uint256 seed) external {
        IMandateAccount.Limits memory live = account.limits();
        uint256 daily = live.dailyWindow;
        uint256 monthly = live.monthlyWindow;

        uint256 step;
        uint256 pick = seed % 8;
        if (pick == 0) step = 1;
        else if (pick == 1) step = daily > 1 ? daily - 1 : 1;
        else if (pick == 2) step = daily;
        else if (pick == 3) step = daily + 1;
        else if (pick == 4) step = monthly > 1 ? monthly - 1 : 1;
        else if (pick == 5) step = monthly;
        else if (pick == 6) step = monthly + 1;
        else step = bound(seed, 1, 45 days);

        vm.warp(block.timestamp + step);
    }

    function retune(uint256 dailyCapSeed, uint256 monthlyCapSeed, uint256 dailyWindowSeed, uint256 monthlyWindowSeed)
        external
    {
        IMandateAccount.Limits memory live = account.limits();

        IMandateAccount.Limits memory next = IMandateAccount.Limits({
            perCallCap: live.perCallCap,
            dailyCap: uint128(bound(dailyCapSeed, 1, 100_000e6)),
            monthlyCap: uint128(bound(monthlyCapSeed, 1, 1_000_000e6)),
            dailyWindow: uint64(bound(dailyWindowSeed, 1 hours, 7 days)),
            monthlyWindow: uint64(bound(monthlyWindowSeed, 1 days, 60 days)),
            // Consent routing is a different test. Holding the threshold open keeps every
            // refusal here attributable to a cap.
            approvalThreshold: type(uint128).max,
            validFrom: 0,
            validUntil: 0,
            classMask: 3,
            totalCap: 0,
            lane: 0
        });

        vm.prank(principal);
        account.setLimits(next);

        ++retunes;
    }

    function _request(address merchant, uint128 amount) private view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: merchant,
            capabilityId: CAPABILITY,
            inputCommit: keccak256(abi.encode(merchant, amount, block.timestamp)),
            inputURI: "ipfs://mandate-windows",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }
}

/// The daily and the monthly bucket bind at the same time, and the agent feels whichever is
/// tighter. These tests hold both against the clock: a window advances by whole periods, an
/// elapsed remainder stays on the clock, a refund that arrives after its window closed is
/// dropped, and rewriting the limits re-anchors both windows without handing back allowance
/// that was already spent.
contract MandateAccountWindowsTest is Test {
    uint64 private constant START = 1_780_000_000;

    uint64 private constant DAILY_WINDOW = 1 days;
    uint64 private constant MONTHLY_WINDOW = 30 days;

    // Six decimals, the settlement asset's own units.
    uint128 private constant PER_CALL_CAP = 500e6;
    uint128 private constant DAILY_CAP = 1_000e6;
    uint128 private constant MONTHLY_CAP = 6_000e6;

    bytes32 private constant CAPABILITY = keccak256("mandate.windows");

    address private principal = makeAddr("principal");
    address private agent = makeAddr("agent");
    address private merchantA = makeAddr("merchantA");
    address private merchantB = makeAddr("merchantB");
    address private merchantC = makeAddr("merchantC");
    address private outsider = makeAddr("outsider");

    MockUsdg private token;

    WindowEscrowStub private stub;
    MandateAccount private account;

    /// The stateful rig runs on its own account and its own stub, so the handler's agent and
    /// its shadow ledger never share state with the cases below.
    WindowEscrowStub private fuzzStub;
    MandateAccount private fuzzAccount;
    MandateWindowsHandler private handler;

    function setUp() public {
        vm.warp(START);

        token = new MockUsdg();

        stub = new WindowEscrowStub(IERC20(address(token)));
        account = _deploy(address(stub), _baseLimits());

        fuzzStub = new WindowEscrowStub(IERC20(address(token)));
        fuzzAccount = _deploy(address(fuzzStub), _baseLimits());

        address[3] memory roster = [merchantA, merchantB, merchantC];
        handler = new MandateWindowsHandler(fuzzAccount, fuzzStub, token, principal, roster);

        vm.startPrank(principal);
        fuzzAccount.setAgent(address(handler));
        fuzzAccount.setMerchant(merchantC, true);
        vm.stopPrank();

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = MandateWindowsHandler.spend.selector;
        selectors[1] = MandateWindowsHandler.refund.selector;
        selectors[2] = MandateWindowsHandler.warp.selector;
        selectors[3] = MandateWindowsHandler.retune.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_noSettledSpendEverLeftABucketAboveItsCap() public view {
        assertFalse(handler.overspent(), "a settled spend left a window carrying more than its cap");
    }

    function invariant_noRefundEverReturnedMoreThanItsEpochCommitted() public view {
        assertFalse(handler.overcredited(), "a refund credited an epoch more than that epoch ever spent");
    }

    function invariant_eachWindowCarriesWhatItsLiveEpochCommittedLessWhatCameBack() public view {
        IMandateAccount.Window memory daily = fuzzAccount.window(IMandateAccount.WindowKind.Daily);
        IMandateAccount.Window memory monthly = fuzzAccount.window(IMandateAccount.WindowKind.Monthly);

        assertEq(
            uint256(daily.spent),
            handler.committedDaily(daily.epoch) - handler.creditedDaily(daily.epoch),
            "daily bucket disagrees with the spends booked against its epoch"
        );
        assertEq(
            uint256(monthly.spent),
            handler.committedMonthly(monthly.epoch) - handler.creditedMonthly(monthly.epoch),
            "monthly bucket disagrees with the spends booked against its epoch"
        );
    }

    function invariant_headroomNeverExceedsTheCapThatGrantsIt() public view {
        IMandateAccount.Limits memory live = fuzzAccount.limits();
        (, uint128 daily, uint128 monthly) = fuzzAccount.remaining();

        assertLe(daily, live.dailyCap, "daily headroom above the daily cap");
        assertLe(monthly, live.monthlyCap, "monthly headroom above the monthly cap");
    }

    function invariant_neitherWindowStartsInTheFutureOrLagsAWholePeriod() public view {
        IMandateAccount.Window memory daily = fuzzAccount.window(IMandateAccount.WindowKind.Daily);
        IMandateAccount.Window memory monthly = fuzzAccount.window(IMandateAccount.WindowKind.Monthly);

        assertLe(uint256(daily.start), block.timestamp, "daily window starts in the future");
        assertLe(uint256(monthly.start), block.timestamp, "monthly window starts in the future");
        // A window left a whole period behind the clock is one that failed to roll, which is
        // how an agent ends up holding a bucket it should already have been charged for.
        assertLt(block.timestamp - daily.start, daily.duration, "daily window failed to roll");
        assertLt(block.timestamp - monthly.start, monthly.duration, "monthly window failed to roll");
    }

    function invariant_noSpendThatFittedBothWindowsWasEverRefused() public view {
        assertEq(handler.unjustifiedRefusals(), 0, "a spend inside every live cap was refused");
    }

    function invariant_theEscrowHoldsEveryLockedUnitAndNoOther() public view {
        assertEq(
            token.balanceOf(address(fuzzStub)),
            handler.totalLocked() - handler.totalReturned(),
            "escrow holdings drifted from what the mandate committed"
        );
    }

    function test_theDailyWindowHoldsThroughTheLastSecondOfItsPeriod() public {
        _spend(account, DAILY_CAP / 2);
        _spend(account, DAILY_CAP / 2);

        vm.warp(START + DAILY_WINDOW - 1);

        (, uint128 daily,) = account.remaining();
        assertEq(daily, 0);

        (bool allowed, bytes4 reason) = account.previewSpend(merchantA, CAPABILITY, 1, 0);
        assertFalse(allowed);
        _assertReason(reason, IMandateAccount.DailyCapExceeded.selector);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        account.spend(_request(merchantA, 1), _noProof());
    }

    function test_theDailyWindowRollsOnTheSecondItsPeriodElapses() public {
        _spend(account, DAILY_CAP / 2);
        _spend(account, DAILY_CAP / 2);

        vm.warp(START + DAILY_WINDOW);

        // The view rolls before storage does. A quote taken now matches the spend that follows
        // it, not the stale bucket underneath.
        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP);

        _spend(account, PER_CALL_CAP);

        IMandateAccount.Window memory window = account.window(IMandateAccount.WindowKind.Daily);
        assertEq(window.epoch, 1);
        assertEq(window.start, START + DAILY_WINDOW);
        assertEq(window.spent, PER_CALL_CAP);
    }

    function test_aWindowRollsByWholePeriodsSoWaitingDoesNotBuyAFreshClock() public {
        _spend(account, DAILY_CAP / 2);
        _spend(account, DAILY_CAP / 2);

        // Six hours into the second period. Snapping the window to now would hand the agent a
        // full day dated from the moment it chose to come back.
        vm.warp(START + DAILY_WINDOW + 6 hours);
        _spend(account, 1);

        IMandateAccount.Window memory window = account.window(IMandateAccount.WindowKind.Daily);
        assertEq(window.start, START + DAILY_WINDOW);
        assertEq(window.epoch, 1);

        _spend(account, PER_CALL_CAP);
        _spend(account, DAILY_CAP - PER_CALL_CAP - 1);

        // Eighteen hours after that first spend, not twenty-four.
        vm.warp(START + 2 * DAILY_WINDOW - 1);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        account.spend(_request(merchantA, 1), _noProof());

        vm.warp(START + 2 * DAILY_WINDOW);
        _spend(account, PER_CALL_CAP);
        _spend(account, PER_CALL_CAP);

        window = account.window(IMandateAccount.WindowKind.Daily);
        assertEq(window.start, START + 2 * DAILY_WINDOW);
        assertEq(window.epoch, 2);
        assertEq(window.spent, DAILY_CAP);
    }

    function test_aWindowIdleForSeveralPeriodsRollsOnceAndKeepsTheRemainder() public {
        vm.warp(START + 3 * DAILY_WINDOW + 5 hours);
        _spend(account, 1);

        IMandateAccount.Window memory window = account.window(IMandateAccount.WindowKind.Daily);
        // Epochs count resets, not elapsed periods: three idle days are one reset.
        assertEq(window.epoch, 1);
        assertEq(window.start, START + 3 * DAILY_WINDOW);

        _spend(account, PER_CALL_CAP);
        _spend(account, DAILY_CAP - PER_CALL_CAP - 1);

        // The remainder of the period the agent woke up in is still on the clock. The next
        // reset is nineteen hours out, not a full day.
        vm.warp(START + 4 * DAILY_WINDOW - 1);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        account.spend(_request(merchantA, 1), _noProof());

        vm.warp(START + 4 * DAILY_WINDOW);
        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP);
    }

    function test_theMonthlyWindowFreesTheAgentOnlyOnceTheWholeMonthElapses() public {
        _exhaustMonth(account);

        vm.warp(START + MONTHLY_WINDOW - 1);
        (,, uint128 monthly) = account.remaining();
        assertEq(monthly, 0);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.MonthlyCapExceeded.selector);
        account.spend(_request(merchantA, 1), _noProof());

        vm.warp(START + MONTHLY_WINDOW);
        (,, monthly) = account.remaining();
        assertEq(monthly, MONTHLY_CAP);

        _spend(account, PER_CALL_CAP);

        IMandateAccount.Window memory window = account.window(IMandateAccount.WindowKind.Monthly);
        assertEq(window.epoch, 1);
        assertEq(window.start, START + MONTHLY_WINDOW);
    }

    function test_aSpendThatFitsTheDailyCapButNotTheMonthlyIsRefusedByTheMonthly() public {
        IMandateAccount.Limits memory limits = _baseLimits();
        limits.perCallCap = 1_000e6;
        limits.dailyCap = 1_000e6;
        limits.monthlyCap = 1_500e6;
        MandateAccount tight = _deploy(address(stub), limits);

        _spend(tight, 1_000e6);

        vm.warp(START + DAILY_WINDOW);

        (, uint128 daily, uint128 monthly) = tight.remaining();
        assertEq(daily, 1_000e6, "the daily bucket did not roll");
        assertEq(monthly, 500e6, "the monthly bucket rolled with it");

        (bool allowed, bytes4 reason) = tight.previewSpend(merchantA, CAPABILITY, 600e6, 0);
        assertFalse(allowed);
        _assertReason(reason, IMandateAccount.MonthlyCapExceeded.selector);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.MonthlyCapExceeded.selector);
        tight.spend(_request(merchantA, 600e6), _noProof());

        _spend(tight, 500e6);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.MonthlyCapExceeded.selector);
        tight.spend(_request(merchantA, 1), _noProof());
    }

    function test_theMonthlyCapKeepsBindingWhileTheDailyWindowRollsUnderIt() public {
        IMandateAccount.Limits memory limits = _baseLimits();
        limits.perCallCap = 1_000e6;
        limits.dailyCap = 1_000e6;
        limits.monthlyCap = 2_500e6;
        MandateAccount tight = _deploy(address(stub), limits);

        _spend(tight, 1_000e6);

        vm.warp(START + DAILY_WINDOW);
        _spend(tight, 1_000e6);

        vm.warp(START + 2 * DAILY_WINDOW);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.MonthlyCapExceeded.selector);
        tight.spend(_request(merchantA, 1_000e6), _noProof());

        _spend(tight, 500e6);

        // A fresh daily bucket on the fourth day, and no month left to draw it from.
        vm.warp(START + 3 * DAILY_WINDOW);
        (, uint128 daily, uint128 monthly) = tight.remaining();
        assertEq(daily, 1_000e6);
        assertEq(monthly, 0);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.MonthlyCapExceeded.selector);
        tight.spend(_request(merchantA, 1), _noProof());

        vm.warp(START + MONTHLY_WINDOW);
        _spend(tight, 1_000e6);
    }

    function test_whenBothCapsBindTheDailyOneIsTheRefusalTheAgentSees() public {
        IMandateAccount.Limits memory limits = _baseLimits();
        limits.perCallCap = 1_000e6;
        limits.dailyCap = 400e6;
        limits.monthlyCap = 400e6;
        MandateAccount tight = _deploy(address(stub), limits);

        (, uint128 daily, uint128 monthly) = tight.remaining();
        assertEq(daily, monthly);

        _spend(tight, 400e6);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        tight.spend(_request(merchantA, 1), _noProof());
    }

    function test_aSpendOfExactlyTheRemainingHeadroomClearsAndTheNextUnitDoesNot() public {
        _spend(account, 400e6);

        (, uint128 daily,) = account.remaining();
        assertEq(daily, 600e6);

        _spend(account, 100e6);
        _spend(account, 500e6);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        account.spend(_request(merchantA, 1), _noProof());

        IMandateAccount.Window memory window = account.window(IMandateAccount.WindowKind.Daily);
        assertEq(window.spent, DAILY_CAP);
        assertEq(window.spent, window.cap);
    }

    function test_aRefundInsideTheSameWindowReturnsAllowanceToBothBuckets() public {
        uint256 id = _spend(account, 400e6);

        vm.expectEmit(true, false, false, true, address(account));
        emit IMandateAccount.SpendCredited(id, 400e6, 0, 0);
        stub.refund(account, id, 400e6);

        (, uint128 daily, uint128 monthly) = account.remaining();
        assertEq(daily, DAILY_CAP);
        assertEq(monthly, MONTHLY_CAP);
        assertEq(account.creditable(id), 0);
    }

    function test_aRefundAfterTheDailyWindowRolledDoesNotRefillTheFreshBucket() public {
        uint256 id = _spend(account, 400e6);

        vm.warp(START + DAILY_WINDOW);
        _spend(account, 100e6);

        // The daily allowance this lock consumed expired with its window. The monthly bucket,
        // which has not rolled, is the only one still holding the spend.
        vm.expectEmit(true, false, false, true, address(account));
        emit IMandateAccount.SpendCredited(id, 400e6, 100e6, 100e6);
        stub.refund(account, id, 400e6);

        (, uint128 daily, uint128 monthly) = account.remaining();
        assertEq(daily, DAILY_CAP - 100e6, "a closed window was refilled by a late refund");
        assertEq(monthly, MONTHLY_CAP - 100e6);
    }

    function test_aRefundAfterBothWindowsRolledIsDroppedEntirely() public {
        uint256 id = _spend(account, 400e6);

        vm.warp(START + MONTHLY_WINDOW + 1);
        _spend(account, 100e6);

        stub.refund(account, id, 400e6);

        (, uint128 daily, uint128 monthly) = account.remaining();
        assertEq(daily, DAILY_CAP - 100e6);
        assertEq(monthly, MONTHLY_CAP - 100e6);
        // The refund still closes the lock out although it credited nothing, so the same
        // allowance cannot be claimed again once the accounting turns in its favour.
        assertEq(account.creditable(id), 0);
    }

    function test_aPartialRefundLeavesTheRestCommittedAndCanBeFinishedLater() public {
        uint256 id = _spend(account, 400e6);

        stub.refund(account, id, 150e6);
        assertEq(account.creditable(id), 250e6);

        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP - 250e6);

        stub.refund(account, id, 250e6);
        assertEq(account.creditable(id), 0);

        (, daily,) = account.remaining();
        assertEq(daily, DAILY_CAP);
    }

    function test_aRefundCannotOutrunTheSpendItCameFrom() public {
        uint256 id = _spend(account, 400e6);

        vm.expectRevert(IMandateAccount.CreditExceedsSpend.selector);
        stub.forwardCredit(account, id, 400e6 + 1);

        stub.refund(account, id, 400e6);

        vm.expectRevert(IMandateAccount.UnknownSpend.selector);
        stub.forwardCredit(account, id, 1);
    }

    function test_aRefundNamingALockThisMandateNeverOpenedIsRefused() public {
        uint256 id = _spend(account, 400e6);

        vm.expectRevert(IMandateAccount.UnknownSpend.selector);
        stub.forwardCredit(account, id + 1_000, 1);

        vm.expectRevert(IMandateAccount.ZeroAmount.selector);
        stub.forwardCredit(account, id, 0);
    }

    function test_onlyTheEscrowCanReturnAllowanceToAWindow() public {
        uint256 id = _spend(account, 400e6);

        vm.prank(principal);
        vm.expectRevert(IMandateAccount.NotEscrow.selector);
        account.creditSpend(id, 400e6);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotEscrow.selector);
        account.creditSpend(id, 400e6);

        vm.prank(outsider);
        vm.expectRevert(IMandateAccount.NotEscrow.selector);
        account.creditSpend(id, 400e6);
    }

    function test_rewritingIdenticalLimitsDoesNotFreeTheSpentDailyAllowance() public {
        _spend(account, 400e6);

        vm.warp(START + 6 hours);
        vm.prank(principal);
        account.setLimits(_baseLimits());

        (, uint128 daily, uint128 monthly) = account.remaining();
        assertEq(daily, DAILY_CAP - 400e6);
        assertEq(monthly, MONTHLY_CAP - 400e6);

        IMandateAccount.Window memory window = account.window(IMandateAccount.WindowKind.Daily);
        assertEq(window.start, START + 6 hours, "the window did not re-anchor to the rewrite");
        assertEq(window.epoch, 0, "a window that had not elapsed was rolled");
        assertEq(account.version(), 2);
    }

    function test_rewritingLimitsEveryHourNeverHandsBackAFullDailyAllowance() public {
        _spend(account, 400e6);

        // The griefing shape: re-anchor the window often enough that it never elapses, and see
        // whether any one of those rewrites clears the bucket.
        for (uint256 i = 1; i <= 23; ++i) {
            vm.warp(START + i * 1 hours);
            vm.prank(principal);
            account.setLimits(_baseLimits());

            (, uint128 daily,) = account.remaining();
            assertEq(daily, DAILY_CAP - 400e6, "a rewrite freed allowance that was already spent");
        }

        _spend(account, PER_CALL_CAP);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        account.spend(_request(merchantA, 101e6), _noProof());
    }

    function test_rewritingLimitsAfterTheWindowElapsedClearsTheStaleBucketExactlyOnce() public {
        uint256 id = _spend(account, 400e6);

        vm.warp(START + DAILY_WINDOW + 1 hours);
        vm.prank(principal);
        account.setLimits(_baseLimits());

        IMandateAccount.Window memory window = account.window(IMandateAccount.WindowKind.Daily);
        assertEq(window.spent, 0);
        assertEq(window.epoch, 1);
        assertEq(window.start, START + DAILY_WINDOW + 1 hours);

        _spend(account, 100e6);

        // The rewrite carried the daily bucket into a new epoch, so the old lock's refund has
        // nothing left to credit there.
        stub.refund(account, id, 400e6);

        window = account.window(IMandateAccount.WindowKind.Daily);
        assertEq(window.spent, 100e6, "a refund refilled a bucket its spend never touched");

        (,, uint128 monthly) = account.remaining();
        assertEq(monthly, MONTHLY_CAP - 100e6, "the monthly bucket, which did not roll, refused its credit");
    }

    function test_shorteningTheWindowCannotRetroactivelyReleaseTheSpentAmount() public {
        _spend(account, 400e6);

        IMandateAccount.Limits memory limits = _baseLimits();
        limits.dailyWindow = 1 hours;

        vm.prank(principal);
        account.setLimits(limits);

        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP - 400e6, "shortening the window paid the agent back");

        vm.warp(START + 1 hours - 1);
        (, daily,) = account.remaining();
        assertEq(daily, DAILY_CAP - 400e6);

        // The shorter period governs from the rewrite forward.
        vm.warp(START + 1 hours);
        (, daily,) = account.remaining();
        assertEq(daily, DAILY_CAP);
    }

    function test_loweringTheCapBelowWhatIsAlreadySpentLeavesNoHeadroom() public {
        _spend(account, 400e6);

        IMandateAccount.Limits memory limits = _baseLimits();
        limits.dailyCap = 300e6;

        vm.prank(principal);
        account.setLimits(limits);

        (, uint128 daily,) = account.remaining();
        assertEq(daily, 0, "an overdrawn bucket underflowed into fresh allowance");

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        account.spend(_request(merchantA, 1), _noProof());

        // The overdraft clears at the next rollover rather than carrying into it.
        vm.warp(START + DAILY_WINDOW);
        (, daily,) = account.remaining();
        assertEq(daily, 300e6);
    }

    function test_raisingTheCapMidWindowGrantsOnlyTheDifference() public {
        _spend(account, 400e6);

        IMandateAccount.Limits memory limits = _baseLimits();
        limits.dailyCap = DAILY_CAP + 200e6;

        vm.prank(principal);
        account.setLimits(limits);

        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP + 200e6 - 400e6);
    }

    function testFuzz_aSpendClearsExactlyWhenItFitsEveryCapThatBindsIt(uint128 first, uint128 second, uint64 gap)
        public
    {
        first = uint128(bound(first, 1, PER_CALL_CAP));
        second = uint128(bound(second, 1, PER_CALL_CAP));
        gap = uint64(bound(gap, 0, 3 * uint256(DAILY_WINDOW)));

        _spend(account, first);

        vm.warp(START + gap);

        (, uint128 daily, uint128 monthly) = account.remaining();

        if (second <= daily && second <= monthly) {
            _spend(account, second);
        } else {
            bytes4 expected = second > daily
                ? IMandateAccount.DailyCapExceeded.selector
                : IMandateAccount.MonthlyCapExceeded.selector;

            vm.prank(agent);
            vm.expectRevert(expected);
            account.spend(_request(merchantA, second), _noProof());
        }

        IMandateAccount.Window memory window = account.window(IMandateAccount.WindowKind.Daily);
        assertLe(window.spent, window.cap);
    }

    function testFuzz_aWindowNeverStartsInTheFutureOrLagsAWholePeriod(uint64 gap) public {
        gap = uint64(bound(gap, 0, 400 days));

        vm.warp(START + gap);
        _spend(account, 1);

        IMandateAccount.Window memory daily = account.window(IMandateAccount.WindowKind.Daily);
        IMandateAccount.Window memory monthly = account.window(IMandateAccount.WindowKind.Monthly);

        assertLe(uint256(daily.start), block.timestamp);
        assertLe(uint256(monthly.start), block.timestamp);
        assertLt(block.timestamp - daily.start, daily.duration);
        assertLt(block.timestamp - monthly.start, monthly.duration);

        // Whole periods only: the offset from the original anchor stays a multiple of the
        // duration, which is what stops a waiting agent from choosing its own reset time.
        assertEq(uint256(daily.start - START) % DAILY_WINDOW, 0);
        assertEq(uint256(monthly.start - START) % MONTHLY_WINDOW, 0);
    }

    function testFuzz_aSequenceOfSpendsAndRefundsLeavesTheBucketAtTheirNetSum(
        uint128 first,
        uint128 second,
        uint128 refundSeed
    ) public {
        first = uint128(bound(first, 1, PER_CALL_CAP));
        second = uint128(bound(second, 1, DAILY_CAP - PER_CALL_CAP));
        uint128 back = uint128(bound(refundSeed, 1, first));

        uint256 id = _spend(account, first);
        _spend(account, second);
        stub.refund(account, id, back);

        IMandateAccount.Window memory daily = account.window(IMandateAccount.WindowKind.Daily);
        IMandateAccount.Window memory monthly = account.window(IMandateAccount.WindowKind.Monthly);

        assertEq(daily.spent, first + second - back);
        assertEq(monthly.spent, first + second - back);
        assertEq(account.creditable(id), first - back);
    }

    function test_theWindowsBindTheSameWayThroughTheRealEscrow() public {
        Reputation reputation = new Reputation(
            principal, IReputation.CapCurve({baseCap: 1_000_000e6, capPerScore: 0, maxCap: 1_000_000e6})
        );
        Escrow escrow = new Escrow(
            address(token), address(reputation), makeAddr("treasury"), 50, 50, 500, 1 minutes, 7 days, 1 hours, 10_000
        );
        reputation.setEscrow(address(escrow));

        MandateAccount live = _deploy(address(escrow), _baseLimits());

        vm.prank(agent);
        uint256 id = live.spend(_request(merchantA, PER_CALL_CAP), _noProof());
        assertEq(escrow.getLock(id).amount, PER_CALL_CAP);
        assertEq(escrow.getLock(id).payer, address(live));
        assertEq(escrow.getLock(id).payee, merchantA);

        vm.prank(agent);
        live.spend(_request(merchantA, PER_CALL_CAP), _noProof());

        uint256 idsBefore = escrow.nextId();

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        live.spend(_request(merchantA, 1), _noProof());

        // The mandate refuses before the escrow is ever reached, so a spend past the limit
        // opens no lock and leaves no allowance standing behind it.
        assertEq(escrow.nextId(), idsBefore, "a refused spend still opened a lock");
        assertEq(token.allowance(address(live), address(escrow)), 0);

        (, uint128 daily,) = live.remaining();
        assertEq(daily, 0);

        vm.warp(START + DAILY_WINDOW);
        (, daily,) = live.remaining();
        assertEq(daily, DAILY_CAP);
    }

    function _baseLimits() private pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: PER_CALL_CAP,
            dailyCap: DAILY_CAP,
            monthlyCap: MONTHLY_CAP,
            dailyWindow: DAILY_WINDOW,
            monthlyWindow: MONTHLY_WINDOW,
            // The caps are the subject here, so consent never routes a spend away from them.
            approvalThreshold: type(uint128).max,
            validFrom: 0,
            validUntil: 0,
            classMask: 3,
            totalCap: 0,
            lane: 0
        });
    }

    function _deploy(address escrow_, IMandateAccount.Limits memory limits) private returns (MandateAccount created) {
        created = new MandateAccount(principal, agent, address(token), escrow_, limits);

        vm.startPrank(principal);
        created.setMerchant(merchantA, true);
        created.setMerchant(merchantB, true);
        created.setCapability(CAPABILITY, true);
        vm.stopPrank();

        token.mint(address(created), 10_000_000e6);
    }

    function _spend(MandateAccount on, uint128 amount) private returns (uint256 id) {
        vm.prank(agent);
        id = on.spend(_request(merchantA, amount), _noProof());
    }

    /// Spends the whole monthly cap in per-call-sized draws, rolling the daily window between
    /// days so the monthly bucket is the only one still counting at the end.
    function _exhaustMonth(MandateAccount on) private {
        uint128 spent;
        uint64 day;
        while (spent < MONTHLY_CAP) {
            vm.warp(START + day * DAILY_WINDOW);

            uint128 today;
            while (today < DAILY_CAP && spent < MONTHLY_CAP) {
                _spend(on, PER_CALL_CAP);
                today += PER_CALL_CAP;
                spent += PER_CALL_CAP;
            }
            ++day;
        }
    }

    function _request(address merchant, uint128 amount) private view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: merchant,
            capabilityId: CAPABILITY,
            inputCommit: keccak256(abi.encode(merchant, amount, block.timestamp)),
            inputURI: "ipfs://mandate-windows",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }

    function _noProof() private pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    /// A quote's refusal has to name the same error the settlement would revert with, so these
    /// comparisons are on the selector and not on the fact that something failed.
    function _assertReason(bytes4 reason, bytes4 expected) private pure {
        assertEq(bytes32(reason), bytes32(expected), "the quote named a different refusal");
    }
}
