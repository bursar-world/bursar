// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {IEntrypointReads, IShieldedPoolReads, IShieldedRelayReads} from "../../script/VerifyShielded.s.sol";

import {Silent, World} from "./World.sol";

interface IEntrypointOwner {
    function windDownPool(address pool) external;
    function grantRole(bytes32 role, address account) external;
}

/// Shielded settlement, deployed from the script's artifact the way `--libraries` links it: the
/// Entrypoint handed to governance inside the run, the pool on the launch caps and the recorded
/// libraries, and the postman kept apart from every key that holds power.
contract DeployShieldedTest is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 internal constant ASP_POSTMAN = keccak256("ASP_POSTMAN");
    /// The script builds with another compiler, so its error is matched by signature.
    bytes4 internal constant ROLE_COLLISION = bytes4(keccak256("RoleCollision(string,string,address)"));

    struct Deployment {
        address withdrawalVerifier;
        address commitmentVerifier;
        address entrypointImplementation;
        address entrypoint;
        address pool;
        address relay;
    }

    function _prefix() internal pure override returns (string memory) {
        return "DEPLOYSHIELDED_";
    }

    function setUp() public {
        _world("deploy-shielded");
        _core();
        _privacy();
        _save();
    }

    function test_deployShielded_handsTheEntrypointToGovernanceOnTheLaunchTerms() public {
        _theDeployKeyLeavesWithNoPower();
        _thePoolIsRegisteredOnTheLaunchTermsAndRecorded();
        _theDepositorFiguresComeFromTheParameterFile();
        _aSecondRunIsRefused();
        _thePostmanIsNamedAndHoldsNoOtherRole();
        _itWaitsForThePrivacySection();
        _anAccessRegistryThatAnswersNothingIsRefused();
        _librariesOtherThanTheRecordsAreRefused();
    }

    function _deploy() private returns (Deployment memory) {
        return abi.decode(_as(DEPLOYER, _deployShieldedScript(), abi.encodeWithSignature("run()")), (Deployment));
    }

    function _expectRefused(bytes memory reason) private {
        address script = _deployShieldedScript();
        vm.expectRevert(reason);
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));
    }

    function _theDeployKeyLeavesWithNoPower() private {
        _restore();
        Deployment memory out = _deploy();
        IEntrypointReads entrypoint = IEntrypointReads(out.entrypoint);
        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        address postman = vm.envAddress(_key("BURSAR_ASP_POSTMAN"));

        assertTrue(entrypoint.hasRole(OWNER_ROLE, timelock));
        assertFalse(entrypoint.hasRole(OWNER_ROLE, DEPLOYER));
        assertTrue(entrypoint.hasRole(ASP_POSTMAN, postman));
        assertFalse(entrypoint.hasRole(ASP_POSTMAN, DEPLOYER));

        // Wind-down, pool registration and role grants all answer to governance alone.
        vm.startPrank(DEPLOYER);
        vm.expectRevert();
        IEntrypointOwner(out.entrypoint).windDownPool(out.pool);
        vm.expectRevert();
        IEntrypointOwner(out.entrypoint).grantRole(OWNER_ROLE, DEPLOYER);
        vm.stopPrank();
    }

    function _thePoolIsRegisteredOnTheLaunchTermsAndRecorded() private {
        _restore();
        Deployment memory out = _deploy();
        (address registered, uint256 minimumDeposit, uint256 vettingFeeBps, uint256 maxRelayFeeBps) =
            IEntrypointReads(out.entrypoint).assetConfig(USDG);
        assertEq(registered, out.pool);
        assertEq(minimumDeposit, 1e6);
        assertEq(vettingFeeBps, 10);
        assertEq(maxRelayFeeBps, 500);

        IShieldedPoolReads pool = IShieldedPoolReads(out.pool);
        assertEq(pool.ENTRYPOINT(), out.entrypoint);
        assertEq(pool.ASSET(), USDG);
        assertEq(pool.ACCESS_REGISTRY(), _readAddress(path, K.ACCESS_REGISTRY));
        assertEq(pool.MAX_DEPOSIT(), 100e6);
        assertEq(pool.MAX_TOTAL(), 1_000e6);
        assertEq(pool.MAX_PER_DEPOSITOR(), 250e6);
        assertEq(pool.DEPOSITOR_WINDOW(), 7 days);

        IShieldedRelayReads relay = IShieldedRelayReads(out.relay);
        assertEq(relay.POOL(), out.pool);
        assertEq(relay.ENTRYPOINT(), out.entrypoint);
        assertEq(relay.MAX_FEE_BPS(), 500);

        string memory json = vm.readFile(path);
        assertEq(_readAddress(path, K.ENTRYPOINT), out.entrypoint);
        assertEq(_readAddress(path, K.ENTRYPOINT_IMPLEMENTATION), out.entrypointImplementation);
        assertEq(_readAddress(path, K.SHIELDED_POOL), out.pool);
        assertEq(_readAddress(path, K.SHIELDED_RELAY), out.relay);
        assertEq(_readAddress(path, K.POSEIDON_T3), _readAddress(path, K.EXTERNAL_POSEIDON_T3));
        assertEq(_readAddress(path, K.POSEIDON_T4), _readAddress(path, K.EXTERNAL_POSEIDON_T4));
        // A field element does not survive a JSON number, so the scope is a decimal string.
        assertEq(vm.parseJsonString(json, K.SHIELDED_SCOPE), vm.toString(pool.SCOPE()));
        assertEq(vm.parseJsonString(json, K.SHIELDED_MAX_DEPOSIT), "100000000");
        assertEq(vm.parseJsonString(json, K.SHIELDED_MAX_PER_DEPOSITOR), "250000000");
        assertEq(_readUint(path, K.SHIELDED_DEPOSITOR_WINDOW), 604_800);
        assertEq(_readUint(path, K.SHIELDED_VETTING_FEE), 10);
    }

    /// The depositor cap and its window come from the parameter file like every other figure, and
    /// a run without them stops before it sends anything.
    function _theDepositorFiguresComeFromTheParameterFile() private {
        _restore();
        string memory cap = vm.envString(_key("BURSAR_SHIELDED_MAX_PER_DEPOSITOR"));
        _unset("BURSAR_SHIELDED_MAX_PER_DEPOSITOR");
        _expectRefused(
            abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_SHIELDED_MAX_PER_DEPOSITOR"))
        );
        _set("BURSAR_SHIELDED_MAX_PER_DEPOSITOR", cap);

        string memory window = vm.envString(_key("BURSAR_SHIELDED_DEPOSITOR_WINDOW"));
        _unset("BURSAR_SHIELDED_DEPOSITOR_WINDOW");
        _expectRefused(
            abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_SHIELDED_DEPOSITOR_WINDOW"))
        );
        _set("BURSAR_SHIELDED_DEPOSITOR_WINDOW", window);
    }

    function _aSecondRunIsRefused() private {
        _restore();
        Deployment memory out = _deploy();
        _expectRefused(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.ENTRYPOINT, out.entrypoint));
    }

    /// The postman posts association roots from a service. It is never inferred, and it is never
    /// the key that signs the run or the governance that owns the Entrypoint.
    function _thePostmanIsNamedAndHoldsNoOtherRole() private {
        _restore();
        string memory postman = vm.envString(_key("BURSAR_ASP_POSTMAN"));
        _set("BURSAR_ASP_POSTMAN", vm.toString(address(0)));
        _expectRefused(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_ASP_POSTMAN")));

        _set("BURSAR_ASP_POSTMAN", vm.toString(DEPLOYER));
        _expectRefused(abi.encodeWithSelector(ROLE_COLLISION, "aspPostman", "deployer", DEPLOYER));

        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        _set("BURSAR_ASP_POSTMAN", vm.toString(timelock));
        _expectRefused(abi.encodeWithSelector(ROLE_COLLISION, "aspPostman", "timelock", timelock));
        _set("BURSAR_ASP_POSTMAN", postman);
    }

    /// Shielded settlement is written inside the privacy section, which a reader parses whole, so
    /// the committed factory has to be deployed first.
    function _itWaitsForThePrivacySection() private {
        _restore();
        address nothing = makeAddr("noFactoryHere");
        vm.writeJson(vm.toString(nothing), path, K.COMMITTED_FACTORY);
        _expectRefused(abi.encodeWithSelector(BursarScript.NotContract.selector, K.COMMITTED_FACTORY, nothing));
    }

    /// Every deposit and payout is screened against this registry first. One that answers nothing
    /// would strand both.
    function _anAccessRegistryThatAnswersNothingIsRefused() private {
        _restore();
        address silent = address(new Silent());
        vm.writeJson(vm.toString(silent), path, K.ACCESS_REGISTRY);
        _expectRefused(abi.encodeWithSelector(BursarScript.NoAnswer.selector, "AccessRegistry.isBlocked", silent));
    }

    /// The pool hashes with code linked at build time. Linked against anything but the libraries
    /// the record names, it would hash with code nobody checked.
    function _librariesOtherThanTheRecordsAreRefused() private {
        _restore();
        address recordedT3 = _readAddress(path, K.EXTERNAL_POSEIDON_T3);
        address recordedT4 = _readAddress(path, K.EXTERNAL_POSEIDON_T4);
        address elsewhere = makeAddr("anotherPoseidon");

        address script = _deployShieldedScript(elsewhere, recordedT4);
        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "pool.PoseidonT3", recordedT3, address(0))
        );
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));

        script = _deployShieldedScript(recordedT3, elsewhere);
        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "pool.PoseidonT4", recordedT4, address(0))
        );
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));
    }
}
