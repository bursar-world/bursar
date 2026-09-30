// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {BursarScript} from "./BursarScript.sol";

/// What the migration scripts share: the new deployment's record at `BURSAR_RECORD`, and the
/// records being retired, each named by its own variable so no script reads one it did not mean to.
///
/// | | |
/// |---|---|
/// | `BURSAR_V2_RECORD` | the contract set being replaced, `deployments/rhc-mainnet-v2.json` |
/// | `BURSAR_TOKEN_RECORD` | the token set whose staking pool, buyback and seeder are replaced, `deployments/rhc-mainnet-token.json` |
/// | `BURSAR_V1_RECORD` | the first contract set, `deployments/rhc-mainnet.json` |
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

    /// An address from a retiring record, which has to hold code: the migration only ever moves
    /// money out of contracts that are there.
    function _old(string memory recordEnv, string memory key) internal view returns (address at) {
        string memory path = vm.envOr(_key(recordEnv), string(""));
        if (bytes(path).length == 0) revert MissingEnv(_key(recordEnv));
        string memory json = vm.readFile(path);
        if (!vm.keyExistsJson(json, key)) revert NotRecorded(string.concat(path, " ", key));
        at = vm.parseJsonAddress(json, key);
        if (at.code.length == 0) revert NotContract(key, at);
    }

    /// The same, for an entry that may be missing: an example mandate some records never had.
    function _oldOptional(string memory recordEnv, string memory key) internal view returns (address) {
        string memory path = vm.envOr(_key(recordEnv), string(""));
        if (bytes(path).length == 0) return address(0);
        string memory json = vm.readFile(path);
        return vm.keyExistsJson(json, key) ? vm.parseJsonAddress(json, key) : address(0);
    }

    function _requireKey(string memory role, address expected) internal view {
        if (msg.sender != expected) revert NotTheKey(role, expected, msg.sender);
    }

    function _note(string memory what) internal pure {
        console2.log(what);
    }
}
