// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PoolKey, SwapParams} from "../../src/token/Buyback.sol";

contract MockFeed {
    uint8 public decimals = 8;
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MockStock is ERC20 {
    bool public oraclePaused;
    bool public tokenPaused;
    uint256 public uiMultiplier = 1e18;

    constructor(string memory symbol) ERC20(symbol, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }

    function setTokenPaused(bool p) external {
        tokenPaused = p;
    }
}

contract MockAccess {
    bool public paused;
    mapping(address => bool) public isBlocked;

    function setBlocked(address a, bool b) external {
        isBlocked[a] = b;
    }

    function setPaused(bool p) external {
        paused = p;
    }
}

interface IUnlockCallbackR {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// PoolManager and StateView in one. Each pool trades at its sqrt price with no fee and no
/// price impact; the manager holds real balances and the lock closes only when every currency
/// the caller moved nets to zero.
contract MockV4 {
    uint256 internal constant Q96 = 1 << 96;

    mapping(bytes32 => uint160) public sqrtPrice;
    /// Output shaved off every swap, in bps, to model a pool that fills worse than its mid.
    uint16 public haircutBps;

    bool private _unlocked;
    address private _synced;
    uint256 private _syncedBalance;
    mapping(address => int256) private _delta;
    address[] private _touched;

    error NotSettled(address currency);

    function setPrice(PoolKey memory key, uint160 s) external {
        sqrtPrice[keccak256(abi.encode(key))] = s;
    }

    function setHaircut(uint16 bps) external {
        haircutBps = bps;
    }

    function getSlot0(bytes32 id) external view returns (uint160, int24, uint24, uint24) {
        return (sqrtPrice[id], 0, 0, 0);
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        _unlocked = true;
        result = IUnlockCallbackR(msg.sender).unlockCallback(data);
        for (uint256 i; i < _touched.length; ++i) {
            if (_delta[_touched[i]] != 0) revert NotSettled(_touched[i]);
        }
        delete _touched;
        _unlocked = false;
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        uint256 s = sqrtPrice[keccak256(abi.encode(key))];
        require(s != 0, "no pool");
        bool exactIn = p.amountSpecified < 0;
        uint256 amt = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        uint256 inAmt;
        uint256 outAmt;
        if (p.zeroForOne) {
            if (exactIn) {
                inAmt = amt;
                outAmt = Math.mulDiv(Math.mulDiv(amt, s, Q96), s, Q96);
            } else {
                outAmt = amt;
                inAmt = Math.mulDiv(Math.mulDiv(amt, Q96, s, Math.Rounding.Ceil), Q96, s, Math.Rounding.Ceil);
            }
        } else {
            if (exactIn) {
                inAmt = amt;
                outAmt = Math.mulDiv(Math.mulDiv(amt, Q96, s), Q96, s);
            } else {
                outAmt = amt;
                inAmt = Math.mulDiv(Math.mulDiv(amt, s, Q96, Math.Rounding.Ceil), s, Q96, Math.Rounding.Ceil);
            }
        }
        if (exactIn) outAmt = outAmt * (10_000 - haircutBps) / 10_000;
        else inAmt = inAmt * (10_000 + haircutBps) / 10_000;

        (address cIn, address cOut) = p.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _move(cIn, -int256(inAmt));
        _move(cOut, int256(outAmt));
        int256 d0 = p.zeroForOne ? -int256(inAmt) : int256(outAmt);
        int256 d1 = p.zeroForOne ? int256(outAmt) : -int256(inAmt);
        return (d0 << 128) | int256(uint256(uint128(int128(d1))));
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
        IERC20(currency).transfer(to, amount);
    }

    function _move(address c, int256 d) private {
        require(_unlocked, "locked");
        if (_delta[c] == 0) _touched.push(c);
        _delta[c] += d;
    }
}

contract MockEscrow {
    IERC20 public immutable asset;
    uint256 public next;

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    function lock(address, bytes32, bytes32, string calldata, uint128 amount, uint64) external returns (uint256) {
        asset.transferFrom(msg.sender, address(this), amount);
        return ++next;
    }
}
