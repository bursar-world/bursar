// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MigrateLiquidity} from "../../../script/MigrateLiquidity.s.sol";
import {SeedPool} from "../../../script/SeedPool.s.sol";
import {RecordKeys as K} from "../../../script/lib/RecordKeys.sol";
import {V4Math} from "../../../script/lib/V4Math.sol";

import {Buyback, IPoolManager, PoolKey, SwapParams} from "../../../src/token/Buyback.sol";
import {Staking} from "../../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../../src/token/V4LiquiditySeeder.sol";
import {ForkWorld} from "./ForkWorld.sol";

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
        manager.unlock(abi.encode(false, front));
        buyback.buyback();
        manager.unlock(abi.encode(true, buyback.brsr().balanceOf(address(this))));
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

/// The token rail the scripts deploy, against the live BRSR/USDG pool: the governance seeder names
/// that pool, the position moves into it through the migration step, a buyback from the recorded
/// keeper fills under the ceiling and stakes what it buys, the trade an open buyback invites is
/// refused, a ceiling under the market refuses to fill, and the seeding script adds through the
/// governance seeder at the price the pool stands at.
contract TokenRailForkTest is ForkWorld {
    uint256 internal constant BRSR_UNIT = 1e18;

    Staking internal staking;
    Buyback internal buyback;
    V4LiquiditySeeder internal seeder;
    IStateView internal stateView;
    bytes32 internal poolId;
    address internal timelock;
    address internal treasury;
    address internal keeper;

    function _prefix() internal pure override returns (string memory) {
        return "TOKENRAILFORK_";
    }

    function setUp() public {
        _fork("fork-token");
        _core();
        _staking();
        _rwa();
        _collateral();
        _wiring();
        staking = Staking(_readAddress(path, K.STAKING));
        buyback = Buyback(_readAddress(path, K.BUYBACK));
        seeder = V4LiquiditySeeder(_readAddress(path, K.SEEDER));
        stateView = IStateView(_readAddress(path, K.STATE_VIEW));
        poolId = vm.parseJsonBytes32(vm.readFile(path), ".token.poolId");
        timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        treasury = _readAddress(path, K.TREASURY);
        keeper = _readAddress(path, K.KEEPER);
        _set("BURSAR_TOKEN_RECORD", "deployments/rhc-mainnet-token.json");
        _save();
    }

    function test_fork_onlyTheKeeperBuysBackUnderTheCeiling() public {
        _theGovernanceSeederNamesTheLivePool();
        _theLivePositionMovesToGovernancesSeeder();
        _aBuybackFromTheKeeperFillsUnderTheCeilingAndStakesWhatItBuys();
        _theTradeAnOpenBuybackInvitesIsRefused();
        _aCeilingUnderTheMarketRefusesToFill();
        _seedingAddsThroughTheGovernanceSeederAndOnlyGovernanceTakesItOut();
    }

    function _theGovernanceSeederNamesTheLivePool() private {
        _restore();
        assertEq(seeder.owner(), timelock, "the seeder is not governance's");
        assertEq(seeder.buyback(), address(buyback));
        assertEq(seeder.poolId(), poolId);
        (uint160 sqrtPriceX96,,, uint24 lpFee) = stateView.getSlot0(poolId);
        assertGt(sqrtPriceX96, 0, "the recorded pool is not open");
        assertEq(lpFee, buyback.poolFee());
        assertGt(stateView.getLiquidity(poolId), 0, "the live pool holds no liquidity");
    }

    /// The migration step, run by the liquidity key: the whole position leaves the old seeder and
    /// lands in governance's, and the price does not move.
    function _theLivePositionMovesToGovernancesSeeder() private {
        _restore();
        address old =
            vm.parseJsonAddress(vm.readFile("deployments/rhc-mainnet-token.json"), ".contracts.V4LiquiditySeeder");
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(buyback.poolTickSpacing());
        uint128 held = V4LiquiditySeeder(old).liquidityOf(lower, upper);
        (uint160 before,,,) = stateView.getSlot0(poolId);

        _set("BURSAR_ALLOW_MAINNET_SEED", "i-am-moving-the-market");
        _run(V4LiquiditySeeder(old).owner(), address(new MigrateLiquidity()));
        _unset("BURSAR_ALLOW_MAINNET_SEED");

        assertEq(V4LiquiditySeeder(old).liquidityOf(lower, upper), 0, "the old seeder still holds liquidity");
        uint128 moved = seeder.liquidityOf(lower, upper);
        assertApproxEqRel(moved, held, 0.0001e18, "the new seeder holds a different position");
        (uint160 after_,,,) = stateView.getSlot0(poolId);
        assertEq(after_, before, "moving the position moved the price");
    }

    function _aBuybackFromTheKeeperFillsUnderTheCeilingAndStakesWhatItBuys() private {
        _restore();
        _stake(makeAddr("staker"), 100_000 * BRSR_UNIT);
        _usdg(address(buyback), 2e6);
        uint256 stakedBefore = staking.totalStaked();
        (uint160 sqrtBefore,,,) = stateView.getSlot0(poolId);

        vm.prank(keeper);
        (uint256 spent, uint256 received) = buyback.buyback();

        uint256 fill = (spent * BRSR_UNIT * 1e6) / received;
        uint128 ceiling = buyback.params().maxPriceMicroUsdPerBrsr;
        console2.log("spent, micro-USD           ", spent);
        console2.log("received, whole BRSR       ", received / BRSR_UNIT);
        console2.log("mid before (x1e6)          ", _midScaled(sqrtBefore));
        console2.log("fill       (x1e6)          ", fill);
        assertEq(spent, buyback.params().spendPerCallMicroUsd, "spent something other than the per-call target");
        assertGe(fill, _midScaled(sqrtBefore), "a fill below mid means the direction is wrong");
        assertLe(spent * BRSR_UNIT, received * ceiling, "filled above the ceiling");
        assertEq(staking.totalStaked() - stakedBefore, received, "the staking pool was not credited the whole buy");
        assertEq(IERC20(buyback.brsr()).balanceOf(address(buyback)), 0, "BRSR stayed in the buyback");
    }

    /// Buy ahead of the buyback, trigger it into the pushed price, sell back, all in one
    /// transaction. Only the keeper can trigger it, so the whole trade reverts.
    function _theTradeAnOpenBuybackInvitesIsRefused() private {
        _restore();
        _stake(makeAddr("staker"), 100_000 * BRSR_UNIT);
        _usdg(address(buyback), 2e6);
        ForkSandwicher trader = new ForkSandwicher(IPoolManager(POOL_MANAGER), buyback);
        _usdg(address(trader), 10e6);

        vm.expectRevert(Buyback.NotKeeper.selector);
        trader.run(2e6);
    }

    /// A ceiling below the market refuses the trade.
    function _aCeilingUnderTheMarketRefusesToFill() private {
        _restore();
        _stake(makeAddr("staker"), 100_000 * BRSR_UNIT);
        Buyback.Params memory p = buyback.params();
        p.maxPriceMicroUsdPerBrsr = 20;
        vm.prank(timelock);
        buyback.setParams(p);
        _usdg(address(buyback), 2e6);

        vm.prank(keeper);
        vm.expectPartialRevert(Buyback.MinimumOutNotMet.selector);
        buyback.buyback();
    }

    /// The seeding script's path for an open pool, run as a provider would run it: it sizes the
    /// position at the price it finds and adds exactly that through the governance seeder. What it
    /// adds is governance's: the provider cannot take it back out, the timelock can.
    function _seedingAddsThroughTheGovernanceSeederAndOnlyGovernanceTakesItOut() private {
        _restore();
        address provider = makeAddr("provider");
        IERC20 brsr = IERC20(buyback.brsr());
        vm.prank(treasury);
        brsr.transfer(provider, 100_000 * BRSR_UNIT);
        _usdg(provider, 10e6);
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(buyback.poolTickSpacing());
        uint128 before = stateView.getLiquidity(poolId);
        (uint160 price,,,) = stateView.getSlot0(poolId);

        _set("BURSAR_SEED_USDG_MICRO", "5000000");
        _set("BURSAR_ALLOW_MAINNET_SEED", "i-am-adding-to-the-market");
        SeedPool seeding = new SeedPool();
        seeding.pinEnvPrefix(_prefix());
        _as(provider, address(seeding), abi.encodeCall(seeding.seedExisting, ()));
        _unset("BURSAR_ALLOW_MAINNET_SEED");

        uint128 added = seeder.liquidityOf(lower, upper);
        assertGt(added, 0, "the seeder took no position");
        assertEq(stateView.getLiquidity(poolId), before + added, "the pool did not gain what the seeder holds");
        (uint160 after_,,,) = stateView.getSlot0(poolId);
        assertEq(after_, price, "adding moved the price");

        vm.prank(provider);
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        seeder.removeLiquidity(lower, upper, added, 0, 0, provider);
        vm.prank(timelock);
        seeder.removeLiquidity(lower, upper, added, 0, 0, treasury);
        assertEq(stateView.getLiquidity(poolId), before, "liquidity left behind");
    }

    function _stake(address staker, uint256 amount) private {
        IERC20 brsr = IERC20(buyback.brsr());
        vm.prank(treasury);
        brsr.transfer(staker, amount);
        vm.startPrank(staker);
        brsr.approve(address(staking), amount);
        assertGt(staking.stake(amount), 0, "no shares minted");
        vm.stopPrank();
    }

    /// The pool's mid in micro-USD for one whole BRSR, scaled by a further 1e6.
    function _midScaled(uint160 sqrtPriceX96) private pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        return (((s * s) >> 96) * 1e24) >> 96;
    }
}
