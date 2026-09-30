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
    /// that follow can skip it rather than read garbage.
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
}
