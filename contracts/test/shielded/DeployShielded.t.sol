// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPrivacyPool} from "../../vendor/privacy-pools-core/src/interfaces/IPrivacyPool.sol";

import {DeployShielded} from "../../script/DeployShielded.s.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAccessRegistry} from "./Shielded.t.sol";

/// Calls the script from the address that broadcasts, as `forge script` does, so `msg.sender`
/// inside `run` is the deploy key.
contract ShieldedDeployRunner {
    function go(DeployShielded script) external returns (DeployShielded.Deployed memory) {
        return script.run();
    }
}

contract TimelockStandIn {}

contract DeployShieldedTest is Test {
    uint256 internal constant CHAIN_ID = 4663;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ACCESS_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 internal constant ASP_POSTMAN = keccak256("ASP_POSTMAN");

    address internal postman = address(0x9057);
    address internal timelock;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        vm.etch(USDG, address(new MockERC20()).code);
        vm.etch(ACCESS_REGISTRY, address(new MockAccessRegistry()).code);
        timelock = address(new TimelockStandIn());
    }

    function _run() internal returns (DeployShielded.Deployed memory) {
        DeployShielded script = new DeployShielded();
        vm.etch(DEFAULT_SENDER, address(new ShieldedDeployRunner()).code);
        return ShieldedDeployRunner(DEFAULT_SENDER).go(script);
    }

    /// One test, run in sequence, because the script reads process-wide environment variables.
    function test_deployScript_handsTheEntrypointToTheTimelockAtTheLaunchConfiguration() public {
        vm.setEnv("BURSAR_ASP_POSTMAN", vm.toString(postman));

        vm.setEnv("BURSAR_TIMELOCK", vm.toString(address(0x7133)));
        DeployShielded refused = new DeployShielded();
        vm.expectRevert(bytes("BURSAR_TIMELOCK holds no code"));
        refused.run();

        vm.setEnv("BURSAR_TIMELOCK", vm.toString(timelock));
        DeployShielded.Deployed memory d = _run();

        assertTrue(d.entrypoint.hasRole(OWNER_ROLE, timelock));
        assertFalse(d.entrypoint.hasRole(OWNER_ROLE, DEFAULT_SENDER));
        assertTrue(d.entrypoint.hasRole(ASP_POSTMAN, postman));
        assertFalse(d.entrypoint.hasRole(ASP_POSTMAN, DEFAULT_SENDER));
        // The deploy key can no longer wind the pool down, register pools or upgrade.
        vm.prank(DEFAULT_SENDER);
        vm.expectRevert();
        d.entrypoint.windDownPool(d.pool);

        (IPrivacyPool pool, uint256 minimumDeposit, uint256 vettingFeeBps, uint256 maxRelayFeeBps) =
            d.entrypoint.assetConfig(IERC20(USDG));
        assertEq(address(pool), address(d.pool));
        assertEq(minimumDeposit, 1e6);
        assertEq(vettingFeeBps, 10);
        assertEq(maxRelayFeeBps, 500);
        assertEq(d.pool.MAX_DEPOSIT(), 100e6);
        assertEq(d.pool.MAX_TOTAL(), 1_000e6);
        assertEq(d.relay.MAX_FEE_BPS(), 500);
        assertEq(address(d.relay.POOL()), address(d.pool));
        assertEq(d.relay.ENTRYPOINT(), address(d.entrypoint));
    }
}
