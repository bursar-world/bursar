// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMandateAccount} from "./IMandateAccount.sol";

/// Deploys mandate accounts at addresses a principal can compute before funding them.
///
/// The settlement asset and the escrow are properties of the deployment, not of an
/// individual account, so they are read from the factory instead of being passed per call.
/// That also means an account cannot be created against a token nobody has audited.
interface IMandateAccountFactory {
    error ZeroAddress();
    error AlreadyDeployed();
    error NotPrincipal();
    error CreateFailed();

    event Created(address indexed account, address indexed principal, address indexed agent, bytes32 salt);

    /// Limits are set in the constructor, never after deployment. There is no block in which a
    /// funded account is spendable without a bound.
    function create(address principal, address agent, bytes32 salt, IMandateAccount.Limits calldata limits)
        external
        returns (address account);

    /// `limits` is part of the init code, so predicting an address requires the exact limit
    /// set the account will be created with.
    function predict(address principal, address agent, bytes32 salt, IMandateAccount.Limits calldata limits)
        external
        view
        returns (address account);

    function accountsOf(address principal) external view returns (address[] memory);
    function accountCount(address principal) external view returns (uint256);

    function escrow() external view returns (address);
    function blueprint() external view returns (address);
    function settlementAsset() external view returns (address);
}
