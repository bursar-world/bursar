// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {LocalPoolManager} from "../../script/local/LocalPoolManager.sol";
import {V4Math} from "../../script/lib/V4Math.sol";
import {Buyback, PoolKey} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {MockBRSR} from "../mocks/MockBRSR.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

/// Random but legal traffic around the buyback: the treasury funds it, the keeper triggers it
/// and strangers try to, governance restates the ceiling and the caps, renames the keeper,
/// pauses and lifts, sweeps and hands the seat over; a trader pushes the pool's price either
/// way between calls; strays land on the contract; and minutes to days pass, long enough for a
/// ceiling to go stale.
///
/// The pool is the local manager with v4's swap arithmetic, so the fill a buy will get can be
/// quoted here before the call and a refusal judged against the ceiling the way the contract
/// judges it. Every action swallows its own revert, and counters carry the findings out.
contract BuybackHandler is CommonBase, StdUtils {
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant BRSR_UNIT = 1e18;

    /// What the contract reads before it decides to buy, read here first so its decision and
    /// its spend can be checked against the same figures.
    struct Gate {
        Buyback.Params params;
        uint256 available;
        uint256 windowSpent;
        uint256 spend;
        uint256 staked;
        uint256 kept;
        /// A gate is down: paused, no keeper, the ceiling unset or stale, too soon after the
        /// last buy, nobody staked, or less than the minimum to spend.
        bool shut;
        /// The quoted fill sits inside the ceiling.
        bool fits;
    }

    Buyback public immutable buyback;
    LocalPoolManager public immutable manager;
    Staking public immutable staking;
    MockUsdg public immutable usdg;
    MockBRSR public immutable brsr;
    address public immutable treasury;
    uint160 public immutable basePrice;
    bytes32 public immutable id;

    /// Governance and the keeper as the handler believes them to be.
    address public admin;
    address public keeper;
    /// Keeper candidates, strangers and the admin's successors.
    address[] public outsiders;

    uint256 public funded;
    uint256 public spent;
    uint256 public received;
    uint256 public buys;
    mapping(address token => uint256) public donated;
    mapping(address token => uint256) public swept;

    /// A buy past its call or window limit or inside the interval, a fill above the ceiling, a
    /// buy through a shut gate, proceeds that went anywhere but the staking pool, `available`
    /// disagreeing with what a buy spent, a reserved call that went through for a stranger, a
    /// sweep governance was refused or that paid anyone but the treasury, a seat taken
    /// unoffered, and a buy inside every gate and the ceiling that was refused. All asserted zero.
    uint256 public capBreaks;
    uint256 public priceBreaks;
    uint256 public gateBreaks;
    uint256 public destinationBreaks;
    uint256 public availableBreaks;
    uint256 public authBreaks;
    uint256 public trapBreaks;
    uint256 public seatBreaks;
    uint256 public refusals;

    constructor(
        Buyback buyback_,
        LocalPoolManager manager_,
        uint160 basePrice_,
        address admin_,
        address keeper_,
        address[] memory outsiders_
    ) {
        buyback = buyback_;
        manager = manager_;
        staking = Staking(address(buyback_.staking()));
        usdg = MockUsdg(address(buyback_.settlementAsset()));
        brsr = MockBRSR(address(buyback_.brsr()));
        treasury = buyback_.treasury();
        basePrice = basePrice_;
        id = keccak256(abi.encode(_key()));
        admin = admin_;
        keeper = keeper_;
        outsiders = outsiders_;
    }

    /// Revenue arriving from the treasury, as a transfer in and never an allowance.
    function fund(uint256 amount) external {
        amount = bound(amount, 1e6, 500e6);
        usdg.mint(address(buyback), amount);
        funded += amount;
    }

    function buy() external {
        _buy();
    }

    /// With no keeper named nobody can buy, so the attempt is made by an outsider and has to
    /// fail like any stranger's.
    function buyAsStranger(uint256 who) external {
        address stranger = _outsider(who);
        if (stranger == keeper) return;

        vm.prank(stranger);
        try buyback.buyback() returns (uint256 spentNow, uint256 receivedNow) {
            authBreaks += 1;
            _book(spentNow, receivedNow);
        } catch {}
    }

    /// Any shape the contract accepts, with the ceiling anywhere from unset to twice the pool's
    /// opening price, so buys are refused on price about as often as they fill.
    function restate(uint256 callSeed, uint256 windowSeed, uint256 ceilingSeed, uint256 shapeSeed) external {
        Buyback.Params memory p;
        p.spendPerCallMicroUsd = uint128(bound(callSeed, 1e6, 50e6));
        p.maxSpendPerWindowMicroUsd =
            uint128(bound(shapeSeed, p.spendPerCallMicroUsd, 10 * uint256(p.spendPerCallMicroUsd)));
        p.minSpendMicroUsd = uint128(bound(shapeSeed >> 64, 1, p.spendPerCallMicroUsd));
        p.maxPriceMicroUsdPerBrsr = ceilingSeed % 5 == 0 ? 0 : uint128(bound(ceilingSeed, 100, 400));
        p.window = uint64(bound(windowSeed, 1 hours, 30 days));
        p.minInterval = uint64(bound(windowSeed >> 64, 0, p.window));

        vm.prank(admin);
        try buyback.setParams(p) {}
        catch {
            refusals += 1;
        }
    }

    function setCeilingAge(uint256 seed) external {
        vm.prank(admin);
        try buyback.setMaxCeilingAge(uint64(bound(seed, 1 days, 30 days))) {}
        catch {
            refusals += 1;
        }
    }

    /// One naming in eight leaves the seat empty.
    function nameKeeper(uint256 seed) external {
        address next = seed % 8 == 0 ? address(0) : _outsider(seed);
        vm.prank(admin);
        try buyback.setKeeper(next) {
            keeper = next;
        } catch {
            refusals += 1;
        }
    }

    /// Lifts a pause whenever it finds one and starts one a third of the time, so the contract
    /// spends most of its life open.
    function pauseOrLift(uint256 seed) external {
        vm.startPrank(admin);
        if (buyback.paused()) buyback.unpause();
        else if (seed % 3 == 0) buyback.pause();
        vm.stopPrank();
    }

    /// Governance's way out, paused or not. A sweep of what the contract holds has to land,
    /// and what it sends has to reach the treasury. One sweep in eight asks for a unit more
    /// than is held, and has to fail.
    function sweep(bool settlement, uint256 amountSeed) external {
        IERC20 token = settlement ? IERC20(address(usdg)) : IERC20(address(brsr));
        uint256 held = token.balanceOf(address(buyback));
        uint256 amount = held == 0 || amountSeed % 8 == 0 ? held + 1 : bound(amountSeed, 1, held);
        uint256 before = token.balanceOf(treasury);

        vm.prank(admin);
        try buyback.sweep(address(token), amount) {
            if (amount > held || token.balanceOf(treasury) != before + amount) trapBreaks += 1;
            swept[address(token)] += amount;
        } catch {
            if (amount <= held) trapBreaks += 1;
        }
    }

    /// Every governance call, from someone who is not governance.
    function governAsStranger(uint256 who, uint256 which, uint256 seed) external {
        address stranger = _outsider(who);
        if (stranger == admin) return;
        uint256 choice = which % 6;
        Buyback.Params memory p = buyback.params();

        vm.prank(stranger);
        bool ok;
        if (choice == 0) {
            (ok,) = address(buyback).call(abi.encodeCall(Buyback.setParams, (p)));
        } else if (choice == 1) {
            (ok,) = address(buyback).call(abi.encodeCall(Buyback.setKeeper, (stranger)));
        } else if (choice == 2) {
            (ok,) = address(buyback).call(abi.encodeCall(Buyback.pause, ()));
        } else if (choice == 3) {
            (ok,) = address(buyback).call(abi.encodeCall(Buyback.unpause, ()));
        } else if (choice == 4) {
            (ok,) = address(buyback).call(abi.encodeCall(Buyback.sweep, (address(usdg), bound(seed, 1, 1e6))));
        } else {
            (ok,) =
                address(buyback).call(abi.encodeCall(Buyback.setMaxCeilingAge, (uint64(bound(seed, 1 days, 30 days)))));
        }
        if (ok) authBreaks += 1;
    }

    /// A trader pushes the pool anywhere from half to double its opening price, which is what a
    /// sandwich does ahead of a keeper's call.
    function pushPrice(uint256 seed) external {
        uint256 moved = bound(seed, 5_000, 20_000);
        manager.setPrice(_key(), uint160(Math.mulDiv(basePrice, Math.sqrt(moved * 1e32), 1e18)));
    }

    /// A transfer nobody asked for. Settlement strays are the treasury's to sweep, BRSR strays
    /// are not proceeds and must not be mistaken for them.
    function donate(bool settlement, uint256 amount) external {
        if (settlement) {
            amount = bound(amount, 1, 100e6);
            usdg.mint(address(buyback), amount);
            donated[address(usdg)] += amount;
        } else {
            amount = bound(amount, 1, 100e18);
            brsr.mint(address(buyback), amount);
            donated[address(brsr)] += amount;
        }
    }

    function offerSeat(uint256 who) external {
        vm.prank(admin);
        try buyback.transferAdmin(_outsider(who)) {} catch {}
        if (buyback.admin() != admin) seatBreaks += 1;
    }

    function takeSeat(uint256 who) external {
        address taker = _outsider(who);
        address offered = buyback.pendingAdmin();

        vm.prank(taker);
        try buyback.acceptAdmin() {
            if (taker != offered) seatBreaks += 1;
            admin = taker;
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 minutes, 10 days));
    }

    /// Puts the contract back where a buy can land, from wherever the run left it, and buys once.
    /// A run that never bought proved nothing about the trade, and this also proves the brake and
    /// the ceiling never leave governance without a way back to buying.
    function driveBuy() external {
        Buyback.Params memory p = buyback.params();
        // Past the interval and into a fresh window first, so the ceiling restated below is
        // still fresh when the buy reads it.
        vm.warp(block.timestamp + p.window);

        vm.startPrank(admin);
        if (buyback.paused()) buyback.unpause();
        if (keeper == address(0)) {
            keeper = outsiders[0];
            buyback.setKeeper(keeper);
        }
        // Five times the opening price, which clears the pool wherever a trader left it.
        p.maxPriceMicroUsdPerBrsr = 1_000;
        buyback.setParams(p);
        vm.stopPrank();

        uint256 held = usdg.balanceOf(address(buyback));
        if (held < p.spendPerCallMicroUsd) {
            usdg.mint(address(buyback), p.spendPerCallMicroUsd - held);
            funded += p.spendPerCallMicroUsd - held;
        }
        _buy();
    }

    function outsiderCount() external view returns (uint256) {
        return outsiders.length;
    }

    function _buy() private {
        Gate memory gate = _gate();
        if (keeper == address(0)) {
            vm.prank(_outsider(gate.spend));
            try buyback.buyback() returns (uint256 spentNow, uint256 receivedNow) {
                gateBreaks += 1;
                _book(spentNow, receivedNow);
            } catch {}
            return;
        }

        vm.prank(keeper);
        try buyback.buyback() returns (uint256 spentNow, uint256 receivedNow) {
            _check(gate, spentNow, receivedNow);
            _book(spentNow, receivedNow);
        } catch {
            if (!gate.shut && gate.fits) refusals += 1;
        }
    }

    function _gate() private view returns (Gate memory gate) {
        Buyback.Params memory p = buyback.params();
        gate.params = p;
        gate.available = buyback.available();
        gate.windowSpent = buyback.window().spentMicroUsd;
        gate.staked = staking.totalStaked();
        gate.kept = brsr.balanceOf(address(buyback));

        uint256 headroom =
            gate.windowSpent >= p.maxSpendPerWindowMicroUsd ? 0 : p.maxSpendPerWindowMicroUsd - gate.windowSpent;
        uint256 balance = usdg.balanceOf(address(buyback));
        gate.spend = p.spendPerCallMicroUsd;
        if (headroom < gate.spend) gate.spend = headroom;
        if (balance < gate.spend) gate.spend = balance;

        uint64 last = buyback.lastBuybackAt();
        uint256 readyAt = last == 0 ? 0 : uint256(last) + p.minInterval;
        gate.shut = buyback.paused() || keeper == address(0) || p.maxPriceMicroUsdPerBrsr == 0
            || block.timestamp > uint256(buyback.ceilingSetAt()) + buyback.maxCeilingAge() || block.timestamp < readyAt
            || staking.totalShares() == 0 || gate.spend < p.minSpendMicroUsd;
        gate.fits = p.maxPriceMicroUsdPerBrsr != 0
            && _quote(gate.spend) >= Math.ceilDiv(gate.spend * BRSR_UNIT, p.maxPriceMicroUsdPerBrsr);
    }

    /// Everything a landed buy has to satisfy, against the figures read before it.
    function _check(Gate memory gate, uint256 spentNow, uint256 receivedNow) private {
        Buyback.Params memory p = gate.params;
        if (gate.shut) gateBreaks += 1;
        if (!gate.fits) priceBreaks += 1;
        if (spentNow != gate.spend || spentNow != gate.available) availableBreaks += 1;

        uint256 windowNow = buyback.window().spentMicroUsd;
        if (spentNow > p.spendPerCallMicroUsd || windowNow != gate.windowSpent + spentNow) capBreaks += 1;
        if (windowNow > p.maxSpendPerWindowMicroUsd) capBreaks += 1;

        // Micro-USD per whole BRSR, which is the unit the ceiling is written in.
        if (spentNow * BRSR_UNIT > receivedNow * p.maxPriceMicroUsdPerBrsr) priceBreaks += 1;

        if (staking.totalStaked() != gate.staked + receivedNow || brsr.balanceOf(address(buyback)) != gate.kept) {
            destinationBreaks += 1;
        }
        if (brsr.balanceOf(keeper) != 0) destinationBreaks += 1;
    }

    function _book(uint256 spentNow, uint256 receivedNow) private {
        spent += spentNow;
        received += receivedNow;
        buys += 1;
    }

    /// The fill the local pool gives for `amountIn` at its current price: the LP fee off the
    /// input, the mid applied, the flat haircut off the output. The same arithmetic the manager
    /// runs, so a refusal can be checked against the ceiling exactly.
    function _quote(uint256 amountIn) private view returns (uint256) {
        uint256 s = manager.sqrtPrice(id);
        uint256 net = (amountIn * (1_000_000 - buyback.poolFee())) / 1_000_000;
        uint256 atMid = buyback.settlementIsCurrency0()
            ? Math.mulDiv(Math.mulDiv(net, s, Q96), s, Q96)
            : Math.mulDiv(Math.mulDiv(net, Q96, s), Q96, s);
        return (atMid * (10_000 - manager.haircutBps())) / 10_000;
    }

    function _key() private view returns (PoolKey memory) {
        return PoolKey({
            currency0: buyback.currency0(),
            currency1: buyback.currency1(),
            fee: buyback.poolFee(),
            tickSpacing: buyback.poolTickSpacing(),
            hooks: buyback.poolHooks()
        });
    }

    function _outsider(uint256 seed) private view returns (address) {
        return outsiders[seed % outsiders.length];
    }
}

/// The buyback under any sequence of the calls above: it never spends past its limits, never
/// fills above the ceiling, buys nothing through a shut gate, hands every BRSR it buys to the
/// staking pool, holds exactly what it was given less what it spent or returned, answers only
/// to its keeper and its admin, and never traps what governance can recover.
contract BuybackInvariantTest is Test {
    uint256 internal constant STAKE = 1_000_000e18;

    MockUsdg internal usdg;
    MockBRSR internal brsr;
    Staking internal staking;
    LocalPoolManager internal manager;
    Buyback internal buyback;
    BuybackHandler internal handler;

    address internal admin = makeAddr("timelock");
    address internal treasury = makeAddr("treasury");
    address internal staker = makeAddr("staker");
    address[] internal outsiders;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdg = new MockUsdg();
        brsr = new MockBRSR();
        staking = new Staking(
            IERC20(address(brsr)), IERC20(address(usdg)), admin, makeAddr("slashSink"), treasury, 7 days, 1e18
        );
        manager = new LocalPoolManager();

        // The live shape: a ceiling of 240 micro-USD over a pool opening at 200.
        buyback = new Buyback(
            address(usdg),
            address(brsr),
            address(manager),
            3000,
            60,
            address(0),
            address(staking),
            admin,
            treasury,
            Buyback.Params({
                spendPerCallMicroUsd: 10e6,
                maxSpendPerWindowMicroUsd: 50e6,
                minSpendMicroUsd: 1e6,
                maxPriceMicroUsdPerBrsr: 240,
                window: 1 days,
                minInterval: 1 hours
            })
        );

        // One BRSR at 200 micro-USD: a raw ratio of 1e18 BRSR wei to 200 USDG units, whichever
        // side of the pool each is on. Every buy moves the pool a quarter of a percent against
        // the buyer, so a long run of buys drifts the price up to and past the ceiling.
        uint160 price = buyback.settlementIsCurrency0()
            ? V4Math.initialSqrtPriceX96(200, 1e18)
            : V4Math.initialSqrtPriceX96(1e18, 200);
        manager.initialize(
            PoolKey({
                currency0: buyback.currency0(),
                currency1: buyback.currency1(),
                fee: 3000,
                tickSpacing: 60,
                hooks: address(0)
            }),
            price
        );
        manager.setImpact(25);
        brsr.mint(address(manager), 1e30);

        brsr.mint(staker, STAKE);
        vm.startPrank(staker);
        brsr.approve(address(staking), STAKE);
        staking.stake(STAKE);
        vm.stopPrank();

        outsiders.push(makeAddr("keeper"));
        outsiders.push(makeAddr("stranger"));
        outsiders.push(makeAddr("successor"));
        outsiders.push(admin);
        vm.prank(admin);
        buyback.setKeeper(outsiders[0]);

        handler = new BuybackHandler(buyback, manager, price, admin, outsiders[0], outsiders);

        bytes4[] memory selectors = new bytes4[](16);
        selectors[0] = BuybackHandler.fund.selector;
        selectors[1] = BuybackHandler.buy.selector;
        selectors[2] = BuybackHandler.buy.selector;
        selectors[3] = BuybackHandler.buy.selector;
        selectors[4] = BuybackHandler.buyAsStranger.selector;
        selectors[5] = BuybackHandler.restate.selector;
        selectors[6] = BuybackHandler.setCeilingAge.selector;
        selectors[7] = BuybackHandler.nameKeeper.selector;
        selectors[8] = BuybackHandler.pauseOrLift.selector;
        selectors[9] = BuybackHandler.sweep.selector;
        selectors[10] = BuybackHandler.governAsStranger.selector;
        selectors[11] = BuybackHandler.pushPrice.selector;
        selectors[12] = BuybackHandler.donate.selector;
        selectors[13] = BuybackHandler.offerSeat.selector;
        selectors[14] = BuybackHandler.takeSeat.selector;
        selectors[15] = BuybackHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// One call spends at most the per-call target, the window never carries more than its cap
    /// after a buy, and no buy lands inside the interval after the last.
    function invariant_noBuyEverPassesItsCallOrWindowLimit() public view {
        assertEq(handler.capBreaks(), 0, "a buy spent past a cap or inside the interval");
    }

    /// Every fill prices BRSR at or under the ceiling governance set, in micro-USD per whole
    /// token, wherever a trader pushed the pool first.
    function invariant_noBuyEverFillsAboveTheCeiling() public view {
        assertEq(handler.priceBreaks(), 0, "a buy filled above the ceiling");
    }

    /// Paused, keeperless, with the ceiling unset or stale, inside the interval, with nobody
    /// staked or with less than the minimum to spend, a buy is refused.
    function invariant_aShutGateBuysNothing() public view {
        assertEq(handler.gateBreaks(), 0, "a buy went through a shut gate");
    }

    /// What a buy receives is compounded into the staking pool in the same transaction. The
    /// contract keeps no BRSR of its own beyond strays, and the keeper is paid nothing.
    function invariant_boughtBrsrLandsInTheStakingPoolAndNowhereElse() public view {
        assertEq(staking.totalStaked(), STAKE + handler.received(), "the staking pool did not receive every buy");
        assertEq(
            brsr.balanceOf(address(buyback)),
            handler.donated(address(brsr)) - handler.swept(address(brsr)),
            "BRSR on the buyback is not the unswept strays"
        );
        for (uint256 i; i < outsiders.length; ++i) {
            assertEq(brsr.balanceOf(outsiders[i]), 0, "a keeper or stranger was paid BRSR");
        }
        assertEq(handler.destinationBreaks(), 0, "a buy's proceeds went somewhere other than the staking pool");
    }

    /// The settlement balance is what was given less what was spent on the pool or returned to
    /// the treasury, the pool holds exactly what was spent, and the treasury holds exactly what
    /// was swept.
    function invariant_theBalanceIsWhatWasGivenLessWhatWasSpentOrReturned() public view {
        assertEq(
            usdg.balanceOf(address(buyback)),
            handler.funded() + handler.donated(address(usdg)) - handler.spent() - handler.swept(address(usdg)),
            "the settlement balance drifted from funding less spend and sweeps"
        );
        assertEq(
            usdg.balanceOf(address(manager)), handler.spent(), "the pool holds something other than what was spent"
        );
        assertEq(usdg.balanceOf(treasury), handler.swept(address(usdg)), "the treasury holds unswept settlement");
        assertEq(brsr.balanceOf(treasury), handler.swept(address(brsr)), "the treasury holds unswept BRSR");
    }

    /// `available` is the exact spend of a buy made in the same block, and zero whenever a buy
    /// would be refused at a gate.
    function invariant_availableIsWhatABuyWouldSpend() public view {
        assertEq(handler.availableBreaks(), 0, "available disagreed with what a buy spent");
    }

    function invariant_onlyTheKeeperBuysAndOnlyGovernanceGoverns() public view {
        assertEq(buyback.keeper(), handler.keeper(), "the keeper changed hands outside governance");
        assertEq(handler.authBreaks(), 0, "a stranger bought or governed");
    }

    /// The brake stops buying and nothing else: a sweep of what is held lands, paused or not,
    /// and pays the treasury.
    function invariant_pauseStopsBuysAndTrapsNothing() public view {
        if (buyback.paused()) assertEq(buyback.available(), 0, "a paused buyback offered a spend");
        assertEq(handler.trapBreaks(), 0, "governance was refused a sweep, or a sweep paid someone else");
    }

    /// A buy inside every gate whose quoted fill sits inside the ceiling lands. Refusing it
    /// would leave revenue idle for no reason the parameters can explain.
    function invariant_aBuyInsideEveryGateAndTheCeilingLands() public view {
        assertEq(
            handler.refusals(), 0, "a buy inside every gate and the ceiling was refused, or governance a legal change"
        );
    }

    function invariant_theAdminSeatMovesOnlyByOfferAndAcceptance() public view {
        assertEq(buyback.admin(), handler.admin(), "the admin seat moved without an accepted offer");
        assertEq(handler.seatBreaks(), 0, "a stranger took the seat, or an offer moved it on its own");
    }

    /// A run that never bought proved nothing about the trade. One more buy is driven from
    /// wherever the run left the contract, which also proves governance can always get it buying
    /// again.
    function afterInvariant() public {
        if (handler.buys() == 0) handler.driveBuy();
        assertGt(handler.buys(), 0, "no buy ever landed");
        invariant_boughtBrsrLandsInTheStakingPoolAndNowhereElse();
        invariant_theBalanceIsWhatWasGivenLessWhatWasSpentOrReturned();
        invariant_noBuyEverFillsAboveTheCeiling();
        invariant_aBuyInsideEveryGateAndTheCeilingLands();
    }
}
