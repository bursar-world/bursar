// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {CommittedMandateAccount} from "./CommittedMandateAccount.sol";

/// Deploys committed mandates. The escrow, the settlement asset, the verifier and the per-mandate
/// ceiling belong to the deployment, so an account cannot be pointed at a verifier that accepts
/// anything or given a ceiling its principal chose.
contract CommittedMandateFactory {
    error ZeroAddress();
    error ZeroCeiling();
    error NotPrincipal();
    error AlreadyDeployed();

    event Created(address indexed account, address indexed principal, address indexed agent, bytes32 salt);

    // forge-lint: disable-start(screaming-snake-case-immutable)
    address public immutable escrow;
    address public immutable settlementAsset;
    address public immutable verifier;
    /// What each account may lock over its whole life, whatever its terms say. It bounds the loss
    /// to a forged proof while the proving key rests on a single-contributor setup.
    uint256 public immutable ceiling;
    // forge-lint: disable-end

    mapping(address => address[]) private _accounts;

    constructor(address escrow_, address settlementAsset_, address verifier_, uint256 ceiling_) {
        if (escrow_ == address(0) || settlementAsset_ == address(0) || verifier_ == address(0)) revert ZeroAddress();
        if (ceiling_ == 0) revert ZeroCeiling();
        escrow = escrow_;
        settlementAsset = settlementAsset_;
        verifier = verifier_;
        ceiling = ceiling_;
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
        // The callee is the account created on the line above, from code this factory fixes:
        // `sealInitial` writes its own version, emits, and calls nothing.
        // slither-disable-next-line reentrancy-benign,reentrancy-events
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
        // The creation code is a constant, so no two argument sets can pack to the same bytes.
        // forge-lint: disable-start(encode-packed-collision)
        // Creation code, not a literal with digits to miscount.
        // slither-disable-next-line too-many-digits
        return abi.encodePacked(
            type(CommittedMandateAccount).creationCode,
            abi.encode(principal, agent, settlementAsset, escrow, verifier, termsCommitment, counter, ceiling)
        );
        // forge-lint: disable-end(encode-packed-collision)
    }
}
