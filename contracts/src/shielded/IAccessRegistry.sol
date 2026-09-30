// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

/// The Robinhood Chain access registry (`0xe10b6f6B275de231345c20D14Ab812db62151b00` on 4663).
interface IAccessRegistry {
    function isBlocked(address account) external view returns (bool);
}
