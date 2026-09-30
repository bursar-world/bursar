// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deploy} from "../../script/Deploy.s.sol";
import {DeployCollateral} from "../../script/DeployCollateral.s.sol";
import {DeployPrivacy} from "../../script/DeployPrivacy.s.sol";
import {DeployRwa} from "../../script/DeployRwa.s.sol";
import {DeployStaking} from "../../script/DeployStaking.s.sol";
import {DeployToken} from "../../script/DeployToken.s.sol";
import {MigrateCredit} from "../../script/MigrateCredit.s.sol";
import {ProposeWiring} from "../../script/ProposeWiring.s.sol";
import {SeedPool} from "../../script/SeedPool.s.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {LocalFixtures} from "../../script/local/LocalFixtures.s.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
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
    /// The key every deploy script signs with: anvil's first account here, the record's own deploy
    /// key on a fork of Robinhood Chain.
    address internal deployKey;
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
        deployKey = DEPLOYER;
        _run(FIXTURES, address(new LocalFixtures()));
    }

    function _core() internal {
        _run(deployKey, address(new Deploy()));
    }

    function _token() internal {
        _run(deployKey, address(new DeployToken()));
    }

    function _staking() internal {
        _run(deployKey, address(new DeployStaking()));
    }

    function _rwa() internal {
        _run(deployKey, address(new DeployRwa()));
    }

    function _collateral() internal {
        _run(deployKey, address(new DeployCollateral()));
    }

    function _privacy() internal {
        _run(deployKey, address(new DeployPrivacy()));
    }

    /// The BRSR/USDG market, opened as the rehearsal opens it: 25 USDG a side at 200 micro-USD a
    /// BRSR, by the liquidity key, whose USDG the local stand-in mints. The seeder is offered to the
    /// timelock, which takes it in the wiring batch.
    function _seed() internal {
        address liquidity = _readAddress(path, K.LIQUIDITY);
        MockUsdg(_readAddress(path, K.SETTLEMENT_ASSET)).mint(liquidity, 25e6);
        _set("BURSAR_SEED_PRICE_MICRO_USD", "200");
        _set("BURSAR_SEED_USDG_MICRO", "25000000");
        _run(liquidity, address(new SeedPool()));
    }

    /// The lender's first cash in the credit pool, from the USDG the fixtures gave the deploy key.
    function _fundCredit() internal {
        MigrateCredit credit = MigrateCredit(_pinned(address(new MigrateCredit())));
        _as(_readAddress(path, K.LENDER), address(credit), abi.encodeCall(credit.fund, (10e6)));
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

    /// The shielded script builds with the compiler the vendored code pins, so no suite here can
    /// import it. It is deployed from its artifact, linked against the libraries the record names,
    /// the way `--libraries` links it for a real run.
    function _deployShieldedScript(address poseidonT3, address poseidonT4) internal returns (address script) {
        string memory t3 = "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3";
        string memory t4 = "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4";
        string memory artifact = vm.readFile("out/DeployShielded.s.sol/DeployShielded.json");
        string memory code = vm.parseJsonString(artifact, ".bytecode.object");
        code = _unlink(artifact, code, t3);
        code = _unlink(artifact, code, t4);
        code = vm.replace(code, _placeholder(t3), _hex(poseidonT3));
        code = vm.replace(code, _placeholder(t4), _hex(poseidonT4));
        bytes memory creation = vm.parseBytes(code);
        assembly ("memory-safe") {
            script := create(0, add(creation, 0x20), mload(creation))
        }
        require(script != address(0), "the shielded script did not deploy");
        IPinnable(script).pinEnvPrefix(_prefix());
    }

    /// A `forge script` run with `--libraries` leaves the artifact linked against the addresses it
    /// was given, which its metadata names, and `forge test` never rebuilds a script. Putting the
    /// placeholder back lets such an artifact be linked like a fresh build.
    function _unlink(string memory artifact, string memory code, string memory library_)
        private
        view
        returns (string memory)
    {
        string memory key = string.concat(".metadata.settings.libraries['", library_, "']");
        if (!vm.keyExistsJson(artifact, key)) return code;
        return vm.replace(code, _hex(vm.parseJsonAddress(artifact, key)), _placeholder(library_));
    }

    /// Solidity marks an unlinked library as `__$` and the first 34 hex digits of the keccak of its
    /// fully qualified name, then `$__`.
    function _placeholder(string memory library_) private pure returns (string memory) {
        string memory hash = vm.toString(keccak256(bytes(library_)));
        bytes memory digits = new bytes(34);
        for (uint256 i; i < 34; ++i) {
            digits[i] = bytes(hash)[i + 2];
        }
        return string.concat("__$", string(digits), "$__");
    }

    function _hex(address at) private pure returns (string memory) {
        return vm.replace(vm.toLowercase(vm.toString(at)), "0x", "");
    }
}
