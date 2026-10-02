// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Handover, IAdministered, IEntrypointRoles} from "./lib/Handover.sol";

import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";

/// The new timelock's side of the governance handover, as a script: `acceptAdmin()` on each of the
/// eleven administered contracts, `acceptOwnership()` on the seeder, and then the old timelock's
/// owner role on the Entrypoint revoked. The same batch `HandoverGovernance.s.sol handover()` prints
/// as `cast send` lines for hardware keys.
///
/// On Robinhood Chain the new timelock's signers are hardware keys, which `forge script` does not
/// drive, so this script is for the fork rehearsal, where anvil signs as them. Each step can be run
/// again; a call already applied is skipped, and the revoke waits for every acceptance.
///
///   forge script script/AcceptGovernance.s.sol --sig "status()"  --rpc-url "$RHC_RPC_URL"
///   forge script script/AcceptGovernance.s.sol --sig "propose()" --rpc-url "$RPC" --unlocked --sender "$HW_1" --broadcast
///   forge script script/AcceptGovernance.s.sol --sig "approve()" --rpc-url "$RPC" --unlocked --sender "$HW_2" --broadcast
///   forge script script/AcceptGovernance.s.sol --sig "execute()" --rpc-url "$RPC" --unlocked --sender "$HW_1" --broadcast
contract AcceptGovernance is Handover {
    function _calls() internal view override returns (Call[] memory) {
        return _acceptance(_previous());
    }

    function _applied(Call memory call) internal view override returns (bool) {
        return _accepted(call, _next());
    }

    /// An acceptance can only follow the offer, and the revoke only the acceptances: the new
    /// timelock has to hold the owner role itself to take it from the old one, and taking it
    /// earlier would leave the old timelock administering what it has not yet handed over.
    function _ready(Call memory call) internal view override returns (bool) {
        address next = _next();
        bytes4 selector = bytes4(call.data);
        if (selector == IAdministered.acceptAdmin.selector) return IAdministered(call.target).pendingAdmin() == next;
        if (selector == V4LiquiditySeeder.acceptOwnership.selector) {
            return V4LiquiditySeeder(call.target).pendingOwner() == next;
        }
        if (!IEntrypointRoles(call.target).hasRole(OWNER_ROLE, next)) return false;
        Call[] memory calls = _acceptance(_previous());
        for (uint256 i; i + 1 < calls.length; ++i) {
            if (!_accepted(calls[i], next)) return false;
        }
        return true;
    }
}
