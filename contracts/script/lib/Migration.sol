// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {BursarScript} from "./BursarScript.sol";

/// What the migration scripts share: the new deployment's record at `BURSAR_RECORD`, and the one
/// it replaces at `BURSAR_PREVIOUS_RECORD`, which has to be the record the new one names in
/// `supersedes`. The previous record has the shape every record since the third set has, so one
/// set of keys reads both.
///
/// Every script prints what it is about to do and sends nothing without `--broadcast`. Every step
/// can be run again: one whose effect is already on chain says so and sends nothing. The commands
/// in each script's comment sign with `--keystore "$KEYS/<name>"`, the encrypted keystores
/// `MIGRATION.md` sets up, and it gives the order they run in.
abstract contract Migration is BursarScript {
    error NotTheKey(string role, address expected, address caller);
    error NothingToMove(string what);

    function _begin() internal {
        _loadPrefix();
        _requireChain();
    }

    /// A contract of the previous record, which has to hold code: the migration only ever moves
    /// money out of contracts that are there.
    function _previous(string memory key) internal view returns (address at) {
        string memory json = _previousJson();
        if (!vm.keyExistsJson(json, key)) revert NotRecorded(string.concat(_previousPath(), " ", key));
        at = vm.parseJsonAddress(json, key);
        if (at.code.length == 0) revert NotContract(key, at);
    }

    /// The same, for an entry the previous record may lack, or for a run with no previous record
    /// at all, which is a first deployment registering its own payee and resolvers.
    function _previousOptional(string memory key) internal view returns (address) {
        return _previousAddress(key);
    }

    /// What write-offs seized of `asset` in the previous vault and the lender has not claimed. A
    /// vault built before write-offs seized anything answers no such read, and seized nothing.
    function _seized(address vault, address asset) internal view returns (uint256) {
        (bool ok, bytes memory answer) = vault.staticcall(abi.encodeWithSignature("seized(address)", asset));
        return ok && answer.length == 32 ? abi.decode(answer, (uint256)) : 0;
    }

    /// Whether the record carries a contract over from the previous one at the same address. A
    /// move that replaces one lane leaves the rest of the set where it was, and the migration
    /// neither drains nor retires what both records name.
    function _carried(string memory key) internal view returns (bool) {
        address at = _recordAddress(key);
        return at != address(0) && at == _previousOptional(key);
    }

    function _requireKey(string memory role, address expected) internal view {
        if (msg.sender != expected) revert NotTheKey(role, expected, msg.sender);
    }

    function _note(string memory what) internal pure {
        console2.log(what);
    }
}
