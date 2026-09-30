// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {BursarScript} from "./BursarScript.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";

/// A batch of governance calls, put to the signers the way the timelock takes them: one signer
/// proposes, a second approves, and once the delay has passed any signer executes.
///
/// Each step is its own run, from the signer's own key, and each one can be repeated. A call whose
/// effect is already on chain is skipped, and so is one with a live proposal carrying the same
/// target and calldata, so running `propose` twice proposes nothing twice. Proposals are read from
/// the timelock itself, so a batch proposed by hand is picked up too.
///
///   forge script <script> --sig "status()"  --rpc-url "$RHC_RPC_URL"
///   forge script <script> --sig "propose()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1" [--broadcast]
///   forge script <script> --sig "approve()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-2" [--broadcast]
///   forge script <script> --sig "execute()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1" [--broadcast]
abstract contract Governance is BursarScript {
    struct Call {
        address timelock;
        address target;
        bytes data;
        string label;
    }

    error NotSigner(address timelock, address caller);

    /// The batch, in the order it has to execute in.
    function _calls() internal virtual returns (Call[] memory);

    /// Whether the call's effect is already on chain.
    function _applied(Call memory call) internal view virtual returns (bool);

    /// Whether the call would succeed if executed now. A call that depends on an earlier one in
    /// the batch waits for it, and the rest of the run goes on.
    function _ready(Call memory) internal view virtual returns (bool) {
        return true;
    }

    function status() external {
        _loadPrefix();
        _requireChain();
        Call[] memory calls = _calls();
        for (uint256 i; i < calls.length; ++i) {
            Call memory call = calls[i];
            if (_applied(call)) {
                console2.log(string.concat("done      ", call.label));
                continue;
            }
            (bool found, uint256 id) = _find(call);
            if (!found) {
                console2.log(string.concat("to propose ", call.label));
                continue;
            }
            AdminTimelock timelock = AdminTimelock(call.timelock);
            uint256 executeAfter = timelock.getProposal(id).executeAfter;
            console2.log(
                string.concat(
                    "proposed  ",
                    call.label,
                    ": #",
                    vm.toString(id),
                    " on ",
                    vm.toString(call.timelock),
                    ", ",
                    vm.toString(timelock.approvals(id)),
                    " of ",
                    vm.toString(timelock.REQUIRED_APPROVALS()),
                    " approvals, executable from ",
                    _utc(executeAfter),
                    " (",
                    _until(executeAfter),
                    ")"
                )
            );
        }
    }

    function propose() external {
        _loadPrefix();
        _requireChain();
        Call[] memory calls = _calls();
        _requireSigner(calls);
        vm.startBroadcast(msg.sender);
        for (uint256 i; i < calls.length; ++i) {
            Call memory call = calls[i];
            if (_applied(call)) continue;
            (bool found,) = _find(call);
            if (found) continue;
            uint256 id = AdminTimelock(call.timelock).propose(call.target, call.data);
            console2.log(string.concat("proposed #", vm.toString(id), " ", call.label));
        }
        vm.stopBroadcast();
    }

    function approve() external {
        _loadPrefix();
        _requireChain();
        Call[] memory calls = _calls();
        _requireSigner(calls);
        vm.startBroadcast(msg.sender);
        for (uint256 i; i < calls.length; ++i) {
            Call memory call = calls[i];
            if (_applied(call)) continue;
            (bool found, uint256 id) = _find(call);
            if (!found) {
                console2.log(string.concat("not proposed yet: ", call.label));
                continue;
            }
            AdminTimelock timelock = AdminTimelock(call.timelock);
            if (timelock.hasApproved(id, msg.sender)) continue;
            timelock.approve(id);
            console2.log(string.concat("approved #", vm.toString(id), " ", call.label));
        }
        vm.stopBroadcast();
    }

    function execute() external {
        _loadPrefix();
        _requireChain();
        Call[] memory calls = _calls();
        _requireSigner(calls);
        vm.startBroadcast(msg.sender);
        for (uint256 i; i < calls.length; ++i) {
            Call memory call = calls[i];
            if (_applied(call)) continue;
            (bool found, uint256 id) = _find(call);
            if (!found) {
                console2.log(string.concat("not proposed yet: ", call.label));
                continue;
            }
            (bool due, bytes4 reason) = AdminTimelock(call.timelock).canExecute(id);
            if (!due) {
                console2.log(
                    string.concat(
                        "not executable yet: #",
                        vm.toString(id),
                        " ",
                        call.label,
                        ". ",
                        _whyNot(AdminTimelock(call.timelock), id, reason)
                    )
                );
                continue;
            }
            if (!_ready(call)) {
                console2.log(string.concat("waiting on an earlier call: #", vm.toString(id), " ", call.label));
                continue;
            }
            AdminTimelock(call.timelock).execute(id);
            console2.log(string.concat("executed #", vm.toString(id), " ", call.label));
        }
        vm.stopBroadcast();
    }

    /// What `canExecute` answered, in words. The timelock answers with the selector of the error
    /// `execute` would raise; the one an operator meets is the delay, and that comes with its date.
    function _whyNot(AdminTimelock timelock, uint256 id, bytes4 reason) internal view returns (string memory) {
        if (reason == AdminTimelock.TimelockNotExpired.selector) {
            uint256 executeAfter = timelock.getProposal(id).executeAfter;
            return string.concat(
                "The delay ends ", _utc(executeAfter), ", in ", _until(executeAfter), ": run execute() again then."
            );
        }
        if (reason == AdminTimelock.InsufficientApprovals.selector) {
            return string.concat(
                vm.toString(timelock.approvals(id)),
                " of ",
                vm.toString(timelock.REQUIRED_APPROVALS()),
                " approvals: a second signer runs approve() first."
            );
        }
        if (reason == AdminTimelock.ProposalExpired.selector) return "Its grace period has passed: propose it again.";
        if (reason == AdminTimelock.AlreadyExecuted.selector) return "It has already executed.";
        if (reason == AdminTimelock.AlreadyCancelled.selector) return "It was cancelled: propose it again.";
        if (reason == AdminTimelock.ProposalNotFound.selector) return "The timelock has no such proposal.";
        return string.concat("canExecute answered ", vm.toString(abi.encodePacked(reason)), ".");
    }

    /// The newest proposal on the call's timelock carrying the same target and calldata that can
    /// still execute: neither executed nor cancelled, and inside its grace period.
    function _find(Call memory call) internal view returns (bool found, uint256 id) {
        AdminTimelock timelock = AdminTimelock(call.timelock);
        bytes32 data = keccak256(call.data);
        uint256 grace = timelock.GRACE_PERIOD();
        for (uint256 i = timelock.proposalCount(); i > 0; --i) {
            AdminTimelock.Proposal memory p = timelock.getProposal(i - 1);
            if (p.target != call.target || keccak256(p.data) != data) continue;
            if (p.executed || p.cancelled || block.timestamp > uint256(p.executeAfter) + grace) continue;
            return (true, i - 1);
        }
    }

    /// The key has to sign for every timelock with work left in the batch. Checked before the
    /// broadcast opens, so a wrong key stops the run with nothing queued.
    function _requireSigner(Call[] memory calls) private view {
        for (uint256 i; i < calls.length; ++i) {
            if (_applied(calls[i])) continue;
            address timelock = calls[i].timelock;
            if (!AdminTimelock(timelock).isSigner(msg.sender)) revert NotSigner(timelock, msg.sender);
        }
    }
}
