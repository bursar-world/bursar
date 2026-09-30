// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEscrow} from "../interfaces/IEscrow.sol";

interface IPrincipalOf {
    function principal() external view returns (address);
}

/// Scoped disclosure for disputes. A party to a disputed lock grants one resolver one slice of the
/// job: the input, the output and the terms leaves the dispute turns on, sealed to that resolver's
/// published key. The registry stores nothing and holds no funds; the grant is the event, and only
/// the named resolver can open its ciphertext.
///
/// It reads locks in the v1 layout, which every escrow deployed so far still uses, and it lets
/// the principal of a mandate account grant directly, without routing through the account.
contract DisclosureRegistry {
    error NotParty();
    error NotDisputed();
    error ZeroAddress();

    event DisclosureGranted(
        address indexed escrow,
        uint256 indexed lockId,
        address indexed resolver,
        address grantor,
        bytes32 sliceCommit,
        bytes ciphertext
    );

    uint256 private constant PRINCIPAL_GAS = 30_000;

    function grant(address escrow, uint256 lockId, address resolver, bytes32 sliceCommit, bytes calldata ciphertext)
        external
    {
        if (resolver == address(0) || escrow == address(0)) revert ZeroAddress();
        IEscrow.Lock memory entry = IEscrow(escrow).getLock(lockId);
        if (entry.status != IEscrow.LockStatus.Disputed) revert NotDisputed();
        if (!_isParty(msg.sender, entry)) revert NotParty();

        emit DisclosureGranted(escrow, lockId, resolver, msg.sender, sliceCommit, ciphertext);
    }

    function _isParty(address who, IEscrow.Lock memory entry) private view returns (bool) {
        if (who == entry.payer || who == entry.payee) return true;
        return _principalOf(entry.payer) == who || _principalOf(entry.payee) == who;
    }

    function _principalOf(address account) private view returns (address) {
        if (account.code.length == 0) return address(0);
        (bool ok, bytes memory data) =
            account.staticcall{gas: PRINCIPAL_GAS}(abi.encodeCall(IPrincipalOf.principal, ()));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }
}
