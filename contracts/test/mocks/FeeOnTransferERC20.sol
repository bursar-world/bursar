// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Burns one percent of every holder-to-holder transfer, so the amount credited is always
/// less than the amount named. A contract that trusts its own arithmetic over a measured
/// balance delta ends up short by the fee.
contract FeeOnTransferERC20 is ERC20 {
    uint256 private constant FEE_BPS = 100;
    uint256 private constant BPS = 10_000;

    constructor() ERC20("Fee Token", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = value * FEE_BPS / BPS;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}
