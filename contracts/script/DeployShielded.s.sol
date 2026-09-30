// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Entrypoint} from "../vendor/privacy-pools-core/src/contracts/Entrypoint.sol";
import {CommitmentVerifier} from "../vendor/privacy-pools-core/src/contracts/verifiers/CommitmentVerifier.sol";
import {WithdrawalVerifier} from "../vendor/privacy-pools-core/src/contracts/verifiers/WithdrawalVerifier.sol";

import {IAccessRegistry} from "../src/shielded/IAccessRegistry.sol";
import {ShieldedPool} from "../src/shielded/ShieldedPool.sol";
import {ShieldedRelay} from "../src/shielded/ShieldedRelay.sol";

/// F17: the Privacy Pools v1.3.0 verifiers and Entrypoint, a USDG ShieldedPool with the launch caps,
/// and the ShieldedRelay that screens recipients.
///
///   BURSAR_TIMELOCK=0x135e… BURSAR_ASP_POSTMAN=0x… forge script script/DeployShielded.s.sol \
///     --rpc-url $RHC_RPC_URL --keystore $ETH_KEYSTORE --password-file $ETH_PASSWORD [--broadcast]
///
/// The broadcaster holds the Entrypoint's OWNER_ROLE only long enough to register the pool. The
/// same run grants the role to the AdminTimelock, renounces it, and checks both, so the deploy key
/// leaves with no power over the Entrypoint (upgrades, pool registration, wind-down, fees).
contract DeployShielded is Script {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    IAccessRegistry internal constant ACCESS_REGISTRY = IAccessRegistry(0xe10b6f6B275de231345c20D14Ab812db62151b00);
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");

    uint256 internal constant MAX_DEPOSIT = 100e6;
    uint256 internal constant MAX_TOTAL = 1_000e6;
    uint256 internal constant MIN_DEPOSIT = 1e6;
    /// The Entrypoint keeps this share of every deposit, so a flood of small deposits costs something.
    uint256 internal constant VETTING_FEE_BPS = 10;
    /// The relayer's fee ceiling is ShieldedRelay.MAX_FEE_BPS. The same figure goes to the
    /// Entrypoint, whose own ceiling only governs `Entrypoint.relay`, and the pool refuses that path.
    uint256 internal constant MAX_RELAY_FEE_BPS = 500;

    struct Deployed {
        address withdrawalVerifier;
        address commitmentVerifier;
        address entrypointImplementation;
        Entrypoint entrypoint;
        ShieldedPool pool;
        ShieldedRelay relay;
    }

    function run() external returns (Deployed memory d) {
        require(block.chainid == 4663, "not Robinhood Chain");
        address timelock = vm.envAddress("BURSAR_TIMELOCK");
        address postman = vm.envAddress("BURSAR_ASP_POSTMAN");
        require(timelock.code.length != 0, "BURSAR_TIMELOCK holds no code");

        vm.startBroadcast();
        address deployer = msg.sender;
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
            USDG,
            ACCESS_REGISTRY,
            MAX_DEPOSIT,
            MAX_TOTAL
        );
        d.entrypoint.registerPool(IERC20(USDG), d.pool, MIN_DEPOSIT, VETTING_FEE_BPS, MAX_RELAY_FEE_BPS);
        d.relay = new ShieldedRelay(d.pool, ACCESS_REGISTRY, MAX_RELAY_FEE_BPS);
        d.entrypoint.grantRole(OWNER_ROLE, timelock);
        d.entrypoint.renounceRole(OWNER_ROLE, deployer);
        vm.stopBroadcast();

        require(d.entrypoint.hasRole(OWNER_ROLE, timelock), "timelock does not hold OWNER_ROLE");
        require(!d.entrypoint.hasRole(OWNER_ROLE, deployer), "deploy key still holds OWNER_ROLE");

        console2.log("WithdrawalVerifier", d.withdrawalVerifier);
        console2.log("CommitmentVerifier", d.commitmentVerifier);
        console2.log("EntrypointImplementation", d.entrypointImplementation);
        console2.log("Entrypoint", address(d.entrypoint));
        console2.log("ShieldedPool", address(d.pool));
        console2.log("ShieldedPoolScope", d.pool.SCOPE());
        console2.log("ShieldedRelay", address(d.relay));
    }
}
