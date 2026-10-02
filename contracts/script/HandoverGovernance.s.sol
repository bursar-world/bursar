// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Handover, IAdministered, IEntrypointRoles} from "./lib/Handover.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {Escrow} from "../src/Escrow.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";

/// Moves the set from the one-hour timelock to a 48-hour one whose signers are hardware keys. Four
/// parts, in this order; `GOVERNANCE-48H.md` is the runbook.
///
/// `deploy()`, from the deploy key, puts up the new `AdminTimelock` with the three signers in
/// `BURSAR_SIGNERS_48H`, the guardian in `BURSAR_GUARDIAN_48H` or the record's, and a 48-hour delay,
/// and records it under `governance48`. Nothing else in the record changes yet: the set is still the
/// old timelock's until the last step.
///
/// `propose()`, `approve()` and `execute()` put the old timelock's side to its signers as one batch,
/// the way `ProposeWiring.s.sol` does: every administered contract names the new timelock as its
/// pending admin, the seeder offers it ownership, the Entrypoint grants it the owner role beside
/// the old one, and the community allocation of BRSR moves to it. A call already applied is skipped.
///
/// `handover()` prints the new timelock's side: each call it has to make, with its target, selector
/// and calldata, and the `cast send` lines that propose, approve and execute it from a hardware
/// wallet. `AcceptGovernance.s.sol` is the same batch as a script, for a rehearsal that can sign
/// through impersonation.
///
/// `finish()`, from the deploy key, checks that every contract answers to the new timelock, that
/// the Entrypoint's owner role is the new timelock's alone and that the old timelock holds no BRSR,
/// then rewrites the record: `contracts.AdminTimelock`, the signers and the guardian are the new
/// governance's, the escrow's pauser is recorded as the old timelock, and `dev` is false. It sends
/// nothing and takes `--broadcast`, because a simulation writes no file.
///
///   forge script script/HandoverGovernance.s.sol --sig "deploy()"   --keystore "$KEYS/rh-deployer" ...
///   forge script script/HandoverGovernance.s.sol --sig "propose()"  --keystore "$KEYS/signer-1" ...
///   forge script script/HandoverGovernance.s.sol --sig "approve()"  --keystore "$KEYS/signer-2" ...
///   forge script script/HandoverGovernance.s.sol --sig "execute()"  --keystore "$KEYS/signer-1" ...
///   forge script script/HandoverGovernance.s.sol --sig "handover()" --rpc-url "$RHC_RPC_URL"
///   forge script script/HandoverGovernance.s.sol --sig "finish()"   --keystore "$KEYS/rh-deployer" ... --broadcast
contract HandoverGovernance is Handover {
    /// Forty-eight hours: long enough for anyone watching a mandate to act on a pending change.
    uint64 internal constant PERIOD = 48 hours;

    /// What `BURSAR_ALLOW_EOA_GOVERNANCE` has to say for a signer set with no contract in it.
    string internal constant EOA_GOVERNANCE_ACK = "i-accept-eoa-governance";

    error SignerCountMismatch(uint256 given);
    error DuplicateSigner(address signer);
    error RoleCollision(string role, string otherRole, address account);
    error GovernanceHasNoMultisig();
    error EoaGovernanceNotAcknowledged(string given, string required);
    error NotHandedOver(string what, address expected, address actual);
    error StillHeld(string what, uint256 amount);

    function deploy() external {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();
        _requireUnrecorded(K.GOVERNANCE48_TIMELOCK);
        address previous = _timelock();

        address[] memory signers = _envAddressList("BURSAR_SIGNERS_48H");
        if (signers.length != 3) revert SignerCountMismatch(signers.length);
        address guardian = _envAddressOr("BURSAR_GUARDIAN_48H", address(0));
        if (guardian == address(0)) guardian = _recordAddress(K.GUARDIAN);
        if (guardian == address(0)) revert MissingEnv(_key("BURSAR_GUARDIAN_48H"));

        // Duplicates would turn two-of-three into two-of-two. The brake has to stay warm, so it
        // must not also carry an approval, and the deploy key signs from a shell.
        bool multisig;
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < i; ++j) {
                if (signers[j] == signers[i]) revert DuplicateSigner(signers[i]);
            }
            if (signers[i] == guardian) revert RoleCollision("guardian", "timelockSigner", guardian);
            if (signers[i] == deployer) revert RoleCollision("deployer", "timelockSigner", deployer);
            if (signers[i].code.length != 0) multisig = true;
        }
        if (!multisig) _requireEoaGovernanceAccepted();

        vm.startBroadcast(deployer);
        AdminTimelock timelock = new AdminTimelock([signers[0], signers[1], signers[2]], guardian, PERIOD);
        vm.stopBroadcast();

        _expectUint("timelock.timelockPeriod", PERIOD, timelock.timelockPeriod());
        _expect("timelock.guardian", guardian, timelock.guardian());
        address[3] memory live = timelock.getSigners();
        for (uint256 i; i < 3; ++i) {
            _expect("timelock.signer", signers[i], live[i]);
        }

        _write(K.GOVERNANCE48_TIMELOCK, address(timelock));
        _write(K.GOVERNANCE48_SIGNERS, signers);
        _write(K.GOVERNANCE48_GUARDIAN, guardian);
        _write(K.GOVERNANCE48_PERIOD, PERIOD);
        _write(K.GOVERNANCE48_PREVIOUS, previous);
        _write(K.GOVERNANCE48_FROM_BLOCK, _chainBlock());

        console2.log("AdminTimelock, 48 hours", address(timelock));
        console2.log("  guardian", guardian);
        console2.log("  replaces", previous);
        console2.log("Next: propose() from signer-1 and approve() from signer-2 on the old timelock");
    }

    /// Hardware keys are plain keys too. The refusal stands unless the shell says the phrase.
    function _requireEoaGovernanceAccepted() private view {
        string memory given = _envRaw(_key("BURSAR_ALLOW_EOA_GOVERNANCE"));
        if (bytes(given).length == 0) revert GovernanceHasNoMultisig();
        if (keccak256(bytes(given)) != keccak256(bytes(EOA_GOVERNANCE_ACK))) {
            revert EoaGovernanceNotAcknowledged(given, EOA_GOVERNANCE_ACK);
        }
    }

    /// The old timelock's batch.
    function _calls() internal view override returns (Call[] memory calls) {
        address previous = _previous();
        address next = _next();
        (address[] memory targets, string[] memory names) = _administered();
        address brsr = _upstream(K.BRSR);

        calls = new Call[](targets.length + 3);
        for (uint256 i; i < targets.length; ++i) {
            calls[i] = Call(
                previous,
                targets[i],
                abi.encodeCall(IAdministered.transferAdmin, (next)),
                string.concat(names[i], ".transferAdmin")
            );
        }
        uint256 n = targets.length;
        calls[n] = Call(
            previous,
            _upstream(K.SEEDER),
            abi.encodeCall(V4LiquiditySeeder.transferOwnership, (next)),
            "V4LiquiditySeeder.transferOwnership"
        );
        calls[n + 1] = Call(
            previous,
            _upstream(K.ENTRYPOINT),
            abi.encodeCall(IEntrypointRoles.grantRole, (OWNER_ROLE, next)),
            "Entrypoint.grantRole OWNER_ROLE"
        );
        calls[n + 2] = Call(
            previous,
            brsr,
            abi.encodeCall(IERC20.transfer, (next, _communityAllocation(previous, next, brsr))),
            "BRSR.transfer, the community allocation"
        );
    }

    /// The whole BRSR balance the old timelock holds when the transfer is first proposed. Once a
    /// transfer to the new timelock is on the old one's books, proposed or executed, that is the
    /// figure, so the batch reads the same across runs and a token sent to the old timelock
    /// afterwards does not put a second transfer up.
    function _communityAllocation(address previous, address next, address brsr) private view returns (uint256) {
        AdminTimelock timelock = AdminTimelock(previous);
        bytes memory head = abi.encodeWithSelector(IERC20.transfer.selector, next);
        for (uint256 i = timelock.proposalCount(); i > 0; --i) {
            AdminTimelock.Proposal memory p = timelock.getProposal(i - 1);
            if (p.target != brsr || p.cancelled || p.data.length != 68) continue;
            bool same = true;
            for (uint256 j; j < head.length && same; ++j) {
                same = p.data[j] == head[j];
            }
            if (!same) continue;
            (, uint256 amount) = abi.decode(_args(p.data), (address, uint256));
            return amount;
        }
        return IERC20(brsr).balanceOf(previous);
    }

    function _applied(Call memory call) internal view override returns (bool) {
        address next = _recordAddress(K.GOVERNANCE48_TIMELOCK);
        bytes4 selector = bytes4(call.data);
        if (selector == IAdministered.transferAdmin.selector) {
            IAdministered target = IAdministered(call.target);
            return target.pendingAdmin() == next || target.admin() == next;
        }
        if (selector == V4LiquiditySeeder.transferOwnership.selector) {
            V4LiquiditySeeder seeder = V4LiquiditySeeder(call.target);
            return seeder.pendingOwner() == next || seeder.owner() == next;
        }
        if (selector == IEntrypointRoles.grantRole.selector) {
            return IEntrypointRoles(call.target).hasRole(OWNER_ROLE, next);
        }
        if (selector == IERC20.transfer.selector) {
            (, uint256 amount) = abi.decode(_args(call.data), (address, uint256));
            return IERC20(call.target).balanceOf(next) >= amount;
        }
        return false;
    }

    /// The new timelock's side, as the hardware keys sign it: one proposal per call, in this order,
    /// each proposed by one signer, approved by a second, and executed by any once the 48 hours
    /// have passed. The ids follow from the order: a call not yet proposed gets the next one.
    function handover() external {
        _loadPrefix();
        _requireChain();
        address previous = _previous();
        address next = _next();
        AdminTimelock timelock = AdminTimelock(next);
        Call[] memory calls = _acceptance(previous);
        uint256 nextId = timelock.proposalCount();

        console2.log("The new timelock's side, signed by its hardware keys. Each line is one transaction.");
        console2.log("timelock", next);
        console2.log(
            "A key held at another derivation path adds --mnemonic-derivation-path to each line; --trezor in place of --ledger for a Trezor."
        );
        for (uint256 i; i < calls.length; ++i) {
            Call memory call = calls[i];
            console2.log("");
            console2.log(string.concat("#", vm.toString(i + 1), " ", call.label));
            console2.log("  target   ", call.target);
            console2.log(string.concat("  selector  ", vm.toString(abi.encodePacked(bytes4(call.data)))));
            console2.log(string.concat("  calldata  ", vm.toString(call.data)));
            if (_accepted(call, next)) {
                console2.log("  done: already applied on chain");
                continue;
            }
            (bool found, uint256 id) = _find(call);
            if (found) {
                console2.log(string.concat("  proposed as #", vm.toString(id), "; approve and execute it:"));
            } else {
                id = nextId++;
                console2.log(string.concat("  will be #", vm.toString(id), " once proposed in this order:"));
                console2.log(
                    string.concat(
                        "  cast send ",
                        vm.toString(next),
                        ' "propose(address,bytes)" ',
                        vm.toString(call.target),
                        " ",
                        vm.toString(call.data),
                        ' --rpc-url "$RHC_RPC_URL" --ledger'
                    )
                );
            }
            console2.log(
                string.concat(
                    "  cast send ",
                    vm.toString(next),
                    ' "approve(uint256)" ',
                    vm.toString(id),
                    ' --rpc-url "$RHC_RPC_URL" --ledger'
                )
            );
            console2.log(
                string.concat(
                    "  cast send ",
                    vm.toString(next),
                    ' "execute(uint256)" ',
                    vm.toString(id),
                    ' --rpc-url "$RHC_RPC_URL" --ledger'
                )
            );
        }
        console2.log("");
        console2.log("Execute the revoke last: it needs every acceptance above to have landed.");
        console2.log(
            "The console's governance page proposes catalogue actions on the timelock the live record names, which is the old one until finish() runs, and it has no action for the seeder, the Entrypoint or the RWA contracts. Use the lines above."
        );
    }

    function finish() external {
        _loadPrefix();
        _requireChain();
        _deployer();
        address previous = _previous();
        address next = _next();

        (address[] memory targets, string[] memory names) = _administered();
        for (uint256 i; i < targets.length; ++i) {
            IAdministered target = IAdministered(targets[i]);
            _requireHandedOver(string.concat(names[i], ".admin"), next, target.admin());
            _requireHandedOver(string.concat(names[i], ".pendingAdmin"), address(0), target.pendingAdmin());
        }
        V4LiquiditySeeder seeder = V4LiquiditySeeder(_upstream(K.SEEDER));
        _requireHandedOver("V4LiquiditySeeder.owner", next, seeder.owner());
        _requireHandedOver("V4LiquiditySeeder.pendingOwner", address(0), seeder.pendingOwner());

        IEntrypointRoles entrypoint = IEntrypointRoles(_upstream(K.ENTRYPOINT));
        if (!entrypoint.hasRole(OWNER_ROLE, next)) revert NotHandedOver("Entrypoint.OWNER_ROLE", next, address(0));
        if (entrypoint.hasRole(OWNER_ROLE, previous)) {
            revert NotHandedOver("Entrypoint.OWNER_ROLE, still held by", address(0), previous);
        }

        // The old timelock's signers can still move anything sent to it later, by proposal.
        uint256 held = IERC20(_upstream(K.BRSR)).balanceOf(previous);
        if (held != 0) {
            if (!_envFlag("BURSAR_FORCE")) revert StillHeld("BRSR on the previous timelock", held);
            console2.log("BURSAR_FORCE=1: the previous timelock still holds BRSR, wei", held);
        }

        // The escrow's pauser was named once, by the deploy key, and stays the first governance.
        address pauser = Escrow(_upstream(K.ESCROW)).pauser();
        _expect("escrow.pauser", previous, pauser);

        AdminTimelock timelock = AdminTimelock(next);
        address[3] memory live = timelock.getSigners();
        address[] memory signers = new address[](3);
        for (uint256 i; i < 3; ++i) {
            signers[i] = live[i];
        }
        _write(K.ADMIN_TIMELOCK, next);
        _write(K.ESCROW_PAUSER, pauser);
        _write(K.SIGNERS, signers);
        _write(K.GUARDIAN, timelock.guardian());
        _write(".parameters.AdminTimelock.timelockPeriod", timelock.timelockPeriod());
        _write(".dev", false);
        _writeString(
            ".note",
            string.concat(
                "Fourth contract set on Robinhood Chain mainnet, administered since ",
                _utc(block.timestamp),
                " by a 48-hour AdminTimelock whose three signers are hardware keys. The timelock, BRSR, Vesting, ",
                "the staking pool, the buyback and the seeder carried over from rhc-mainnet-v3, and the Poseidon ",
                "libraries with them; every other contract was rebuilt after the external audit. The one-hour ",
                "timelock at contracts.escrowPauser keeps the escrow's brake, pause and unpause, and nothing else."
            )
        );
        console2.log("governance handed over to", next);
        console2.log("  escrow pauser stays", pauser);
        console2.log("Next: BURSAR_VERIFY_STRICT=1 Verify.s.sol, then publish the record");
    }

    function _requireHandedOver(string memory what, address expected, address actual) private pure {
        if (expected != actual) revert NotHandedOver(what, expected, actual);
    }
}
