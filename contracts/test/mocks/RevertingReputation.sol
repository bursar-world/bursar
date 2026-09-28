// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Fails every outcome callback. A settlement must still complete against it: reputation is a
/// side effect of the money path, never a condition on it.
///
/// The cap is the exception and answers normally, because the escrow reads it as a control and
/// fails the lock closed when it cannot. A test that wants that refusal writes a payee cap of
/// zero on the real contract instead of reaching for this one.
contract RevertingReputation {
    error Rejected();

    function onReleased(address, address) external pure {
        revert Rejected();
    }

    function onTimedOut(address, address) external pure {
        revert Rejected();
    }

    function onDisputed(address, address) external pure {
        revert Rejected();
    }

    function capOf(address) external pure returns (uint128) {
        return type(uint128).max;
    }
}
