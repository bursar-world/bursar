// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Calls back into a target in the middle of a transfer, the way a hook-bearing token would. The
/// callback result is recorded: a guard that reverts the reentrant call must not also revert the
/// outer transfer, or the test cannot tell a working guard from a token that failed.
contract ReentrantERC20 is ERC20 {
    bool public callbackSucceeded;
    bytes4 public callbackError;

    address private target;
    bytes private payload;
    bool private armed;
    bool private entered;

    constructor() ERC20("Reentrant Token", "REENTER") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// Fires once, on the next transfer that touches `target_`.
    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        callbackSucceeded = false;
        callbackError = bytes4(0);
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (!armed || entered || from == address(0) || (from != target && to != target)) return;

        entered = true;
        (bool success, bytes memory result) = target.call(payload);
        callbackSucceeded = success;
        if (result.length >= 4) {
            bytes4 selector;
            assembly ("memory-safe") {
                selector := mload(add(result, 32))
            }
            callbackError = selector;
        }
        entered = false;
        armed = false;
    }
}
