// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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

/// Opens the BRSR/USDG market on Robinhood Chain and puts the first position in it, or adds to
/// the market once it is open.
///
/// `run` opens the pool at a price you name and seeds it, and refuses a pool that is already
/// open. `seedExisting` adds to an open pool at the price it is trading at. Run either one
/// without `--broadcast` first. Everything it will do is printed, including the price, the exact
/// amounts the pool will take and what a buyback then does to the pool, and nothing about the
/// printed run touches the chain.
///
/// ## The one number that matters
///
/// `sqrtPriceX96` is a ratio of **raw token units**. BRSR has eighteen decimals and USDG has
/// six, so the ratio at a price of one dollar per BRSR is `1e-12`, not `1`. This script never
/// takes a `sqrtPriceX96` from an operator. It takes a price in micro-USD for one whole BRSR,
/// which is the unit the buyback's ceiling already uses and the unit a person can check against
/// a screen, and derives the rest. It derives it twice, by two different routes, and refuses to
/// broadcast if the two disagree by more than a fifth of a tick.
///
/// ## What it will not do
///
/// It refuses chain 4663 unless `BURSAR_ALLOW_MAINNET_SEED` is set: to `i-am-opening-the-market`
/// for `run`, to `i-am-adding-to-the-market` for `seedExisting`. Seeding is not a step that can be
/// undone or repriced, and the deploy key's own balance is not a safety check: an under-funded
/// seed opens a real market at a real price with almost nothing behind it, which is worse than
/// no market at all.
///
/// It takes the pool manager from the buyback, never from an operator. A manager named in the
/// environment is checked against it and a mismatch stops the run before anything is sent,
/// because the opening price is set once and a typo would set it on some other manager.
///
/// It reads the pool back through v4's StateView after the seed and fails unless the pool holds
/// what was sent. Forge runs the whole script against a fork before it broadcasts anything, so a
/// read-back that fails stops the run with nothing sent.
///
/// ## Environment
///
/// | | |
/// |---|---|
/// | `BURSAR_BUYBACK` | the live buyback, which names the pool and the manager |
/// | `BURSAR_STATE_VIEW` | v4's StateView, read before the seed and again after it |
/// | `BURSAR_SEED_USDG_MICRO` | the USDG side of the position, in micro-USD |
/// | `BURSAR_SEED_PRICE_MICRO_USD` | `run`: the opening price of one whole BRSR, in micro-USD; `seedExisting`: optional, the price you expect the pool to be at |
/// | `BURSAR_SEED_MAX_DEVIATION_BPS` | `seedExisting`: how far from that price the pool may be, default 100 |
/// | `BURSAR_BUYBACK_POOL_MANAGER` | optional: checked against the buyback's manager |
/// | `BURSAR_SEEDER` | optional: an already-deployed seeder to reuse |
/// | `BURSAR_ALLOW_MAINNET_SEED` | required on 4663 |
/// | `BURSAR_ENV_PREFIX` | optional: a namespace every variable above is read under |
contract SeedPool is Script {
    uint256 internal constant RHC_CHAIN_ID = 4663;
    uint256 internal constant BRSR_UNIT = 1e18;
    uint8 internal constant SETTLEMENT_DECIMALS = 6;
    uint8 internal constant BRSR_DECIMALS = 18;

    /// How far apart the two derivations of the opening price may sit, in parts per billion of
    /// the square root. One tick is a part in ten thousand of price, so half that in the square
    /// root, and this is a fifth of that. The Q96 route loses the most at the bottom of the
    /// range, about 3,500 ppb at one micro-dollar, which the old gate of 1,000 refused.
    uint256 internal constant DERIVATION_TOLERANCE_PPB = 10_000;

    uint256 internal constant DEFAULT_MAX_DEVIATION_BPS = 100;

    /// v4 splits a pool's protocol fee into two 12-bit halves, one per direction.
    uint24 internal constant PROTOCOL_FEE_MASK = 0xfff;
    uint256 internal constant PIPS = 1_000_000;

    struct Plan {
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 brsrNeeded;
        uint256 usdgNeeded;
    }

    /// Every variable this script reads sits under this namespace, empty for an ordinary run. A
    /// harness pins its own so two suites in one process cannot read each other's values.
    string public envPrefix;

    function pinEnvPrefix(string calldata prefix) external {
        envPrefix = prefix;
    }

    /// Opens the pool at `BURSAR_SEED_PRICE_MICRO_USD` and puts the first position in it.
    function run() external {
        _loadPrefix();
        (Buyback buyback, IStateView stateView, address manager) = _context();
        bytes32 id = _poolId(buyback);

        uint256 priceMicroUsd = vm.envUint(_key("BURSAR_SEED_PRICE_MICRO_USD"));
        uint256 usdgSide = vm.envUint(_key("BURSAR_SEED_USDG_MICRO"));
        require(priceMicroUsd != 0, "BURSAR_SEED_PRICE_MICRO_USD is zero");
        _preflight(buyback, usdgSide);
        _warnIfCeilingBelow(buyback, priceMicroUsd * 1e6);

        (uint160 openAt,,,) = stateView.getSlot0(id);
        require(openAt == 0, "the pool is already open; seedExisting adds to it");

        Plan memory plan =
            _plan(buyback, _openingSqrtPrice(priceMicroUsd), (usdgSide * BRSR_UNIT) / priceMicroUsd, usdgSide);
        console2.log("--- the opening price ---");
        console2.log("micro-USD per whole BRSR      ", priceMicroUsd);
        console2.log("sqrtPriceX96, Q192 route      ", plan.sqrtPriceX96);
        console2.log("sqrtPriceX96, Q96 route       ", V4Math.initialSqrtPriceX96ViaQ96(BRSR_UNIT, priceMicroUsd));
        console2.log("fully diluted, micro-USD      ", priceMicroUsd * 1_000_000_000);
        // The protocol fee is fixed when the pool opens, so before then only the LP fee is known.
        _report(buyback, plan, usdgSide, 0);

        if (!_allowed("i-am-opening-the-market")) return;

        address seeder = vm.envOr(_key("BURSAR_SEEDER"), address(0));
        vm.startBroadcast();
        // Opening the pool is the owner's, so a seeder deployed here starts with the broadcasting
        // key and hands itself to governance once the seed is in.
        V4LiquiditySeeder s = seeder == address(0)
            ? new V4LiquiditySeeder(manager, address(buyback), msg.sender)
            : _reuse(seeder, buyback, manager);
        IERC20(address(buyback.brsr())).approve(address(s), plan.brsrNeeded);
        IERC20(address(buyback.settlementAsset())).approve(address(s), usdgSide);

        int24 openedAt = s.initializePool(plan.sqrtPriceX96);
        (uint256 brsrIn, uint256 usdgIn) =
            s.addLiquidity(plan.tickLower, plan.tickUpper, plan.liquidity, plan.brsrNeeded, usdgSide);
        if (seeder == address(0)) s.transferOwnership(buyback.admin());
        vm.stopBroadcast();

        if (seeder == address(0)) {
            console2.log("seeder deployed at            ", address(s));
            console2.log("ownership offered to          ", buyback.admin());
            console2.log("governance takes it by calling acceptOwnership() on the seeder.");
        }
        console2.log("opened at tick                ", vm.toString(openedAt));
        _readBack(stateView, id, plan.sqrtPriceX96, plan.liquidity, brsrIn, usdgIn);
    }

    /// Adds to a pool that is already open, at the price it stands at. The maxima are the exact
    /// amounts the position costs at that price, so a price that moves between this read and the
    /// transaction landing makes the add revert rather than pay more of either side.
    function seedExisting() external {
        _loadPrefix();
        (Buyback buyback, IStateView stateView, address manager) = _context();
        bytes32 id = _poolId(buyback);

        uint256 usdgSide = vm.envUint(_key("BURSAR_SEED_USDG_MICRO"));
        (uint160 sqrtPriceX96,, uint24 protocolFee,) = stateView.getSlot0(id);
        require(sqrtPriceX96 != 0, "the pool is not open; run opens it");
        uint256 midScaled = _midMicroUsdScaled(sqrtPriceX96);
        _preflight(buyback, usdgSide);
        _warnIfCeilingBelow(buyback, midScaled);
        _requireNear(midScaled);

        uint256 brsrSide = Math.mulDiv(Math.mulDiv(usdgSide, V4Math.Q96, sqrtPriceX96), V4Math.Q96, sqrtPriceX96);
        Plan memory plan = _plan(buyback, sqrtPriceX96, brsrSide, usdgSide);
        uint128 before = stateView.getLiquidity(id);

        console2.log("--- the pool as it stands ---");
        console2.log("mid, micro-USD per BRSR (x1e6)", midScaled);
        console2.log("liquidity                     ", before);
        _report(buyback, plan, _virtualUsdg(plan, before + plan.liquidity), protocolFee);

        if (!_allowed("i-am-adding-to-the-market")) return;

        address seeder = vm.envOr(_key("BURSAR_SEEDER"), address(0));
        vm.startBroadcast();
        // Anyone may add, so a seeder deployed here belongs to governance from its first block.
        V4LiquiditySeeder s = seeder == address(0)
            ? new V4LiquiditySeeder(manager, address(buyback), buyback.admin())
            : _reuse(seeder, buyback, manager);
        IERC20(address(buyback.brsr())).approve(address(s), plan.brsrNeeded);
        IERC20(address(buyback.settlementAsset())).approve(address(s), plan.usdgNeeded);
        (uint256 brsrIn, uint256 usdgIn) =
            s.addLiquidity(plan.tickLower, plan.tickUpper, plan.liquidity, plan.brsrNeeded, plan.usdgNeeded);
        vm.stopBroadcast();

        if (seeder == address(0)) console2.log("seeder deployed at            ", address(s));
        _readBack(stateView, id, sqrtPriceX96, before + plan.liquidity, brsrIn, usdgIn);
    }

    /// The buyback, the StateView and the manager, the last taken from the buyback and checked
    /// against the environment rather than read from it.
    function _context() internal view returns (Buyback buyback, IStateView stateView, address manager) {
        buyback = Buyback(vm.envAddress(_key("BURSAR_BUYBACK")));
        stateView = IStateView(vm.envAddress(_key("BURSAR_STATE_VIEW")));
        manager = address(buyback.poolManager());
        _requireManager(manager, vm.envOr(_key("BURSAR_BUYBACK_POOL_MANAGER"), address(0)));
    }

    function _requireManager(address fromBuyback, address named) internal pure {
        require(
            named == address(0) || named == fromBuyback,
            "BURSAR_BUYBACK_POOL_MANAGER is not the manager the buyback trades on"
        );
    }

    /// A seeder named in the environment has to be one built against this buyback and manager.
    function _reuse(address seeder, Buyback buyback, address manager) internal view returns (V4LiquiditySeeder s) {
        s = V4LiquiditySeeder(seeder);
        require(s.buyback() == address(buyback), "BURSAR_SEEDER seeds a different buyback's pool");
        require(address(s.poolManager()) == manager, "BURSAR_SEEDER is built against a different manager");
    }

    /// The position, worked out before anything is sent, over the widest range the spacing
    /// allows. The liquidity is the most the two sides back together, so neither is overdrawn.
    function _plan(Buyback buyback, uint160 sqrtPriceX96, uint256 brsrSide, uint256 usdgSide)
        internal
        view
        returns (Plan memory plan)
    {
        plan.sqrtPriceX96 = sqrtPriceX96;
        (plan.tickLower, plan.tickUpper) = V4Math.fullRangeTicks(buyback.poolTickSpacing());

        uint160 sqrtA = V4Math.getSqrtPriceAtTick(plan.tickLower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(plan.tickUpper);

        plan.liquidity = V4Math.getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, brsrSide, usdgSide);
        require(plan.liquidity != 0, "the amounts back no liquidity");

        plan.brsrNeeded = V4Math.amount0For(sqrtPriceX96, sqrtA, sqrtB, plan.liquidity);
        plan.usdgNeeded = V4Math.amount1For(sqrtPriceX96, sqrtA, sqrtB, plan.liquidity);
        require(plan.brsrNeeded <= brsrSide, "the position wants more BRSR than was offered");
        require(plan.usdgNeeded <= usdgSide, "the position wants more USDG than was offered");
    }

    /// Both derivations, and a refusal if they disagree. One whole BRSR is 1e18 raw units and one
    /// micro-USD is one raw USDG unit, so the pair below is the raw ratio the pool will price.
    /// currency0 is BRSR on this deployment, which `_preflight` has already established.
    function _openingSqrtPrice(uint256 priceMicroUsd) internal pure returns (uint160) {
        uint160 viaQ192 = V4Math.initialSqrtPriceX96(BRSR_UNIT, priceMicroUsd);
        uint160 viaQ96 = V4Math.initialSqrtPriceX96ViaQ96(BRSR_UNIT, priceMicroUsd);

        uint256 gap = viaQ192 > viaQ96 ? viaQ192 - viaQ96 : viaQ96 - viaQ192;
        require((gap * 1e9) / viaQ192 <= DERIVATION_TOLERANCE_PPB, "the two price derivations disagree");

        return viaQ192;
    }

    /// What the position takes, and what one buyback at the parameters governance set does to
    /// the pool it leaves behind. `reserveMicroUsd` is the pool's USDG depth at the current price.
    function _report(Buyback buyback, Plan memory plan, uint256 reserveMicroUsd, uint24 protocolFee) internal view {
        uint256 spend = buyback.params().spendPerCallMicroUsd;
        uint256 fee = _buyFeePips(buyback.poolFee(), protocolFee, buyback.settlementIsCurrency0());

        console2.log("--- the position ---");
        console2.log("tickLower                     ", vm.toString(plan.tickLower));
        console2.log("tickUpper                     ", vm.toString(plan.tickUpper));
        console2.log("liquidity                     ", plan.liquidity);
        console2.log("BRSR it will take, wei        ", plan.brsrNeeded);
        console2.log("BRSR it will take, whole      ", plan.brsrNeeded / BRSR_UNIT);
        console2.log("USDG it will take, micro      ", plan.usdgNeeded);
        console2.log("--- what a buyback does to it ---");
        console2.log("per-call spend, micro-USD     ", spend);
        console2.log("swap fee, pips                ", fee);
        console2.log("mid moves by, bps             ", _impactBps(reserveMicroUsd, spend, fee));
        console2.log("fill sits above mid by, bps   ", _fillBps(reserveMicroUsd, spend, fee));
    }

    /// The fee a buy pays, in pips: the LP fee and the protocol fee for the buy's direction,
    /// combined the way v4 combines them. The buy spends USDG, so it is zero-for-one exactly
    /// when USDG is currency0.
    function _buyFeePips(uint24 lpFee, uint24 protocolFee, bool zeroForOne) internal pure returns (uint256) {
        uint256 protocol = zeroForOne ? protocolFee & PROTOCOL_FEE_MASK : protocolFee >> 12;
        return protocol + lpFee - (protocol * lpFee) / PIPS;
    }

    /// How far a full-range pool's mid moves on an exact-input buy, in basis points.
    ///
    /// A full-range v4 position is a constant-product market in the amounts it holds at the
    /// current price, so the mid moves by `(1 + in/reserve)**2 - 1` with the fee taken off the
    /// input first.
    function _impactBps(uint256 reserveMicroUsd, uint256 spendMicroUsd, uint256 feePips)
        internal
        pure
        returns (uint256)
    {
        uint256 net = (spendMicroUsd * (PIPS - feePips)) / PIPS;
        uint256 ratio = ((reserveMicroUsd + net) * 1e9) / reserveMicroUsd;
        return ((ratio * ratio) / 1e9 - 1e9) * 10_000 / 1e9;
    }

    /// How far the average fill sits above the pre-trade mid, in basis points.
    function _fillBps(uint256 reserveMicroUsd, uint256 spendMicroUsd, uint256 feePips) internal pure returns (uint256) {
        uint256 net = (spendMicroUsd * (PIPS - feePips)) / PIPS;
        // avg / mid = spend * (reserve + net) / (net * reserve)
        uint256 ratio = (spendMicroUsd * (reserveMicroUsd + net) * 1e9) / (net * reserveMicroUsd);
        return (ratio - 1e9) * 10_000 / 1e9;
    }

    /// The USDG a full-range position of `liquidity` holds at the plan's price.
    function _virtualUsdg(Plan memory plan, uint128 liquidity) internal pure returns (uint256) {
        return V4Math.amount1For(
            plan.sqrtPriceX96,
            V4Math.getSqrtPriceAtTick(plan.tickLower),
            V4Math.getSqrtPriceAtTick(plan.tickUpper),
            liquidity
        );
    }

    /// The pool's price and depth after the seed, against what was sent. Not optional: a seed
    /// that cannot be read back has not been checked.
    function _readBack(
        IStateView stateView,
        bytes32 id,
        uint160 expectedSqrtPrice,
        uint128 expectedLiquidity,
        uint256 brsrIn,
        uint256 usdgIn
    ) internal view {
        (uint160 sqrtBack, int24 tickBack,,) = stateView.getSlot0(id);
        uint128 liquidityBack = stateView.getLiquidity(id);

        console2.log("BRSR taken, wei               ", brsrIn);
        console2.log("USDG taken, micro             ", usdgIn);
        console2.log("read back, sqrtPriceX96       ", sqrtBack);
        console2.log("read back, tick               ", vm.toString(tickBack));
        console2.log("read back, liquidity          ", liquidityBack);

        require(sqrtBack == expectedSqrtPrice, "the pool is not at the price the seed was planned at");
        require(liquidityBack == expectedLiquidity, "the pool does not hold the liquidity that was sent");
    }

    /// With an expected price set, the pool has to be within `BURSAR_SEED_MAX_DEVIATION_BPS` of
    /// it. A pool pushed away from the market just before an add is a pool somebody wants
    /// liquidity in at the wrong price.
    function _requireNear(uint256 midScaled) internal view {
        uint256 expected = vm.envOr(_key("BURSAR_SEED_PRICE_MICRO_USD"), uint256(0));
        if (expected == 0) return;

        uint256 maxBps = vm.envOr(_key("BURSAR_SEED_MAX_DEVIATION_BPS"), DEFAULT_MAX_DEVIATION_BPS);
        uint256 expectedScaled = expected * 1e6;
        uint256 gap = midScaled > expectedScaled ? midScaled - expectedScaled : expectedScaled - midScaled;
        console2.log("expected mid (x1e6)           ", expectedScaled);
        require(gap * 10_000 <= expectedScaled * maxBps, "the pool is further from the expected price than allowed");
    }

    /// The pool's mid in micro-USD for one whole BRSR, scaled by a further 1e6. `sqrtPriceX96`
    /// squares to raw USDG per raw BRSR, and one whole BRSR is 1e18 raw.
    function _midMicroUsdScaled(uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        return (((s * s) >> 96) * 1e24) >> 96;
    }

    function _poolId(Buyback buyback) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                buyback.currency0(),
                buyback.currency1(),
                buyback.poolFee(),
                buyback.poolTickSpacing(),
                buyback.poolHooks()
            )
        );
    }

    function _preflight(Buyback buyback, uint256 usdgSide) internal view {
        require(usdgSide != 0, "BURSAR_SEED_USDG_MICRO is zero");

        address brsr = address(buyback.brsr());
        address usdg = address(buyback.settlementAsset());
        require(IERC20Metadata(brsr).decimals() == BRSR_DECIMALS, "BRSR is not an eighteen-decimal token");
        require(IERC20Metadata(usdg).decimals() == SETTLEMENT_DECIMALS, "USDG is not a six-decimal token");

        // v4 reads the zero address as native currency. Neither side of this pool may be it.
        require(buyback.currency0() != address(0) && buyback.currency1() != address(0), "native currency");
        // This deployment's BRSR sorts below USDG, which is what makes the ratio USDG per BRSR.
        require(buyback.currency0() == brsr && buyback.currency1() == usdg, "unexpected currency order");
    }

    /// `priceScaled` is micro-USD per whole BRSR, scaled by a further 1e6.
    function _warnIfCeilingBelow(Buyback buyback, uint256 priceScaled) internal view {
        uint256 ceiling = buyback.params().maxPriceMicroUsdPerBrsr;
        if (ceiling == 0 || ceiling * 1e6 >= priceScaled) return;
        console2.log("WARNING: the buyback ceiling is below the pool price. Every buyback will refuse.");
        console2.log("ceiling, micro-USD per BRSR   ", ceiling);
    }

    function _allowed(string memory phrase) internal view returns (bool) {
        if (block.chainid != RHC_CHAIN_ID) return true;
        string memory gate = vm.envOr(_key("BURSAR_ALLOW_MAINNET_SEED"), string(""));
        if (keccak256(bytes(gate)) == keccak256(bytes(phrase))) return true;

        console2.log("");
        console2.log("Dry run. Nothing was sent.");
        console2.log(string.concat("Set BURSAR_ALLOW_MAINNET_SEED=", phrase, " to broadcast on 4663."));
        return false;
    }

    /// Read once, so every variable in one run comes from one namespace.
    function _loadPrefix() internal {
        if (bytes(envPrefix).length == 0) envPrefix = vm.envOr("BURSAR_ENV_PREFIX", string(""));
    }

    function _key(string memory key) internal view returns (string memory) {
        return bytes(envPrefix).length == 0 ? key : string.concat(envPrefix, key);
    }
}
