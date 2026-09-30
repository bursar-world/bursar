// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {Buyback, PoolKey, SwapParams} from "../../src/token/Buyback.sol";
import {BRSR} from "../../src/token/BRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPoolManager} from "../mocks/MockPoolManager.sol";

/// Eighteen decimals where the settlement asset has to have six.
contract WideToken is ERC20 {
    constructor() ERC20("Wide", "WIDE") {}
}

/// Trades the mock pool out of its own balance, the way anyone can trade the live one.
/// `sandwich` is the trade an open buyback invites: push the price up, trigger the buy, sell back
/// into it, all in one transaction.
contract PoolTrader {
    MockPoolManager internal immutable manager;
    Buyback internal immutable buyback;

    constructor(MockPoolManager manager_, Buyback buyback_) {
        manager = manager_;
        buyback = buyback_;
    }

    function buy(uint256 usdgIn) public returns (uint256 brsrOut) {
        return abi.decode(manager.unlock(abi.encode(true, usdgIn)), (uint256));
    }

    function sell(uint256 brsrIn) public returns (uint256 usdgOut) {
        return abi.decode(manager.unlock(abi.encode(false, brsrIn)), (uint256));
    }

    function sandwich(uint256 front) external {
        buy(front);
        buyback.buyback();
        sell(buyback.brsr().balanceOf(address(this)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (bool settlementIn, uint256 amountIn) = abi.decode(data, (bool, uint256));
        bool zeroForOne = settlementIn == buyback.settlementIsCurrency0();

        int256 delta = manager.swap(
            PoolKey({
                currency0: buyback.currency0(),
                currency1: buyback.currency1(),
                fee: buyback.poolFee(),
                tickSpacing: buyback.poolTickSpacing(),
                hooks: buyback.poolHooks()
            }),
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: 0}),
            ""
        );
        int256 delta0 = int256(int128(delta >> 128));
        int256 delta1 = int256(int128(delta));
        (int256 inDelta, int256 outDelta) = zeroForOne ? (delta0, delta1) : (delta1, delta0);

        (IERC20 tokenIn, IERC20 tokenOut) =
            settlementIn ? (buyback.settlementAsset(), buyback.brsr()) : (buyback.brsr(), buyback.settlementAsset());
        manager.sync(address(tokenIn));
        tokenIn.transfer(address(manager), uint256(-inDelta));
        manager.settle();
        manager.take(address(tokenOut), address(this), uint256(outDelta));

        return abi.encode(uint256(outDelta));
    }
}

/// Revenue into the pool, at a price governance set and nobody else can move, in amounts the
/// caps bound, on the say-so of the one keeper governance named.
contract BuybackTest is Test {
    event BuybackExecuted(address indexed caller, uint256 spentMicroUsd, uint256 receivedWei, uint256 minOutWei);
    event ParamsUpdated(Buyback.Params params);
    event Swept(address indexed token, uint256 amount);

    /// The pool pays two BRSR for a whole USDG, which is fifty cents a token, and the ceiling
    /// is set at a dollar. The gap between them is the headroom every test that moves the price
    /// works inside.
    ///
    /// The two are quoted in opposite directions. `MockPoolManager` speaks the
    /// venue's language, BRSR wei out per USDG in; the ceiling is the price a person reads,
    /// micro-USD for one whole BRSR. `POOL_PRICE_AT_CEILING` is where the two meet, and it is
    /// the boundary a fill is measured against.
    uint256 internal constant POOL_PRICE = 2e18;
    uint128 internal constant CEILING = 1_000_000;
    uint256 internal constant POOL_PRICE_AT_CEILING = 1e18;

    /// The ceiling proposed for the live pool, twenty per cent over its opening price.
    uint128 internal constant LIVE_CEILING = 240;

    uint128 internal constant SPEND_PER_CALL = 100e6;
    uint128 internal constant MAX_PER_WINDOW = 500e6;
    uint128 internal constant MIN_SPEND = 10e6;
    uint64 internal constant WINDOW = 1 days;
    uint64 internal constant MIN_INTERVAL = 1 hours;
    uint256 internal constant MIN_BOND = 1_000e18;

    BRSR internal brsr;
    MockUsdg internal usdg;
    Staking internal staking;
    MockPoolManager internal manager;
    Buyback internal buyback;

    address internal admin = makeAddr("timelock");
    address internal treasury = makeAddr("treasury");
    address internal slashSink = makeAddr("slashSink");
    address internal staker = makeAddr("staker");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdg = new MockUsdg();
        brsr = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: makeAddr("team"), treasury: treasury, liquidity: makeAddr("liquidity")
            })
        );
        staking = new Staking(brsr, usdg, admin, slashSink, treasury, 7 days, MIN_BOND);
        manager = new MockPoolManager(usdg, brsr, POOL_PRICE);

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
            _params()
        );

        manager.initialize(
            PoolKey({
                currency0: buyback.currency0(),
                currency1: buyback.currency1(),
                fee: 3000,
                tickSpacing: 60,
                hooks: address(0)
            })
        );

        // The pool's BRSR side, and a staker so there are shares for the proceeds to land on.
        brsr.transfer(address(manager), 100_000_000e18);
        brsr.transfer(staker, 1_000e18);
        vm.startPrank(staker);
        brsr.approve(address(staking), type(uint256).max);
        staking.stake(1_000e18);
        vm.stopPrank();

        vm.prank(admin);
        buyback.setKeeper(keeper);

        _fund(1_000e6);
    }

    function _params() internal pure returns (Buyback.Params memory) {
        return Buyback.Params({
            spendPerCallMicroUsd: SPEND_PER_CALL,
            maxSpendPerWindowMicroUsd: MAX_PER_WINDOW,
            minSpendMicroUsd: MIN_SPEND,
            maxPriceMicroUsdPerBrsr: CEILING,
            window: WINDOW,
            minInterval: MIN_INTERVAL
        });
    }

    function _fund(uint256 amount) internal {
        usdg.mint(address(buyback), amount);
    }

    function _setParams(Buyback.Params memory p) internal {
        vm.prank(admin);
        buyback.setParams(p);
    }

    function test_aBuybackSpendsTheCapAndCompoundsTheProceeds() public {
        uint256 valueBefore = staking.stakedValueOf(staker);

        vm.expectEmit(true, false, false, true, address(buyback));
        emit BuybackExecuted(keeper, SPEND_PER_CALL, 200e18, 100e18);
        vm.prank(keeper);
        (uint256 spent, uint256 received) = buyback.buyback();

        assertEq(spent, SPEND_PER_CALL);
        assertEq(received, 200e18);
        assertEq(usdg.balanceOf(address(buyback)), 1_000e6 - SPEND_PER_CALL);
        assertEq(usdg.balanceOf(address(manager)), SPEND_PER_CALL);
        assertEq(brsr.balanceOf(address(buyback)), 0);
        assertEq(staking.totalStaked(), 1_000e18 + 200e18);
        assertGt(staking.stakedValueOf(staker), valueBefore);
        // No standing approval is left behind for the pool to draw on later.
        assertEq(brsr.allowance(address(buyback), address(staking)), 0);
    }

    function test_theKeeperGetsNothingBeyondTheGasItCost() public {
        vm.prank(keeper);
        buyback.buyback();

        assertEq(brsr.balanceOf(keeper), 0);
        assertEq(usdg.balanceOf(keeper), 0);
    }

    /// The keeper supplies no amount, no price, no deadline and no recipient. The only thing
    /// it controls is when, and the interval bounds that.
    function test_theKeeperCannotPickThePrice() public {
        (bool ok,) = address(buyback).call(abi.encodeWithSignature("buyback(uint256)", 1));
        assertFalse(ok);

        (ok,) = address(buyback).call(abi.encodeWithSignature("buyback(uint256,uint256)", 1, 1));
        assertFalse(ok);

        vm.prank(keeper);
        buyback.buyback();
        assertEq(manager.lastAmountSpecified(), -int256(uint256(SPEND_PER_CALL)));
        assertEq(manager.lastHookData().length, 0);
    }

    /// The ceiling is absolute, in micro-USD per whole BRSR, and it is not read from the
    /// pool. A sandwicher can push the fill up to it and no further.
    function test_aFillAboveTheCeilingIsRefused() public {
        manager.setPrice(POOL_PRICE_AT_CEILING - 1);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                Buyback.MinimumOutNotMet.selector, (SPEND_PER_CALL * (POOL_PRICE_AT_CEILING - 1)) / 1e6, 100e18
            )
        );
        buyback.buyback();

        // Exactly at the ceiling clears. The number is a boundary, not an approximation of
        // one.
        manager.setPrice(POOL_PRICE_AT_CEILING);
        vm.prank(keeper);
        (, uint256 received) = buyback.buyback();
        assertEq(received, 100e18);
    }

    function test_loweringTheCeilingStopsBuyingAtAPriceGovernanceRejects() public {
        Buyback.Params memory p = _params();
        // A quarter of a dollar a token, against a pool asking half of one.
        p.maxPriceMicroUsdPerBrsr = 250_000;
        _setParams(p);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.MinimumOutNotMet.selector, 200e18, 400e18));
        buyback.buyback();
    }

    function test_spendPerCallBoundsOneCallAndTheWindowBoundsTheDay() public {
        _fund(10_000e6);

        uint256 spentTotal;
        for (uint256 i; i < 5; ++i) {
            vm.warp(block.timestamp + MIN_INTERVAL);
            vm.prank(keeper);
            (uint256 spent,) = buyback.buyback();
            assertEq(spent, SPEND_PER_CALL);
            spentTotal += spent;
        }
        assertEq(spentTotal, MAX_PER_WINDOW);

        vm.warp(block.timestamp + MIN_INTERVAL);
        assertEq(buyback.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.BelowMinimumSpend.selector, 0, MIN_SPEND));
        buyback.buyback();

        // The window rolls by whole periods, so waiting it out buys one fresh budget and not
        // a clock of the caller's choosing.
        vm.warp(block.timestamp + WINDOW);
        assertEq(buyback.available(), SPEND_PER_CALL);
        vm.prank(keeper);
        buyback.buyback();
        assertEq(buyback.window().spentMicroUsd, SPEND_PER_CALL);
    }

    function test_theIntervalStopsTheWindowBeingSpentInOneBlock() public {
        // Nothing has been bought yet, so there is nothing to wait for.
        assertEq(buyback.nextBuybackAt(), 0);
        assertEq(buyback.available(), SPEND_PER_CALL);

        vm.prank(keeper);
        buyback.buyback();

        uint64 readyAt = buyback.nextBuybackAt();
        assertEq(readyAt, uint64(block.timestamp) + MIN_INTERVAL);
        assertEq(buyback.available(), 0);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.TooSoon.selector, readyAt));
        buyback.buyback();

        vm.warp(readyAt - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.TooSoon.selector, readyAt));
        buyback.buyback();

        vm.warp(readyAt);
        vm.prank(keeper);
        buyback.buyback();
    }

    function test_theBalanceIsTheHardCeilingOnEverySpend() public {
        Buyback.Params memory p = _params();
        p.spendPerCallMicroUsd = 5_000e6;
        p.maxSpendPerWindowMicroUsd = 5_000e6;
        _setParams(p);

        vm.prank(keeper);
        (uint256 spent,) = buyback.buyback();
        assertEq(spent, 1_000e6);
        assertEq(usdg.balanceOf(address(buyback)), 0);
    }

    function test_theBuybackHoldsNoAllowanceOnTheTreasury() public view {
        assertEq(usdg.allowance(treasury, address(buyback)), 0);
        assertEq(brsr.allowance(treasury, address(buyback)), 0);
    }

    function test_aDustBuyIsRefused() public {
        Buyback.Params memory p = _params();
        p.spendPerCallMicroUsd = 5_000e6;
        p.maxSpendPerWindowMicroUsd = 5_000e6;
        _setParams(p);

        vm.prank(keeper);
        buyback.buyback();
        assertEq(usdg.balanceOf(address(buyback)), 0);

        _fund(MIN_SPEND - 1);
        vm.warp(block.timestamp + MIN_INTERVAL);
        assertEq(buyback.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.BelowMinimumSpend.selector, MIN_SPEND - 1, MIN_SPEND));
        buyback.buyback();
    }

    /// A short fill at the extreme price limit means the pool ran out of liquidity under the
    /// trade. The remainder would sit here and the minimum out would have been checked against
    /// an amount nobody chose.
    function test_aPartialFillIsRefusedRatherThanAccepted() public {
        manager.setFillBps(5_000);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.SwapConsumedWrongAmount.selector, SPEND_PER_CALL, 50e6));
        buyback.buyback();
    }

    /// Both legs are read back from the manager, never inferred, because a hook can rewrite
    /// either of them.
    function test_aSwapThatReportsTheWrongDirectionIsRefused() public {
        manager.setFlipDelta(true);

        vm.prank(keeper);
        vm.expectRevert();
        buyback.buyback();
    }

    function test_aSettlementThatCreditsLessThanWasSentIsRefused() public {
        manager.setSettleShortfall(1);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.SettlementShort.selector, SPEND_PER_CALL - 1, SPEND_PER_CALL));
        buyback.buyback();
    }

    /// A pool whose every share has asked to leave has nobody to credit. Stake behind an exit
    /// request earns no compounds, so the buyback counts it as gone the moment it is requested.
    function test_aBuybackIntoAnEmptyStakingPoolIsRefusedBeforeTheTrade() public {
        uint256 shares = staking.sharesOf(staker);
        vm.prank(staker);
        staking.requestUnbond(shares);

        assertEq(staking.totalShares(), 0);
        assertEq(buyback.available(), 0);

        vm.prank(keeper);
        vm.expectRevert(Buyback.NoStakeToDistributeTo.selector);
        buyback.buyback();
        assertEq(manager.swapCount(), 0);
    }

    function test_theCallbackRefusesEveryCallerButTheManager() public {
        vm.prank(keeper);
        vm.expectRevert(Buyback.NotPoolManager.selector);
        buyback.unlockCallback(abi.encode(uint256(1), uint256(1)));
    }

    /// The manager calls back into whatever address unlocked it, so a callback arriving from
    /// the right address is not on its own a callback this contract asked for.
    function test_theCallbackRefusesAnUnlockItDidNotAskFor() public {
        vm.prank(address(manager));
        vm.expectRevert(Buyback.NotUnlocking.selector);
        buyback.unlockCallback(abi.encode(uint256(1e6), uint256(1)));
    }

    function test_theSwapCarriesThePoolTheContractWasBuiltAgainst() public {
        vm.prank(keeper);
        buyback.buyback();

        (address c0, address c1, uint24 fee, int24 spacing, address hooks) = manager.lastKey();
        assertEq(c0, buyback.currency0());
        assertEq(c1, buyback.currency1());
        assertEq(fee, buyback.poolFee());
        assertEq(spacing, buyback.poolTickSpacing());
        assertEq(hooks, buyback.poolHooks());
        assertEq(manager.lastZeroForOne(), buyback.settlementIsCurrency0());
    }

    function test_currenciesAreSortedAndTheDirectionFollows() public view {
        (address c0, address c1) =
            address(usdg) < address(brsr) ? (address(usdg), address(brsr)) : (address(brsr), address(usdg));
        assertEq(buyback.currency0(), c0);
        assertEq(buyback.currency1(), c1);
        assertEq(buyback.settlementIsCurrency0(), address(usdg) == c0);
        assertLt(uint160(buyback.currency0()), uint160(buyback.currency1()));
    }

    function test_theVenueIsFixedAtConstruction() public {
        // Nothing on this contract can move the pool. A redeploy is the only way to change
        // venue, which is what stops a governance key repointing the price.
        assertEq(buyback.currency0().code.length > 0, true);
        assertEq(address(buyback.poolManager()), address(manager));

        bytes4[5] memory absent = [
            bytes4(keccak256("setPoolManager(address)")),
            bytes4(keccak256("setPool(address,uint24,int24,address)")),
            bytes4(keccak256("setStaking(address)")),
            bytes4(keccak256("setTreasury(address)")),
            bytes4(keccak256("setBrsr(address)"))
        ];
        for (uint256 i; i < absent.length; ++i) {
            (bool ok,) = address(buyback).call(abi.encodePacked(absent[i], bytes32(uint256(uint160(stranger)))));
            assertFalse(ok);
        }
    }

    function test_theBrakeStopsBuyingAndGovernanceRestartsIt() public {
        vm.prank(keeper);
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.pause();

        vm.prank(admin);
        buyback.pause();

        assertEq(buyback.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        buyback.buyback();

        vm.prank(admin);
        buyback.unpause();
        vm.prank(keeper);
        buyback.buyback();
    }

    function test_parametersMoveOnlyThroughTheAdmin() public {
        Buyback.Params memory p = _params();
        p.spendPerCallMicroUsd = 50e6;

        vm.prank(keeper);
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.setParams(p);

        vm.expectEmit(false, false, false, true, address(buyback));
        emit ParamsUpdated(p);
        _setParams(p);
        assertEq(buyback.params().spendPerCallMicroUsd, 50e6);
    }

    function test_theParameterSetRefusesEveryShapeThatWouldOpenTheGuards() public {
        Buyback.Params memory p = _params();

        p = _params();
        p.spendPerCallMicroUsd = 0;
        _expectBadParams(p, "spendPerCall");

        p = _params();
        p.minSpendMicroUsd = 0;
        _expectBadParams(p, "minSpend");

        p = _params();
        p.minSpendMicroUsd = SPEND_PER_CALL + 1;
        _expectBadParams(p, "minSpend > spendPerCall");

        p = _params();
        p.maxSpendPerWindowMicroUsd = SPEND_PER_CALL - 1;
        _expectBadParams(p, "spendPerCall > maxSpendPerWindow");

        // Not the ceiling: zero is legal there and blocks every trade. What is rejected is a
        // number too large to be a price, which is what a figure in the retired unit looks
        // like.
        p = _params();
        p.maxPriceMicroUsdPerBrsr = 1e12 + 1;
        _expectBadParams(p, "maxPrice");

        p = _params();
        p.window = 0;
        _expectBadParams(p, "window");

        p = _params();
        p.window = 31 days;
        _expectBadParams(p, "window > 30 days");

        p = _params();
        p.minInterval = WINDOW + 1;
        _expectBadParams(p, "minInterval > window");
    }

    function _expectBadParams(Buyback.Params memory p, string memory what) internal {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Buyback.BadParams.selector, what));
        buyback.setParams(p);
    }

    /// Lowering the cap below what the live window already spent is a legitimate tightening.
    /// It has to close the window rather than revert every call until the period rolls.
    function test_tighteningTheCapMidWindowClosesItRatherThanBreakingIt() public {
        _fund(10_000e6);
        vm.prank(keeper);
        buyback.buyback();

        Buyback.Params memory p = _params();
        p.spendPerCallMicroUsd = 20e6;
        p.maxSpendPerWindowMicroUsd = 50e6;
        _setParams(p);

        vm.warp(block.timestamp + MIN_INTERVAL);
        assertEq(buyback.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.BelowMinimumSpend.selector, 0, MIN_SPEND));
        buyback.buyback();

        vm.warp(block.timestamp + WINDOW);
        assertEq(buyback.available(), 20e6);
    }

    /// Changing the window length must not hand the current window a reset, which is what
    /// applying a new duration to an old start would do for anyone willing to time the change.
    function test_changingTheWindowLengthDoesNotResetTheLiveOne() public {
        _fund(10_000e6);
        for (uint256 i; i < 5; ++i) {
            vm.warp(block.timestamp + MIN_INTERVAL);
            vm.prank(keeper);
            buyback.buyback();
        }
        assertEq(buyback.window().spentMicroUsd, MAX_PER_WINDOW);

        Buyback.Params memory p = _params();
        p.window = 2 days;
        _setParams(p);

        assertEq(buyback.window().spentMicroUsd, MAX_PER_WINDOW);
        assertEq(buyback.available(), 0);
    }

    function test_anIdleWindowRollsByWholePeriodsRatherThanToNow() public {
        _fund(10_000e6);
        uint64 startedAt = buyback.window().start;

        vm.prank(keeper);
        buyback.buyback();

        vm.warp(startedAt + WINDOW * 3 + 100);
        Buyback.Window memory w = buyback.window();
        assertEq(w.start, startedAt + WINDOW * 3);
        assertEq(w.spentMicroUsd, 0);
    }

    function test_sweepReturnsMoneyToTheTreasuryAndNowhereElse() public {
        vm.prank(keeper);
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.sweep(address(usdg), 1);

        vm.prank(admin);
        vm.expectRevert(Buyback.ZeroAddress.selector);
        buyback.sweep(address(0), 1);

        uint256 before = usdg.balanceOf(treasury);
        vm.expectEmit(true, false, false, true, address(buyback));
        emit Swept(address(usdg), 400e6);
        vm.prank(admin);
        buyback.sweep(address(usdg), 400e6);

        assertEq(usdg.balanceOf(treasury), before + 400e6);
        assertEq(usdg.balanceOf(address(buyback)), 600e6);
    }

    function test_constructorRefusesAMismatchedTokenOrRecipient() public {
        WideToken wide = new WideToken();

        vm.expectRevert(Buyback.ZeroAddress.selector);
        new Buyback(
            address(0),
            address(brsr),
            address(manager),
            3000,
            60,
            address(0),
            address(staking),
            admin,
            treasury,
            _params()
        );

        vm.expectRevert(
            abi.encodeWithSelector(Buyback.AssetDecimalsMismatch.selector, address(wide), uint8(18), uint8(6))
        );
        new Buyback(
            address(wide),
            address(brsr),
            address(manager),
            3000,
            60,
            address(0),
            address(staking),
            admin,
            treasury,
            _params()
        );

        MockERC20 sixDecimalImposter = new MockERC20();
        vm.expectRevert(
            abi.encodeWithSelector(
                Buyback.AssetDecimalsMismatch.selector, address(sixDecimalImposter), uint8(6), uint8(18)
            )
        );
        new Buyback(
            address(usdg),
            address(sixDecimalImposter),
            address(manager),
            3000,
            60,
            address(0),
            address(staking),
            admin,
            treasury,
            _params()
        );
    }

    /// The pool this buys into has to be the pool the proceeds go to. A staking contract
    /// holding a different stake token would accept the compound and credit it to shares
    /// denominated in something else.
    function test_constructorRefusesAStakingPoolOnDifferentTokens() public {
        BRSR otherStake = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: makeAddr("t2"), treasury: treasury, liquidity: makeAddr("l2")
            })
        );
        Staking wrongStake = new Staking(otherStake, usdg, admin, slashSink, treasury, 7 days, MIN_BOND);

        vm.expectRevert(
            abi.encodeWithSelector(Buyback.StakingTokenMismatch.selector, address(otherStake), address(brsr))
        );
        new Buyback(
            address(usdg),
            address(brsr),
            address(manager),
            3000,
            60,
            address(0),
            address(wrongStake),
            admin,
            treasury,
            _params()
        );

        MockUsdg otherReward = new MockUsdg();
        Staking wrongReward = new Staking(brsr, otherReward, admin, slashSink, treasury, 7 days, MIN_BOND);

        vm.expectRevert(
            abi.encodeWithSelector(Buyback.StakingTokenMismatch.selector, address(otherReward), address(usdg))
        );
        new Buyback(
            address(usdg),
            address(brsr),
            address(manager),
            3000,
            60,
            address(0),
            address(wrongReward),
            admin,
            treasury,
            _params()
        );
    }

    /// A buyback deployed before its pool has a price buys nothing, and that is the state it
    /// is deployed in. `available` says so without costing a transaction.
    function test_aBuybackWithNoPriceCeilingRefusesEveryTrade() public {
        Buyback.Params memory p = _params();
        p.maxPriceMicroUsdPerBrsr = 0;

        Buyback unarmed = new Buyback(
            address(usdg), address(brsr), address(manager), 3000, 60, address(0), address(staking), admin, treasury, p
        );
        usdg.mint(address(unarmed), 1_000e6);
        vm.prank(admin);
        unarmed.setKeeper(keeper);

        assertEq(unarmed.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(Buyback.PriceCeilingUnset.selector);
        unarmed.buyback();

        p.maxPriceMicroUsdPerBrsr = CEILING;
        vm.prank(admin);
        unarmed.setParams(p);
        assertEq(unarmed.available(), SPEND_PER_CALL);
    }

    /// Nobody but the keeper can trigger a buy, the keeper is governance's to name, and a
    /// deployment starts with none.
    function test_onlyTheKeeperBuys() public {
        vm.prank(stranger);
        vm.expectRevert(Buyback.NotKeeper.selector);
        buyback.buyback();

        vm.prank(admin);
        vm.expectRevert(Buyback.NotKeeper.selector);
        buyback.buyback();

        vm.prank(keeper);
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.setKeeper(stranger);

        Buyback fresh = new Buyback(
            address(usdg),
            address(brsr),
            address(manager),
            3000,
            60,
            address(0),
            address(staking),
            admin,
            treasury,
            _params()
        );
        usdg.mint(address(fresh), 1_000e6);
        assertEq(fresh.keeper(), address(0));
        assertEq(fresh.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(Buyback.NotKeeper.selector);
        fresh.buyback();

        // Zero puts the contract back in that state.
        vm.prank(admin);
        buyback.setKeeper(address(0));
        assertEq(buyback.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(Buyback.NotKeeper.selector);
        buyback.buyback();
    }

    /// A ceiling is trusted for `maxCeilingAge` after governance sets it. Past that the keeper is
    /// refused too, until a proposal restates it.
    function test_aStaleCeilingStopsTheKeeperUntilGovernanceRestatesIt() public {
        uint64 staleSince = buyback.ceilingSetAt() + buyback.maxCeilingAge();
        assertEq(buyback.maxCeilingAge(), 7 days);

        // The last second it is trusted.
        vm.warp(staleSince);
        assertEq(buyback.available(), SPEND_PER_CALL);
        vm.prank(keeper);
        buyback.buyback();

        vm.warp(staleSince + MIN_INTERVAL);
        assertEq(buyback.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.PriceCeilingStale.selector, staleSince));
        buyback.buyback();

        _setParams(_params());
        assertEq(buyback.ceilingSetAt(), block.timestamp);
        assertEq(buyback.available(), SPEND_PER_CALL);
        vm.prank(keeper);
        buyback.buyback();
    }

    function test_theCeilingAgeStaysInsideItsBounds() public {
        vm.prank(stranger);
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.setMaxCeilingAge(2 days);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Buyback.BadParams.selector, "maxCeilingAge"));
        buyback.setMaxCeilingAge(1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(Buyback.BadParams.selector, "maxCeilingAge"));
        buyback.setMaxCeilingAge(30 days + 1);

        buyback.setMaxCeilingAge(1 days);
        assertEq(buyback.maxCeilingAge(), 1 days);
        buyback.setMaxCeilingAge(30 days);
        assertEq(buyback.maxCeilingAge(), 30 days);
        vm.stopPrank();
    }

    /// The live pool's shape: twenty-five USDG against 125,000 BRSR, which is $0.000200 a token,
    /// at the 0.30% tier, with the parameters governance proposed for it and a ceiling at $0.000240.
    function _liveShapedPool() internal {
        manager.setReserves(25e6, 125_000e18, 3000);
        usdg.mint(address(manager), 1_000e6);
        _setParams(
            Buyback.Params({
                spendPerCallMicroUsd: 500_000,
                maxSpendPerWindowMicroUsd: 5_000_000,
                minSpendMicroUsd: 100_000,
                maxPriceMicroUsdPerBrsr: LIVE_CEILING,
                window: 1 days,
                minInterval: 1 hours
            })
        );
    }

    /// The trade an open buyback invites: push the pool up, trigger the buy into the pushed
    /// price, sell back into it, all in one transaction. Only the keeper can trigger a buy, so
    /// the whole trade reverts. The keeper still fills at or under the ceiling, and once the
    /// ceiling has gone a week without a proposal restating it the keeper is refused as well.
    function test_buyback_refusesSandwichAndStaleCeiling() public {
        _liveShapedPool();
        PoolTrader trader = new PoolTrader(manager, buyback);
        usdg.mint(address(trader), 10e6);

        uint256[3] memory fronts = [uint256(2_000_000), 1_500_000, 1_000_000];
        for (uint256 i; i < fronts.length; ++i) {
            vm.expectRevert(Buyback.NotKeeper.selector);
            trader.sandwich(fronts[i]);
        }
        assertEq(usdg.balanceOf(address(trader)), 10e6, "the trader moved the pool");
        assertEq(manager.midMicroUsdPerBrsr(), 200, "the pool moved");

        vm.prank(keeper);
        (uint256 spent, uint256 received) = buyback.buyback();
        assertEq(spent, 500_000);
        assertLe(spent * 1e18, received * LIVE_CEILING, "filled above the ceiling");

        uint64 staleSince = buyback.ceilingSetAt() + buyback.maxCeilingAge();
        vm.warp(staleSince + 1);
        assertEq(buyback.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.PriceCeilingStale.selector, staleSince));
        buyback.buyback();
    }

    /// The value the testnet parameters carried as a placeholder that would "refuse every
    /// trade". In the unit it was written in, BRSR wei per whole USDC, it blocked nothing: it
    /// asked for one BRSR per dollar spent, which only bites above a dollar a token, and the
    /// token has never been near that. Every fill cleared and a permissionless buyback ran
    /// with almost no floor under it. Read as a price it is a million million dollars a token,
    /// and the constructor says so.
    function test_theOldPlaceholderIsNotAPriceAndCannotBeDeployed() public {
        Buyback.Params memory p = _params();
        p.maxPriceMicroUsdPerBrsr = 1e18;

        vm.expectRevert(abi.encodeWithSelector(Buyback.BadParams.selector, "maxPrice"));
        new Buyback(
            address(usdg), address(brsr), address(manager), 3000, 60, address(0), address(staking), admin, treasury, p
        );
    }

    function test_adminMovesInTwoSteps() public {
        address next = makeAddr("next");

        vm.prank(stranger);
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.transferAdmin(next);

        vm.prank(admin);
        vm.expectRevert(Buyback.ZeroAddress.selector);
        buyback.transferAdmin(address(0));

        vm.prank(admin);
        buyback.transferAdmin(next);
        assertEq(buyback.admin(), admin);

        vm.prank(stranger);
        vm.expectRevert(Buyback.NotAuthorized.selector);
        buyback.acceptAdmin();

        vm.prank(next);
        buyback.acceptAdmin();
        assertEq(buyback.admin(), next);
        assertEq(buyback.pendingAdmin(), address(0));
    }

    /// `available` reports what a call would spend, so the keeper never pays for a reverting
    /// transaction. It has to agree with `buyback` in every state, a stale ceiling included.
    function testFuzz_availableAgreesWithWhatABuybackSpends(uint64 balance, uint32 wait, bool paused) public {
        uint256 held = bound(balance, 0, 10_000e6);
        deal(address(usdg), address(buyback), held);

        if (paused) {
            vm.prank(admin);
            buyback.pause();
        }
        vm.warp(block.timestamp + bound(wait, 0, 10 days));

        uint256 quoted = buyback.available();

        vm.prank(keeper);
        try buyback.buyback() returns (uint256 spent, uint256) {
            assertEq(spent, quoted);
            assertGt(quoted, 0);
        } catch {
            assertEq(quoted, 0);
        }
    }

    /// However far a trader pushes the pool ahead of the keeper, in either direction, the
    /// buyback fills at or under the ceiling or buys nothing. Nothing between those two states
    /// is reachable.
    function testFuzz_aBuybackNeverFillsAboveTheCeiling(uint96 push, bool up) public {
        _liveShapedPool();
        PoolTrader trader = new PoolTrader(manager, buyback);
        usdg.mint(address(trader), 50e6);
        brsr.transfer(address(trader), 1_000_000e18);

        if (up) trader.buy(bound(push, 1, 50e6));
        else trader.sell(bound(push, 1e15, 1_000_000e18));

        uint256 mid = manager.midMicroUsdPerBrsr();
        uint256 before = brsr.balanceOf(address(manager));

        vm.prank(keeper);
        try buyback.buyback() returns (uint256 spent, uint256 received) {
            // What was paid per whole BRSR, at or under what governance allowed.
            assertLe(spent * 1e18, received * LIVE_CEILING);
            assertEq(before - brsr.balanceOf(address(manager)), received);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), Buyback.MinimumOutNotMet.selector);
            assertEq(brsr.balanceOf(address(manager)), before);
            // Only a pool pushed close to the ceiling refuses; the fee and the buy's own impact
            // are the rest of the gap.
            assertGt(mid * 10_000, uint256(LIVE_CEILING) * 9_000);
        }
    }
}

/// The buyback under the governance that holds it. The deploy key administers nothing, and the
/// guardian's brake is the only fast response to a ceiling the market has left behind.
contract BuybackUnderTimelockTest is Test {
    uint256 internal constant MIN_BOND = 1_000e18;

    uint64 internal constant PERIOD = 48 hours;

    AdminTimelock internal timelock;
    BRSR internal brsr;
    MockUsdg internal usdg;
    Staking internal staking;
    MockPoolManager internal manager;
    Buyback internal buyback;

    address internal signerA = makeAddr("signerA");
    address internal signerB = makeAddr("signerB");
    address internal signerC = makeAddr("signerC");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        timelock = new AdminTimelock([signerA, signerB, signerC], guardian, PERIOD);

        usdg = new MockUsdg();
        brsr = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: makeAddr("team"), treasury: treasury, liquidity: makeAddr("liquidity")
            })
        );
        staking = new Staking(brsr, usdg, address(timelock), makeAddr("slashSink"), treasury, 7 days, MIN_BOND);
        manager = new MockPoolManager(usdg, brsr, 2e18);

        buyback = new Buyback(
            address(usdg),
            address(brsr),
            address(manager),
            3000,
            60,
            address(0),
            address(staking),
            address(timelock),
            treasury,
            Buyback.Params({
                spendPerCallMicroUsd: 100e6,
                maxSpendPerWindowMicroUsd: 500e6,
                minSpendMicroUsd: 10e6,
                maxPriceMicroUsdPerBrsr: 1_000_000,
                window: 1 days,
                minInterval: 1 hours
            })
        );

        manager.initialize(
            PoolKey({
                currency0: buyback.currency0(),
                currency1: buyback.currency1(),
                fee: 3000,
                tickSpacing: 60,
                hooks: address(0)
            })
        );

        brsr.transfer(address(manager), 100_000_000e18);
        brsr.approve(address(staking), 1_000e18);
        staking.stake(1_000e18);
        usdg.mint(address(buyback), 1_000e6);

        _pass(abi.encodeCall(Buyback.setKeeper, (keeper)));
    }

    function _pass(bytes memory data) internal {
        vm.prank(signerA);
        uint256 id = timelock.propose(address(buyback), data);
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(signerA);
        timelock.execute(id);
    }

    function test_theDeployKeyAdministersNothing() public {
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.pause();

        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.sweep(address(usdg), 1);

        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.transferAdmin(address(this));

        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.setKeeper(address(this));

        vm.expectRevert(Buyback.NotKeeper.selector);
        buyback.buyback();

        assertEq(buyback.admin(), address(timelock));
        assertEq(buyback.keeper(), keeper);
    }

    /// A signer is not the keeper either. Naming one is a proposal, and so is replacing it.
    function test_theKeeperIsNamedByProposal() public {
        vm.prank(signerA);
        vm.expectRevert(Buyback.NotKeeper.selector);
        buyback.buyback();

        vm.prank(signerA);
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.setKeeper(signerA);

        address next = makeAddr("nextKeeper");
        _pass(abi.encodeCall(Buyback.setKeeper, (next)));
        assertEq(buyback.keeper(), next);

        vm.prank(keeper);
        vm.expectRevert(Buyback.NotKeeper.selector);
        buyback.buyback();
        vm.prank(next);
        buyback.buyback();
    }

    /// The guardian stops it in one call with no approvals and no delay, and that is the only
    /// thing the guardian can do here. Restarting is a proposal like any other change.
    function test_theGuardianStopsItInOneCallAndCannotStartItAgain() public {
        address[] memory targets = new address[](1);
        targets[0] = address(buyback);

        vm.prank(guardian);
        timelock.guardianPause(targets);
        assertTrue(buyback.paused());

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.propose(address(buyback), abi.encodeCall(Buyback.unpause, ()));

        vm.prank(signerA);
        uint256 id = timelock.propose(address(buyback), abi.encodeCall(Buyback.unpause, ()));
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(signerA);
        timelock.execute(id);

        assertFalse(buyback.paused());
    }

    function test_aCeilingChangeWaitsOutTheDelay() public {
        Buyback.Params memory p = buyback.params();
        p.maxPriceMicroUsdPerBrsr = 250_000;

        vm.prank(signerA);
        uint256 id = timelock.propose(address(buyback), abi.encodeCall(Buyback.setParams, (p)));
        vm.prank(signerB);
        timelock.approve(id);

        // Buying carries on at the old ceiling for the length of the delay, which is the
        // exposure the brake exists to cover.
        vm.prank(keeper);
        buyback.buyback();

        vm.warp(block.timestamp + PERIOD);
        vm.prank(signerA);
        timelock.execute(id);
        assertEq(buyback.params().maxPriceMicroUsdPerBrsr, 250_000);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.MinimumOutNotMet.selector, 200e18, 400e18));
        buyback.buyback();
    }
}
