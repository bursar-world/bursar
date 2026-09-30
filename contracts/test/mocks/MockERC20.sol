// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Plain six-decimal settlement asset for tests that care about the money path. Use MockUsdg when
/// the test touches EIP-3009 or the issuer controls.
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock Settlement", "mUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
