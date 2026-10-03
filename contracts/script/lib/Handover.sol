// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governance} from "./Governance.sol";
import {RecordKeys as K} from "./RecordKeys.sol";

import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";

/// The two-step handover every administered contract in the set offers: the admin names its
/// successor, and the successor accepts. Eleven contracts answer these four reads and calls with
/// one signature each.
interface IAdministered {
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function transferAdmin(address to) external;
    function acceptAdmin() external;
}

/// The roles on the shielded Entrypoint, which the vendored Privacy Pools code defines with a
/// compiler this file cannot import alongside the rest.
interface IEntrypointRoles {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
}

/// What both sides of the governance handover share: which contracts the timelock administers,
/// which timelock is handing over and which is taking over, and the two batches, one per timelock.
///
/// The record names the new timelock under `governance48` once `HandoverGovernance.s.sol deploy()`
/// has run, and the one it replaces under `governance48.previous`. Until the last step rewrites
/// `contracts.AdminTimelock`, that is still the previous one; afterwards the two agree, and the
/// previous timelock keeps only the escrow's brake.
abstract contract Handover is Governance {
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// The contracts the timelock administers through `transferAdmin`, in the order the batches
    /// name them. The escrow and the mandate factory have no admin, and the escrow's pauser is a
    /// one-shot that stays with the first governance.
    function _administered() internal view returns (address[] memory targets, string[] memory names) {
        string[12] memory keys = [
            K.REPUTATION,
            K.ORACLE_REGISTRY,
            K.AGENT_REGISTRY,
            K.STAKING,
            K.BUYBACK,
            K.ASSET_REGISTRY,
            K.PRICE_GUARD,
            K.TREASURY_PARK,
            K.CREDIT_POOL,
            K.COLLATERAL_VAULT,
            K.SOLVENCY_LOG,
            K.VESTING
        ];
        string[12] memory labels = [
            "Reputation",
            "OracleRegistry",
            "AgentRegistry",
            "Staking",
            "Buyback",
            "AssetRegistry",
            "PriceGuard",
            "TreasuryPark",
            "CreditPool",
            "CollateralVault",
            "SolvencyLog",
            "Vesting"
        ];
        targets = new address[](keys.length);
        names = new string[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            targets[i] = _upstream(keys[i]);
            names[i] = labels[i];
        }
    }

    /// The timelock taking over, which `deploy()` records.
    function _next() internal view returns (address) {
        return _upstream(K.GOVERNANCE48_TIMELOCK);
    }

    /// The timelock handing over. Recorded by `deploy()`, so the batches read the same address
    /// before and after the last step moves `contracts.AdminTimelock`.
    function _previous() internal view returns (address previous) {
        previous = _recordAddress(K.GOVERNANCE48_PREVIOUS);
        if (previous == address(0)) previous = _upstream(K.ADMIN_TIMELOCK);
        _requireCode(K.GOVERNANCE48_PREVIOUS, previous);
    }

    /// The new timelock's batch: it accepts each contract, takes the seeder, and only then takes
    /// the first governance's owner role on the Entrypoint away.
    function _acceptance(address previous) internal view returns (Call[] memory calls) {
        address next = _next();
        (address[] memory targets, string[] memory names) = _administered();
        calls = new Call[](targets.length + 2);
        for (uint256 i; i < targets.length; ++i) {
            calls[i] = Call(
                next, targets[i], abi.encodeCall(IAdministered.acceptAdmin, ()), string.concat(names[i], ".acceptAdmin")
            );
        }
        calls[targets.length] = Call(
            next,
            _upstream(K.SEEDER),
            abi.encodeCall(V4LiquiditySeeder.acceptOwnership, ()),
            "V4LiquiditySeeder.acceptOwnership"
        );
        calls[targets.length + 1] = Call(
            next,
            _upstream(K.ENTRYPOINT),
            abi.encodeCall(IEntrypointRoles.revokeRole, (OWNER_ROLE, previous)),
            "Entrypoint.revokeRole OWNER_ROLE, the previous timelock"
        );
    }

    /// Whether a call of the new timelock's batch has taken effect.
    function _accepted(Call memory call, address next) internal view returns (bool) {
        bytes4 selector = bytes4(call.data);
        if (selector == IAdministered.acceptAdmin.selector) return IAdministered(call.target).admin() == next;
        if (selector == V4LiquiditySeeder.acceptOwnership.selector) {
            return V4LiquiditySeeder(call.target).owner() == next;
        }
        if (selector == IEntrypointRoles.revokeRole.selector) {
            (, address previous) = abi.decode(_args(call.data), (bytes32, address));
            return !IEntrypointRoles(call.target).hasRole(OWNER_ROLE, previous);
        }
        return false;
    }

    function _args(bytes memory data) internal pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
    }
}
