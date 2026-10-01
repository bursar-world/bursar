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

    /// Holds the account's creation code as its own runtime, behind a leading STOP so it can
    /// never be called. The account's creation code is close to the size limit on its own, so
    /// carrying it inside this contract's runtime would push the factory past it.
    address public immutable blueprint;

    mapping(address => address[]) private _accounts;

    constructor(address escrow_, address settlementAsset_) {
        if (escrow_ == address(0) || settlementAsset_ == address(0)) revert ZeroAddress();

        escrow = escrow_;
        settlementAsset = settlementAsset_;
        // Creation code, not a literal with digits to miscount.
        // slither-disable-next-line too-many-digits
        blueprint = _writeBlueprint(type(MandateAccount).creationCode);
    }

    function create(address principal, address agent, bytes32 salt, IMandateAccount.Limits calldata limits)
        external
        override
        returns (address account)
    {
        if (principal == address(0)) revert ZeroAddress();
        // Otherwise anyone can create accounts in a principal's name and fill `accountsOf`
        // with limits the principal never chose.
        if (msg.sender != principal) revert NotPrincipal();

        // Without this the collision reverts inside CREATE2 with nothing to tell the caller
        // that the address they predicted is already live.
        address predicted = Create2.computeAddress(salt, keccak256(_initCode(principal, agent, limits)));
        if (predicted.code.length != 0) revert AlreadyDeployed();

        bytes memory initCode = _initCode(principal, agent, limits);
        assembly ("memory-safe") {
            account := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (account == address(0)) revert CreateFailed();
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
        // The creation code is the same blob on every call, so the seam between the two halves
        // never moves and no two argument sets pack to the same bytes.
        // forge-lint: disable-next-line(encode-packed-collision)
        return abi.encodePacked(_creationCode(), abi.encode(principal, agent, settlementAsset, escrow, limits));
    }

    function _creationCode() private view returns (bytes memory code) {
        address source = blueprint;
        uint256 size = source.code.length - 1;
        code = new bytes(size);
        assembly ("memory-safe") {
            extcodecopy(source, add(code, 0x20), 1, size)
        }
    }

    /// PUSH4 len, DUP1, PUSH1 14, PUSH1 0, CODECOPY, PUSH1 0, RETURN: fourteen bytes that return
    /// everything after them as the new contract's code.
    function _writeBlueprint(bytes memory creationCode) private returns (address source) {
        bytes memory runtime = abi.encodePacked(hex"00", creationCode);
        bytes memory deploy = abi.encodePacked(hex"63", uint32(runtime.length), hex"80600e6000396000f3", runtime);
        assembly ("memory-safe") {
            source := create(0, add(deploy, 0x20), mload(deploy))
        }
        if (source == address(0)) revert CreateFailed();
    }
}
