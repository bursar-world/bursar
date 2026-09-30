// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {BursarScript} from "./BursarScript.sol";

/// What the verify scripts share. They send nothing: each one reads the record, asks the chain
/// the same questions its deploy script asked its own simulation, and says what disagrees.
///
/// Three outcomes per question. A match passes. A value governance or the migration still has to
/// set, found unset, is owed: listed, and fatal only under `BURSAR_VERIFY_STRICT=1`, which is how
/// the last check after the migration is run. Anything else is a mismatch, and any mismatch fails
/// the run after every question has been asked, so one run names every problem.
abstract contract Verifier is BursarScript {
    error VerificationFailed(uint256 mismatches, uint256 owed);

    uint256 internal mismatches;
    uint256 internal owed;

    function _begin() internal {
        _loadPrefix();
        _requireChain();
        mismatches = 0;
        owed = 0;
    }

    function _end(string memory what) internal view {
        console2.log(string.concat(what, ": ", vm.toString(mismatches), " mismatched, ", vm.toString(owed), " owed"));
        bool strict = _envFlag("BURSAR_VERIFY_STRICT");
        if (mismatches != 0 || (strict && owed != 0)) revert VerificationFailed(mismatches, owed);
    }

    /// A contract the record names, which has to hold code. Zero when it does not, so the checks
    /// that follow skip it.
    function _contract(string memory key) internal returns (address at) {
        at = _recordAddress(key);
        if (at == address(0)) {
            _mismatch(string.concat(key, " is not recorded"));
            return address(0);
        }
        if (at.code.length == 0) {
            _mismatch(string.concat(key, " holds no code at ", vm.toString(at)));
            return address(0);
        }
    }

    function _is(string memory what, address expected, address actual) internal {
        if (expected == actual) return;
        _mismatch(string.concat(what, ": expected ", vm.toString(expected), ", found ", vm.toString(actual)));
    }

    function _isUint(string memory what, uint256 expected, uint256 actual) internal {
        if (expected == actual) return;
        _mismatch(string.concat(what, ": expected ", vm.toString(expected), ", found ", vm.toString(actual)));
    }

    function _isTrue(string memory what, bool holds) internal {
        if (!holds) _mismatch(what);
    }

    /// A value governance sets. Unset is owed; the intended value passes; anything else is a
    /// mismatch, because a proposal that named the wrong address is worse than none.
    function _governed(string memory what, address intended, address actual) internal {
        if (actual == intended) return;
        if (actual == address(0)) {
            _owe(string.concat(what, " is unset: governance names ", vm.toString(intended)));
            return;
        }
        _is(what, intended, actual);
    }

    function _governedUint(string memory what, uint256 intended, uint256 actual) internal {
        if (actual == intended) return;
        if (actual == 0) {
            _owe(string.concat(what, " is unset: governance sets ", vm.toString(intended)));
            return;
        }
        _isUint(what, intended, actual);
    }

    function _owe(string memory what) internal {
        ++owed;
        console2.log(string.concat("owed      ", what));
    }

    function _mismatch(string memory what) internal {
        ++mismatches;
        console2.log(string.concat("MISMATCH  ", what));
    }

    /// A figure the deploy script recorded as applied.
    function _param(string memory key) internal view returns (uint256) {
        return _recordUint(string.concat(".parameters.", key));
    }

    /// A read asked so that a contract unable to answer it is a finding and the run goes on.
    /// A record that names the wrong contract meets a bare revert on the first read that contract
    /// lacks. Here the read is named with the address, counted as a mismatch, and every other
    /// question is still asked.
    function _ask(string memory what, address target, bytes memory call, uint256 words)
        internal
        returns (bool ok, bytes memory answer)
    {
        (ok, answer) = target.staticcall(call);
        if (ok && answer.length >= words * 32) return (true, answer);
        _mismatch(string.concat(what, ": ", vm.toString(target), " does not answer"));
        return (false, "");
    }

    function _askUint(string memory what, address target, bytes memory call) internal returns (bool, uint256) {
        (bool ok, bytes memory answer) = _ask(what, target, call, 1);
        return ok ? (true, abi.decode(answer, (uint256))) : (false, 0);
    }

    function _askAddress(string memory what, address target, bytes memory call) internal returns (bool, address) {
        (bool ok, uint256 word) = _askUint(what, target, call);
        if (!ok) return (false, address(0));
        return _asAddress(what, target, word);
    }

    function _asAddress(string memory what, address target, uint256 word) internal returns (bool, address) {
        // forge-lint: disable-next-line(unsafe-typecast)
        if (word <= type(uint160).max) return (true, address(uint160(word)));
        _mismatch(string.concat(what, ": ", vm.toString(target), " answers with something other than an address"));
        return (false, address(0));
    }

    function _isAt(string memory what, address expected, address target, bytes memory call) internal {
        (bool ok, address actual) = _askAddress(what, target, call);
        if (ok) _is(what, expected, actual);
    }

    function _isUintAt(string memory what, uint256 expected, address target, bytes memory call) internal {
        (bool ok, uint256 actual) = _askUint(what, target, call);
        if (ok) _isUint(what, expected, actual);
    }

    /// The figure recorded as applied under `.parameters.<what>`, held to what the chain answers.
    /// A record that carries no such figure is a mismatch of its own.
    function _isParam(string memory what, uint256 actual) internal {
        string memory key = string.concat(".parameters.", what);
        if (!_recorded(key)) {
            _mismatch(string.concat(what, ": the record carries no ", key));
            return;
        }
        _isUint(what, _recordUint(key), actual);
    }

    function _isParamAt(string memory what, address target, bytes memory call) internal {
        (bool ok, uint256 actual) = _askUint(what, target, call);
        if (ok) _isParam(what, actual);
    }
}
