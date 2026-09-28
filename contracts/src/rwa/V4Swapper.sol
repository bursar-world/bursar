// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager, PoolKey, SwapParams} from "../token/Buyback.sol";

/// One swap against one pinned Uniswap v4 pool, paid from this contract's own balance.
///
/// Trades go straight to the PoolManager (0x8366…0951) rather than through the UniversalRouter:
/// the router would need a Permit2 allowance on every caller for a route that is always a single
/// hookless pool. Both legs are read back from the manager's delta, never inferred from the
/// request.
abstract contract V4Swapper {
    using SafeERC20 for IERC20;

    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    IPoolManager public immutable poolManager;

    bool private _unlocking;

    error NotPoolManager();
    error NotUnlocking();
    error SwapShort(uint256 amountIn, uint256 amountOut);
    error SettlementShort(uint256 paid, uint256 owed);

    struct SwapOrder {
        PoolKey key;
        bool zeroForOne;
        bool exactIn;
        /// Exact input when `exactIn`, exact output otherwise.
        uint256 amount;
        /// Minimum output when `exactIn`, maximum input otherwise.
        uint256 limit;
        address to;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function _swap(SwapOrder memory order) internal returns (uint256 amountIn, uint256 amountOut) {
        _unlocking = true;
        bytes memory result = poolManager.unlock(abi.encode(order));
        (amountIn, amountOut) = abi.decode(result, (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_unlocking) revert NotUnlocking();
        _unlocking = false;

        SwapOrder memory o = abi.decode(data, (SwapOrder));
        // forge-lint: disable-start(unsafe-typecast)
        int256 delta = poolManager.swap(
            o.key,
            SwapParams({
                zeroForOne: o.zeroForOne,
                // Negative is exact input, positive exact output.
                amountSpecified: o.exactIn ? -int256(o.amount) : int256(o.amount),
                sqrtPriceLimitX96: o.zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int256 delta0 = int256(int128(delta >> 128));
        int256 delta1 = int256(int128(delta));
        // forge-lint: disable-end

        (int256 inDelta, int256 outDelta) = o.zeroForOne ? (delta0, delta1) : (delta1, delta0);
        if (inDelta >= 0 || outDelta <= 0) revert SwapShort(0, 0);
        uint256 owed = uint256(-inDelta);
        uint256 received = uint256(outDelta);

        // A partial fill means the pool ran out of range under the order.
        if (o.exactIn) {
            if (owed != o.amount || received < o.limit) revert SwapShort(owed, received);
        } else {
            if (received != o.amount || owed > o.limit) revert SwapShort(owed, received);
        }

        (address currencyIn, address currencyOut) =
            o.zeroForOne ? (o.key.currency0, o.key.currency1) : (o.key.currency1, o.key.currency0);

        poolManager.sync(currencyIn);
        IERC20(currencyIn).safeTransfer(address(poolManager), owed);
        uint256 paid = poolManager.settle();
        if (paid < owed) revert SettlementShort(paid, owed);

        poolManager.take(currencyOut, o.to, received);

        return abi.encode(owed, received);
    }
}
