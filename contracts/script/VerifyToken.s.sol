// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {BRSR} from "../src/token/BRSR.sol";
import {Vesting} from "../src/token/Vesting.sol";

/// Asks the chain about the token the record names: the fixed supply, and the vesting contract
/// that pays the team's share out of it.
///
/// On Robinhood Chain both carry over from the first deployment. A vesting contract that does not
/// answer to the record's timelock yet is reported as owed, with the step that hands it over; with
/// `BURSAR_VERIFY_STRICT=1`, which the migration ends on, it fails the run.
abstract contract TokenChecks is Verifier {
    uint256 private constant SUPPLY = 1_000_000_000e18;

    function _checkToken() internal {
        address token = _contract(K.BRSR);
        address vesting = _contract(K.VESTING);
        if (token == address(0) || vesting == address(0)) return;

        BRSR brsr = BRSR(token);
        _isUint("BRSR.decimals", 18, brsr.decimals());
        _isUint("BRSR.totalSupply", SUPPLY, brsr.totalSupply());
        _isUint("BRSR.TOTAL_SUPPLY", SUPPLY, brsr.TOTAL_SUPPLY());

        Vesting v = Vesting(vesting);
        _is("Vesting.token", token, address(v.token()));
        _is("Vesting.treasury", _recordAddress(K.TREASURY), v.treasury());
        _isTrue("Vesting.grantsWritten", v.grantsWritten());

        address timelock = _recordAddress(K.ADMIN_TIMELOCK);
        address admin = v.admin();
        _fact("Vesting.admin", admin);
        if (admin == timelock) {
            _pendingAdmin("Vesting.pendingAdmin", v.pendingAdmin());
        } else if (v.pendingAdmin() == timelock) {
            _owe("Vesting.admin: the timelock has to accept the handover (Vesting.acceptAdmin, by proposal)");
        } else {
            _owe(string.concat("Vesting.admin is ", vm.toString(admin), ": its handover to the timelock is owed"));
        }
    }
}

/// `forge script script/VerifyToken.s.sol --rpc-url "$RHC_RPC_URL"`.
contract VerifyToken is TokenChecks {
    function run() external {
        _begin();
        _checkToken();
        _end("token");
    }
}
