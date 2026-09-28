// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {V4Math} from "../../script/lib/V4Math.sol";
import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {Buyback} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/// The whole $BRSR rail, against the real Uniswap v4 deployment on Robinhood Chain.
///
/// Every contract under test here is the one that is live at the addresses below: the BRSR
/// token, the staking pool, the buyback, the admin timelock and Uniswap's PoolManager. Only the
/// seeder is new, and it is deployed into the fork at the address the same bytecode would take
/// on chain. Nothing is mocked, which is the point: a mock pool manager can be made to agree
/// with whatever the contract under test expects, and the question this file exists to answer is
/// whether `Buyback` works against a v4 pool that was not written to suit it.
///
/// Run it with a fork endpoint in the environment:
///
///   BURSAR_RHC_FORK_RPC=<archive rpc for 4663> forge test --match-path test/token/TokenRailFork.t.sol -vv
///
/// Without that variable every test here skips, so the offline suite is unaffected. The block is
/// pinned, because an unpinned fork reports a different execution price every hour and none of
/// them can be checked later.
contract TokenRailForkTest is Test {
    // Uniswap v4 on chain 4663.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    // Ours, deployed 2026-09-22.
    address internal constant BRSR = 0x00e503925880c4b07E5Fb70232D83aD871F57a7d;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant STAKING = 0x3f2a0E7822B30aD928488F053348b137866Cf962;
    address internal constant BUYBACK = 0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0;
    address internal constant TIMELOCK = 0x5a32Eab02454f97a39857E85b536F83EE0f844Bf;

    address internal constant LIQUIDITY = 0x0DF776dBD1Ce5A8F38993Bc98bc3D81661FA51B2;
    address internal constant TREASURY = 0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21;
    address internal constant SIGNER_1 = 0xb51c63568324848DfC88A09f91F06fA86771aB69;
    address internal constant SIGNER_2 = 0x3C7facc7C72c3aCeB2EF93703813652aC9039266;

    /// A plain address holding tens of millions of USDG on 4663, used only as a source of test
    /// funds inside the fork. Read off the token's holder list, never written to.
    address internal constant USDG_WHALE = 0x6bEbb110c9BB93D529d1EAB51D44bcf49ae585D5;

    /// Pinned. 2026-09-23, a few thousand blocks behind head at the time this was written.
    uint256 internal constant FORK_BLOCK = 70_730_000;

    /// The pending changes the live timelock is already carrying: 1 writes the staking rebate
    /// table, 2 restarts the buyback after the guardian stopped it.
    uint256 internal constant PROPOSAL_SET_TIERS = 1;
    uint256 internal constant PROPOSAL_UNPAUSE_BUYBACK = 2;

    /// The opening price this run seeds at, in micro-USD for one whole BRSR. $0.000200.
    uint256 internal constant OPEN_PRICE_MICRO_USD = 200;

    /// `sqrtPriceX96` for that price, derived outside Solidity as
    /// `isqrt((200 << 192) / 1e18)` and carried here as a literal so the library is checked
    /// against a number it did not produce.
    uint160 internal constant OPEN_SQRT_PRICE_X96 = 1120455419495722798374;

    /// The ceiling the buyback proposal writes: the most governance will pay for one whole
    /// BRSR, in micro-USD. Twenty per cent above the opening price.
    uint128 internal constant CEILING_MICRO_USD = 240;

    uint256 internal constant BRSR_UNIT = 1e18;
    uint256 internal constant USDG_UNIT = 1e6;

    V4LiquiditySeeder internal seeder;
    bytes32 internal poolId;

    modifier onFork() {
        string memory rpc = vm.envOr("BURSAR_RHC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("BURSAR_RHC_FORK_RPC is unset; skipping the fork run.");
            vm.skip(true);
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        require(block.chainid == 4663, "fork is not chain 4663");
        seeder = new V4LiquiditySeeder(POOL_MANAGER, BUYBACK, LIQUIDITY);
        poolId = seeder.poolId();
        _;
    }

    // --------------------------------------------------------------------------------------
    // The run that matters: seed, set a ceiling, stake, buy back.
    // --------------------------------------------------------------------------------------

    /// Seeds at the depth this repository would defend on mainnet: 25 USDG a side, full range.
    function test_rail_atDefendedDepth() public onFork {
        _rail(25 * USDG_UNIT, "25 USDG a side");
    }

    /// Seeds at the depth the deploy key can actually afford today, which is 8.088 USDG.
    function test_rail_atAffordableDepth() public onFork {
        _rail(8 * USDG_UNIT, "8 USDG a side");
    }

    function _rail(uint256 usdgSide, string memory label) internal {
        console2.log("");
        console2.log("================================================================");
        console2.log(label);
        console2.log("================================================================");

        // ---- 1. the pool key is the buyback's own, not one this test assembled ------------
        assertEq(seeder.currency0(), BRSR, "currency0 is not BRSR");
        assertEq(seeder.currency1(), USDG, "currency1 is not USDG");
        assertEq(seeder.poolFee(), 3000, "fee tier");
        assertEq(seeder.poolTickSpacing(), int24(60), "tick spacing");
        assertEq(seeder.poolHooks(), address(0), "hooks");
        assertEq(Buyback(BUYBACK).currency0(), seeder.currency0(), "the buyback and the seeder disagree on currency0");
        assertEq(Buyback(BUYBACK).currency1(), seeder.currency1(), "the buyback and the seeder disagree on currency1");
        assertEq(
            poolId,
            bytes32(0x95bdade638ae86f8f1e424a2561796dd3aea34d75f594bd03cdb8d9e615ec765),
            "not the pool id recorded in contracts/deployments/rhc-mainnet-token.json"
        );

        // ---- 2. the opening price, derived twice ------------------------------------------
        uint160 sqrtPriceX96 = _openingSqrtPrice();

        // ---- 3. open the pool and seed it -------------------------------------------------
        (uint128 liquidity, uint256 brsrIn, uint256 usdgIn) = _seed(sqrtPriceX96, usdgSide);

        (uint160 sqrtAfterSeed, int24 tickAfterSeed,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        assertEq(sqrtAfterSeed, sqrtPriceX96, "the pool did not open where it was told to");
        assertEq(IStateView(STATE_VIEW).getLiquidity(poolId), liquidity, "pool liquidity");
        console2.log("opening tick                 ", vm.toString(tickAfterSeed));
        console2.log("mid, micro-USD per BRSR (x1e6)", _midMicroUsdScaled(sqrtAfterSeed));

        // ---- 4. governance: tiers, restart, ceiling ---------------------------------------
        _executePending(PROPOSAL_SET_TIERS);
        _executePending(PROPOSAL_UNPAUSE_BUYBACK);
        assertFalse(Buyback(BUYBACK).paused(), "buyback still stopped");

        bytes memory ceilingCalldata = _ceilingCalldata(CEILING_MICRO_USD);
        _proposeApproveExecute(BUYBACK, ceilingCalldata);
        assertEq(Buyback(BUYBACK).params().maxPriceMicroUsdPerBrsr, CEILING_MICRO_USD, "ceiling");

        // ---- 5. stake -------------------------------------------------------------------
        _stake(makeAddr("staker"), 100_000 * BRSR_UNIT);

        // ---- 6. fund the buyback and run one ----------------------------------------------
        _buyOnce(_midMicroUsdScaled(sqrtAfterSeed));

        console2.log("--- what it cost to seed ---");
        console2.log("BRSR in, whole               ", brsrIn / BRSR_UNIT);
        console2.log("USDG in, micro               ", usdgIn);
        console2.log("liquidity                    ", liquidity);
    }

    function _stake(address staker, uint256 amount) internal {
        vm.prank(TREASURY);
        IERC20(BRSR).transfer(staker, amount);
        vm.startPrank(staker);
        IERC20(BRSR).approve(STAKING, amount);
        uint256 shares = Staking(STAKING).stake(amount);
        vm.stopPrank();
        assertGt(shares, 0, "no shares minted");
        console2.log("--- staking ---");
        console2.log("staked BRSR, whole           ", amount / BRSR_UNIT);
        console2.log("shares                       ", shares);
        console2.log("rebate, bps                  ", Staking(STAKING).rebateBpsOf(staker));
    }

    /// Funds the buyback, runs one, and reports what the pool actually filled at.
    function _buyOnce(uint256 midBefore) internal {
        uint256 funding = 2 * USDG_UNIT;
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(BUYBACK, funding);

        assertEq(Buyback(BUYBACK).available(), 500_000, "the buyback would not spend its per-call target");

        uint256 stakedBefore = Staking(STAKING).totalStaked();

        vm.prank(makeAddr("anyone"));
        uint256 gasBuy = gasleft();
        (uint256 spent, uint256 received) = Buyback(BUYBACK).buyback();
        gasBuy = gasBuy - gasleft();

        (uint160 sqrtAfterBuy, int24 tickAfterBuy,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        uint256 midAfter = _midMicroUsdScaled(sqrtAfterBuy);

        // The execution price, in micro-USD for one whole BRSR, scaled by a further 1e6 so the
        // log keeps six digits below the unit.
        uint256 fill = (spent * BRSR_UNIT * 1e6) / received;

        console2.log("--- the buyback ---");
        console2.log("spent, micro-USD             ", spent);
        console2.log("received, BRSR wei           ", received);
        console2.log("received, whole BRSR         ", received / BRSR_UNIT);
        console2.log("mid before (x1e6)            ", midBefore);
        console2.log("fill       (x1e6)            ", fill);
        console2.log("mid after  (x1e6)            ", midAfter);
        console2.log("fill over mid, bps           ", ((fill - midBefore) * 10_000) / midBefore);
        console2.log("mid moved, bps               ", ((midAfter - midBefore) * 10_000) / midBefore);
        console2.log("tick after                   ", vm.toString(tickAfterBuy));
        console2.log("gas, buyback()               ", gasBuy);

        assertEq(spent, 500_000, "spent something other than the per-call target");
        assertGt(received, 0, "bought nothing");
        assertGe(fill, midBefore, "a fill below mid means the direction is wrong");
        assertEq(
            Staking(STAKING).totalStaked() - stakedBefore, received, "the staking pool was not credited the whole buy"
        );
        assertEq(IERC20(BRSR).balanceOf(BUYBACK), 0, "BRSR stayed in the buyback");
        assertEq(IERC20(USDG).balanceOf(BUYBACK), funding - spent, "USDG accounting");
    }

    /// The buyback refuses to pay above the ceiling. Set one below the market and the call has
    /// to revert rather than fill badly, which is the guard the whole design rests on.
    function test_ceilingBelowMarketRefusesTheTrade() public onFork {
        uint160 sqrtPriceX96 = _openingSqrtPrice();
        _seed(sqrtPriceX96, 25 * USDG_UNIT);
        _executePending(PROPOSAL_SET_TIERS);
        _executePending(PROPOSAL_UNPAUSE_BUYBACK);

        // A tenth of the opening price. Every fill is above it.
        _proposeApproveExecute(BUYBACK, _ceilingCalldata(uint128(OPEN_PRICE_MICRO_USD / 10)));

        address staker = makeAddr("staker");
        vm.prank(TREASURY);
        IERC20(BRSR).transfer(staker, 100_000 * BRSR_UNIT);
        vm.startPrank(staker);
        IERC20(BRSR).approve(STAKING, 100_000 * BRSR_UNIT);
        Staking(STAKING).stake(100_000 * BRSR_UNIT);
        vm.stopPrank();

        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(BUYBACK, 2 * USDG_UNIT);

        // The swap runs, the fill comes back above the ceiling, and the minimum-out check
        // unwinds the whole call. The ceiling is the binding guard, exactly as designed.
        vm.expectPartialRevert(Buyback.MinimumOutNotMet.selector);
        Buyback(BUYBACK).buyback();
    }

    /// An unseeded pool has no liquidity, so an exact-input swap fills nothing and the buyback
    /// has to notice. This is the state chain 4663 is in today.
    ///
    /// It notices, but it names the wrong thing: v4 returns a zero delta on both legs, and
    /// `Buyback` tests the direction before it tests the amount, so the refusal reads
    /// `SwapDirectionWrong(0, 0)`, which is the error for a hook that rewrote the swap. The
    /// money is safe either way. Recorded here so the message is a known quantity rather than a
    /// surprise during an incident; see script/TOKEN-README.md.
    function test_buybackAgainstAnEmptyPoolReverts() public onFork {
        uint160 sqrtPriceX96 = _openingSqrtPrice();

        // Open the pool and put nothing in it.
        vm.prank(LIQUIDITY);
        seeder.initializePool(sqrtPriceX96);

        _executePending(PROPOSAL_SET_TIERS);
        _executePending(PROPOSAL_UNPAUSE_BUYBACK);
        _proposeApproveExecute(BUYBACK, _ceilingCalldata(CEILING_MICRO_USD));

        address staker = makeAddr("staker");
        vm.prank(TREASURY);
        IERC20(BRSR).transfer(staker, 100_000 * BRSR_UNIT);
        vm.startPrank(staker);
        IERC20(BRSR).approve(STAKING, 100_000 * BRSR_UNIT);
        Staking(STAKING).stake(100_000 * BRSR_UNIT);
        vm.stopPrank();

        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(BUYBACK, 2 * USDG_UNIT);

        vm.expectRevert(abi.encodeWithSelector(Buyback.SwapDirectionWrong.selector, int256(0), int256(0)));
        Buyback(BUYBACK).buyback();
    }

    /// The position comes back out, which is the difference between seeding a market and
    /// posting a bond nobody can collect.
    function test_liquidityComesBackOut() public onFork {
        uint160 sqrtPriceX96 = _openingSqrtPrice();
        (uint128 liquidity, uint256 brsrIn, uint256 usdgIn) = _seed(sqrtPriceX96, 25 * USDG_UNIT);

        (int24 tickLower, int24 tickUpper) = V4Math.fullRangeTicks(60);
        vm.prank(LIQUIDITY);
        (uint256 out0, uint256 out1) = seeder.removeLiquidity(tickLower, tickUpper, liquidity, 0, 0, LIQUIDITY);

        // v4 rounds a deposit up and a withdrawal down, so a round trip returns a wei or two
        // less on each leg. Anything larger would be a bug.
        assertApproxEqAbs(out0, brsrIn, 2, "BRSR did not come back");
        assertApproxEqAbs(out1, usdgIn, 2, "USDG did not come back");
        assertEq(IStateView(STATE_VIEW).getLiquidity(poolId), 0, "liquidity left behind");
    }

    // --------------------------------------------------------------------------------------
    // Pieces
    // --------------------------------------------------------------------------------------

    /// Derives the opening price twice and prints both. The first path squares the ratio into
    /// Q192 and takes one integer square root; the second square-roots in Q96 and shifts the
    /// half-precision back. They are different arithmetic over the same definition.
    function _openingSqrtPrice() internal pure returns (uint160) {
        // One whole BRSR is 1e18 raw units. OPEN_PRICE_MICRO_USD of a dollar is that many raw
        // USDG units, because USDG carries six decimals and a micro-dollar is its smallest
        // unit. currency0 is BRSR and currency1 is USDG, so the ratio is USDG over BRSR.
        uint256 amount0 = BRSR_UNIT;
        uint256 amount1 = OPEN_PRICE_MICRO_USD;

        uint160 viaQ192 = V4Math.initialSqrtPriceX96(amount0, amount1);
        uint160 viaQ96 = V4Math.initialSqrtPriceX96ViaQ96(amount0, amount1);

        console2.log("--- opening price ---");
        console2.log("target, micro-USD per BRSR   ", OPEN_PRICE_MICRO_USD);
        console2.log("sqrtPriceX96 via Q192        ", viaQ192);
        console2.log("sqrtPriceX96 via Q96         ", viaQ96);
        console2.log("sqrtPriceX96 literal         ", OPEN_SQRT_PRICE_X96);

        assertEq(viaQ192, OPEN_SQRT_PRICE_X96, "the library disagrees with the off-chain integer square root");
        // One tick is a part in ten thousand of price, so half that in the square root: 5e-5.
        // A fiftieth of that, 1e-6, is the tolerance here, and the two paths came in at 7.4e-8
        // of each other at this price.
        assertApproxEqRel(uint256(viaQ96), uint256(viaQ192), 1e12, "the two derivations disagree");

        return viaQ192;
    }

    function _seed(uint160 sqrtPriceX96, uint256 usdgSide)
        internal
        returns (uint128 liquidity, uint256 brsrIn, uint256 usdgIn)
    {
        Plan memory plan = _plan(sqrtPriceX96, usdgSide);
        liquidity = plan.liquidity;

        console2.log("--- the seed ---");
        console2.log("liquidity                    ", plan.liquidity);
        console2.log("predicted BRSR, wei          ", plan.predicted0);
        console2.log("predicted USDG, micro        ", plan.predicted1);

        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(LIQUIDITY, usdgSide);

        vm.startPrank(LIQUIDITY);
        uint256 gasApprove = gasleft();
        IERC20(BRSR).approve(address(seeder), plan.brsrSide);
        IERC20(USDG).approve(address(seeder), usdgSide);
        gasApprove = gasApprove - gasleft();

        uint256 gasInit = gasleft();
        seeder.initializePool(sqrtPriceX96);
        gasInit = gasInit - gasleft();

        uint256 gasAdd = gasleft();
        (brsrIn, usdgIn) = seeder.addLiquidity(plan.tickLower, plan.tickUpper, plan.liquidity, plan.brsrSide, usdgSide);
        gasAdd = gasAdd - gasleft();
        vm.stopPrank();

        console2.log("gas, two approvals           ", gasApprove);
        console2.log("gas, initializePool          ", gasInit);
        console2.log("gas, addLiquidity            ", gasAdd);

        assertEq(brsrIn, plan.predicted0, "the pool took a different amount of BRSR than the algebra said");
        assertEq(usdgIn, plan.predicted1, "the pool took a different amount of USDG than the algebra said");
        assertLe(brsrIn, plan.brsrSide, "over the BRSR maximum");
        assertLe(usdgIn, usdgSide, "over the USDG maximum");
    }

    struct Plan {
        int24 tickLower;
        int24 tickUpper;
        uint256 brsrSide;
        uint128 liquidity;
        uint256 predicted0;
        uint256 predicted1;
    }

    /// The position `usdgSide` micro-USD buys at the opening price, over the widest range the
    /// spacing allows.
    function _plan(uint160 sqrtPriceX96, uint256 usdgSide) internal pure returns (Plan memory plan) {
        (plan.tickLower, plan.tickUpper) = V4Math.fullRangeTicks(60);
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(plan.tickLower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(plan.tickUpper);

        // The BRSR side the position needs: `usdgSide` micro-USD at `OPEN_PRICE_MICRO_USD` for
        // one whole BRSR buys that many whole BRSR, carried into wei.
        plan.brsrSide = (usdgSide * BRSR_UNIT) / OPEN_PRICE_MICRO_USD;

        plan.liquidity = V4Math.getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, plan.brsrSide, usdgSide);
        plan.predicted0 = V4Math.amount0For(sqrtPriceX96, sqrtA, sqrtB, plan.liquidity);
        plan.predicted1 = V4Math.amount1For(sqrtPriceX96, sqrtA, sqrtB, plan.liquidity);
    }

    /// The whole `setParams` struct, with only the ceiling changed. `setParams` takes every
    /// field, so a proposal that touches one has to restate the other five.
    function _ceilingCalldata(uint128 ceiling) internal view returns (bytes memory) {
        Buyback.Params memory p = Buyback(BUYBACK).params();
        p.maxPriceMicroUsdPerBrsr = ceiling;
        return abi.encodeCall(Buyback.setParams, (p));
    }

    function _executePending(uint256 id) internal {
        AdminTimelock timelock = AdminTimelock(TIMELOCK);
        AdminTimelock.Proposal memory p = timelock.getProposal(id);
        if (p.executed) return;
        if (block.timestamp < p.executeAfter) vm.warp(p.executeAfter);
        vm.prank(SIGNER_1);
        timelock.execute(id);
    }

    function _proposeApproveExecute(address target, bytes memory data) internal {
        AdminTimelock timelock = AdminTimelock(TIMELOCK);
        vm.prank(SIGNER_1);
        uint256 id = timelock.propose(target, data);
        vm.prank(SIGNER_2);
        timelock.approve(id);
        vm.warp(block.timestamp + timelock.timelockPeriod() + 1);
        vm.prank(SIGNER_1);
        timelock.execute(id);
    }

    /// The pool's mid price in micro-USD for one whole BRSR, scaled by a further 1e6 so the
    /// number keeps six decimals of a micro-dollar.
    ///
    /// `sqrtPriceX96` squares to raw USDG per raw BRSR. One whole BRSR is 1e18 raw and one
    /// micro-USD is 1 raw USDG, so the conversion from the raw ratio to micro-USD per whole
    /// BRSR is a factor of 1e18, and the extra 1e6 is the display scale.
    function _midMicroUsdScaled(uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        // (s / 2**96)**2 * 1e18 * 1e6, kept in integers. s**2 is at most 2**320 for the whole
        // tick range, so it is split rather than squared in one word.
        return (((s * s) >> 96) * 1e24) >> 96;
    }
}
