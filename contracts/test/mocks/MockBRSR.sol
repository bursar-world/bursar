// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Eighteen-decimal stand-in for BRSR, where resolver bonds are denominated.
///
/// Mintable, unlike the real token, whose whole supply is placed once by its constructor. A
/// fixture that needs to hand a resolver a bond should not have to route it through a four-way
/// allocation split first. Use the real `BRSR` where the supply itself is what is under test.
contract MockBRSR is ERC20 {
    constructor() ERC20("Bursar", "BRSR") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
