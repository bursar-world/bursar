// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SeedPool} from "../../script/SeedPool.s.sol";
import {V4Math} from "../../script/lib/V4Math.sol";
import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {Buyback, IPoolManager, PoolKey, SwapParams} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/// Buys BRSR, triggers a buyback, and sells back into it, in one transaction against the real
/// pool.
contract ForkSandwicher {
    IPoolManager internal immutable manager;
    Buyback internal immutable buyback;

    constructor(IPoolManager manager_, Buyback buyback_) {
        manager = manager_;
        buyback = buyback_;
    }

    function run(uint256 front) external {
        _swap(false, front);
        buyback.buyback();
        _swap(true, buyback.brsr().balanceOf(address(this)));
    }

    function _swap(bool zeroForOne, uint256 amountIn) internal {
        manager.unlock(abi.encode(zeroForOne, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (bool zeroForOne, uint256 amountIn) = abi.decode(data, (bool, uint256));
        PoolKey memory key = PoolKey({
            currency0: buyback.currency0(),
            currency1: buyback.currency1(),
            fee: buyback.poolFee(),
            tickSpacing: buyback.poolTickSpacing(),
            hooks: buyback.poolHooks()
        });
        int256 delta = manager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341
            }),
            ""
        );
        int256 delta0 = int256(int128(delta >> 128));
        int256 delta1 = int256(int128(delta));
        (address tokenIn, int256 inDelta, address tokenOut, int256 outDelta) =
            zeroForOne ? (key.currency0, delta0, key.currency1, delta1) : (key.currency1, delta1, key.currency0, delta0);

        manager.sync(tokenIn);
        IERC20(tokenIn).transfer(address(manager), uint256(-inDelta));
        manager.settle();
        manager.take(tokenOut, address(this), uint256(outDelta));
        return "";
    }
}

/// Runs the script from the address it broadcasts as.
contract ForkSeedRunner {
    function add(SeedPool script) external {
        script.seedExisting();
    }
}

/// The $BRSR rail against the real Uniswap v4 deployment on Robinhood Chain, after the pool
/// was opened and seeded on 2026-09-29.
///
/// The live pool, the live seeder and the tokens are read as they are. The staking pool, the
/// buyback and the seeder this repository now builds are deployed into the fork next to them,
/// administered by the live timelock and pointed at the live pool, so the question the file
/// answers is whether the contracts that will replace the live ones work against a v4 pool that
/// was not written to suit them. Nothing is mocked.
///
/// Run it with a fork endpoint in the environment:
///
///   BURSAR_RHC_FORK_RPC=<rpc for 4663> forge test --match-path test/token/TokenRailFork.t.sol -vv
///
/// Without that variable every test here skips, so the offline suite is unaffected. The block is
/// pinned, because an unpinned fork reports a different execution price every hour and none of
/// them can be checked later. The public endpoint keeps only recent state, so a first run needs
/// an archive endpoint or a block still inside its window; Foundry caches what that run reads.
contract TokenRailForkTest is Test {
    // Uniswap v4 on chain 4663.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    // Ours, deployed 2026-09-22.
    address internal constant BRSR = 0x00e503925880c4b07E5Fb70232D83aD871F57a7d;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant BUYBACK = 0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0;
    address internal constant TIMELOCK = 0x5a32Eab02454f97a39857E85b536F83EE0f844Bf;

    address internal constant LIQUIDITY = 0x0DF776dBD1Ce5A8F38993Bc98bc3D81661FA51B2;
    address internal constant TREASURY = 0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21;
    address internal constant SLASH_SINK = 0xb4A7D77a710f6b1fF4cDDd9D3c9b66E3f917A4FF;
    address internal constant SIGNER_1 = 0xb51c63568324848DfC88A09f91F06fA86771aB69;
    address internal constant SIGNER_2 = 0x3C7facc7C72c3aCeB2EF93703813652aC9039266;

    /// The seeder that opened the pool, owned by the liquidity key, and what it put in.
    address internal constant LIVE_SEEDER = 0xB3caCD9ce86F12a85cB5dbeEBFFb41a1C848AD5f;
    bytes32 internal constant POOL_ID = 0x95bdade638ae86f8f1e424a2561796dd3aea34d75f594bd03cdb8d9e615ec765;
    uint160 internal constant OPEN_SQRT_PRICE_X96 = 1120455419495722798374;
    uint128 internal constant SEED_LIQUIDITY = 1767766952966368;

    /// A plain address holding millions of USDG on 4663, used only as a source of test funds
    /// inside the fork. Read off the token's holder list, never written to.
    address internal constant USDG_WHALE = 0x6bEbb110c9BB93D529d1EAB51D44bcf49ae585D5;

    /// Pinned. 2026-09-30, fifteen hours after the seed, with the pool still at its opening price.
    uint256 internal constant FORK_BLOCK = 76_111_000;

    /// The ceiling the live buyback's pending proposal writes, twenty per cent over the opening
    /// price, in micro-USD for one whole BRSR.
    uint128 internal constant CEILING_MICRO_USD = 240;

    uint256 internal constant BRSR_UNIT = 1e18;
    uint256 internal constant USDG_UNIT = 1e6;

    Staking internal staking;
    Buyback internal buyback;
    V4LiquiditySeeder internal seeder;
    address internal keeper = makeAddr("keeper");

    modifier onFork() {
        string memory rpc = vm.envOr("BURSAR_RHC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("BURSAR_RHC_FORK_RPC is unset; skipping the fork run.");
            vm.skip(true);
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        require(block.chainid == 4663, "fork is not chain 4663");
        _;
    }

    /// The pool the live buyback trades and the seeder that opened it, as they stand.
    function test_theLivePoolAndSeederReadBack() public onFork {
        (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) = IStateView(STATE_VIEW).getSlot0(POOL_ID);
        console2.log("tick                         ", vm.toString(tick));
        console2.log("protocol fee, packed         ", protocolFee);

        assertEq(sqrtPriceX96, OPEN_SQRT_PRICE_X96, "the pool is not at its opening price");
        assertEq(lpFee, 3000, "fee tier");
        assertEq(IStateView(STATE_VIEW).getLiquidity(POOL_ID), SEED_LIQUIDITY, "pool liquidity");

        V4LiquiditySeeder live = V4LiquiditySeeder(LIVE_SEEDER);
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(60);
        assertEq(live.poolId(), POOL_ID, "the seeder names another pool");
        assertEq(live.buyback(), BUYBACK);
        assertEq(address(live.poolManager()), POOL_MANAGER);
        assertEq(live.owner(), LIQUIDITY);
        assertEq(live.liquidityOf(lower, upper), SEED_LIQUIDITY, "the seeder's own record");
        assertEq(live.currency0(), Buyback(BUYBACK).currency0());
        assertEq(live.currency1(), Buyback(BUYBACK).currency1());
    }

    /// The replacements end to end: add to the live pool through the new seeder, stake, have
    /// governance name the keeper, fund the buyback and run one.
    function test_rail_replacementsAgainstTheLivePool() public onFork {
        _deployReplacements();

        (uint128 added, uint256 brsrIn, uint256 usdgIn) = _addThroughNewSeeder(makeAddr("provider"), 25 * USDG_UNIT);
        assertEq(IStateView(STATE_VIEW).getLiquidity(POOL_ID), SEED_LIQUIDITY + added, "pool liquidity");
        console2.log("added liquidity              ", added);
        console2.log("BRSR in, whole               ", brsrIn / BRSR_UNIT);
        console2.log("USDG in, micro               ", usdgIn);

        _stake(makeAddr("staker"), 100_000 * BRSR_UNIT);
        _proposeApproveExecute(address(buyback), abi.encodeCall(Buyback.setKeeper, (keeper)));

        (uint160 sqrtBefore,,,) = IStateView(STATE_VIEW).getSlot0(POOL_ID);
        _buyOnce(_midMicroUsdScaled(sqrtBefore));
    }

    /// The trade an open buyback invites: buy ahead of it, trigger it into the pushed price,
    /// sell back, all in one transaction. The replacement refuses anyone but its keeper, so the
    /// whole trade reverts, and the keeper's own call still fills under the ceiling.
    function test_theAtomicSandwichIsRefused() public onFork {
        _deployReplacements();
        _stake(makeAddr("staker"), 100_000 * BRSR_UNIT);
        _proposeApproveExecute(address(buyback), abi.encodeCall(Buyback.setKeeper, (keeper)));
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(address(buyback), 2 * USDG_UNIT);

        ForkSandwicher trader = new ForkSandwicher(IPoolManager(POOL_MANAGER), buyback);
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(address(trader), 10 * USDG_UNIT);

        vm.expectRevert(Buyback.NotKeeper.selector);
        trader.run(2 * USDG_UNIT);

        vm.prank(keeper);
        (uint256 spent, uint256 received) = buyback.buyback();
        assertLe(spent * BRSR_UNIT, received * CEILING_MICRO_USD, "filled above the ceiling");
    }

    /// Set a ceiling below the market and the call has to revert rather than fill badly, which
    /// is the guard the whole design rests on.
    function test_ceilingBelowMarketRefusesTheTrade() public onFork {
        _deployReplacements();
        _stake(makeAddr("staker"), 100_000 * BRSR_UNIT);
        _proposeApproveExecute(address(buyback), abi.encodeCall(Buyback.setKeeper, (keeper)));
        _proposeApproveExecute(address(buyback), _ceilingCalldata(20));

        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(address(buyback), 2 * USDG_UNIT);

        vm.prank(keeper);
        vm.expectPartialRevert(Buyback.MinimumOutNotMet.selector);
        buyback.buyback();
    }

    /// An empty pool fills nothing, and the buyback notices. v4 returns a zero delta on both
    /// legs, and `Buyback` tests the direction before the amount, so the refusal reads
    /// `SwapDirectionWrong(0, 0)`, the error for a hook that rewrote the swap. The money is safe
    /// either way; recorded here so the message is a known quantity during an incident.
    function test_buybackAgainstAnEmptyPoolReverts() public onFork {
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(60);
        vm.prank(LIQUIDITY);
        V4LiquiditySeeder(LIVE_SEEDER).removeLiquidity(lower, upper, SEED_LIQUIDITY, 0, 0, LIQUIDITY);
        assertEq(IStateView(STATE_VIEW).getLiquidity(POOL_ID), 0);

        _deployReplacements();
        _stake(makeAddr("staker"), 100_000 * BRSR_UNIT);
        _proposeApproveExecute(address(buyback), abi.encodeCall(Buyback.setKeeper, (keeper)));
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(address(buyback), 2 * USDG_UNIT);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Buyback.SwapDirectionWrong.selector, int256(0), int256(0)));
        buyback.buyback();
    }

    /// A position added through the new seeder comes back out, and only through its owner, the
    /// timelock.
    function test_liquidityComesBackOut() public onFork {
        _deployReplacements();
        (uint128 added, uint256 brsrIn, uint256 usdgIn) = _addThroughNewSeeder(makeAddr("provider"), 25 * USDG_UNIT);

        (int24 lower, int24 upper) = V4Math.fullRangeTicks(60);
        vm.prank(makeAddr("provider"));
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        seeder.removeLiquidity(lower, upper, added, 0, 0, LIQUIDITY);

        vm.prank(TIMELOCK);
        (uint256 out0, uint256 out1) = seeder.removeLiquidity(lower, upper, added, 0, 0, TREASURY);

        // v4 rounds a deposit up and a withdrawal down, so a round trip returns a wei or two
        // less on each leg. Anything larger would be a bug.
        assertApproxEqAbs(out0, brsrIn, 2, "BRSR did not come back");
        assertApproxEqAbs(out1, usdgIn, 2, "USDG did not come back");
        assertEq(IStateView(STATE_VIEW).getLiquidity(POOL_ID), SEED_LIQUIDITY, "liquidity left behind");
    }

    /// The seeding script's second path, run as an operator would run it: it reads the live
    /// pool, sizes the position at the price it finds, adds exactly that through a seeder the
    /// timelock owns, and reads the pool back.
    function test_seedExistingAddsToTheLivePool() public onFork {
        SeedPool script = new SeedPool();
        script.pinEnvPrefix("TOKENRAILFORK_");
        vm.setEnv("TOKENRAILFORK_BURSAR_BUYBACK", vm.toString(BUYBACK));
        vm.setEnv("TOKENRAILFORK_BURSAR_STATE_VIEW", vm.toString(STATE_VIEW));
        vm.setEnv("TOKENRAILFORK_BURSAR_BUYBACK_POOL_MANAGER", vm.toString(POOL_MANAGER));
        vm.setEnv("TOKENRAILFORK_BURSAR_SEED_USDG_MICRO", "5000000");
        vm.setEnv("TOKENRAILFORK_BURSAR_SEED_PRICE_MICRO_USD", "200");
        vm.setEnv("TOKENRAILFORK_BURSAR_SEEDER", vm.toString(address(0)));
        vm.setEnv("TOKENRAILFORK_BURSAR_ALLOW_MAINNET_SEED", "i-am-adding-to-the-market");

        vm.etch(DEFAULT_SENDER, address(new ForkSeedRunner()).code);
        vm.prank(TREASURY);
        IERC20(BRSR).transfer(DEFAULT_SENDER, 100_000 * BRSR_UNIT);
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(DEFAULT_SENDER, 10 * USDG_UNIT);

        address deployed = vm.computeCreateAddress(DEFAULT_SENDER, vm.getNonce(DEFAULT_SENDER));
        ForkSeedRunner(DEFAULT_SENDER).add(script);

        V4LiquiditySeeder added = V4LiquiditySeeder(deployed);
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(60);
        assertEq(added.owner(), TIMELOCK, "the new seeder is not governance's");
        assertEq(
            IStateView(STATE_VIEW).getLiquidity(POOL_ID), SEED_LIQUIDITY + added.liquidityOf(lower, upper), "liquidity"
        );
        (uint160 sqrtAfter,,,) = IStateView(STATE_VIEW).getSlot0(POOL_ID);
        assertEq(sqrtAfter, OPEN_SQRT_PRICE_X96, "an add moved the price");
    }

    // --------------------------------------------------------------------------------------
    // Pieces
    // --------------------------------------------------------------------------------------

    /// A staking pool, a buyback and a seeder built from this repository, administered by the
    /// live timelock and trading the live pool. The buyback carries the parameters the live
    /// one's pending proposal writes.
    function _deployReplacements() internal {
        staking = new Staking(IERC20(BRSR), IERC20(USDG), TIMELOCK, SLASH_SINK, TREASURY, 7 days, 25_000 * BRSR_UNIT);
        buyback = new Buyback(
            USDG,
            BRSR,
            POOL_MANAGER,
            3000,
            60,
            address(0),
            address(staking),
            TIMELOCK,
            TREASURY,
            Buyback.Params({
                spendPerCallMicroUsd: 500_000,
                maxSpendPerWindowMicroUsd: 5_000_000,
                minSpendMicroUsd: 100_000,
                maxPriceMicroUsdPerBrsr: CEILING_MICRO_USD,
                window: 1 days,
                minInterval: 1 hours
            })
        );
        seeder = new V4LiquiditySeeder(POOL_MANAGER, address(buyback), TIMELOCK);
        assertEq(seeder.poolId(), POOL_ID, "the replacements name another pool");
    }

    /// Full range at the pool's price, `usdgSide` of USDG and the BRSR that matches it, from an
    /// address that is not the seeder's owner.
    function _addThroughNewSeeder(address provider, uint256 usdgSide)
        internal
        returns (uint128 liquidity, uint256 brsrIn, uint256 usdgIn)
    {
        (uint160 sqrtPriceX96,,,) = IStateView(STATE_VIEW).getSlot0(POOL_ID);
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(60);
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(lower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(upper);

        uint256 brsrSide = (usdgSide * BRSR_UNIT) / 200;
        liquidity = V4Math.getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, brsrSide, usdgSide);
        uint256 predicted0 = V4Math.amount0For(sqrtPriceX96, sqrtA, sqrtB, liquidity);
        uint256 predicted1 = V4Math.amount1For(sqrtPriceX96, sqrtA, sqrtB, liquidity);

        vm.prank(TREASURY);
        IERC20(BRSR).transfer(provider, predicted0);
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(provider, predicted1);

        vm.startPrank(provider);
        IERC20(BRSR).approve(address(seeder), predicted0);
        IERC20(USDG).approve(address(seeder), predicted1);
        (brsrIn, usdgIn) = seeder.addLiquidity(lower, upper, liquidity, predicted0, predicted1);
        vm.stopPrank();

        assertEq(brsrIn, predicted0, "the pool took a different amount of BRSR than the algebra said");
        assertEq(usdgIn, predicted1, "the pool took a different amount of USDG than the algebra said");
        assertEq(seeder.liquidityOf(lower, upper), liquidity);
    }

    function _stake(address staker, uint256 amount) internal {
        vm.prank(TREASURY);
        IERC20(BRSR).transfer(staker, amount);
        vm.startPrank(staker);
        IERC20(BRSR).approve(address(staking), amount);
        uint256 shares = staking.stake(amount);
        vm.stopPrank();
        assertGt(shares, 0, "no shares minted");
    }

    /// Funds the buyback, runs one as the keeper, and reports what the pool actually filled at.
    function _buyOnce(uint256 midBefore) internal {
        uint256 funding = 2 * USDG_UNIT;
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(address(buyback), funding);

        assertEq(buyback.available(), 500_000, "the buyback would not spend its per-call target");
        uint256 stakedBefore = staking.totalStaked();

        vm.prank(keeper);
        (uint256 spent, uint256 received) = buyback.buyback();

        (uint160 sqrtAfterBuy,,,) = IStateView(STATE_VIEW).getSlot0(POOL_ID);
        uint256 fill = (spent * BRSR_UNIT * 1e6) / received;

        console2.log("--- the buyback ---");
        console2.log("spent, micro-USD             ", spent);
        console2.log("received, whole BRSR         ", received / BRSR_UNIT);
        console2.log("mid before (x1e6)            ", midBefore);
        console2.log("fill       (x1e6)            ", fill);
        console2.log("mid after  (x1e6)            ", _midMicroUsdScaled(sqrtAfterBuy));

        assertEq(spent, 500_000, "spent something other than the per-call target");
        assertGe(fill, midBefore, "a fill below mid means the direction is wrong");
        assertLe(spent * BRSR_UNIT, received * CEILING_MICRO_USD, "filled above the ceiling");
        assertEq(staking.totalStaked() - stakedBefore, received, "the staking pool was not credited the whole buy");
        assertEq(IERC20(BRSR).balanceOf(address(buyback)), 0, "BRSR stayed in the buyback");
        assertEq(IERC20(USDG).balanceOf(address(buyback)), funding - spent, "USDG accounting");
    }

    /// The whole `setParams` struct, with only the ceiling changed.
    function _ceilingCalldata(uint128 ceiling) internal view returns (bytes memory) {
        Buyback.Params memory p = buyback.params();
        p.maxPriceMicroUsdPerBrsr = ceiling;
        return abi.encodeCall(Buyback.setParams, (p));
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

    /// The pool's mid price in micro-USD for one whole BRSR, scaled by a further 1e6.
    /// `sqrtPriceX96` squares to raw USDG per raw BRSR, and one whole BRSR is 1e18 raw.
    function _midMicroUsdScaled(uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        return (((s * s) >> 96) * 1e24) >> 96;
    }
}
