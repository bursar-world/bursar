// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {V4Math} from "../../script/lib/V4Math.sol";

/// The arithmetic that decides the opening price of BRSR.
///
/// Every number in here is checked against something that did not produce it: the two
/// derivations against each other, the square root against its own square, the tick constants
/// against Uniswap's published values, and the whole of it against the deposit the live pool
/// actually took, which is `test/script/fork/TokenRailFork.t.sol`.
contract V4MathTest is Test {
    uint256 internal constant BRSR_UNIT = 1e18;
    uint256 internal constant Q96 = 1 << 96;

    /// One BRSR at two hundred micro-dollars, the price this repository seeds at. The expected
    /// value is `isqrt((200 << 192) / 1e18)`, computed outside Solidity.
    function test_openingPriceMatchesAnIndependentSquareRoot() public pure {
        assertEq(V4Math.initialSqrtPriceX96(BRSR_UNIT, 200), 1120455419495722798374);
    }

    /// The same at four other prices, so a single lucky constant cannot pass this file.
    function test_openingPriceMatchesAtFourOtherPrices() public pure {
        assertEq(V4Math.initialSqrtPriceX96(BRSR_UNIT, 100), 792281625142643375935);
        assertEq(V4Math.initialSqrtPriceX96(BRSR_UNIT, 500), 1771595571142957102961);
        assertEq(V4Math.initialSqrtPriceX96(BRSR_UNIT, 1_000), 2505414483750479311864);
        assertEq(V4Math.initialSqrtPriceX96(BRSR_UNIT, 2_000), 3543191142285914205922);
    }

    /// The decimal trap itself, stated as a test. A price read into the pool as if both tokens
    /// carried the same decimals is out by `1e12` in the ratio, which is `1e6` in the square
    /// root, and that is what the pool would open at.
    function test_ignoringDecimalsIsOutByAMillionInTheSquareRoot() public pure {
        // Correct: 200 raw USDG units against 1e18 raw BRSR units.
        uint160 right = V4Math.initialSqrtPriceX96(BRSR_UNIT, 200);
        // Wrong: whole tokens against whole tokens, which is what "0.0002 USDG per BRSR" looks
        // like to anyone who forgets the units. Scaled up to stay in integers.
        uint160 wrong = V4Math.initialSqrtPriceX96(1e18, 200 * 1e12);

        assertApproxEqRel(uint256(wrong), uint256(right) * 1e6, 1e12, "the gap is a factor of a million");
    }

    /// The two derivations, over the whole band a BRSR price could sit in.
    function testFuzz_derivationsAgree(uint96 priceMicroUsd) public pure {
        priceMicroUsd = uint96(bound(priceMicroUsd, 1, 1e12));

        uint160 viaQ192 = V4Math.initialSqrtPriceX96(BRSR_UNIT, priceMicroUsd);
        uint160 viaQ96 = V4Math.initialSqrtPriceX96ViaQ96(BRSR_UNIT, priceMicroUsd);

        // One tick is a part in ten thousand of price, so half that in the square root: 5e-5.
        // The Q96 route floors a square root whose magnitude falls as the ratio moves away from
        // one, so its error grows at the extremes: about 7e-8 at the price this repository
        // seeds at, about 3.5e-6 at a price of one micro-dollar. A fifth of a tick covers the
        // whole band, and it is the gate `script/SeedPool.s.sol` applies.
        assertApproxEqRel(uint256(viaQ96), uint256(viaQ192), 1e13);
    }

    /// One to nine micro-dollars, the bottom of the range and where the Q96 route is least
    /// precise. Each expected value is `isqrt((p << 192) / 1e18)` computed outside Solidity, and
    /// the Q96 route lands inside the script's gate at every one of them.
    function test_bothRoutesPriceOneToNineMicroDollarsInsideTheGate() public pure {
        uint160[9] memory expected = [
            uint160(79228162514264337593),
            112045541949572279837,
            137227202865029797602,
            158456325028528675187,
            177159557114295710296,
            194068571418249185253,
            209618014845353321189,
            224091083899144559674,
            237684487542793012780
        ];
        for (uint256 i; i < expected.length; ++i) {
            uint256 price = i + 1;
            uint160 viaQ192 = V4Math.initialSqrtPriceX96(BRSR_UNIT, price);
            assertEq(viaQ192, expected[i]);
            assertApproxEqRel(uint256(V4Math.initialSqrtPriceX96ViaQ96(BRSR_UNIT, price)), uint256(viaQ192), 1e13);
        }
    }

    /// The Q192 route squared is the ratio it was given, to within the last unit.
    function testFuzz_squaringTheRootReturnsThePrice(uint96 priceMicroUsd) public pure {
        priceMicroUsd = uint96(bound(priceMicroUsd, 1, 1e12));

        uint256 s = V4Math.initialSqrtPriceX96(BRSR_UNIT, priceMicroUsd);
        // (s / 2**96)**2 * 1e18 is micro-USD per whole BRSR. Split so the square stays in range.
        uint256 back = (((s * s) >> 96) * 1e18) >> 96;

        assertApproxEqAbs(back, priceMicroUsd, 1, "the square root does not square back");
    }

    /// Uniswap's own published bounds, which every v4 deployment enforces.
    function test_tickBoundsMatchUniswap() public pure {
        assertEq(V4Math.getSqrtPriceAtTick(V4Math.MIN_TICK), V4Math.MIN_SQRT_PRICE);
        assertEq(V4Math.getSqrtPriceAtTick(V4Math.MAX_TICK), V4Math.MAX_SQRT_PRICE);
        assertEq(V4Math.getSqrtPriceAtTick(0), uint160(Q96));
    }

    /// The two ends of the widest position a 60-spacing pool can hold. These are the ticks the
    /// seed uses, and the values are what the live pool reported back on the fork.
    function test_fullRangeTicks_spanPlusMinus887220AtSpacingSixty() public pure {
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(60);
        assertEq(lower, -887220);
        assertEq(upper, 887220);
        assertEq(lower % 60, 0);
        assertEq(upper % 60, 0);
        assertGe(V4Math.getSqrtPriceAtTick(lower), V4Math.MIN_SQRT_PRICE);
        assertLe(V4Math.getSqrtPriceAtTick(upper), V4Math.MAX_SQRT_PRICE);
    }

    function test_fullRangeTicks_alignToOtherSpacings() public pure {
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(1);
        assertEq(lower, V4Math.MIN_TICK);
        assertEq(upper, V4Math.MAX_TICK);

        (lower, upper) = V4Math.fullRangeTicks(10);
        assertEq(lower, -887270);
        assertEq(upper, 887270);
    }

    /// `getSqrtPriceAtTick` is monotone, which is the property every other use of it relies on.
    function testFuzz_sqrtPriceIsMonotoneInTheTick(int24 tick) public pure {
        tick = int24(bound(tick, V4Math.MIN_TICK, V4Math.MAX_TICK - 1));
        assertLt(V4Math.getSqrtPriceAtTick(tick), V4Math.getSqrtPriceAtTick(tick + 1));
    }

    function test_tickOutsideTheBandReverts() public {
        vm.expectRevert(abi.encodeWithSelector(V4Math.InvalidTick.selector, int24(887273)));
        this.sqrtAt(887273);
        vm.expectRevert(abi.encodeWithSelector(V4Math.InvalidTick.selector, int24(-887273)));
        this.sqrtAt(-887273);
    }

    function test_zeroAmountsRevert() public {
        vm.expectRevert(V4Math.ZeroAmount.selector);
        this.openAt(0, 200);
        vm.expectRevert(V4Math.ZeroAmount.selector);
        this.openAt(BRSR_UNIT, 0);
        vm.expectRevert(V4Math.ZeroAmount.selector);
        this.openViaQ96At(0, 200);
        vm.expectRevert(V4Math.ZeroAmount.selector);
        this.openViaQ96At(BRSR_UNIT, 0);
    }

    /// A ratio outside the band v4 can express is refused: truncated into a `uint160`, it would
    /// open a pool at a price nobody chose.
    function test_priceOutsideTheBandReverts() public {
        vm.expectRevert(V4Math.PriceOutOfRange.selector);
        this.openAt(type(uint128).max, 1);
        vm.expectRevert(V4Math.PriceOutOfRange.selector);
        this.openViaQ96At(type(uint128).max, 1);
    }

    /// Above `2**64` the Q192 route would overflow, so the library answers by the Q96 route.
    function test_theHighRatioFallbackAnswers() public pure {
        // One raw unit of currency0 against 2**80 raw units of currency1.
        uint160 s = V4Math.initialSqrtPriceX96(1, 1 << 80);
        assertGt(s, V4Math.MIN_SQRT_PRICE);
        assertLt(s, V4Math.MAX_SQRT_PRICE);
    }

    /// The liquidity a pair of amounts backs, and the deposit that liquidity costs, are inverse
    /// to within v4's own rounding. The fork run checks the same pair against the live pool.
    function test_liquidityAndDepositAgree() public pure {
        uint160 sqrtPrice = V4Math.initialSqrtPriceX96(BRSR_UNIT, 200);
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(60);
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(lower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(upper);

        uint256 brsrSide = 125_000 * BRSR_UNIT;
        uint256 usdgSide = 25_000_000;

        uint128 liquidity = V4Math.getLiquidityForAmounts(sqrtPrice, sqrtA, sqrtB, brsrSide, usdgSide);
        assertEq(liquidity, 1767766952966368, "the liquidity the live pool recorded");

        uint256 amount0 = V4Math.amount0For(sqrtPrice, sqrtA, sqrtB, liquidity);
        uint256 amount1 = V4Math.amount1For(sqrtPrice, sqrtA, sqrtB, liquidity);
        assertEq(amount0, 124999999999999942653563, "the BRSR the live pool took");
        assertEq(amount1, 25000000, "the USDG the live pool took");
        assertLe(amount0, brsrSide);
        assertLe(amount1, usdgSide);
    }

    /// A range wholly above the price is one-sided in currency0, and one wholly below it is
    /// one-sided in currency1. Both ends of `getLiquidityForAmounts` are reached.
    function test_aRangeOffThePriceIsOneSided() public pure {
        // The pool's price, near tick -361500.
        uint160 sqrtPrice = V4Math.initialSqrtPriceX96(BRSR_UNIT, 200);

        // Wholly above: the position is all BRSR and asks for no USDG.
        uint160 aboveLower = V4Math.getSqrtPriceAtTick(-300_000);
        uint160 aboveUpper = V4Math.getSqrtPriceAtTick(-200_000);
        assertGt(aboveLower, sqrtPrice);
        uint128 above = V4Math.getLiquidityForAmounts(sqrtPrice, aboveLower, aboveUpper, 1e18, 0);
        assertGt(above, 0);
        assertGt(V4Math.amount0For(sqrtPrice, aboveLower, aboveUpper, above), 0);
        assertEq(V4Math.amount1For(sqrtPrice, aboveLower, aboveUpper, above), 0);

        // Wholly below: the position is all USDG and asks for no BRSR.
        uint160 belowLower = V4Math.getSqrtPriceAtTick(-500_000);
        uint160 belowUpper = V4Math.getSqrtPriceAtTick(-400_000);
        assertLt(belowUpper, sqrtPrice);
        uint128 below = V4Math.getLiquidityForAmounts(sqrtPrice, belowLower, belowUpper, 0, 1e6);
        assertGt(below, 0);
        assertEq(V4Math.amount0For(sqrtPrice, belowLower, belowUpper, below), 0);
        assertGt(V4Math.amount1For(sqrtPrice, belowLower, belowUpper, below), 0);
    }

    /// The range ends may arrive either way round.
    function test_rangeEndsMayBeReversed() public pure {
        uint160 sqrtPrice = V4Math.initialSqrtPriceX96(BRSR_UNIT, 200);
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(60);
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(lower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(upper);

        assertEq(
            V4Math.getLiquidityForAmounts(sqrtPrice, sqrtA, sqrtB, 125_000e18, 25_000_000),
            V4Math.getLiquidityForAmounts(sqrtPrice, sqrtB, sqrtA, 125_000e18, 25_000_000)
        );
        uint128 l = V4Math.getLiquidityForAmounts(sqrtPrice, sqrtA, sqrtB, 125_000e18, 25_000_000);
        assertEq(V4Math.amount0For(sqrtPrice, sqrtB, sqrtA, l), V4Math.amount0For(sqrtPrice, sqrtA, sqrtB, l));
        assertEq(V4Math.amount1For(sqrtPrice, sqrtB, sqrtA, l), V4Math.amount1For(sqrtPrice, sqrtA, sqrtB, l));
    }

    /// Liquidity that does not fit the `uint128` the pool manager takes is refused.
    function test_liquidityOverflowReverts() public {
        // One tick of range at a price of one, where a hundred and twenty-eight bits of
        // currency1 back about three hundred times as much liquidity.
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(0);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(60);
        vm.expectRevert(V4Math.LiquidityOverflow.selector);
        this.liquidityFor(sqrtB, sqrtA, sqrtB, 0, type(uint128).max);
    }

    // External wrappers, so `expectRevert` has a call boundary to watch.
    function sqrtAt(int24 tick) external pure returns (uint160) {
        return V4Math.getSqrtPriceAtTick(tick);
    }

    function openAt(uint256 amount0, uint256 amount1) external pure returns (uint160) {
        return V4Math.initialSqrtPriceX96(amount0, amount1);
    }

    function openViaQ96At(uint256 amount0, uint256 amount1) external pure returns (uint160) {
        return V4Math.initialSqrtPriceX96ViaQ96(amount0, amount1);
    }

    function liquidityFor(uint160 p, uint160 a, uint160 b, uint256 amount0, uint256 amount1)
        external
        pure
        returns (uint128)
    {
        return V4Math.getLiquidityForAmounts(p, a, b, amount0, amount1);
    }
}
