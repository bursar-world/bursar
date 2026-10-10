// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "../token/Buyback.sol";
import {IMandateAccount} from "../interfaces/IMandateAccount.sol";
import {IStockRouter} from "../interfaces/IStockRouter.sol";
import {AssetRegistry} from "./AssetRegistry.sol";
import {PriceGuard} from "./PriceGuard.sol";
import {V4Swapper} from "./V4Swapper.sol";

/// Holds the stock a mandate's principal has released for sale. One per mandate, at an address
/// `StockSpendRouter.custodyOf` predicts, so stock sent here can only ever be sold for USDG that
/// lands in that mandate, or returned to it.
contract SellCustody {
    using SafeERC20 for IERC20;

    address public immutable router;

    error NotRouter();

    constructor() {
        router = msg.sender;
    }

    function sweep(address token, address to, uint256 amount) external {
        if (msg.sender != router) revert NotRouter();
        IERC20(token).safeTransfer(to, amount);
    }
}

/// Buys a registered stock token with USDG for a mandate account and delivers it to the account,
/// and sells one the account holds back to USDG.
///
/// Buying. A mandate reaches this through `buy`, which has already checked the `rwa` class, the
/// caps and the total. This contract checks the rest: the asset is on the mandate's own list, the
/// purchase is under the asset's per-trade cap, the price guard passes before and after the swap,
/// the caller's quote is within the asset's band of the feed, and the fill is no worse than the
/// feed price less the mandate's slippage limit. It swaps only in the asset's pinned pool.
///
/// Selling. A mandate account holds what it bought and lets only its principal move a token out,
/// so the principal releases what the agent may sell by sending it from the account to the
/// mandate's custody, `custodyOf(mandate)`, with the account's own `withdraw`. From there the
/// agent or the principal sells any part of it with `sell`, under the same guard a purchase gets:
/// the feed price has to be inside its trade bound, the pool inside the asset's band of the feed
/// before and after the swap, the caller's quote inside that band, the sale under the asset's
/// per-trade cap at the feed, and the fill no worse than the feed price less the mandate's
/// slippage limit. The USDG is delivered to the mandate. Either of them can also send custody
/// back to the mandate with `recall`. A sale is not a spend: it restores USDG the mandate can
/// spend again, and nothing is credited back to the limits the purchase counted against.
///
/// The per-mandate lists, one for purchases and one for sales, and the slippage limit are set by
/// the mandate's principal. A mandate with no list set can buy nothing and sell nothing here.
contract StockSpendRouter is IStockRouter, V4Swapper, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    AssetRegistry public immutable registry;
    PriceGuard public immutable guard;
    IERC20 public immutable usdg;

    /// Zero means the asset's band.
    mapping(address mandate => uint16) public maxSlippageBps;
    mapping(address mandate => mapping(address asset => bool)) public assetAllowed;
    mapping(address mandate => mapping(address asset => bool)) public saleAllowed;

    event PolicySet(address indexed mandate, uint16 maxSlippageBps);
    event AssetAllowed(address indexed mandate, address indexed asset, bool allowed);
    event SaleAllowed(address indexed mandate, address indexed asset, bool allowed);
    event StockBought(
        address indexed mandate, address indexed asset, uint256 usdgIn, uint256 amountOut, uint256 feedPriceE8
    );
    event StockSold(
        address indexed mandate, address indexed asset, uint256 amountIn, uint256 usdgOut, uint256 feedPriceE8
    );
    event Recalled(address indexed mandate, address indexed asset, uint256 amount);

    error NotPrincipal();
    error NotOperator();
    error AssetNotAllowed(address asset);
    error SaleNotAllowed(address asset);
    error NotAStock(address asset);
    error TradeCapExceeded(uint256 usdgIn, uint256 cap);
    error BadSlippage();
    error LengthMismatch();
    error ZeroAmount();
    error CustodyShort(uint256 held, uint256 needed);
    error QuoteOutsideBand(address asset, uint256 quotedPriceE8, uint256 feedPriceE8);

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

    /// Which assets the agent may sell out of the mandate's custody. Separate from the purchase
    /// list: a principal can let an agent sell a holding it may no longer buy, or the reverse.
    function setSalePolicy(address mandate, address[] calldata assets, bool[] calldata allowed) external {
        if (msg.sender != IMandateAccount(mandate).principal()) revert NotPrincipal();
        if (assets.length != allowed.length) revert LengthMismatch();
        for (uint256 i; i < assets.length; ++i) {
            saleAllowed[mandate][assets[i]] = allowed[i];
            emit SaleAllowed(mandate, assets[i], allowed[i]);
        }
    }

    /// The smallest fill `buy` will accept for `usdgIn` from `mandate`, at the current feed.
    function minOutFor(address mandate, address asset, uint256 usdgIn) public view returns (uint256) {
        AssetRegistry.Asset memory a = registry.get(asset);
        uint256 price = guard.tradePrice(asset, mandate);
        return _floor(a, price, usdgIn, _slippage(mandate, a));
    }

    /// The least USDG `sell` will accept for `raw` of `asset` from `mandate`, at the current feed.
    function minUsdgFor(address mandate, address asset, uint256 raw) public view returns (uint256) {
        AssetRegistry.Asset memory a = registry.get(asset);
        uint256 price = guard.exitPrice(asset, mandate);
        return _proceedsFloor(_atFeed(a, price, raw), _slippage(mandate, a));
    }

    /// Where a principal sends stock the agent may sell. The contract is created on the first sale
    /// or recall, so stock can be sent here before it exists.
    function custodyOf(address mandate) public view returns (address) {
        // Creation code, not a literal with digits to miscount.
        // slither-disable-next-line too-many-digits
        return Create2.computeAddress(bytes32(uint256(uint160(mandate))), keccak256(type(SellCustody).creationCode));
    }

    /// How much of `asset` the mandate's custody holds, which is what `sell` can sell.
    function sellable(address mandate, address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(custodyOf(mandate));
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
        // Called for its refusals, this time for the mandate itself. The price is the one above.
        // slither-disable-next-line unused-return
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
        // slither-disable-next-line unused-return
        guard.tradePrice(asset, msg.sender);

        emit StockBought(msg.sender, asset, usdgIn, amountOut, price);
    }

    /// Sells `raw` of `asset` out of the mandate's custody for at least `minUsdg`, delivered to
    /// the mandate. Sent by the mandate's agent or principal. `quotedPriceE8` is the feed price
    /// the caller decided on, refused outside the asset's band of the feed now, so a sale decided
    /// on a price that has since moved stops here instead of filling against the new one.
    function sell(address mandate, address asset, uint128 raw, uint128 minUsdg, uint256 quotedPriceE8)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        _onlyOperator(mandate);
        if (!saleAllowed[mandate][asset]) revert SaleNotAllowed(asset);
        AssetRegistry.Asset memory a = registry.get(asset);
        if (!a.isStock) revert NotAStock(asset);
        if (raw == 0) revert ZeroAmount();

        // The exit price, so a holding governance has delisted can still be sold out.
        uint256 price = guard.exitPrice(asset, mandate);
        if (_deviationBps(quotedPriceE8, price) > a.bandBps) revert QuoteOutsideBand(asset, quotedPriceE8, price);
        uint256 atFeed = _atFeed(a, price, raw);
        if (atFeed > a.perTradeCap) revert TradeCapExceeded(atFeed, a.perTradeCap);

        uint256 floor = _proceedsFloor(atFeed, _slippage(mandate, a));
        if (minUsdg > floor) floor = minUsdg;

        address custody = _custody(mandate);
        uint256 held = IERC20(asset).balanceOf(custody);
        if (held < raw) revert CustodyShort(held, raw);
        SellCustody(custody).sweep(asset, address(this), raw);

        (, usdgOut) = _swap(
            SwapOrder({
                key: a.pool, zeroForOne: a.pool.currency0 == asset, exactIn: true, amount: raw, limit: floor, to: mandate
            })
        );
        // The sale has to leave the pool inside the band as well as find it there.
        // slither-disable-next-line unused-return
        guard.exitPrice(asset, mandate);

        emit StockSold(mandate, asset, raw, usdgOut, price);
    }

    /// Sends `amount` of `asset` from the mandate's custody back to the mandate. Needs no price:
    /// the stock is the mandate's either way.
    function recall(address mandate, address asset, uint256 amount) external nonReentrant {
        _onlyOperator(mandate);
        if (amount == 0) revert ZeroAmount();
        address custody = _custody(mandate);
        uint256 held = IERC20(asset).balanceOf(custody);
        if (held < amount) revert CustodyShort(held, amount);
        SellCustody(custody).sweep(asset, mandate, amount);
        emit Recalled(mandate, asset, amount);
    }

    function _onlyOperator(address mandate) private view {
        if (msg.sender != IMandateAccount(mandate).principal() && msg.sender != IMandateAccount(mandate).agent()) {
            revert NotOperator();
        }
    }

    function _custody(address mandate) private returns (address custody) {
        custody = custodyOf(mandate);
        if (custody.code.length == 0) new SellCustody{salt: bytes32(uint256(uint160(mandate)))}();
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

    /// USDG that `raw` is worth at the feed.
    function _atFeed(AssetRegistry.Asset memory a, uint256 priceE8, uint256 raw) private pure returns (uint256) {
        return Math.mulDiv(raw, priceE8, 10 ** (uint256(a.decimals) + 2));
    }

    function _proceedsFloor(uint256 atFeed, uint256 slippageBps) private pure returns (uint256) {
        return Math.mulDiv(atFeed, BPS - slippageBps, BPS);
    }

    function _deviationBps(uint256 x, uint256 ref) private pure returns (uint256) {
        uint256 diff = x > ref ? x - ref : ref - x;
        return Math.mulDiv(diff, BPS, ref, Math.Rounding.Ceil);
    }
}
