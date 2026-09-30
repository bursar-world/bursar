// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PoolKey, SwapParams} from "../../src/token/Buyback.sol";

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// A Uniswap v4 pool manager with the four functions the buyback calls and the one property
/// that makes them worth testing against: the lock closes only when every currency the caller
/// moved is settled to zero.
///
/// The types are the ones `Buyback` declares, so an encoding that would miss the live manager
/// misses this one too. By default the price is a constant, because the contract under test never
/// reads a price: what it checks is how much arrived, and a curve would only make the expected
/// figure harder to state in the test.
///
/// `setReserves` turns it into a constant-product market for the tests that are about the price
/// moving: every swap moves it, in either direction, so a trader can push the price ahead of a
/// buyback and sell back into it afterwards the way one would on the live pool.
///
/// The knobs exist to reproduce failures a real venue can produce. A hook may rewrite either
/// leg of a swap, a pool that runs out of liquidity fills part of an exact-input order, and a
/// settlement asset that takes a fee credits less than was sent.
contract MockPoolManager {
    error CurrencyNotSettled(address currency, int256 delta);
    error NotUnlocked();
    error AlreadyUnlocked();
    error PoolNotInitialised(bytes32 id);
    error NothingSynced();

    /// BRSR wei paid out for each whole unit of the settlement asset taken in.
    uint256 public price;

    uint256 private constant SETTLEMENT_UNIT = 1e6;

    IERC20 public immutable settlement;
    IERC20 public immutable brsr;

    bool public unlocked;

    /// Set to the last swap's key so a test can prove the buyback sent the pool it was built
    /// against, in the right sort order.
    PoolKey public lastKey;
    bytes public lastHookData;
    int256 public lastAmountSpecified;
    uint160 public lastSqrtPriceLimit;
    bool public lastZeroForOne;
    uint256 public swapCount;

    /// Fraction of an exact-input order consumed, in basis points.
    uint16 public fillBps = 10_000;

    /// Returns a delta that says the caller received the input and owes the output.
    bool public flipDelta;

    /// Credits less on settle than the balance moved, the way a fee-taking asset
    /// would.
    uint256 public settleShortfall;

    /// Set by `setReserves`. The pool then prices off these two balances as x * y = k, and the
    /// fee, in pips, comes off the input and stays in the pool.
    bool public curve;
    uint256 public reserveSettlement;
    uint256 public reserveBrsr;
    uint24 public feePips;

    /// Pool keys this manager will trade. An unregistered key reverts, which is what an
    /// uninitialised pool does on the live chain.
    mapping(bytes32 id => bool live) public pools;

    address private syncedCurrency;
    uint256 private syncedBalance;

    mapping(address caller => mapping(address currency => int256 delta)) private _delta;

    constructor(IERC20 settlement_, IERC20 brsr_, uint256 price_) {
        settlement = settlement_;
        brsr = brsr_;
        price = price_;
    }

    function initialize(PoolKey memory key) external {
        pools[keccak256(abi.encode(key))] = true;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function setFillBps(uint16 bps) external {
        fillBps = bps;
    }

    function setFlipDelta(bool flip) external {
        flipDelta = flip;
    }

    function setSettleShortfall(uint256 amount) external {
        settleShortfall = amount;
    }

    function setReserves(uint256 settlementReserve, uint256 brsrReserve, uint24 fee) external {
        curve = true;
        reserveSettlement = settlementReserve;
        reserveBrsr = brsrReserve;
        feePips = fee;
    }

    /// The curve's mid in micro-USD for one whole BRSR.
    function midMicroUsdPerBrsr() external view returns (uint256) {
        return (reserveSettlement * 1e18) / reserveBrsr;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (unlocked) revert AlreadyUnlocked();
        unlocked = true;

        result = IUnlockCallback(msg.sender).unlockCallback(data);

        int256 owedSettlement = _delta[msg.sender][address(settlement)];
        if (owedSettlement != 0) revert CurrencyNotSettled(address(settlement), owedSettlement);
        int256 owedBrsr = _delta[msg.sender][address(brsr)];
        if (owedBrsr != 0) revert CurrencyNotSettled(address(brsr), owedBrsr);

        unlocked = false;
        syncedCurrency = address(0);
        syncedBalance = 0;
    }

    /// Returns the caller's two deltas packed into one word, amount0 above amount1, signed
    /// from the caller's side: negative is owed to the pool, positive is owed to the caller.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta)
    {
        if (!unlocked) revert NotUnlocked();
        bytes32 id = keccak256(abi.encode(key));
        if (!pools[id]) revert PoolNotInitialised(id);

        lastKey = key;
        lastHookData = hookData;
        lastAmountSpecified = params.amountSpecified;
        lastSqrtPriceLimit = params.sqrtPriceLimitX96;
        lastZeroForOne = params.zeroForOne;
        ++swapCount;

        uint256 requested = uint256(-params.amountSpecified);
        uint256 consumed = (requested * fillBps) / 10_000;

        // The fixed price only ever takes the settlement asset in and pays BRSR out. The curve
        // trades both ways, in the direction the caller asked for.
        bool settlementIn = !curve || params.zeroForOne == (address(settlement) < address(brsr));
        uint256 produced = curve ? _trade(consumed, settlementIn) : (consumed * price) / SETTLEMENT_UNIT;

        (int128 inLeg, int128 outLeg) = flipDelta
            ? (int128(int256(consumed)), -int128(int256(produced)))
            : (-int128(int256(consumed)), int128(int256(produced)));

        (address inCurrency, address outCurrency) =
            settlementIn ? (address(settlement), address(brsr)) : (address(brsr), address(settlement));
        _delta[msg.sender][inCurrency] += inLeg;
        _delta[msg.sender][outCurrency] += outLeg;

        (int128 amount0, int128 amount1) = params.zeroForOne ? (inLeg, outLeg) : (outLeg, inLeg);
        swapDelta = int256((uint256(uint128(amount0)) << 128) | uint256(uint128(amount1)));
    }

    function _trade(uint256 amountIn, bool settlementIn) private returns (uint256 amountOut) {
        uint256 net = (amountIn * (1e6 - feePips)) / 1e6;
        if (settlementIn) {
            amountOut = (reserveBrsr * net) / (reserveSettlement + net);
            reserveSettlement += amountIn;
            reserveBrsr -= amountOut;
        } else {
            amountOut = (reserveSettlement * net) / (reserveBrsr + net);
            reserveBrsr += amountIn;
            reserveSettlement -= amountOut;
        }
    }

    function sync(address currency) external {
        syncedCurrency = currency;
        syncedBalance = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        address currency = syncedCurrency;
        if (currency == address(0)) revert NothingSynced();

        uint256 arrived = IERC20(currency).balanceOf(address(this)) - syncedBalance;
        paid = arrived > settleShortfall ? arrived - settleShortfall : 0;

        _delta[msg.sender][currency] += int256(paid);
        syncedCurrency = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        if (!unlocked) revert NotUnlocked();
        _delta[msg.sender][currency] -= int256(amount);
        IERC20(currency).transfer(to, amount);
    }

    function deltaOf(address caller, address currency) external view returns (int256) {
        return _delta[caller][currency];
    }
}
