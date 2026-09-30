// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {V4Math} from "./lib/V4Math.sol";

import {Buyback} from "../src/token/Buyback.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/// The arithmetic every change to the BRSR/USDG position shares: the price read or derived, the
/// full-range position two amounts back at it, what a buyback then does to the pool, and the
/// read-back that fails unless the pool holds what was sent.
///
/// `sqrtPriceX96` is a ratio of raw token units. BRSR has eighteen decimals and USDG has six, so
/// the ratio at a price of one dollar per BRSR is `1e-12`, not `1`. Nothing here takes a
/// `sqrtPriceX96` from an operator: it takes a price in micro-USD for one whole BRSR, the unit the
/// buyback's ceiling uses and a person can check against a screen, and derives the rest twice, by
/// two routes, refusing to broadcast if they disagree by more than a fifth of a tick.
///
/// v4 sorts a pool's two currencies by address, so BRSR is currency0 where its address is below
/// USDG's, as on Robinhood Chain, and currency1 where it is above, as on a local chain whose deploy
/// key placed it there. The price is USDG per BRSR in the first case and BRSR per USDG in the
/// second, and every figure here is worked out for the side BRSR is on.
abstract contract PoolSeeding is BursarScript {
    uint256 internal constant BRSR_UNIT = 1e18;
    uint8 internal constant BRSR_DECIMALS = 18;

    /// How far apart the two derivations of the opening price may sit, in parts per billion of the
    /// square root. One tick is a part in ten thousand of price, so half that in the square root,
    /// and this is a fifth of that.
    uint256 internal constant DERIVATION_TOLERANCE_PPB = 10_000;

    uint256 internal constant DEFAULT_MAX_DEVIATION_BPS = 100;

    /// v4 splits a pool's protocol fee into two 12-bit halves, one per direction.
    uint24 internal constant PROTOCOL_FEE_MASK = 0xfff;
    uint256 internal constant PIPS = 1_000_000;

    struct Plan {
        bool brsrIs0;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 brsrNeeded;
        uint256 usdgNeeded;
    }

    struct Market {
        Buyback buyback;
        IStateView stateView;
        address manager;
        bytes32 id;
    }

    /// The buyback and the StateView from the record, and the manager from the buyback, checked
    /// against the record and any parameter file rather than read from either.
    function _market() internal view returns (Market memory m) {
        m.buyback = Buyback(_upstream(K.BUYBACK));
        m.stateView = IStateView(_upstream(K.STATE_VIEW));
        m.manager = address(m.buyback.poolManager());
        address recorded = _recordAddress(K.POOL_MANAGER);
        if (recorded != address(0) && recorded != m.manager) {
            revert RecordMismatch(K.POOL_MANAGER, recorded, m.manager);
        }
        address named = _envAddressOr("BURSAR_BUYBACK_POOL_MANAGER", address(0));
        require(
            named == address(0) || named == m.manager,
            "BURSAR_BUYBACK_POOL_MANAGER is not the manager the buyback trades on"
        );
        m.id = _poolId(m.buyback);
    }

    /// A seeder the record names has to be one built against this buyback and manager.
    function _requireSeederFor(V4LiquiditySeeder s, Market memory m) internal view {
        require(s.buyback() == address(m.buyback), "the recorded seeder seeds a different buyback's pool");
        require(address(s.poolManager()) == m.manager, "the recorded seeder is built against a different manager");
    }

    /// The position, worked out before anything is sent, over the widest range the spacing allows.
    /// The liquidity is the most the two sides back together, so neither is overdrawn.
    function _plan(Buyback buyback, uint160 sqrtPriceX96, uint256 brsrSide, uint256 usdgSide)
        internal
        view
        returns (Plan memory plan)
    {
        plan.brsrIs0 = _brsrIs0(buyback);
        plan.sqrtPriceX96 = sqrtPriceX96;
        (plan.tickLower, plan.tickUpper) = V4Math.fullRangeTicks(buyback.poolTickSpacing());

        uint160 sqrtA = V4Math.getSqrtPriceAtTick(plan.tickLower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(plan.tickUpper);

        (uint256 side0, uint256 side1) = _pair(plan.brsrIs0, brsrSide, usdgSide);
        plan.liquidity = V4Math.getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, side0, side1);
        require(plan.liquidity != 0, "the amounts back no liquidity");

        (plan.brsrNeeded, plan.usdgNeeded) = _pair(
            plan.brsrIs0,
            V4Math.amount0For(sqrtPriceX96, sqrtA, sqrtB, plan.liquidity),
            V4Math.amount1For(sqrtPriceX96, sqrtA, sqrtB, plan.liquidity)
        );
        require(plan.brsrNeeded <= brsrSide, "the position wants more BRSR than was offered");
        require(plan.usdgNeeded <= usdgSide, "the position wants more USDG than was offered");
    }

    function _brsrIs0(Buyback buyback) internal view returns (bool) {
        return !buyback.settlementIsCurrency0();
    }

    /// A BRSR figure and a USDG figure as the pool orders them, currency0 first, or a pool's pair
    /// back as BRSR and USDG. The same swap maps either way.
    function _pair(bool brsrIs0, uint256 a, uint256 b) internal pure returns (uint256, uint256) {
        return brsrIs0 ? (a, b) : (b, a);
    }

    /// Approves the seeder for the two maxima and adds the plan's liquidity through it, the maxima
    /// in the pool's order. Returns what the pool took, BRSR first.
    function _addThrough(V4LiquiditySeeder seeder, Buyback buyback, Plan memory plan, uint256 maxBrsr, uint256 maxUsdg)
        internal
        returns (uint256 brsrIn, uint256 usdgIn)
    {
        IERC20(address(buyback.brsr())).approve(address(seeder), maxBrsr);
        IERC20(address(buyback.settlementAsset())).approve(address(seeder), maxUsdg);
        (uint256 max0, uint256 max1) = _pair(plan.brsrIs0, maxBrsr, maxUsdg);
        (uint256 in0, uint256 in1) = seeder.addLiquidity(plan.tickLower, plan.tickUpper, plan.liquidity, max0, max1);
        return _pair(plan.brsrIs0, in0, in1);
    }

    /// Both derivations, and a refusal if they disagree. One whole BRSR is 1e18 raw units and one
    /// micro-USD is one raw USDG unit, so the pair below is the raw ratio the pool will price.
    function _openingSqrtPrice(uint256 priceMicroUsd, bool brsrIs0) internal pure returns (uint160) {
        (uint256 amount0, uint256 amount1) = _pair(brsrIs0, BRSR_UNIT, priceMicroUsd);
        uint160 viaQ192 = V4Math.initialSqrtPriceX96(amount0, amount1);
        uint160 viaQ96 = V4Math.initialSqrtPriceX96ViaQ96(amount0, amount1);

        uint256 gap = viaQ192 > viaQ96 ? viaQ192 - viaQ96 : viaQ96 - viaQ192;
        require((gap * 1e9) / viaQ192 <= DERIVATION_TOLERANCE_PPB, "the two price derivations disagree");

        return viaQ192;
    }

    /// The BRSR a given USDG side is worth at `sqrtPriceX96`, which is what an add at the pool's
    /// own price has to bring. The price squares to currency1 per currency0.
    function _brsrFor(uint256 usdgSide, uint160 sqrtPriceX96, bool brsrIs0) internal pure returns (uint256) {
        if (brsrIs0) return Math.mulDiv(Math.mulDiv(usdgSide, V4Math.Q96, sqrtPriceX96), V4Math.Q96, sqrtPriceX96);
        return Math.mulDiv(Math.mulDiv(usdgSide, sqrtPriceX96, V4Math.Q96), sqrtPriceX96, V4Math.Q96);
    }

    /// What the position takes, and what one buyback at the parameters governance set does to the
    /// pool it leaves behind. `reserveMicroUsd` is the pool's USDG depth at the current price.
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
    /// combined the way v4 combines them. The buy spends USDG, so it is zero-for-one exactly when
    /// USDG is currency0.
    function _buyFeePips(uint24 lpFee, uint24 protocolFee, bool zeroForOne) internal pure returns (uint256) {
        uint256 protocol = zeroForOne ? protocolFee & PROTOCOL_FEE_MASK : protocolFee >> 12;
        return protocol + lpFee - (protocol * lpFee) / PIPS;
    }

    /// How far a full-range pool's mid moves on an exact-input buy, in basis points. A full-range
    /// v4 position is a constant-product market in the amounts it holds at the current price, so
    /// the mid moves by `(1 + in/reserve)**2 - 1` with the fee taken off the input first.
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
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(plan.tickLower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(plan.tickUpper);
        if (plan.brsrIs0) return V4Math.amount1For(plan.sqrtPriceX96, sqrtA, sqrtB, liquidity);
        return V4Math.amount0For(plan.sqrtPriceX96, sqrtA, sqrtB, liquidity);
    }

    /// The pool's price and depth after the change, against what was sent. Not optional: a seed
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
        uint256 expected = _envUintOr("BURSAR_SEED_PRICE_MICRO_USD", 0);
        if (expected == 0) return;

        uint256 maxBps = _envUintOr("BURSAR_SEED_MAX_DEVIATION_BPS", DEFAULT_MAX_DEVIATION_BPS);
        uint256 expectedScaled = expected * 1e6;
        uint256 gap = midScaled > expectedScaled ? midScaled - expectedScaled : expectedScaled - midScaled;
        console2.log("expected mid (x1e6)           ", expectedScaled);
        require(gap * 10_000 <= expectedScaled * maxBps, "the pool is further from the expected price than allowed");
    }

    /// The pool's mid in micro-USD for one whole BRSR, scaled by a further 1e6. `sqrtPriceX96`
    /// squares to raw USDG per raw BRSR when BRSR is currency0 and to its inverse when it is not,
    /// and one whole BRSR is 1e18 raw.
    function _midMicroUsdScaled(uint160 sqrtPriceX96, bool brsrIs0) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        if (brsrIs0) return Math.mulDiv(Math.mulDiv(s, s, V4Math.Q96), 1e24, V4Math.Q96);
        return Math.mulDiv(Math.mulDiv(1e24, V4Math.Q96, s), V4Math.Q96, s);
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
        require(usdgSide != 0, "the USDG side is zero");
        _requireShape(buyback);
    }

    function _requireShape(Buyback buyback) internal view {
        address brsr = address(buyback.brsr());
        address usdg = address(buyback.settlementAsset());
        require(IERC20Metadata(brsr).decimals() == BRSR_DECIMALS, "BRSR is not an eighteen-decimal token");
        require(IERC20Metadata(usdg).decimals() == SETTLEMENT_DECIMALS, "USDG is not a six-decimal token");

        // v4 reads the zero address as native currency. Neither side of this pool may be it.
        address c0 = buyback.currency0();
        address c1 = buyback.currency1();
        require(c0 != address(0) && c1 != address(0), "native currency");
        require((c0 == brsr && c1 == usdg) || (c0 == usdg && c1 == brsr), "the buyback's pool is not BRSR/USDG");
    }

    /// `priceScaled` is micro-USD per whole BRSR, scaled by a further 1e6.
    function _warnIfCeilingBelow(Buyback buyback, uint256 priceScaled) internal view {
        uint256 ceiling = buyback.params().maxPriceMicroUsdPerBrsr;
        if (ceiling == 0 || ceiling * 1e6 >= priceScaled) return;
        console2.log("WARNING: the buyback ceiling is below the pool price. Every buyback will refuse.");
        console2.log("ceiling, micro-USD per BRSR   ", ceiling);
    }

    /// Changing the market is not a step that can be undone or repriced, so on Robinhood Chain it
    /// takes a phrase in `BURSAR_ALLOW_MAINNET_SEED`. Without it the run prints and stops.
    function _allowed(string memory phrase) internal view returns (bool) {
        if (!_onRobinhood()) return true;
        string memory gate = _envRaw(_key("BURSAR_ALLOW_MAINNET_SEED"));
        if (keccak256(bytes(gate)) == keccak256(bytes(phrase))) return true;

        console2.log("");
        console2.log("Dry run. Nothing was sent.");
        console2.log(string.concat("Set BURSAR_ALLOW_MAINNET_SEED=", phrase, " to broadcast on 4663."));
        return false;
    }
}

/// Opens the BRSR/USDG market and puts the first position in it, or adds to the market once it is
/// open.
///
/// `run` opens the pool at a price you name and seeds it, and refuses a pool that is already open.
/// `seedExisting` adds to an open pool at the price it is trading at. Run either one without
/// `--broadcast` first: everything it will do is printed, including the price, the exact amounts
/// the pool will take and what a buyback then does to the pool, and nothing about the printed run
/// touches the chain.
///
/// The buyback, the StateView and the seeder come from the record. On Robinhood Chain the pool is
/// already open and the recorded seeder belongs to governance, so `seedExisting` is the path: it
/// adds to governance's position from whichever key runs it. `run` exists for a new chain.
///
/// ## Environment
///
/// | | |
/// |---|---|
/// | `BURSAR_RECORD` | the deployment record, which names the buyback, the StateView and the seeder |
/// | `BURSAR_SEED_USDG_MICRO` | the USDG side of the position, in micro-USD |
/// | `BURSAR_SEED_PRICE_MICRO_USD` | `run`: the opening price of one whole BRSR, in micro-USD; `seedExisting`: optional, the price you expect the pool to be at |
/// | `BURSAR_SEED_MAX_DEVIATION_BPS` | `seedExisting`: how far from that price the pool may be, default 100 |
/// | `BURSAR_ALLOW_MAINNET_SEED` | required on 4663: `i-am-opening-the-market` for `run`, `i-am-adding-to-the-market` for `seedExisting` |
contract SeedPool is PoolSeeding {
    /// Opens the pool at `BURSAR_SEED_PRICE_MICRO_USD` and puts the first position in it.
    function run() external {
        _loadPrefix();
        _requireChain();
        _refuseRetired("BURSAR_SEEDER", "the record's token.V4LiquiditySeeder");
        Market memory m = _market();

        uint256 priceMicroUsd = _envUint("BURSAR_SEED_PRICE_MICRO_USD");
        uint256 usdgSide = _envUint("BURSAR_SEED_USDG_MICRO");
        require(priceMicroUsd != 0, "BURSAR_SEED_PRICE_MICRO_USD is zero");
        _preflight(m.buyback, usdgSide);
        _warnIfCeilingBelow(m.buyback, priceMicroUsd * 1e6);

        (uint160 openAt,,,) = m.stateView.getSlot0(m.id);
        require(openAt == 0, "the pool is already open; seedExisting adds to it");

        // Opening the pool is the seeder owner's call, and the one decision here that cannot be
        // taken back. A seeder in the record belongs to whoever the record's deployment gave it
        // to, so this path brings its own and hands it to governance once the seed is in.
        address recorded = _recordAddress(K.SEEDER);
        require(recorded == address(0), "the record already names a seeder; its owner opens the pool");

        Plan memory plan = _plan(
            m.buyback,
            _openingSqrtPrice(priceMicroUsd, _brsrIs0(m.buyback)),
            (usdgSide * BRSR_UNIT) / priceMicroUsd,
            usdgSide
        );
        _reportOpening(priceMicroUsd, plan);
        // The protocol fee is fixed when the pool opens, so before then only the LP fee is known.
        _report(m.buyback, plan, usdgSide, 0);

        if (!_allowed("i-am-opening-the-market")) return;

        vm.startBroadcast(msg.sender);
        V4LiquiditySeeder s = new V4LiquiditySeeder(m.manager, address(m.buyback), msg.sender);
        int24 openedAt = s.initializePool(plan.sqrtPriceX96);
        (uint256 brsrIn, uint256 usdgIn) = _addThrough(s, m.buyback, plan, plan.brsrNeeded, usdgSide);
        s.transferOwnership(m.buyback.admin());
        vm.stopBroadcast();

        console2.log("seeder deployed at            ", address(s));
        console2.log("ownership offered to          ", m.buyback.admin());
        console2.log("governance takes it by calling acceptOwnership() on the seeder.");
        console2.log("opened at tick                ", vm.toString(openedAt));
        _readBack(m.stateView, m.id, plan.sqrtPriceX96, plan.liquidity, brsrIn, usdgIn);
        _write(K.SEEDER, address(s));
    }

    function _reportOpening(uint256 priceMicroUsd, Plan memory plan) private pure {
        (uint256 amount0, uint256 amount1) = _pair(plan.brsrIs0, BRSR_UNIT, priceMicroUsd);
        console2.log("--- the opening price ---");
        console2.log("micro-USD per whole BRSR      ", priceMicroUsd);
        console2.log(
            plan.brsrIs0
                ? "BRSR is currency0, so the pool prices USDG per BRSR"
                : "BRSR is currency1, so the pool prices BRSR per USDG"
        );
        console2.log("sqrtPriceX96, Q192 route      ", plan.sqrtPriceX96);
        console2.log("sqrtPriceX96, Q96 route       ", V4Math.initialSqrtPriceX96ViaQ96(amount0, amount1));
        console2.log("fully diluted, micro-USD      ", priceMicroUsd * 1_000_000_000);
    }

    /// Adds to a pool that is already open, at the price it stands at. The maxima are the exact
    /// amounts the position costs at that price, so a price that moves between this read and the
    /// transaction landing makes the add revert rather than pay more of either side.
    function seedExisting() external {
        _loadPrefix();
        _requireChain();
        _refuseRetired("BURSAR_SEEDER", "the record's token.V4LiquiditySeeder");
        Market memory m = _market();
        uint256 usdgSide = _envUint("BURSAR_SEED_USDG_MICRO");

        (uint160 sqrtPriceX96,, uint24 protocolFee,) = m.stateView.getSlot0(m.id);
        require(sqrtPriceX96 != 0, "the pool is not open; run opens it");
        _preflight(m.buyback, usdgSide);
        uint256 midScaled = _midMicroUsdScaled(sqrtPriceX96, _brsrIs0(m.buyback));
        _warnIfCeilingBelow(m.buyback, midScaled);
        _requireNear(midScaled);

        address recorded = _recordAddress(K.SEEDER);
        if (recorded != address(0)) _requireSeederFor(V4LiquiditySeeder(recorded), m);

        Plan memory plan =
            _plan(m.buyback, sqrtPriceX96, _brsrFor(usdgSide, sqrtPriceX96, _brsrIs0(m.buyback)), usdgSide);
        uint128 before = m.stateView.getLiquidity(m.id);

        console2.log("--- the pool as it stands ---");
        console2.log("mid, micro-USD per BRSR (x1e6)", midScaled);
        console2.log("liquidity                     ", before);
        _report(m.buyback, plan, _virtualUsdg(plan, before + plan.liquidity), protocolFee);

        if (!_allowed("i-am-adding-to-the-market")) return;

        vm.startBroadcast(msg.sender);
        // Anyone may add, so a seeder deployed here belongs to governance from its first block.
        V4LiquiditySeeder s = recorded == address(0)
            ? new V4LiquiditySeeder(m.manager, address(m.buyback), m.buyback.admin())
            : V4LiquiditySeeder(recorded);
        (uint256 brsrIn, uint256 usdgIn) = _addThrough(s, m.buyback, plan, plan.brsrNeeded, plan.usdgNeeded);
        vm.stopBroadcast();

        if (recorded == address(0)) {
            console2.log("seeder deployed at            ", address(s));
            _write(K.SEEDER, address(s));
        }
        _readBack(m.stateView, m.id, sqrtPriceX96, before + plan.liquidity, brsrIn, usdgIn);
    }
}
