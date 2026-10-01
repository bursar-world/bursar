// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessRegistry} from "../../src/shielded/IAccessRegistry.sol";

/// Stands in for the Robinhood Chain access registry: a block list anyone can edit.
contract MockAccessRegistry is IAccessRegistry {
    mapping(address => bool) public blocked;

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function isBlocked(address account) external view returns (bool) {
        return blocked[account];
    }
}
