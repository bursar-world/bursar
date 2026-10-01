// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Accepts every proof, for suites that drive the shielded pool with public signals they write
/// themselves. What such a suite checks is the pool's accounting and its gates, never the circuits.
contract MockVerifier {
    function verifyProof(uint256[2] memory, uint256[2][2] memory, uint256[2] memory, uint256[8] memory)
        external
        pure
        returns (bool)
    {
        return true;
    }

    function verifyProof(uint256[2] memory, uint256[2][2] memory, uint256[2] memory, uint256[4] memory)
        external
        pure
        returns (bool)
    {
        return true;
    }
}
