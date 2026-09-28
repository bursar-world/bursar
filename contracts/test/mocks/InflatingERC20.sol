// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Credits the recipient twice on every transfer, so a balance measured around the transfer
/// rises by more than was sent. The mirror image of FeeOnTransferERC20: both break a
/// contract that equates the named amount with the received amount.
contract InflatingERC20 is ERC20 {
    constructor() ERC20("Inflating Token", "INFLATE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (from == address(0) || to == address(0)) return;

        _mint(to, value);
    }
}
