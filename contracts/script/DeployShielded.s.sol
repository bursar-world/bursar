// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Entrypoint} from "../vendor/privacy-pools-core/src/contracts/Entrypoint.sol";
import {CommitmentVerifier} from "../vendor/privacy-pools-core/src/contracts/verifiers/CommitmentVerifier.sol";
import {WithdrawalVerifier} from "../vendor/privacy-pools-core/src/contracts/verifiers/WithdrawalVerifier.sol";
import {IPrivacyPool} from "../vendor/privacy-pools-core/src/interfaces/IPrivacyPool.sol";

import {IAccessRegistry} from "../src/shielded/IAccessRegistry.sol";
import {ShieldedPool} from "../src/shielded/ShieldedPool.sol";
import {ShieldedRelay} from "../src/shielded/ShieldedRelay.sol";

import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

/// Shielded settlement: the Privacy Pools v1.3.0 verifiers and Entrypoint, a USDG `ShieldedPool`
/// with the launch caps, and the `ShieldedRelay` that screens recipients against the access
/// registry. The per-deposit and pool-wide caps are fixed below; what one depositor may put in
/// per window comes from `BURSAR_SHIELDED_MAX_PER_DEPOSITOR` and `BURSAR_SHIELDED_DEPOSITOR_WINDOW`.
///
/// The deploy key holds the Entrypoint's owner role only for as long as it takes to register the
/// pool. The same run grants the role to the timelock and renounces it, and checks both, so the key
/// leaves with no power over the Entrypoint: upgrades, pool registration, wind-down and fees all
/// answer to governance. The association-set postman is the key the ASP service runs, named in
/// `BURSAR_ASP_POSTMAN`, and nothing else holds that role.
///
/// The pool hashes with two Poseidon libraries. They are stateless and already on chain, so the
/// record names them in `external` and the pool is linked against them: the command passes them to
/// Forge with `--libraries`, and the run stops unless the pool's code names exactly those two.
///
/// Every contract is created before any call is made, so each one's address depends only on the
/// deploy key's nonce when the run starts. The end-to-end suite's proofs are bound to those
/// addresses.
contract DeployShielded is BursarScript {
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 internal constant ASP_POSTMAN = keccak256("ASP_POSTMAN");

    uint256 internal constant MAX_DEPOSIT = 100e6;
    uint256 internal constant MAX_TOTAL = 1_000e6;
    uint256 internal constant MIN_DEPOSIT = 1e6;
    /// The Entrypoint keeps this share of every deposit, so a flood of small deposits costs
    /// something.
    uint256 internal constant VETTING_FEE_BPS = 10;
    /// The relayer's fee ceiling. The same figure goes to the Entrypoint, whose own ceiling only
    /// governs `Entrypoint.relay`, and the pool refuses that path.
    uint256 internal constant MAX_RELAY_FEE_BPS = 500;

    struct Deployment {
        address withdrawalVerifier;
        address commitmentVerifier;
        address entrypointImplementation;
        Entrypoint entrypoint;
        ShieldedPool pool;
        ShieldedRelay relay;
    }

    error RoleCollision(string role, string otherRole, address account);

    address private asset;
    address private timelock;
    address private accessRegistry;
    address private postman;
    address private relayer;
    address private poseidonT3;
    address private poseidonT4;
    uint128 private maxPerDepositor;
    uint64 private depositorWindow;

    Deployment private d;

    function run() external returns (Deployment memory) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        asset = _settlementAsset();
        timelock = _timelock();
        accessRegistry = _upstream(K.ACCESS_REGISTRY);
        postman = _role(K.ASP_POSTMAN, "BURSAR_ASP_POSTMAN");
        relayer = _role(K.SHIELDED_RELAYER, "BURSAR_SHIELDED_RELAYER");
        poseidonT3 = _upstream(K.EXTERNAL_POSEIDON_T3);
        poseidonT4 = _upstream(K.EXTERNAL_POSEIDON_T4);
        maxPerDepositor = _envUint128("BURSAR_SHIELDED_MAX_PER_DEPOSITOR");
        depositorWindow = _envUint64("BURSAR_SHIELDED_DEPOSITOR_WINDOW");
        _preflight(deployer);

        vm.startBroadcast(deployer);
        d.withdrawalVerifier = address(new WithdrawalVerifier());
        d.commitmentVerifier = address(new CommitmentVerifier());
        d.entrypointImplementation = address(new Entrypoint());
        d.entrypoint = Entrypoint(
            payable(address(
                    new ERC1967Proxy(
                        d.entrypointImplementation, abi.encodeCall(Entrypoint.initialize, (deployer, postman))
                    )
                ))
        );
        d.pool = new ShieldedPool(
            address(d.entrypoint),
            d.withdrawalVerifier,
            d.commitmentVerifier,
            asset,
            IAccessRegistry(accessRegistry),
            MAX_DEPOSIT,
            MAX_TOTAL,
            maxPerDepositor,
            depositorWindow
        );
        d.relay = new ShieldedRelay(d.pool, IAccessRegistry(accessRegistry), MAX_RELAY_FEE_BPS);
        d.entrypoint.registerPool(IERC20(asset), d.pool, MIN_DEPOSIT, VETTING_FEE_BPS, MAX_RELAY_FEE_BPS);
        d.entrypoint.grantRole(OWNER_ROLE, timelock);
        d.entrypoint.renounceRole(OWNER_ROLE, deployer);
        vm.stopBroadcast();

        _verify(deployer);
        _record();
        _report();
        return d;
    }

    function _preflight(address deployer) private view {
        _requireUnrecorded(K.ENTRYPOINT);
        _requireUnrecorded(K.SHIELDED_POOL);
        _requireUnrecorded(K.SHIELDED_RELAY);
        // The record keeps shielded settlement inside the privacy section, and a reader parses
        // that section whole. It has to exist before this one is written into it.
        _upstream(K.COMMITTED_FACTORY);

        // The pool and the relay screen every address against this registry before money moves.
        // One that answers nothing would make every deposit and every payout revert.
        try IAccessRegistry(accessRegistry).isBlocked(deployer) returns (bool) {}
        catch {
            revert NoAnswer("AccessRegistry.isBlocked", accessRegistry);
        }
        // The postman posts association roots from a service; the owner role goes to governance.
        // Neither may be the key that signs this run.
        if (postman == deployer) revert RoleCollision("aspPostman", "deployer", postman);
        if (postman == timelock) revert RoleCollision("aspPostman", "timelock", postman);
    }

    function _verify(address deployer) private view {
        if (!d.entrypoint.hasRole(OWNER_ROLE, timelock)) revert WiringFailed("entrypoint.owner", timelock, address(0));
        if (d.entrypoint.hasRole(OWNER_ROLE, deployer)) revert WiringFailed("entrypoint.owner", address(0), deployer);
        if (!d.entrypoint.hasRole(ASP_POSTMAN, postman)) {
            revert WiringFailed("entrypoint.postman", postman, address(0));
        }
        if (d.entrypoint.hasRole(ASP_POSTMAN, deployer)) {
            revert WiringFailed("entrypoint.postman", address(0), deployer);
        }

        (IPrivacyPool registered, uint256 minimumDeposit, uint256 vettingFeeBps, uint256 maxRelayFeeBps) =
            d.entrypoint.assetConfig(IERC20(asset));
        _expect("entrypoint.pool", address(d.pool), address(registered));
        _expectUint("entrypoint.minimumDeposit", MIN_DEPOSIT, minimumDeposit);
        _expectUint("entrypoint.vettingFeeBps", VETTING_FEE_BPS, vettingFeeBps);
        _expectUint("entrypoint.maxRelayFeeBps", MAX_RELAY_FEE_BPS, maxRelayFeeBps);

        _expect("pool.entrypoint", address(d.entrypoint), address(d.pool.ENTRYPOINT()));
        _expect("pool.asset", asset, d.pool.ASSET());
        _expect("pool.accessRegistry", accessRegistry, address(d.pool.ACCESS_REGISTRY()));
        _expectUint("pool.maxDeposit", MAX_DEPOSIT, d.pool.MAX_DEPOSIT());
        _expectUint("pool.maxTotal", MAX_TOTAL, d.pool.MAX_TOTAL());
        _expectUint("pool.maxPerDepositor", maxPerDepositor, d.pool.MAX_PER_DEPOSITOR());
        _expectUint("pool.depositorWindow", depositorWindow, d.pool.DEPOSITOR_WINDOW());

        _expect("relay.pool", address(d.pool), address(d.relay.POOL()));
        _expect("relay.entrypoint", address(d.entrypoint), d.relay.ENTRYPOINT());
        _expect("relay.accessRegistry", accessRegistry, address(d.relay.ACCESS_REGISTRY()));
        _expectUint("relay.maxFeeBps", MAX_RELAY_FEE_BPS, d.relay.MAX_FEE_BPS());

        // Forge links whatever `--libraries` names. A pool linked against anything but the
        // recorded libraries would hash with code nobody checked.
        if (!_linksTo(address(d.pool), poseidonT3)) revert WiringFailed("pool.PoseidonT3", poseidonT3, address(0));
        if (!_linksTo(address(d.pool), poseidonT4)) revert WiringFailed("pool.PoseidonT4", poseidonT4, address(0));
    }

    function _record() private {
        _write(K.POSEIDON_T3, poseidonT3);
        _write(K.POSEIDON_T4, poseidonT4);
        _write(K.WITHDRAWAL_VERIFIER, d.withdrawalVerifier);
        _write(K.COMMITMENT_VERIFIER, d.commitmentVerifier);
        _write(K.ENTRYPOINT_IMPLEMENTATION, d.entrypointImplementation);
        _write(K.ENTRYPOINT, address(d.entrypoint));
        _write(K.SHIELDED_POOL, address(d.pool));
        _write(K.SHIELDED_RELAY, address(d.relay));
        _write(K.SHIELDED_ACCESS_REGISTRY, accessRegistry);
        _write(K.SHIELDED_ASSET, asset);
        // Decimal strings, the way readers of this section expect every figure in it but the fee
        // ceilings. The scope is a field element and would not survive a JSON number.
        _writeAmount(K.SHIELDED_SCOPE, d.pool.SCOPE());
        _writeAmount(K.SHIELDED_MAX_DEPOSIT, MAX_DEPOSIT);
        _writeAmount(K.SHIELDED_MAX_TOTAL, MAX_TOTAL);
        _writeAmount(K.SHIELDED_MAX_PER_DEPOSITOR, maxPerDepositor);
        _write(K.SHIELDED_DEPOSITOR_WINDOW, depositorWindow);
        _writeAmount(K.SHIELDED_MIN_DEPOSIT, MIN_DEPOSIT);
        _write(K.SHIELDED_VETTING_FEE, VETTING_FEE_BPS);
        _write(K.SHIELDED_MAX_RELAY_FEE, MAX_RELAY_FEE_BPS);
        _write(K.ASP_POSTMAN, postman);
        _write(K.SHIELDED_RELAYER, relayer);
        _write(K.SHIELDED_FROM_BLOCK, _chainBlock());
    }

    function _report() private view {
        console2.log("WithdrawalVerifier", d.withdrawalVerifier);
        console2.log("CommitmentVerifier", d.commitmentVerifier);
        console2.log("EntrypointImplementation", d.entrypointImplementation);
        console2.log("Entrypoint", address(d.entrypoint));
        console2.log("  owner", timelock);
        console2.log("  postman", postman);
        console2.log("ShieldedPool", address(d.pool));
        console2.log("  scope", d.pool.SCOPE());
        console2.log("ShieldedRelay", address(d.relay));
    }
}
