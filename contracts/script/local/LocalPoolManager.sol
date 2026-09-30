// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {V4Math} from "../lib/V4Math.sol";

import {PoolKey, SwapParams} from "../../src/token/Buyback.sol";
import {ModifyLiquidityParams} from "../../src/token/V4LiquiditySeeder.sol";

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// Uniswap v4's pool manager and its StateView in one contract, standing in for both on a local
/// chain.
///
/// Opening a pool and adding or removing liquidity follow v4's arithmetic, so `SeedPool.s.sol`
/// opens and funds the BRSR/USDG market here with the same calls and the same read-back it makes on
/// Robinhood Chain. A swap fills at the pool's price, less the key's fee and a flat haircut, rather
/// than along the curve: that puts a fill a little under the feed the way the live pools do, which
/// is what the lanes' price guards need. Money moves inside `unlock`, and an unlock that leaves any
/// currency owed either way reverts, as v4's does. `setPrice` places a pool outright, for the RWA
/// pools and for suites that need a price where nobody seeded one.
contract LocalPoolManager {
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PIPS = 1_000_000;

    mapping(bytes32 id => uint160) public sqrtPrice;
    mapping(bytes32 id => int24) public tickOf;
    /// Liquidity in range at the pool's price, which is what StateView reports.
    mapping(bytes32 id => uint128) private _liquidity;

    /// Output shaved off every swap on top of the fee, in bps: the depth the live pools lack.
    uint16 public haircutBps = 10;
    /// How far each swap moves the price against the trader, in bps. Zero leaves it put.
    uint16 public impactBps;

    bool private _unlocked;
    address private _synced;
    uint256 private _syncedBalance;
    mapping(address currency => int256) private _delta;
    address[] private _touched;

    error NotSettled(address currency);
    error PoolAlreadyInitialized(bytes32 id);
    error PoolNotInitialized(bytes32 id);

    function setPrice(PoolKey memory key, uint160 sqrtPriceX96) external {
        _setPrice(keccak256(abi.encode(key)), sqrtPriceX96);
    }

    function setHaircut(uint16 bps) external {
        haircutBps = bps;
    }

    function setImpact(uint16 bps) external {
        impactBps = bps;
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        bytes32 id = keccak256(abi.encode(key));
        if (sqrtPrice[id] != 0) revert PoolAlreadyInitialized(id);
        _setPrice(id, sqrtPriceX96);
        return tickOf[id];
    }

    function getSlot0(bytes32 id) external view returns (uint160, int24, uint24, uint24) {
        return (sqrtPrice[id], tickOf[id], 0, 0);
    }

    function getLiquidity(bytes32 id) external view returns (uint128) {
        return _liquidity[id];
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        _unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        for (uint256 i; i < _touched.length; ++i) {
            if (_delta[_touched[i]] != 0) revert NotSettled(_touched[i]);
        }
        delete _touched;
        _unlocked = false;
    }

    /// An add costs what v4 charges for the liquidity at the pool's price, rounded up, and a removal
    /// pays out what it returns, rounded down. The position earns no fees here.
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata)
        external
        returns (int256 callerDelta, int256 feesAccrued)
    {
        bytes32 id = keccak256(abi.encode(key));
        uint160 price = sqrtPrice[id];
        if (price == 0) revert PoolNotInitialized(id);

        uint160 sqrtA = V4Math.getSqrtPriceAtTick(params.tickLower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(params.tickUpper);
        bool adding = params.liquidityDelta > 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amount = uint128(uint256(adding ? params.liquidityDelta : -params.liquidityDelta));

        int256 delta0;
        int256 delta1;
        if (adding) {
            delta0 = -int256(V4Math.amount0For(price, sqrtA, sqrtB, amount));
            delta1 = -int256(V4Math.amount1For(price, sqrtA, sqrtB, amount));
        } else {
            (uint256 out0, uint256 out1) = _removed(price, sqrtA, sqrtB, amount);
            delta0 = int256(out0);
            delta1 = int256(out1);
        }
        if (price >= sqrtA && price < sqrtB) {
            _liquidity[id] = adding ? _liquidity[id] + amount : _liquidity[id] - amount;
        }

        _move(key.currency0, delta0);
        _move(key.currency1, delta1);
        callerDelta = _pack(delta0, delta1);
        feesAccrued = 0;
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        bytes32 id = keccak256(abi.encode(key));
        uint256 s = sqrtPrice[id];
        require(s != 0, "no pool");
        bool exactIn = p.amountSpecified < 0;
        uint256 amt = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        uint256 inAmt;
        uint256 outAmt;
        if (exactIn) {
            inAmt = amt;
            outAmt = _atMid(amt * (PIPS - key.fee) / PIPS, s, p.zeroForOne) * (BPS - haircutBps) / BPS;
        } else {
            outAmt = amt;
            uint256 net = Math.mulDiv(_atMidIn(amt, s, p.zeroForOne), BPS + haircutBps, BPS, Math.Rounding.Ceil);
            inAmt = Math.mulDiv(net, PIPS, PIPS - key.fee, Math.Rounding.Ceil);
        }
        if (impactBps != 0) {
            // Selling currency0 lowers its price in currency1, and the reverse.
            uint256 moved = p.zeroForOne ? BPS - impactBps : BPS + impactBps;
            // forge-lint: disable-next-line(unsafe-typecast)
            _setPrice(id, uint160(Math.mulDiv(s, Math.sqrt(moved * 1e32), 1e18)));
        }

        (address cIn, address cOut) = p.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _move(cIn, -int256(inAmt));
        _move(cOut, int256(outAmt));
        int256 d0 = p.zeroForOne ? -int256(inAmt) : int256(outAmt);
        int256 d1 = p.zeroForOne ? int256(outAmt) : -int256(inAmt);
        return _pack(d0, d1);
    }

    function sync(address currency) external {
        _synced = currency;
        _syncedBalance = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        paid = IERC20(_synced).balanceOf(address(this)) - _syncedBalance;
        _move(_synced, int256(paid));
        _synced = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        _move(currency, -int256(amount));
        require(IERC20(currency).transfer(to, amount), "transfer failed");
    }

    function _setPrice(bytes32 id, uint160 sqrtPriceX96) private {
        sqrtPrice[id] = sqrtPriceX96;
        tickOf[id] = sqrtPriceX96 == 0 ? int24(0) : _tickAt(sqrtPriceX96);
    }

    /// The highest tick whose price is at or below `sqrtPriceX96`, which is how v4 reports a pool's
    /// tick, found by bisection over v4's own tick-to-price function.
    function _tickAt(uint160 sqrtPriceX96) private pure returns (int24) {
        int256 low = V4Math.MIN_TICK;
        int256 high = V4Math.MAX_TICK;
        while (low < high) {
            int256 mid = low + (high - low + 1) / 2;
            // forge-lint: disable-next-line(unsafe-typecast)
            if (V4Math.getSqrtPriceAtTick(int24(mid)) <= sqrtPriceX96) low = mid;
            else high = mid - 1;
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(low);
    }

    /// What removing `liquidity` over `[sqrtA, sqrtB]` pays out at `price`, rounded down.
    function _removed(uint160 price, uint160 sqrtA, uint160 sqrtB, uint128 liquidity)
        private
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint160 lower = price < sqrtA ? sqrtA : (price > sqrtB ? sqrtB : price);
        if (lower < sqrtB) amount0 = Math.mulDiv(uint256(liquidity) << 96, sqrtB - lower, sqrtB) / lower;
        if (lower > sqrtA) amount1 = Math.mulDiv(liquidity, lower - sqrtA, Q96);
    }

    function _pack(int256 amount0, int256 amount1) private pure returns (int256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return (amount0 << 128) | int256(uint256(uint128(int128(amount1))));
    }

    /// Output of `amountIn` at the mid. `sqrtPrice` is currency1 per currency0.
    function _atMid(uint256 amountIn, uint256 s, bool zeroForOne) private pure returns (uint256) {
        if (zeroForOne) return Math.mulDiv(Math.mulDiv(amountIn, s, Q96), s, Q96);
        return Math.mulDiv(Math.mulDiv(amountIn, Q96, s), Q96, s);
    }

    /// Input that buys `amountOut` at the mid, rounded up.
    function _atMidIn(uint256 amountOut, uint256 s, bool zeroForOne) private pure returns (uint256) {
        if (zeroForOne) {
            return Math.mulDiv(Math.mulDiv(amountOut, Q96, s, Math.Rounding.Ceil), Q96, s, Math.Rounding.Ceil);
        }
        return Math.mulDiv(Math.mulDiv(amountOut, s, Q96, Math.Rounding.Ceil), s, Q96, Math.Rounding.Ceil);
    }

    function _move(address currency, int256 delta) private {
        require(_unlocked, "locked");
        if (_delta[currency] == 0) _touched.push(currency);
        _delta[currency] += delta;
    }
}
