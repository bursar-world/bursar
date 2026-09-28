// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// The arithmetic that turns a price a person can read into the numbers a Uniswap v4 pool
/// takes: an opening `sqrtPriceX96`, a tick range, and the liquidity a pair of token amounts
/// backs over that range.
///
/// Nothing here is deployed. It lives under `script` because its whole job is to work out what
/// a seed will do before anyone broadcasts it, and because the seeder on chain is better off
/// being told the answer and checking the amounts than computing it. The less that runs inside
/// the pool manager's unlock, the less there is to get wrong while its books are open.
///
/// ## Where the pieces came from
///
/// `getSqrtPriceAtTick` is Uniswap v4-core's `TickMath.getSqrtPriceAtTick`, unchanged in its
/// arithmetic; the `CustomRevert` helper is replaced with a plain `revert` and the file's other
/// thousand lines are not carried. `getLiquidityForAmounts`, `amount0For` and `amount1For` are
/// v4-periphery's `LiquidityAmounts` and v4-core's `SqrtPriceMath` over OpenZeppelin's
/// `Math.mulDiv`, which is the same 512-bit multiply-divide as Uniswap's `FullMath` with an
/// explicit rounding argument. `initialSqrtPriceX96` and `fullRangeTicks` are written here.
/// The Uniswap code is MIT licensed; its notice is in `NOTICE` at the repository root.
///
/// ## The decimal trap
///
/// A v4 price is a ratio of **raw token units**, not of whole tokens. BRSR carries eighteen
/// decimals and USDG carries six, so one BRSR worth one USDG is a raw ratio of `1e6 / 1e18`,
/// which is `1e-12`, not `1`. Reading a human price straight into `sqrtPriceX96` opens the pool
/// a trillion times away from where it was meant to, and on a public market that is not
/// recoverable: the first trade takes the difference. `initialSqrtPriceX96` therefore takes raw
/// amounts and nothing else, and every caller states both decimals where it computes them.
library V4Math {
    /// The tick is outside the band v4 can express.
    error InvalidTick(int24 tick);
    /// The price the amounts imply is outside `[MIN_SQRT_PRICE, MAX_SQRT_PRICE]`. Returning a
    /// truncated `uint160` here would open a pool at a price nobody chose.
    error PriceOutOfRange();
    /// The liquidity the amounts back does not fit the `uint128` the pool manager takes.
    error LiquidityOverflow();
    error ZeroAmount();

    uint256 internal constant Q96 = 1 << 96;

    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /// @notice `sqrt(amount1 / amount0)` in Q64.96: the price of currency1 per currency0 that a
    ///         pair of raw reserve amounts implies.
    /// @dev Two paths, and they agree to well inside one tick.
    ///
    ///      The first squares the ratio into Q192 before taking a single integer square root,
    ///      which is the Uniswap SDK's `encodeSqrtRatioX96` and is exact to one unit of
    ///      `sqrtPriceX96`. It needs `amount1 / amount0` to stay under `2**64`, which the shift
    ///      below tests without overflowing.
    ///
    ///      The second is the Q96 form: square-root the ratio in Q96 and shift the half-precision
    ///      back. It holds for the whole tickable band and loses about a ten-millionth of the
    ///      price, which is a few thousandths of one tick.
    ///
    ///      Both are checked against each other in `test/token/V4Math.t.sol`, and the first is
    ///      checked against an independent integer square root computed outside Solidity.
    /// @param amount0 Raw units of currency0.
    /// @param amount1 Raw units of currency1.
    function initialSqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();

        uint256 priceX96;
        if ((amount1 >> 64) < amount0) {
            priceX96 = Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0));
        } else {
            priceX96 = Math.sqrt(Math.mulDiv(amount1, Q96, amount0)) << 48;
        }

        if (priceX96 <= MIN_SQRT_PRICE || priceX96 >= MAX_SQRT_PRICE) revert PriceOutOfRange();
        // Bounded above by MAX_SQRT_PRICE, which is below 2**160.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(priceX96);
    }

    /// @notice The Q96 path on its own, so a test can compare the two derivations rather than
    ///         take one of them on trust.
    function initialSqrtPriceX96ViaQ96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        uint256 priceX96 = Math.sqrt(Math.mulDiv(amount1, Q96, amount0)) << 48;
        if (priceX96 <= MIN_SQRT_PRICE || priceX96 >= MAX_SQRT_PRICE) revert PriceOutOfRange();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(priceX96);
    }

    /// @notice The widest position a pool of this spacing supports. Truncation toward zero keeps
    ///         both ends inside `[MIN_TICK, MAX_TICK]` and aligned to the spacing.
    function fullRangeTicks(int24 tickSpacing) internal pure returns (int24 tickLower, int24 tickUpper) {
        // Aligning to spacing needs the divide before the multiply; that is the point.
        // forge-lint: disable-next-line(divide-before-multiply)
        tickLower = (MIN_TICK / tickSpacing) * tickSpacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        tickUpper = (MAX_TICK / tickSpacing) * tickSpacing;
    }

    /// @notice `sqrt(1.0001**tick) * 2**96`. Uniswap v4-core's `TickMath.getSqrtPriceAtTick`.
    function getSqrtPriceAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick;
            assembly ("memory-safe") {
                tick := signextend(2, tick)
                let mask := sar(255, tick)
                absTick := xor(mask, add(mask, tick))
            }

            if (absTick > uint256(int256(MAX_TICK))) revert InvalidTick(tick);

            uint256 price;
            assembly ("memory-safe") {
                price := xor(shl(128, 1), mul(xor(shl(128, 1), 0xfffcb933bd6fad37aa2d162d1a594001), and(absTick, 0x1)))
            }
            if (absTick & 0x2 != 0) price = (price * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) price = (price * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) price = (price * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) price = (price * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) price = (price * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) price = (price * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) price = (price * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) price = (price * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) price = (price * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) price = (price * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) price = (price * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) price = (price * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) price = (price * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) price = (price * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) price = (price * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) price = (price * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) price = (price * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) price = (price * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) price = (price * 0x48a170391f7dc42444e8fa2) >> 128;

            assembly ("memory-safe") {
                if sgt(tick, 0) { price := div(not(0), price) }
                sqrtPriceX96 := shr(32, add(price, sub(shl(32, 1), 1)))
            }
        }
    }

    /// @notice The largest liquidity `amount0` and `amount1` back over `[sqrtA, sqrtB]` at
    ///         `sqrtPrice`, so the caller never deposits more of either than it offered.
    function getLiquidityForAmounts(
        uint160 sqrtPriceX96,
        uint160 sqrtAX96,
        uint160 sqrtBX96,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtAX96 > sqrtBX96) (sqrtAX96, sqrtBX96) = (sqrtBX96, sqrtAX96);

        if (sqrtPriceX96 <= sqrtAX96) return _narrow(_forAmount0(sqrtAX96, sqrtBX96, amount0));
        if (sqrtPriceX96 >= sqrtBX96) return _narrow(_forAmount1(sqrtAX96, sqrtBX96, amount1));

        uint256 liquidity0 = _forAmount0(sqrtPriceX96, sqrtBX96, amount0);
        uint256 liquidity1 = _forAmount1(sqrtAX96, sqrtPriceX96, amount1);
        return _narrow(liquidity0 < liquidity1 ? liquidity0 : liquidity1);
    }

    /// @notice Currency0 a position of `liquidity` over `[sqrtA, sqrtB]` costs at `sqrtPrice`,
    ///         rounded the way v4 rounds a deposit, so the figure is what the pool will take.
    function amount0For(uint160 sqrtPriceX96, uint160 sqrtAX96, uint160 sqrtBX96, uint128 liquidity)
        internal
        pure
        returns (uint256)
    {
        if (sqrtAX96 > sqrtBX96) (sqrtAX96, sqrtBX96) = (sqrtBX96, sqrtAX96);
        if (sqrtPriceX96 >= sqrtBX96) return 0;
        uint160 from = sqrtPriceX96 > sqrtAX96 ? sqrtPriceX96 : sqrtAX96;
        return _amount0Delta(from, sqrtBX96, liquidity);
    }

    /// @notice Currency1 a position of `liquidity` over `[sqrtA, sqrtB]` costs at `sqrtPrice`.
    function amount1For(uint160 sqrtPriceX96, uint160 sqrtAX96, uint160 sqrtBX96, uint128 liquidity)
        internal
        pure
        returns (uint256)
    {
        if (sqrtAX96 > sqrtBX96) (sqrtAX96, sqrtBX96) = (sqrtBX96, sqrtAX96);
        if (sqrtPriceX96 <= sqrtAX96) return 0;
        uint160 to = sqrtPriceX96 < sqrtBX96 ? sqrtPriceX96 : sqrtBX96;
        return _amount1Delta(sqrtAX96, to, liquidity);
    }

    function _forAmount0(uint160 sqrtAX96, uint160 sqrtBX96, uint256 amount0) private pure returns (uint256) {
        uint256 intermediate = Math.mulDiv(sqrtAX96, sqrtBX96, Q96);
        return Math.mulDiv(amount0, intermediate, sqrtBX96 - sqrtAX96);
    }

    function _forAmount1(uint160 sqrtAX96, uint160 sqrtBX96, uint256 amount1) private pure returns (uint256) {
        return Math.mulDiv(amount1, Q96, sqrtBX96 - sqrtAX96);
    }

    function _amount0Delta(uint160 sqrtAX96, uint160 sqrtBX96, uint128 liquidity) private pure returns (uint256) {
        uint256 numerator = uint256(liquidity) << 96;
        return Math.mulDiv(
            Math.mulDiv(numerator, sqrtBX96 - sqrtAX96, sqrtBX96, Math.Rounding.Ceil), 1, sqrtAX96, Math.Rounding.Ceil
        );
    }

    function _amount1Delta(uint160 sqrtAX96, uint160 sqrtBX96, uint128 liquidity) private pure returns (uint256) {
        return Math.mulDiv(liquidity, sqrtBX96 - sqrtAX96, Q96, Math.Rounding.Ceil);
    }

    function _narrow(uint256 value) private pure returns (uint128 narrowed) {
        // Any truncation is caught by the equality check below, which reverts.
        // forge-lint: disable-next-line(unsafe-typecast)
        narrowed = uint128(value);
        if (narrowed != value) revert LiquidityOverflow();
    }
}
