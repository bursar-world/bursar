// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";

/// The parts of a replaced agent registry this step reads and calls. Same signatures in every
/// build that went live, read from the sources they were built from.
interface IRetiringAgentRegistry {
    struct Agent {
        string name;
        uint128 stake;
        uint64 registeredAt;
        bool active;
    }

    function isRegistered(address agent) external view returns (bool);
    function getAgent(address agent) external view returns (Agent memory);
    function withdrawals(address agent) external view returns (uint128 amount, uint64 requestedAt);
    function withdrawalMaturity(address agent) external view returns (uint64);
    function deactivate() external;
    function requestWithdrawal(uint128 amount) external;
    function executeWithdrawal() external;
}

/// Registers a payee on the new agent registry, under the name it already carries, with the
/// registry's minimum stake from its own wallet, and asks the old registries for its old stake
/// back. Without a registration on the new registry no mandate on the new set can pay it.
///
///   forge script script/MigratePayee.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payee" [--broadcast]
///   forge script script/MigratePayee.s.sol --sig "reclaim()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payee" [--broadcast]
///
/// Leaving an old registry takes two steps a week apart: the payee stops taking new work there,
/// asks for its stake, and `reclaim` collects it once the registry's withdrawal delay has passed.
/// Work already paid there settles as before.
///
/// A payee whose wallet holds less than the new stake still leaves the old registries, and the
/// run says how much it is short. Run it again once the wallet holds the stake, from a top-up or
/// from the old stakes `reclaim` returns, and it registers.
contract MigratePayee is Migration {
    function run() external {
        _begin();
        AgentRegistry registry = AgentRegistry(_upstream(K.AGENT_REGISTRY));
        IERC20 usdg = IERC20(_settlementAsset());
        IRetiringAgentRegistry v2 = IRetiringAgentRegistry(_oldOptional("BURSAR_V2_RECORD", ".contracts.AgentRegistry"));
        IRetiringAgentRegistry v1 = IRetiringAgentRegistry(_oldOptional("BURSAR_V1_RECORD", ".contracts.AgentRegistry"));

        uint128 stake = registry.minStake();
        bool registered = registry.isRegistered(msg.sender);
        uint256 held = usdg.balanceOf(msg.sender);
        bool registers = !registered && held >= stake;
        string memory name = _name(v2, v1);
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
        _leave(v2);
        _leave(v1);
        vm.stopBroadcast();

        if (registered || registers) {
            require(registry.isActive(msg.sender), "the payee is not active on the new registry");
        }
    }

    /// Collects the old stakes once each registry's withdrawal delay has passed.
    function reclaim() external {
        _begin();
        IERC20 usdg = IERC20(_settlementAsset());
        uint256 before = usdg.balanceOf(msg.sender);
        vm.startBroadcast(msg.sender);
        _collect(IRetiringAgentRegistry(_oldOptional("BURSAR_V2_RECORD", ".contracts.AgentRegistry")));
        _collect(IRetiringAgentRegistry(_oldOptional("BURSAR_V1_RECORD", ".contracts.AgentRegistry")));
        vm.stopBroadcast();
        console2.log("stake returned, micro-USD", usdg.balanceOf(msg.sender) - before);
    }

    /// The name the payee is known by on the registry it registered with last.
    function _name(IRetiringAgentRegistry v2, IRetiringAgentRegistry v1) private view returns (string memory) {
        string memory named = vm.envOr(_key("BURSAR_PAYEE_NAME"), string(""));
        if (bytes(named).length != 0) return named;
        if (address(v2) != address(0) && v2.isRegistered(msg.sender)) return v2.getAgent(msg.sender).name;
        if (address(v1) != address(0) && v1.isRegistered(msg.sender)) return v1.getAgent(msg.sender).name;
        revert MissingEnv(_key("BURSAR_PAYEE_NAME"));
    }

    /// Stops taking new work on an old registry and asks for the whole stake back.
    function _leave(IRetiringAgentRegistry old) private {
        if (address(old) == address(0) || !old.isRegistered(msg.sender)) return;
        IRetiringAgentRegistry.Agent memory agent = old.getAgent(msg.sender);
        (uint128 pending,) = old.withdrawals(msg.sender);
        if (agent.stake == 0 || pending != 0) return;
        // A stake cannot drop under the minimum while the payee takes work, so it stops first.
        if (agent.active) old.deactivate();
        old.requestWithdrawal(agent.stake);
        console2.log("asked for the old stake back from", address(old));
    }

    function _collect(IRetiringAgentRegistry old) private {
        if (address(old) == address(0) || !old.isRegistered(msg.sender)) return;
        (uint128 pending,) = old.withdrawals(msg.sender);
        if (pending == 0) return;
        if (block.timestamp < old.withdrawalMaturity(msg.sender)) {
            console2.log("not matured yet at", address(old));
            return;
        }
        old.executeWithdrawal();
        console2.log("took the old stake back from", address(old));
    }
}
