// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Governance} from "./lib/Governance.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {Vesting} from "../src/token/Vesting.sol";

/// The parts of the replaced Entrypoint this step calls, which the vendored Privacy Pools code
/// defines with a compiler this script cannot import alongside the rest.
interface IRetiringEntrypoint {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function grantRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address account) external;
    function windDownPool(address pool) external;
}

interface IRetiringShieldedPool {
    function dead() external view returns (bool);
    function ASSET() external view returns (address);
}

/// Hands what the first governance still holds to the new one, so one timelock answers for the
/// whole deployment:
///
/// - the vesting contract, which the first timelock offers and the new one accepts;
/// - the community allocation of BRSR, which the first timelock holds and transfers.
///
/// Both are proposals on the first timelock, and the acceptance is a proposal on the new one that
/// waits until the offer has executed. Every signer sits on both, so the steps in `Governance.sol`
/// run the whole batch: propose, approve, and execute twice, once for the first timelock's calls
/// and once, after the new delay, for the acceptance.
///
/// `retireShielded()` is the deploy key's part. It still holds the owner role on the replaced
/// shielded Entrypoint: once the old pool holds nothing, it winds that pool down, so it takes no
/// new deposits, and hands the role to the new timelock.
contract MigrateGovernance is Governance {
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");

    function _calls() internal view override returns (Call[] memory calls) {
        address timelock = _upstream(K.ADMIN_TIMELOCK);
        address first = _firstTimelock();
        address vesting = _upstream(K.VESTING);
        address brsr = _upstream(K.BRSR);
        uint256 community = IERC20(brsr).balanceOf(first);

        calls = new Call[](3);
        calls[0] = Call(first, vesting, abi.encodeCall(Vesting.transferAdmin, (timelock)), "Vesting.transferAdmin");
        calls[1] = Call(
            first,
            brsr,
            abi.encodeCall(IERC20.transfer, (timelock, community)),
            "BRSR.transfer, the community allocation"
        );
        calls[2] = Call(timelock, vesting, abi.encodeCall(Vesting.acceptAdmin, ()), "Vesting.acceptAdmin");
    }

    function _applied(Call memory call) internal view override returns (bool) {
        bytes4 selector = bytes4(call.data);
        address timelock = _recordAddress(K.ADMIN_TIMELOCK);
        if (selector == Vesting.transferAdmin.selector) {
            Vesting v = Vesting(call.target);
            return v.admin() == timelock || v.pendingAdmin() == timelock;
        }
        if (selector == Vesting.acceptAdmin.selector) return Vesting(call.target).admin() == timelock;
        if (selector == IERC20.transfer.selector) return IERC20(call.target).balanceOf(call.timelock) == 0;
        return false;
    }

    /// The acceptance only succeeds once the offer has landed.
    function _ready(Call memory call) internal view override returns (bool) {
        if (bytes4(call.data) != Vesting.acceptAdmin.selector) return true;
        return Vesting(call.target).pendingAdmin() == call.timelock;
    }

    function retireShielded() external {
        _loadPrefix();
        _requireChain();
        address timelock = _upstream(K.ADMIN_TIMELOCK);
        IRetiringEntrypoint entrypoint = IRetiringEntrypoint(_old(".privacy.shielded.Entrypoint"));
        IRetiringShieldedPool pool = IRetiringShieldedPool(_old(".privacy.shielded.ShieldedPool"));

        // Winding down leaves every note withdrawable and stops new deposits for good. It waits for
        // the notes to be out anyway, so nobody is left in a pool whose operator has gone.
        uint256 held = IERC20(pool.ASSET()).balanceOf(address(pool));
        require(held == 0, "the replaced shielded pool still holds notes; return them to their owners first");

        bool owner = entrypoint.hasRole(OWNER_ROLE, msg.sender);
        if (!owner) {
            require(entrypoint.hasRole(OWNER_ROLE, timelock), "this key does not hold the owner role to hand over");
            console2.log("the new timelock already holds the owner role");
            return;
        }

        vm.startBroadcast(msg.sender);
        if (!pool.dead()) entrypoint.windDownPool(address(pool));
        entrypoint.grantRole(OWNER_ROLE, timelock);
        entrypoint.renounceRole(OWNER_ROLE, msg.sender);
        vm.stopBroadcast();

        require(pool.dead(), "the replaced pool still takes deposits");
        require(entrypoint.hasRole(OWNER_ROLE, timelock), "the new timelock does not hold the owner role");
        require(!entrypoint.hasRole(OWNER_ROLE, msg.sender), "this key still holds the owner role");
        console2.log("replaced pool wound down and its Entrypoint handed to", timelock);
    }

    /// The governance the vesting contract answers to before the handover, from the first record.
    function _firstTimelock() private view returns (address at) {
        at = _oldAddress("BURSAR_V1_RECORD", ".contracts.AdminTimelock");
    }

    function _old(string memory key) private view returns (address) {
        return _oldAddress("BURSAR_V2_RECORD", key);
    }

    function _oldAddress(string memory recordEnv, string memory key) private view returns (address at) {
        string memory path = _envString(recordEnv);
        at = vm.parseJsonAddress(vm.readFile(path), key);
        if (at.code.length == 0) revert NotContract(key, at);
    }
}
