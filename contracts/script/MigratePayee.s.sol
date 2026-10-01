// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";

/// Registers a payee on the new agent registry, under the name it already carries, with the
/// registry's minimum stake from its own wallet, and asks the previous registry for its old stake
/// back. Without a registration on the new registry no mandate on the new set can pay it.
///
///   forge script script/MigratePayee.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payee" [--broadcast]
///   forge script script/MigratePayee.s.sol --sig "reclaim()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payee" [--broadcast]
///
/// Leaving the previous registry takes two steps a week apart: the payee stops taking new work
/// there, asks for its stake, and `reclaim` collects it once the registry's withdrawal delay has
/// passed. Work already paid there settles as before.
///
/// A payee whose wallet holds less than the new stake still leaves the previous registry, and the
/// run says how much it is short. Run it again once the wallet holds the stake, from a top-up or
/// from the old stake `reclaim` returns, and it registers.
///
/// With no previous record in the shell the run registers alone, under `BURSAR_PAYEE_NAME`, which
/// is how a first deployment seats its payee.
contract MigratePayee is Migration {
    function run() external {
        _begin();
        AgentRegistry registry = AgentRegistry(_upstream(K.AGENT_REGISTRY));
        IERC20 usdg = IERC20(_settlementAsset());
        AgentRegistry previous = AgentRegistry(_previousOptional(K.AGENT_REGISTRY));

        uint128 stake = registry.minStake();
        bool registered = registry.isRegistered(msg.sender);
        uint256 held = usdg.balanceOf(msg.sender);
        bool registers = !registered && held >= stake;
        string memory name = _name(previous);
        if (registers) {
            console2.log("registering as", name);
            console2.log("  stake, micro-USD", stake);
        } else if (!registered) {
            console2.log("not registering yet: the wallet is short of the minimum stake by, micro-USD", stake - held);
        }

        vm.startBroadcast(msg.sender);
        if (registers) {
            usdg.approve(address(registry), stake);
            registry.register(name, stake);
        }
        _leave(previous);
        vm.stopBroadcast();

        if (registered || registers) {
            require(registry.isActive(msg.sender), "the payee is not active on the new registry");
        }
    }

    /// Collects the old stake once the previous registry's withdrawal delay has passed.
    function reclaim() external {
        _begin();
        IERC20 usdg = IERC20(_settlementAsset());
        uint256 before = usdg.balanceOf(msg.sender);
        vm.startBroadcast(msg.sender);
        _collect(AgentRegistry(_previous(K.AGENT_REGISTRY)));
        vm.stopBroadcast();
        console2.log("stake returned, micro-USD", usdg.balanceOf(msg.sender) - before);
    }

    /// The name the payee is known by on the previous registry, or `BURSAR_PAYEE_NAME`. The new
    /// registry takes 3 to 32 characters from A-Z, a-z, 0-9 and the underscore, and a name outside
    /// that stops the run here, before `register`.
    function _name(AgentRegistry previous) private view returns (string memory name) {
        string memory variable = _key("BURSAR_PAYEE_NAME");
        name = _envRaw(variable);
        if (bytes(name).length != 0) {
            if (!_registrable(name)) revert InvalidEnv(variable, name);
            return name;
        }
        if (address(previous) == address(0) || !previous.isRegistered(msg.sender)) revert MissingEnv(variable);
        name = previous.getAgent(msg.sender).name;
        require(
            _registrable(name),
            "the name on the previous registry does not fit the new one's rule: set BURSAR_PAYEE_NAME"
        );
    }

    function _registrable(string memory name) private pure returns (bool) {
        bytes memory raw = bytes(name);
        if (raw.length < 3 || raw.length > 32) return false;
        for (uint256 i; i < raw.length; ++i) {
            bytes1 c = raw[i];
            if ((c < "0" || c > "9") && (c < "A" || c > "Z") && (c < "a" || c > "z") && c != "_") return false;
        }
        return true;
    }

    /// Stops taking new work on the previous registry and asks for the whole stake back.
    function _leave(AgentRegistry previous) private {
        if (address(previous) == address(0) || !previous.isRegistered(msg.sender)) return;
        AgentRegistry.Agent memory agent = previous.getAgent(msg.sender);
        (uint128 pending,) = previous.withdrawals(msg.sender);
        if (agent.stake == 0 || pending != 0) return;
        // A stake cannot drop under the minimum while the payee takes work, so it stops first.
        if (agent.active) previous.deactivate();
        previous.requestWithdrawal(agent.stake);
        console2.log("asked for the old stake back from", address(previous));
    }

    function _collect(AgentRegistry previous) private {
        if (!previous.isRegistered(msg.sender)) return;
        (uint128 pending,) = previous.withdrawals(msg.sender);
        if (pending == 0) return;
        uint256 maturesAt = previous.withdrawalMaturity(msg.sender);
        if (block.timestamp < maturesAt) {
            console2.log(
                string.concat(
                    "not matured yet at ",
                    vm.toString(address(previous)),
                    ": matures ",
                    _utc(maturesAt),
                    ", in ",
                    _until(maturesAt)
                )
            );
            return;
        }
        previous.executeWithdrawal();
        console2.log("took the old stake back from", address(previous));
    }
}
