// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PoolSeeding} from "./SeedPool.s.sol";
import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {V4Math} from "./lib/V4Math.sol";

import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";

/// The part of the replaced seeder this step calls. It was built before ownership could move, so
/// its owner is the liquidity key for good, and the position has to come out and go back in.
interface IRetiringSeeder {
    function owner() external view returns (address);
    function poolId() external view returns (bytes32);
    function liquidityOf(int24 tickLower, int24 tickUpper) external view returns (uint128);
    function removeLiquidity(
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        address to
    ) external returns (uint256 amount0, uint256 amount1);
}

/// Moves the BRSR/USDG position from the seeder the liquidity key owns to the one governance owns,
/// in one run from the liquidity key: take the whole position out, then put what came back into the
/// new seeder at the same price, the way `SeedPool.seedExisting` adds to an open pool.
///
/// The two transactions go out back to back. Removing liquidity does not move the price, so the
/// add is planned at the price the pool stood at, and its maxima are the exact amounts that price
/// asks for: a price pushed in between makes the add revert rather than pay more. The tokens then
/// sit in the liquidity wallet, and `SeedPool.seedExisting`, with the price read here as
/// `BURSAR_SEED_PRICE_MICRO_USD`, puts them in once the pool is back.
///
/// Run it without `--broadcast` first and without `--slow` for the real one, so the second
/// transaction is not held back for the first one's receipt.
///
/// | | |
/// |---|---|
/// | `BURSAR_TOKEN_RECORD` | names the replaced seeder |
/// | `BURSAR_MIGRATE_SLIPPAGE_BPS` | how much less than the planned amounts the removal may return, default 50 |
/// | `BURSAR_SEED_PRICE_MICRO_USD` | optional: the price you expect the pool to be at, checked within `BURSAR_SEED_MAX_DEVIATION_BPS` |
/// | `BURSAR_ALLOW_MAINNET_SEED` | `i-am-moving-the-market`, required on 4663 |
contract MigrateLiquidity is PoolSeeding, Migration {
    uint256 internal constant DEFAULT_SLIPPAGE_BPS = 50;

    struct Move {
        int24 lower;
        int24 upper;
        uint128 held;
        uint128 poolBefore;
        uint160 sqrtPriceX96;
        uint24 protocolFee;
        uint256 min0;
        uint256 min1;
    }

    function run() external {
        _begin();
        Market memory m = _market();
        V4LiquiditySeeder next = V4LiquiditySeeder(_upstream(K.SEEDER));
        _requireSeederFor(next, m);

        IRetiringSeeder old = IRetiringSeeder(_old("BURSAR_TOKEN_RECORD", ".contracts.V4LiquiditySeeder"));
        _requireKey("owner of the replaced seeder", old.owner());
        require(old.poolId() == m.id, "the replaced seeder holds a position in another pool");
        _requireShape(m.buyback);

        Move memory mv = _measure(m, old);
        if (mv.held == 0) {
            _note("The replaced seeder holds no liquidity. Nothing to move.");
            return;
        }
        console2.log("from                          ", address(old));
        console2.log("to                            ", address(next));
        if (!_allowed("i-am-moving-the-market")) return;

        vm.startBroadcast(msg.sender);
        (uint256 brsrOut, uint256 usdgOut) =
            old.removeLiquidity(mv.lower, mv.upper, mv.held, mv.min0, mv.min1, msg.sender);
        Plan memory plan = _plan(m.buyback, mv.sqrtPriceX96, brsrOut, usdgOut);
        IERC20(address(m.buyback.brsr())).approve(address(next), plan.brsrNeeded);
        IERC20(address(m.buyback.settlementAsset())).approve(address(next), plan.usdgNeeded);
        (uint256 brsrIn, uint256 usdgIn) =
            next.addLiquidity(plan.tickLower, plan.tickUpper, plan.liquidity, plan.brsrNeeded, plan.usdgNeeded);
        vm.stopBroadcast();

        uint128 settled = mv.poolBefore - mv.held + plan.liquidity;
        _report(m.buyback, plan, _virtualUsdg(plan, settled), mv.protocolFee);
        _readBack(m.stateView, m.id, mv.sqrtPriceX96, settled, brsrIn, usdgIn);
        require(old.liquidityOf(mv.lower, mv.upper) == 0, "the replaced seeder still holds liquidity");
        require(next.liquidityOf(mv.lower, mv.upper) == plan.liquidity, "the new seeder does not hold the position");
        console2.log("left in the liquidity wallet, BRSR wei ", brsrOut - brsrIn);
        console2.log("left in the liquidity wallet, USDG micro", usdgOut - usdgIn);
    }

    /// The position as it stands and the least the removal may return. Removing liquidity does not
    /// move the price, so what comes back is what the position is worth at the price read here.
    function _measure(Market memory m, IRetiringSeeder old) private view returns (Move memory mv) {
        (mv.lower, mv.upper) = V4Math.fullRangeTicks(m.buyback.poolTickSpacing());
        mv.held = old.liquidityOf(mv.lower, mv.upper);
        if (mv.held == 0) return mv;

        (mv.sqrtPriceX96,, mv.protocolFee,) = m.stateView.getSlot0(m.id);
        uint256 midScaled = _midMicroUsdScaled(mv.sqrtPriceX96);
        _requireNear(midScaled);
        mv.poolBefore = m.stateView.getLiquidity(m.id);

        uint160 sqrtA = V4Math.getSqrtPriceAtTick(mv.lower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(mv.upper);
        uint256 keep = BPS - _envUintOr("BURSAR_MIGRATE_SLIPPAGE_BPS", DEFAULT_SLIPPAGE_BPS);
        mv.min0 = (V4Math.amount0For(mv.sqrtPriceX96, sqrtA, sqrtB, mv.held) * keep) / BPS;
        mv.min1 = (V4Math.amount1For(mv.sqrtPriceX96, sqrtA, sqrtB, mv.held) * keep) / BPS;

        console2.log("--- the move ---");
        console2.log("mid, micro-USD per BRSR (x1e6)", midScaled);
        console2.log("liquidity to move             ", mv.held);
        console2.log("at least this BRSR back, wei  ", mv.min0);
        console2.log("at least this USDG back, micro", mv.min1);
    }
}
