// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {CommittedMandateAccount} from "./CommittedMandateAccount.sol";

/// Deploys committed mandates. The escrow, the settlement asset and the verifier belong to the
/// deployment, so an account cannot be pointed at a verifier that accepts anything.
contract CommittedMandateFactory {
    error ZeroAddress();
    error NotPrincipal();
    error AlreadyDeployed();

    event Created(address indexed account, address indexed principal, address indexed agent, bytes32 salt);

    // forge-lint: disable-start(screaming-snake-case-immutable)
    address public immutable escrow;
    address public immutable settlementAsset;
    address public immutable verifier;
    // forge-lint: disable-end

    mapping(address => address[]) private _accounts;

    constructor(address escrow_, address settlementAsset_, address verifier_) {
        if (escrow_ == address(0) || settlementAsset_ == address(0) || verifier_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        settlementAsset = settlementAsset_;
        verifier = verifier_;
    }

    /// `ciphertext` is the terms sealed to the principal's viewing key. It is emitted by the new
    /// account in the same transaction and is not part of the address.
    function create(
        address principal,
        address agent,
        bytes32 salt,
        uint256 termsCommitment,
        uint256 counter,
        bytes calldata ciphertext
    ) external returns (address account) {
        if (principal == address(0)) revert ZeroAddress();
        if (msg.sender != principal) revert NotPrincipal();

        bytes memory initCode = _initCode(principal, agent, termsCommitment, counter);
        if (Create2.computeAddress(salt, keccak256(initCode)).code.length != 0) revert AlreadyDeployed();

        account = Create2.deploy(0, salt, initCode);
        CommittedMandateAccount(account).sealInitial(ciphertext);
        _accounts[principal].push(account);

        emit Created(account, principal, agent, salt);
    }

    function predict(address principal, address agent, bytes32 salt, uint256 termsCommitment, uint256 counter)
        external
        view
        returns (address)
    {
        return Create2.computeAddress(salt, keccak256(_initCode(principal, agent, termsCommitment, counter)));
    }

    function accountsOf(address principal) external view returns (address[] memory) {
        return _accounts[principal];
    }

    function _initCode(address principal, address agent, uint256 termsCommitment, uint256 counter)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(CommittedMandateAccount).creationCode,
            abi.encode(principal, agent, settlementAsset, escrow, verifier, termsCommitment, counter)
        );
    }
}
