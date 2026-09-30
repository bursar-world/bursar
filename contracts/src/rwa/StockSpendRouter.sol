// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "../token/Buyback.sol";
import {IMandateAccount} from "../interfaces/IMandateAccount.sol";
import {IStockRouter} from "../interfaces/IStockRouter.sol";
import {AssetRegistry} from "./AssetRegistry.sol";
import {PriceGuard} from "./PriceGuard.sol";
import {V4Swapper} from "./V4Swapper.sol";

/// Buys a registered stock token with USDG for a mandate account and delivers it to the account.
///
/// A mandate reaches this through `buy`, which has already checked the `rwa` class, the caps and
/// the total. This contract checks the rest: the asset is on the mandate's own list, the
/// purchase is under the asset's per-trade cap, the price guard passes before and after the
/// swap, the caller's quote is within the asset's band of the feed, and the fill is no worse than
/// the feed price less the mandate's slippage limit. It swaps only in the asset's pinned pool.
///
/// The per-mandate list and slippage limit are set by the mandate's principal. A mandate with no
/// list set can buy nothing here.
contract StockSpendRouter is IStockRouter, V4Swapper, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    AssetRegistry public immutable registry;
    PriceGuard public immutable guard;
    IERC20 public immutable usdg;

    /// Zero means the asset's band.
    mapping(address mandate => uint16) public maxSlippageBps;
    mapping(address mandate => mapping(address asset => bool)) public assetAllowed;

    event PolicySet(address indexed mandate, uint16 maxSlippageBps);
    event AssetAllowed(address indexed mandate, address indexed asset, bool allowed);
    event StockBought(
        address indexed mandate, address indexed asset, uint256 usdgIn, uint256 amountOut, uint256 feedPriceE8
    );

    error NotPrincipal();
    error AssetNotAllowed(address asset);
    error NotAStock(address asset);
    error TradeCapExceeded(uint256 usdgIn, uint256 cap);
    error BadSlippage();

    constructor(AssetRegistry registry_, PriceGuard guard_, IPoolManager poolManager_) V4Swapper(poolManager_) {
        registry = registry_;
        guard = guard_;
        usdg = IERC20(registry_.settlementAsset());
    }

    function setPolicy(address mandate, uint16 slippageBps, address[] calldata assets, bool[] calldata allowed)
        external
    {
        if (msg.sender != IMandateAccount(mandate).principal()) revert NotPrincipal();
        if (slippageBps >= BPS || assets.length != allowed.length) revert BadSlippage();
        maxSlippageBps[mandate] = slippageBps;
        emit PolicySet(mandate, slippageBps);
        for (uint256 i; i < assets.length; ++i) {
            assetAllowed[mandate][assets[i]] = allowed[i];
            emit AssetAllowed(mandate, assets[i], allowed[i]);
        }
    }

    /// The smallest fill `buy` will accept for `usdgIn` from `mandate`, at the current feed.
    function minOutFor(address mandate, address asset, uint256 usdgIn) public view returns (uint256) {
        AssetRegistry.Asset memory a = registry.get(asset);
        uint256 price = guard.tradePrice(asset, mandate);
        return _floor(a, price, usdgIn, _slippage(mandate, a));
    }

    function buy(address asset, uint128 usdgIn, uint128 minOut, uint256 quotedPriceE8, address to)
        external
        override
        nonReentrant
        returns (uint256 amountOut)
    {
        if (!assetAllowed[msg.sender][asset]) revert AssetNotAllowed(asset);
        AssetRegistry.Asset memory a = registry.get(asset);
        if (!a.isStock) revert NotAStock(asset);
        if (usdgIn > a.perTradeCap) revert TradeCapExceeded(usdgIn, a.perTradeCap);

        uint256 price = guard.checkQuote(asset, to, quotedPriceE8);
        guard.tradePrice(asset, msg.sender);

        uint256 floor = _floor(a, price, usdgIn, _slippage(msg.sender, a));
        if (minOut > floor) floor = minOut;

        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        bool zeroForOne = a.pool.currency0 == address(usdg);
        (, amountOut) = _swap(
            SwapOrder({key: a.pool, zeroForOne: zeroForOne, exactIn: true, amount: usdgIn, limit: floor, to: to})
        );
        // The purchase has to leave the pool inside the band as well as find it there, or a push
        // to the band's edge earlier in the transaction lets the fill run past it.
        guard.tradePrice(asset, msg.sender);

        emit StockBought(msg.sender, asset, usdgIn, amountOut, price);
    }

    function _slippage(address mandate, AssetRegistry.Asset memory a) private view returns (uint256) {
        uint256 s = maxSlippageBps[mandate];
        return s == 0 || s > a.bandBps ? a.bandBps : s;
    }

    function _floor(AssetRegistry.Asset memory a, uint256 priceE8, uint256 usdgIn, uint256 slippageBps)
        private
        pure
        returns (uint256)
    {
        uint256 atFeed = Math.mulDiv(usdgIn, 10 ** (uint256(a.decimals) + 2), priceE8);
        return Math.mulDiv(atFeed, BPS - slippageBps, BPS);
    }
}
