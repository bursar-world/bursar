// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputation} from "../../src/interfaces/IReputation.sol";

/// Records the escrow's outcome callbacks without the cap curve, so an escrow test can assert
/// that a lifecycle transition reported exactly once and to the right edge.
///
/// The callbacks, the pairing setter and the cap are all that is implemented. The escrow reads
/// the cap as a control and reverts the lock when it cannot, so this mock has to answer it; the
/// score behind it is the thing under test elsewhere and is not reimplemented here.
contract MockReputation {
    error AlreadySet();
    error NotEscrow();

    address public escrow;

    /// Open by default, so a test that cares about the lifecycle never has to think about the
    /// cap. `setCap` is how a test makes the cap the subject.
    uint128 public cap = type(uint128).max;

    mapping(address payee => IReputation.Counters) public payeeStats;
    mapping(address payer => mapping(address payee => IReputation.Counters)) public edges;

    function setEscrow(address escrow_) external {
        if (escrow != address(0)) revert AlreadySet();
        escrow = escrow_;
    }

    function onReleased(address payer, address payee) external {
        _authorize();
        ++payeeStats[payee].released;
        ++edges[payer][payee].released;
    }

    function onTimedOut(address payer, address payee) external {
        _authorize();
        ++payeeStats[payee].timedOut;
        ++edges[payer][payee].timedOut;
    }

    function onDisputed(address payer, address payee) external {
        _authorize();
        ++payeeStats[payee].disputed;
        ++edges[payer][payee].disputed;
    }

    function setCap(uint128 cap_) external {
        cap = cap_;
    }

    function capOf(address) external view returns (uint128) {
        return cap;
    }

    function _authorize() private view {
        if (msg.sender != escrow) revert NotEscrow();
    }
}
