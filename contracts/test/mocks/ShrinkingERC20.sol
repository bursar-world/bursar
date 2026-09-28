// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Once armed, the next credit to the victim burns the victim's whole balance, so a balance
/// measured around the transfer falls. Models a token whose holdings can be taken from the
/// outside, which is what a blacklist or a rebase looks like to a contract that has already
/// booked the funds.
contract ShrinkingERC20 is ERC20 {
    address private victim;
    bool private armed;

    constructor() ERC20("Shrinking Token", "SHRINK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address victim_) external {
        victim = victim_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (!armed || from == address(0) || to != victim) return;

        armed = false;
        super._update(victim, address(0), balanceOf(victim));
    }
}
