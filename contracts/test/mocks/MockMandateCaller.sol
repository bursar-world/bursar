// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IEscrow} from "../../src/interfaces/IEscrow.sol";

/// A contract payer for escrow tests. Stands in for a mandate account without carrying any of
/// its limits, which isolates the escrow's own access control from mandate enforcement.
contract MockMandateCaller {
    error NotOwner();

    // forge-lint: disable-next-item(screaming-snake-case-immutable)
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function approve(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function lock(
        IEscrow escrow,
        address payee,
        bytes32 capabilityId,
        bytes32 inputCommit,
        string calldata inputURI,
        uint128 amount,
        uint64 deadline
    ) external returns (uint256 id) {
        return escrow.lock(payee, capabilityId, inputCommit, inputURI, amount, deadline);
    }

    /// Owner-gated so a test can prove the escrow honours the payer, whoever sends the transaction.
    function dispute(IEscrow escrow, uint256 id) external {
        if (msg.sender != owner) revert NotOwner();
        escrow.dispute(id);
    }
}
