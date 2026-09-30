// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deploy} from "../../script/Deploy.s.sol";
import {DeployCollateral} from "../../script/DeployCollateral.s.sol";
import {DeployPrivacy} from "../../script/DeployPrivacy.s.sol";
import {DeployRwa} from "../../script/DeployRwa.s.sol";
import {DeployStaking} from "../../script/DeployStaking.s.sol";
import {DeployToken} from "../../script/DeployToken.s.sol";
import {ProposeWiring} from "../../script/ProposeWiring.s.sol";
import {Verify} from "../../script/Verify.s.sol";
import {VerifyCollateral} from "../../script/VerifyCollateral.s.sol";
import {VerifyCore} from "../../script/VerifyCore.s.sol";
import {VerifyPrivacy} from "../../script/VerifyPrivacy.s.sol";
import {VerifyRwa} from "../../script/VerifyRwa.s.sol";
import {VerifyShielded} from "../../script/VerifyShielded.s.sol";
import {VerifyStaking} from "../../script/VerifyStaking.s.sol";
import {VerifyToken} from "../../script/VerifyToken.s.sol";
import {VerifyWiring} from "../../script/VerifyWiring.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {LocalFixtures} from "../../script/local/LocalFixtures.s.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {Staking} from "../../src/token/Staking.sol";
import {LaneFlows} from "./LaneFlows.sol";
import {ScriptHarness} from "./ScriptHarness.sol";

interface IPinnable {
    function pinEnvPrefix(string calldata prefix) external;
}

/// The whole deployment, in one process, through the real scripts and the real parameter files: the
/// local fixtures, every deploy script in order with its verify companion after it, the wiring batch
/// through the timelock from the signers' own keys, the full verify, and then one flow per lane.
///
/// It runs the same steps as `script/local/rehearse.sh` does against anvil, with the same accounts:
/// anvil's first account deploys, and the deploy key's nonce is pinned before the shielded run, so
/// the shielded pool lands where the proofs in `fixtures/shielded-e2e.json` were made for.
contract EndToEndTest is ScriptHarness, LaneFlows {
    address internal constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant FIXTURES = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
    uint64 internal constant SHIELDED_NONCE = 10_000;
    /// Monday 2026-09-28, 10:53 UTC: inside the 24/5 equities session, and two hours before the
    /// moment the committed fixture's proof was made for.
    uint256 internal constant T0 = 1_790_592_800;

    string internal path;

    function _prefix() internal pure override returns (string memory) {
        return "E2E_";
    }

    function test_theWholeSetDeploysThroughTheScriptsVerifiesAndRunsEveryLane() public {
        vm.chainId(4663);
        vm.warp(T0);
        _source("script/env/rhc-mainnet-v3.env");
        _source("script/env/local.env");
        _set("BURSAR_VESTING_START", vm.toString(block.timestamp));
        path = string.concat(RECORDS, "/e2e-4663.json");
        _set("BURSAR_RECORD", path);

        _run(FIXTURES, address(new LocalFixtures()));

        _run(DEPLOYER, address(new Deploy()));
        _check(address(new VerifyCore()));
        _run(DEPLOYER, address(new DeployToken()));
        _check(address(new VerifyToken()));
        _run(DEPLOYER, address(new DeployStaking()));
        _check(address(new VerifyStaking()));
        _run(DEPLOYER, address(new DeployRwa()));
        _check(address(new VerifyRwa()));
        _run(DEPLOYER, address(new DeployCollateral()));
        _check(address(new VerifyCollateral()));
        _run(DEPLOYER, address(new DeployPrivacy()));
        _check(address(new VerifyPrivacy()));

        vm.setNonce(DEPLOYER, SHIELDED_NONCE);
        _run(DEPLOYER, _deployShieldedScript());
        _check(address(new VerifyShielded()));

        _wire();
        _check(address(new VerifyWiring()));
        _check(address(new Verify()));

        _lanes(path);
    }

    /// Proposed by one signer, approved by a second, executed by the first once the delay has
    /// passed, each from its own key.
    function _wire() private {
        ProposeWiring wiring = new ProposeWiring();
        wiring.pinEnvPrefix(_prefix());
        address[] memory signers = vm.parseJsonAddressArray(vm.readFile(path), K.SIGNERS);
        _as(signers[0], address(wiring), abi.encodeCall(wiring.propose, ()));
        _as(signers[1], address(wiring), abi.encodeCall(wiring.approve, ()));
        vm.warp(block.timestamp + AdminTimelock(_readAddress(path, K.ADMIN_TIMELOCK)).timelockPeriod());
        _as(signers[0], address(wiring), abi.encodeCall(wiring.execute, ()));

        Staking staking = Staking(_readAddress(path, K.STAKING));
        assertEq(staking.slasher(), _readAddress(path, K.CREDIT_POOL), "the credit pool is not the slasher");
        address[] memory resolvers = vm.parseJsonAddressArray(vm.readFile(path), K.RESOLVERS);
        assertTrue(staking.isBondable(resolvers[0], 30_000e18), "a vetted resolver cannot bond at its floor");
        assertFalse(staking.isBondable(address(0xB0B), 30_000e18), "a resolver nobody vetted can bond");
    }

    function _run(address key, address script) private {
        IPinnable(script).pinEnvPrefix(_prefix());
        _as(key, script, abi.encodeWithSignature("run()"));
    }

    function _check(address verifier) private {
        IPinnable(verifier).pinEnvPrefix(_prefix());
        (bool ok, bytes memory reason) = verifier.call(abi.encodeWithSignature("run()"));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    /// The shielded script builds with the compiler the vendored code pins, so this suite cannot
    /// import it. It is deployed from its artifact, linked against the Poseidon libraries the record
    /// names, the way `--libraries` links it for a real run.
    function _deployShieldedScript() private returns (address script) {
        string memory json = vm.readFile(path);
        string memory code =
            vm.parseJsonString(vm.readFile("out/DeployShielded.s.sol/DeployShielded.json"), ".bytecode.object");
        code = _link(
            code,
            "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3",
            vm.parseJsonAddress(json, K.EXTERNAL_POSEIDON_T3)
        );
        code = _link(
            code,
            "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4",
            vm.parseJsonAddress(json, K.EXTERNAL_POSEIDON_T4)
        );
        bytes memory creation = vm.parseBytes(code);
        assembly ("memory-safe") {
            script := create(0, add(creation, 0x20), mload(creation))
        }
        require(script != address(0), "the shielded script did not deploy");
    }

    /// Solidity marks an unlinked library as `__$` and the first 34 hex digits of the keccak of its
    /// fully qualified name, then `$__`.
    function _link(string memory code, string memory library_, address at) private pure returns (string memory) {
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
