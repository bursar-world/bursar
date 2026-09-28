// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {IMandateAccount} from "./interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "./interfaces/IMandateAccountFactory.sol";
import {MandateAccount} from "./MandateAccount.sol";

contract MandateAccountFactory is IMandateAccountFactory {
    // Names are fixed by IMandateAccountFactory's getters.
    // forge-lint: disable-start(screaming-snake-case-immutable)
    address public immutable override escrow;
    address public immutable override settlementAsset;
    // forge-lint: disable-end

    mapping(address => address[]) private _accounts;

    constructor(address escrow_, address settlementAsset_) {
        if (escrow_ == address(0) || settlementAsset_ == address(0)) revert ZeroAddress();

        escrow = escrow_;
        settlementAsset = settlementAsset_;
    }

    function create(address principal, address agent, bytes32 salt, IMandateAccount.Limits calldata limits)
        external
        override
        returns (address account)
    {
        if (principal == address(0)) revert ZeroAddress();

        // Without this the collision reverts inside CREATE2 with nothing to tell the caller
        // that the address they predicted is already live.
        address predicted = Create2.computeAddress(salt, keccak256(_initCode(principal, agent, limits)));
        if (predicted.code.length != 0) revert AlreadyDeployed();

        account = address(new MandateAccount{salt: salt}(principal, agent, settlementAsset, escrow, limits));
        _accounts[principal].push(account);

        emit Created(account, principal, agent, salt);
    }

    function predict(address principal, address agent, bytes32 salt, IMandateAccount.Limits calldata limits)
        external
        view
        override
        returns (address account)
    {
        return Create2.computeAddress(salt, keccak256(_initCode(principal, agent, limits)));
    }

    function accountsOf(address principal) external view override returns (address[] memory) {
        return _accounts[principal];
    }

    function accountCount(address principal) external view override returns (uint256) {
        return _accounts[principal].length;
    }

    /// The limit set is a constructor argument, so two principals asking for the same salt
    /// and different limits land on different addresses and cannot collide.
    function _initCode(address principal, address agent, IMandateAccount.Limits calldata limits)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(MandateAccount).creationCode, abi.encode(principal, agent, settlementAsset, escrow, limits)
        );
    }
}
