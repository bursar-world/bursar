// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {Buyback} from "../src/token/Buyback.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";
import {V4Math} from "./lib/V4Math.sol";

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/// Opens the BRSR/USDG market on Robinhood Chain and puts the first position in it.
///
/// Run it without `--broadcast` first. Everything it will do is printed, including both
/// derivations of the opening price and the exact amounts the pool will take, and nothing about
/// the printed run touches the chain. The broadcast is the irreversible half: a v4 pool can be
/// initialized once, and the number this script sends is the public price of BRSR from that
/// block onward.
///
/// ## The one number that matters
///
/// `sqrtPriceX96` is a ratio of **raw token units**. BRSR has eighteen decimals and USDG has
/// six, so the ratio at a price of one dollar per BRSR is `1e-12`, not `1`. This script never
/// takes a `sqrtPriceX96` from an operator. It takes a price in micro-USD for one whole BRSR,
/// which is the unit the buyback's ceiling already uses and the unit a person can check against
/// a screen, and derives the rest. It derives it twice, by two different routes, and refuses to
/// broadcast if the two disagree by more than a hundredth of a tick.
///
/// ## What it will not do
///
/// It refuses chain 4663 unless `BURSAR_ALLOW_MAINNET_SEED` is set to `i-am-opening-the-market`.
/// Seeding is not a step that can be undone or repriced, and the deploy key's own balance is not
/// a safety check: an under-funded seed opens a real market at a real price with almost nothing
/// behind it, which is worse than no market at all.
///
/// ## Environment
///
/// | | |
/// |---|---|
/// | `BURSAR_BUYBACK` | the live buyback, which names the pool |
/// | `BURSAR_BUYBACK_POOL_MANAGER` | Uniswap v4's manager on this chain |
/// | `BURSAR_SEED_PRICE_MICRO_USD` | the opening price of one whole BRSR, in micro-USD |
/// | `BURSAR_SEED_USDG_MICRO` | the USDG side of the position, in micro-USD |
/// | `BURSAR_SEEDER` | optional: an already-deployed seeder to reuse |
/// | `BURSAR_STATE_VIEW` | optional: v4's StateView, for the read-back |
/// | `BURSAR_ALLOW_MAINNET_SEED` | required on 4663 |
contract SeedPool is Script {
    uint256 internal constant RHC_CHAIN_ID = 4663;
    uint256 internal constant BRSR_UNIT = 1e18;
    uint8 internal constant SETTLEMENT_DECIMALS = 6;
    uint8 internal constant BRSR_DECIMALS = 18;

    /// How far apart the two derivations of the opening price may sit. One tick is a part in ten
    /// thousand of price, so half that in the square root; this is a fiftieth of that.
    uint256 internal constant DERIVATION_TOLERANCE_PPB = 1_000; // parts per billion

    struct Plan {
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 brsrNeeded;
        uint256 usdgNeeded;
    }

    function run() external {
        address buybackAddress = vm.envAddress("BURSAR_BUYBACK");
        address poolManager = vm.envAddress("BURSAR_BUYBACK_POOL_MANAGER");
        uint256 priceMicroUsd = vm.envUint("BURSAR_SEED_PRICE_MICRO_USD");
        uint256 usdgSide = vm.envUint("BURSAR_SEED_USDG_MICRO");

        Buyback buyback = Buyback(buybackAddress);
        address brsr = address(buyback.brsr());
        address usdg = address(buyback.settlementAsset());

        _preflight(buyback, brsr, usdg, priceMicroUsd, usdgSide);

        Plan memory plan = _plan(buyback, priceMicroUsd, usdgSide);
        _report(plan, priceMicroUsd, usdgSide);

        if (!_allowed()) {
            console2.log("");
            console2.log("Dry run. Nothing was sent.");
            console2.log("Set BURSAR_ALLOW_MAINNET_SEED=i-am-opening-the-market to broadcast on 4663.");
            return;
        }

        address seeder = vm.envOr("BURSAR_SEEDER", address(0));

        vm.startBroadcast();
        V4LiquiditySeeder s = seeder == address(0)
            ? new V4LiquiditySeeder(poolManager, buybackAddress, msg.sender)
            : V4LiquiditySeeder(seeder);
        if (seeder == address(0)) console2.log("seeder deployed at            ", address(s));

        IERC20(brsr).approve(address(s), plan.brsrNeeded);
        IERC20(usdg).approve(address(s), usdgSide);

        int24 openedAt = s.initializePool(plan.sqrtPriceX96);
        (uint256 brsrIn, uint256 usdgIn) =
            s.addLiquidity(plan.tickLower, plan.tickUpper, plan.liquidity, plan.brsrNeeded, usdgSide);
        vm.stopBroadcast();

        console2.log("opened at tick                ", vm.toString(openedAt));
        console2.log("BRSR taken, wei               ", brsrIn);
        console2.log("USDG taken, micro             ", usdgIn);

        address stateView = vm.envOr("BURSAR_STATE_VIEW", address(0));
        if (stateView != address(0)) {
            (uint160 sqrtBack, int24 tickBack,,) = IStateView(stateView).getSlot0(s.poolId());
            console2.log("read back, sqrtPriceX96       ", sqrtBack);
            console2.log("read back, tick               ", vm.toString(tickBack));
            console2.log("read back, liquidity          ", IStateView(stateView).getLiquidity(s.poolId()));
            require(sqrtBack == plan.sqrtPriceX96, "the pool did not open where it was told to");
        }
    }

    /// The position, worked out before anything is sent.
    function _plan(Buyback buyback, uint256 priceMicroUsd, uint256 usdgSide) internal view returns (Plan memory plan) {
        // One whole BRSR is 1e18 raw units and one micro-USD is one raw USDG unit, so the pair
        // below is the raw ratio the pool will price. currency0 is BRSR on this deployment,
        // which the assertion in `_preflight` has already established.
        plan.sqrtPriceX96 = _openingSqrtPrice(priceMicroUsd);

        int24 spacing = buyback.poolTickSpacing();
        (plan.tickLower, plan.tickUpper) = V4Math.fullRangeTicks(spacing);

        uint160 sqrtA = V4Math.getSqrtPriceAtTick(plan.tickLower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(plan.tickUpper);

        uint256 brsrSide = (usdgSide * BRSR_UNIT) / priceMicroUsd;
        plan.liquidity = V4Math.getLiquidityForAmounts(plan.sqrtPriceX96, sqrtA, sqrtB, brsrSide, usdgSide);
        require(plan.liquidity != 0, "the amounts back no liquidity");

        plan.brsrNeeded = V4Math.amount0For(plan.sqrtPriceX96, sqrtA, sqrtB, plan.liquidity);
        plan.usdgNeeded = V4Math.amount1For(plan.sqrtPriceX96, sqrtA, sqrtB, plan.liquidity);
        require(plan.brsrNeeded <= brsrSide, "the position wants more BRSR than was offered");
        require(plan.usdgNeeded <= usdgSide, "the position wants more USDG than was offered");
    }

    /// Both derivations, printed side by side, and a refusal if they disagree.
    function _openingSqrtPrice(uint256 priceMicroUsd) internal pure returns (uint160) {
        uint160 viaQ192 = V4Math.initialSqrtPriceX96(BRSR_UNIT, priceMicroUsd);
        uint160 viaQ96 = V4Math.initialSqrtPriceX96ViaQ96(BRSR_UNIT, priceMicroUsd);

        uint256 gap = viaQ192 > viaQ96 ? viaQ192 - viaQ96 : viaQ96 - viaQ192;
        require((gap * 1e9) / viaQ192 <= DERIVATION_TOLERANCE_PPB, "the two price derivations disagree");

        return viaQ192;
    }

    function _report(Plan memory plan, uint256 priceMicroUsd, uint256 usdgSide) internal pure {
        console2.log("--- the opening price ---");
        console2.log("micro-USD per whole BRSR      ", priceMicroUsd);
        console2.log("sqrtPriceX96, Q192 route      ", plan.sqrtPriceX96);
        console2.log("sqrtPriceX96, Q96 route       ", V4Math.initialSqrtPriceX96ViaQ96(BRSR_UNIT, priceMicroUsd));
        console2.log("fully diluted, micro-USD      ", priceMicroUsd * 1_000_000_000);
        console2.log("--- the position ---");
        console2.log("tickLower                     ", vm.toString(plan.tickLower));
        console2.log("tickUpper                     ", vm.toString(plan.tickUpper));
        console2.log("liquidity                     ", plan.liquidity);
        console2.log("BRSR it will take, wei        ", plan.brsrNeeded);
        console2.log("BRSR it will take, whole      ", plan.brsrNeeded / BRSR_UNIT);
        console2.log("USDG it will take, micro      ", plan.usdgNeeded);
        console2.log("--- what a buyback does to it ---");
        console2.log("per-call spend, micro-USD     ", uint256(500_000));
        console2.log("mid moves by, bps             ", _impactBps(usdgSide, 500_000));
        console2.log("fill sits above mid by, bps   ", _fillBps(usdgSide, 500_000));
    }

    /// How far a full-range pool's mid moves on an exact-input buy, in basis points.
    ///
    /// A full-range v4 position is a constant-product market in the amounts it holds at the
    /// current price, so the mid moves by `(1 + in/reserve)**2 - 1` with the fee taken off the
    /// input first. The fee here is the 0.30% tier the buyback is keyed to.
    function _impactBps(uint256 reserveMicroUsd, uint256 spendMicroUsd) internal pure returns (uint256) {
        uint256 net = (spendMicroUsd * 9970) / 10_000;
        uint256 ratio = ((reserveMicroUsd + net) * 1e9) / reserveMicroUsd;
        return ((ratio * ratio) / 1e9 - 1e9) * 10_000 / 1e9;
    }

    /// How far the average fill sits above the pre-trade mid, in basis points.
    function _fillBps(uint256 reserveMicroUsd, uint256 spendMicroUsd) internal pure returns (uint256) {
        uint256 net = (spendMicroUsd * 9970) / 10_000;
        // avg / mid = spend * (reserve + net) / (net * reserve)
        uint256 ratio = (spendMicroUsd * (reserveMicroUsd + net) * 1e9) / (net * reserveMicroUsd);
        return (ratio - 1e9) * 10_000 / 1e9;
    }

    function _preflight(Buyback buyback, address brsr, address usdg, uint256 priceMicroUsd, uint256 usdgSide)
        internal
        view
    {
        require(priceMicroUsd != 0, "BURSAR_SEED_PRICE_MICRO_USD is zero");
        require(usdgSide != 0, "BURSAR_SEED_USDG_MICRO is zero");

        require(IERC20Metadata(brsr).decimals() == BRSR_DECIMALS, "BRSR is not an eighteen-decimal token");
        require(IERC20Metadata(usdg).decimals() == SETTLEMENT_DECIMALS, "USDG is not a six-decimal token");

        // v4 reads the zero address as native currency. Neither side of this pool may be it.
        require(buyback.currency0() != address(0) && buyback.currency1() != address(0), "native currency");
        // This deployment's BRSR sorts below USDG, which is what makes the ratio USDG per BRSR.
        require(buyback.currency0() == brsr && buyback.currency1() == usdg, "unexpected currency order");

        uint128 ceiling = buyback.params().maxPriceMicroUsdPerBrsr;
        if (ceiling != 0 && ceiling < priceMicroUsd) {
            console2.log("WARNING: the buyback ceiling is below the opening price. Every buyback will refuse.");
            console2.log("ceiling, micro-USD per BRSR   ", ceiling);
        }
    }

    function _allowed() internal view returns (bool) {
        if (block.chainid != RHC_CHAIN_ID) return true;
        string memory gate = vm.envOr("BURSAR_ALLOW_MAINNET_SEED", string(""));
        return keccak256(bytes(gate)) == keccak256(bytes("i-am-opening-the-market"));
    }
}
