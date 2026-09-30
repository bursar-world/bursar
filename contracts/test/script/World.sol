// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deploy} from "../../script/Deploy.s.sol";
import {DeployCollateral} from "../../script/DeployCollateral.s.sol";
import {DeployPrivacy} from "../../script/DeployPrivacy.s.sol";
import {DeployRwa} from "../../script/DeployRwa.s.sol";
import {DeployStaking} from "../../script/DeployStaking.s.sol";
import {DeployToken} from "../../script/DeployToken.s.sol";
import {ProposeWiring} from "../../script/ProposeWiring.s.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {LocalFixtures} from "../../script/local/LocalFixtures.s.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {ScriptHarness} from "./ScriptHarness.sol";

interface IPinnable {
    function pinEnvPrefix(string calldata prefix) external;
}

/// Code with nothing to call: what a record names when it names the wrong kind of contract.
contract Silent {}

/// A deployment built the way a rehearsal builds one: the local fixtures, then the real deploy
/// scripts in order, on chain 4663, with the real parameter files. A suite builds as far as the
/// script it tests needs, saves the chain and the record, and restores both before each case.
abstract contract World is ScriptHarness {
    address internal constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant FIXTURES = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
    uint64 internal constant SHIELDED_NONCE = 10_000;
    /// Monday 2026-09-28, 10:53 UTC: inside the 24/5 equities session.
    uint256 internal constant T0 = 1_790_592_800;

    string internal path;
    uint256 private _snapshot;
    string private _saved;

    function _world(string memory name) internal {
        vm.chainId(4663);
        vm.warp(T0);
        _source("script/env/rhc-mainnet-v3.env");
        _source("script/env/local.env");
        _set("BURSAR_VESTING_START", vm.toString(block.timestamp));
        path = string.concat(RECORDS, "/", name, ".json");
        _set("BURSAR_RECORD", path);
        _run(FIXTURES, address(new LocalFixtures()));
    }

    function _core() internal {
        _run(DEPLOYER, address(new Deploy()));
    }

    function _token() internal {
        _run(DEPLOYER, address(new DeployToken()));
    }

    function _staking() internal {
        _run(DEPLOYER, address(new DeployStaking()));
    }

    function _rwa() internal {
        _run(DEPLOYER, address(new DeployRwa()));
    }

    function _collateral() internal {
        _run(DEPLOYER, address(new DeployCollateral()));
    }

    function _privacy() internal {
        _run(DEPLOYER, address(new DeployPrivacy()));
    }

    /// Proposed by the first signer, approved by the second, executed by the first once the
    /// timelock's delay has passed.
    function _wiring() internal {
        ProposeWiring wiring = new ProposeWiring();
        wiring.pinEnvPrefix(_prefix());
        address[] memory signers = vm.parseJsonAddressArray(vm.readFile(path), K.SIGNERS);
        _as(signers[0], address(wiring), abi.encodeCall(wiring.propose, ()));
        _as(signers[1], address(wiring), abi.encodeCall(wiring.approve, ()));
        vm.warp(block.timestamp + AdminTimelock(_readAddress(path, K.ADMIN_TIMELOCK)).timelockPeriod());
        _as(signers[0], address(wiring), abi.encodeCall(wiring.execute, ()));
    }

    function _run(address key, address script) internal returns (bytes memory) {
        IPinnable(script).pinEnvPrefix(_prefix());
        return _as(key, script, abi.encodeWithSignature("run()"));
    }

    function _pinned(address script) internal returns (address) {
        IPinnable(script).pinEnvPrefix(_prefix());
        return script;
    }

    function _check(address verifier) internal {
        IPinnable(verifier).pinEnvPrefix(_prefix());
        (bool ok, bytes memory reason) = verifier.call(abi.encodeWithSignature("run()"));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    /// The chain and the record as they stand, to come back to before each case. The record is a
    /// file, which a state snapshot does not reach.
    function _save() internal {
        // Read before the snapshot, so the copy is part of the state a restore returns to.
        _saved = vm.readFile(path);
        _snapshot = vm.snapshotState();
    }

    function _restore() internal {
        vm.revertToState(_snapshot);
        _snapshot = vm.snapshotState();
        vm.writeFile(path, _saved);
    }

    function _deployShieldedScript() internal returns (address) {
        string memory json = vm.readFile(path);
        return _deployShieldedScript(
            vm.parseJsonAddress(json, K.EXTERNAL_POSEIDON_T3), vm.parseJsonAddress(json, K.EXTERNAL_POSEIDON_T4)
        );
    }

    function _deployShieldedScript(address poseidonT3, address poseidonT4) internal returns (address script) {
        string memory code =
            vm.parseJsonString(vm.readFile("out/DeployShielded.s.sol/DeployShielded.json"), ".bytecode.object");
        code = _link(code, "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3", poseidonT3);
        code = _link(code, "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4", poseidonT4);
        bytes memory creation = vm.parseBytes(code);
        assembly ("memory-safe") {
            script := create(0, add(creation, 0x20), mload(creation))
        }
        require(script != address(0), "the shielded script did not deploy");
        IPinnable(script).pinEnvPrefix(_prefix());
    }

    /// The shielded script builds with the compiler the vendored code pins, so no suite here can
    /// import it. It is deployed from its artifact, linked against the libraries the record names,
    /// the way `--libraries` links it for a real run. Solidity marks an unlinked library as `__$`
    /// and the first 34 hex digits of the keccak of its fully qualified name, then `$__`.
    function _link(string memory code, string memory library_, address at) internal pure returns (string memory) {
        string memory hash = vm.toString(keccak256(bytes(library_)));
        bytes memory digits = new bytes(34);
        for (uint256 i; i < 34; ++i) {
            digits[i] = bytes(hash)[i + 2];
        }
        string memory placeholder = string.concat("__$", string(digits), "$__");
        string memory addr = vm.replace(vm.toLowercase(vm.toString(at)), "0x", "");
        return vm.replace(code, placeholder, addr);
    }
}
