// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IParkAsset} from "../interfaces/IParkAsset.sol";

/// Parks USDG as USDG. Value is one to one and always fresh. It exists so a principal can set
/// aside a reserve the agent cannot spend directly, with the same unpark path as SGOV.
contract UsdgAdapter is IParkAsset {
    using SafeERC20 for IERC20;

    address public immutable park;
    address public immutable override asset;
    uint128 private immutable _perMandate;
    uint128 private immutable _total;

    error NotPark();
    error Short(uint256 have, uint256 need);

    modifier onlyPark() {
        if (msg.sender != park) revert NotPark();
        _;
    }

    constructor(address park_, address usdg_, uint128 perMandate_, uint128 total_) {
        park = park_;
        asset = usdg_;
        _perMandate = perMandate_;
        _total = total_;
    }

    function value(uint256 raw) external view override returns (uint256, uint256, uint256, bool) {
        return (raw, 1e8, block.timestamp, true);
    }

    function haircutBps() external pure override returns (uint16) {
        return 0;
    }

    function caps() external view override returns (uint128, uint128) {
        return (_perMandate, _total);
    }

    function acquire(uint256 usdgIn, uint256 minOut, address) external view override onlyPark returns (uint256) {
        if (usdgIn < minOut) revert Short(usdgIn, minOut);
        return usdgIn;
    }

    function release(uint256 raw, uint256 minUsdg, address to, address) external override onlyPark returns (uint256) {
        if (raw < minUsdg) revert Short(raw, minUsdg);
        IERC20(asset).safeTransfer(to, raw);
        return raw;
    }

    function releaseExact(uint256 usdgOut, uint256 maxRaw, address to, address)
        external
        override
        onlyPark
        returns (uint256)
    {
        if (usdgOut > maxRaw) revert Short(maxRaw, usdgOut);
        IERC20(asset).safeTransfer(to, usdgOut);
        return usdgOut;
    }
}
