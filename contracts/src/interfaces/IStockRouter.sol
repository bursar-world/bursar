// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// What a mandate account calls to buy an eligible stock token. The router checks the asset
/// and the reference price, pulls `usdgIn` from the caller and delivers at least `minOut` to
/// `to`.
interface IStockRouter {
    function buy(address asset, uint128 usdgIn, uint128 minOut, uint256 quotedPriceE8, address to)
        external
        returns (uint256 amountOut);
}
