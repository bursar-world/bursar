// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {DeployStaking} from "../../script/DeployStaking.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {OracleRegistry} from "../../src/OracleRegistry.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {Buyback, PoolKey} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {IStaking} from "../../src/token/interfaces/IStaking.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockV4} from "../rwa/RwaMocks.sol";
import {World} from "./World.sol";

/// The staking pool, the buyback and the seeder, built on the BRSR the record names, and the last
/// one-shot pairing in the core set closed from the key that deployed the registry.
contract DeployStakingTest is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address internal timelock;
    address internal brsr;

    function _prefix() internal pure override returns (string memory) {
        return "DEPLOYSTAKING_";
    }

    function setUp() public {
        _world("deploy-staking");
        _core();
        _token();
        timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        brsr = _readAddress(path, K.BRSR);
        _save();
    }

    function test_deployStaking_buildsTheEconomicsAndLeavesTheirLeversToGovernance() public {
        _everyLeverAnswersToGovernance();
        _theRegistryBondsInBrsrFromTheFirstBlock();
        _aClosedPoolGetsNoSeederAndAnOpenOneDoes();
        _anUnsetCeilingRefusesEveryBuyback();
        _theKeeperDefaultsToTheFirstResolver();
        _theGuardianStopsBothAtOnce();
        _aSecondRunIsRefused();
        _aRegistryThisKeyDidNotDeployIsRefused();
        _aRegistryAlreadyWiredIsRefused();
        _aTokenThatIsNotBrsrIsRefused();
        _aPoolKeyThatCannotMatchALivePoolIsRefused();
        _aCeilingThatIsNotAPriceIsRefused();
        _theRetiredPriceFloorVariableIsRefused();
        _aValueTooLargeForItsFieldIsRefused();
        _aRoleWearingTwoHatsIsRefused();
        _aZeroFloorIsRefused();
        _noResolversIsRefused();
        _aShellNamingAnotherManagerIsRefused();
        _aFrozenManagerIsRefused();
        _aForeignEnvironmentCannotReachThisRun();
    }

    function _deploy() private returns (DeployStaking.Deployment memory) {
        return abi.decode(_run(DEPLOYER, address(new DeployStaking())), (DeployStaking.Deployment));
    }

    function _expectRefused(bytes memory reason) private {
        address script = _pinned(address(new DeployStaking()));
        vm.expectRevert(reason);
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));
    }

    /// After the run no key that signs from a shell can change a parameter, take stake or trigger a
    /// buyback. Nothing can take stake until governance names a slasher, and nothing can buy until
    /// it names a keeper.
    function _everyLeverAnswersToGovernance() private {
        _restore();
        DeployStaking.Deployment memory out = _deploy();
        Staking staking = Staking(out.staking);
        Buyback buyback = Buyback(out.buyback);

        assertEq(staking.admin(), timelock);
        assertEq(buyback.admin(), timelock);
        assertEq(address(staking.stakeToken()), brsr);
        assertEq(address(staking.rewardToken()), USDG);
        assertEq(staking.minBond(), 1_000_000_000e18, "the allowlist is not closed from the first block");
        assertEq(address(buyback.staking()), out.staking);
        assertEq(buyback.params().maxPriceMicroUsdPerBrsr, 240);

        vm.startPrank(DEPLOYER);
        vm.expectRevert(IStaking.NotAdmin.selector);
        staking.setSlasher(DEPLOYER);
        vm.expectRevert(IStaking.NotAdmin.selector);
        staking.setBondFloor(DEPLOYER, 1);
        vm.expectRevert(Buyback.NotAdmin.selector);
        buyback.setKeeper(DEPLOYER);
        vm.expectRevert(IStaking.NotSlasher.selector);
        staking.slash(1);
        vm.expectRevert(Buyback.NotKeeper.selector);
        buyback.buyback();
        vm.stopPrank();

        assertEq(_readAddress(path, K.STAKING), out.staking);
        assertEq(_readAddress(path, K.BUYBACK), out.buyback);
        assertEq(
            vm.parseJsonString(vm.readFile(path), ".parameters.Staking.resolverBondFloor"), "30000000000000000000000"
        );
        assertEq(_readUint(path, ".parameters.Buyback.poolFee"), 3000);
    }

    /// The last wiring call in the core set: until it lands no resolver can bond at all.
    function _theRegistryBondsInBrsrFromTheFirstBlock() private {
        _restore();
        DeployStaking.Deployment memory out = _deploy();
        OracleRegistry registry = OracleRegistry(_readAddress(path, K.ORACLE_REGISTRY));
        assertEq(address(registry.staking()), out.staking);
        assertEq(address(registry.bondAsset()), brsr);
    }

    function _aClosedPoolGetsNoSeederAndAnOpenOneDoes() private {
        _restore();
        _deploy();
        assertFalse(_has(path, K.SEEDER), "a seeder was recorded for a pool nobody opened");

        _restore();
        _openBrsrPool();
        DeployStaking.Deployment memory out = _deploy();
        V4LiquiditySeeder seeder = V4LiquiditySeeder(out.seeder);
        assertEq(_readAddress(path, K.SEEDER), out.seeder);
        assertEq(seeder.owner(), timelock);
        assertEq(seeder.buyback(), out.buyback);
        assertEq(seeder.poolId(), vm.parseJsonBytes32(vm.readFile(path), ".token.poolId"));
    }

    /// A ceiling of zero blocks every trade, which is where a buyback whose pool has no price
    /// belongs. Even a keeper governance names is refused until a ceiling is set.
    function _anUnsetCeilingRefusesEveryBuyback() private {
        _restore();
        _unset("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR");
        DeployStaking.Deployment memory out = _deploy();
        Buyback buyback = Buyback(out.buyback);
        assertEq(buyback.params().maxPriceMicroUsdPerBrsr, 0);

        address keeper = makeAddr("keeper");
        vm.prank(timelock);
        buyback.setKeeper(keeper);
        MockUsdg(USDG).mint(out.buyback, 10e6);
        assertEq(buyback.available(), 0);
        vm.prank(keeper);
        vm.expectRevert(Buyback.PriceCeilingUnset.selector);
        buyback.buyback();
        _set("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR", "240");
    }

    /// Until a keeper service runs, the first resolver's key triggers buybacks.
    function _theKeeperDefaultsToTheFirstResolver() private {
        _restore();
        _deploy();
        address[] memory resolvers = vm.parseJsonAddressArray(vm.readFile(path), K.RESOLVERS);
        assertEq(_readAddress(path, K.KEEPER), resolvers[0]);

        _restore();
        address keeper = makeAddr("aKeeperService");
        _set("BURSAR_BUYBACK_KEEPER", vm.toString(keeper));
        _deploy();
        assertEq(_readAddress(path, K.KEEPER), keeper);
        _set("BURSAR_BUYBACK_KEEPER", vm.toString(address(0)));
    }

    function _theGuardianStopsBothAtOnce() private {
        _restore();
        DeployStaking.Deployment memory out = _deploy();
        address[] memory targets = new address[](2);
        targets[0] = out.staking;
        targets[1] = out.buyback;
        vm.prank(_readAddress(path, K.GUARDIAN));
        AdminTimelock(timelock).guardianPause(targets);
        assertTrue(Staking(out.staking).paused());
        assertTrue(Buyback(out.buyback).paused());
    }

    function _aSecondRunIsRefused() private {
        _restore();
        DeployStaking.Deployment memory out = _deploy();
        _expectRefused(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.STAKING, out.staking));
    }

    /// `setStaking` answers only to the key that deployed the registry, and takes one call.
    function _aRegistryThisKeyDidNotDeployIsRefused() private {
        _restore();
        IOracleRegistry.Config memory config = OracleRegistry(_readAddress(path, K.ORACLE_REGISTRY)).config();
        OracleRegistry foreign = new OracleRegistry(USDG, timelock, _readAddress(path, K.SLASH_SINK), config);
        vm.writeJson(vm.toString(address(foreign)), path, K.ORACLE_REGISTRY);
        _expectRefused(
            abi.encodeWithSelector(DeployStaking.OracleRegistryNotReady.selector, "deployer", address(this), DEPLOYER)
        );
    }

    /// Forced past its own record, the run still refuses a registry that already bonds in
    /// another pool's token: that pairing takes no second call.
    function _aRegistryAlreadyWiredIsRefused() private {
        _restore();
        DeployStaking.Deployment memory out = _deploy();
        _set("BURSAR_FORCE", "1");
        _expectRefused(
            abi.encodeWithSelector(DeployStaking.OracleRegistryNotReady.selector, "staking", out.staking, address(0))
        );
        _unset("BURSAR_FORCE");
    }

    function _aTokenThatIsNotBrsrIsRefused() private {
        _restore();
        vm.writeJson(vm.toString(USDG), path, K.BRSR);
        _expectRefused(abi.encodeWithSelector(DeployStaking.AssetDecimalsMismatch.selector, USDG, uint8(6), uint8(18)));
    }

    function _aPoolKeyThatCannotMatchALivePoolIsRefused() private {
        _restore();
        _set("BURSAR_BUYBACK_POOL_FEE", vm.toString(uint256(0x800000)));
        _expectRefused(abi.encodeWithSelector(DeployStaking.DynamicFeePoolRejected.selector));
        _set("BURSAR_BUYBACK_POOL_FEE", "3000");

        address hook = makeAddr("hook");
        _set("BURSAR_BUYBACK_POOL_HOOKS", vm.toString(hook));
        _expectRefused(abi.encodeWithSelector(DeployStaking.PoolHookNotContract.selector, hook));
        _set("BURSAR_BUYBACK_POOL_HOOKS", vm.toString(address(0)));

        _set("BURSAR_BUYBACK_POOL_TICK_SPACING", "0");
        _expectRefused(abi.encodeWithSelector(DeployStaking.TickSpacingOutOfRange.selector, int24(0)));
        _set("BURSAR_BUYBACK_POOL_TICK_SPACING", "60");
    }

    function _aCeilingThatIsNotAPriceIsRefused() private {
        _restore();
        _set("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR", "1000000000001");
        _expectRefused(
            abi.encodeWithSelector(DeployStaking.PriceCeilingNotAPrice.selector, uint128(1e12 + 1), uint128(1e12))
        );
        _set("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR", "240");
    }

    /// The variable this replaced held BRSR wei per whole USDC. Left in a shell it would now read
    /// as a price of a million million dollars a token.
    function _theRetiredPriceFloorVariableIsRefused() private {
        _restore();
        _set("BURSAR_BUYBACK_MIN_OUT_PER_USDC", "1000000000000000000");
        _expectRefused(
            abi.encodeWithSelector(
                BursarScript.RetiredEnv.selector,
                _key("BURSAR_BUYBACK_MIN_OUT_PER_USDC"),
                "BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR"
            )
        );
        _unset("BURSAR_BUYBACK_MIN_OUT_PER_USDC");
    }

    function _aValueTooLargeForItsFieldIsRefused() private {
        _restore();
        _set("BURSAR_BUYBACK_POOL_FEE", vm.toString(uint256(type(uint24).max) + 1));
        _expectRefused(
            abi.encodeWithSelector(
                BursarScript.EnvOutOfRange.selector,
                _key("BURSAR_BUYBACK_POOL_FEE"),
                uint256(type(uint24).max) + 1,
                uint256(type(uint24).max)
            )
        );
        _set("BURSAR_BUYBACK_POOL_FEE", "3000");
    }

    function _aRoleWearingTwoHatsIsRefused() private {
        _restore();
        address treasury = _readAddress(path, K.TREASURY);
        string memory sink = vm.envString(_key("BURSAR_SLASH_SINK"));
        // The record is what the run reads; the shell stays out of it.
        _set("BURSAR_SLASH_SINK", vm.toString(address(0)));
        vm.writeJson(vm.toString(treasury), path, K.SLASH_SINK);
        _expectRefused(abi.encodeWithSelector(DeployStaking.RoleCollision.selector, "slashSink", "treasury", treasury));
        _set("BURSAR_SLASH_SINK", sink);

        _restore();
        _set("BURSAR_BUYBACK_KEEPER", vm.toString(DEPLOYER));
        _expectRefused(abi.encodeWithSelector(DeployStaking.RoleCollision.selector, "keeper", "deployer", DEPLOYER));
        _set("BURSAR_BUYBACK_KEEPER", vm.toString(address(0)));
    }

    function _aZeroFloorIsRefused() private {
        _restore();
        _set("BURSAR_RESOLVER_BOND_FLOOR", "0");
        _expectRefused(abi.encodeWithSelector(DeployStaking.BondFloorZero.selector));
        _set("BURSAR_RESOLVER_BOND_FLOOR", "30000000000000000000000");
    }

    function _noResolversIsRefused() private {
        _restore();
        string memory resolvers = vm.envString(_key("BURSAR_RESOLVERS"));
        _unset("BURSAR_RESOLVERS");
        _expectRefused(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_RESOLVERS")));
        _set("BURSAR_RESOLVERS", resolvers);
    }

    /// The manager is Uniswap's and lives in the record. A parameter file that still names one
    /// has to name the same.
    function _aShellNamingAnotherManagerIsRefused() private {
        _restore();
        address other = makeAddr("someOtherManager");
        _set("BURSAR_BUYBACK_POOL_MANAGER", vm.toString(other));
        _expectRefused(
            abi.encodeWithSelector(
                BursarScript.RecordMismatch.selector, K.POOL_MANAGER, _readAddress(path, K.POOL_MANAGER), other
            )
        );
        _set("BURSAR_BUYBACK_POOL_MANAGER", vm.toString(address(0)));
    }

    /// The buyback pays the manager on every call. On chain 4663 a frozen manager or treasury is
    /// read off USDG before anything is sent.
    function _aFrozenManagerIsRefused() private {
        _restore();
        address manager = _readAddress(path, K.POOL_MANAGER);
        MockUsdg(USDG).setFrozen(manager, true);
        _expectRefused(abi.encodeWithSelector(DeployStaking.AddressFrozen.selector, "poolManager", manager));
        MockUsdg(USDG).setFrozen(manager, false);
    }

    function _aForeignEnvironmentCannotReachThisRun() private {
        _restore();
        vm.setEnv("BURSAR_BUYBACK_POOL_FEE", "0");
        vm.setEnv("BURSAR_STAKING_MIN_BOND", "0");
        vm.setEnv("BURSAR_RECORD", "cache/bursar/someone-elses.json");
        DeployStaking.Deployment memory out = _deploy();
        assertEq(Buyback(out.buyback).poolFee(), 3000);
    }

    /// Prices the BRSR/USDG pool in the stand-in manager, which is all an open pool is to it.
    function _openBrsrPool() private {
        (address c0, address c1) = brsr < USDG ? (brsr, USDG) : (USDG, brsr);
        PoolKey memory key = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: address(0)});
        // Two hundred micro-USD for a whole BRSR, in raw units either way round.
        uint256 ratio = brsr < USDG ? Math.mulDiv(200, 1 << 192, 1e18) : Math.mulDiv(1e18, 1 << 192, 200);
        MockV4(_readAddress(path, K.POOL_MANAGER)).setPrice(key, uint160(Math.sqrt(ratio)));
    }
}
