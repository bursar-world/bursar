// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployToken} from "../../script/DeployToken.s.sol";
import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {OracleRegistry} from "../../src/OracleRegistry.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {Buyback} from "../../src/token/Buyback.sol";
import {BRSR} from "../../src/token/BRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {Vesting} from "../../src/token/Vesting.sol";
import {IStaking} from "../../src/token/interfaces/IStaking.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockPoolManager} from "../mocks/MockPoolManager.sol";

/// Calls `run` from the address the script broadcasts as, because the readback compares the
/// script's caller against the key that signed the deployment.
contract TokenDeployRunner {
    function go(DeployToken script) external returns (DeployToken.Deployment memory) {
        return script.run();
    }
}

/// Eighteen decimals where the settlement asset has to have six.
contract WideAsset is ERC20 {
    constructor() ERC20("Wide", "WIDE") {}
}

/// The deployment as it will run: four contracts, one mint, and an admin that is the
/// governance already holding the rest of the system.
///
/// The whole surface runs inside one test, in sequence, because the script is configured
/// through the process environment. Foundry runs tests in parallel and the environment is not
/// part of the EVM state it snapshots, so two tests writing the same variable read each
/// other's values. `MandateDeployScriptTest` carries the core deployment the same way.
contract TokenDeployTest is Test {
    uint256 internal constant RHC_CHAIN_ID = 4663;
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant MIN_SETTLEMENT_BALANCE = 1_000_000;

    uint64 internal constant PERIOD = 48 hours;
    uint256 internal constant TEAM_ALLOCATION = 100_000_000e18;
    uint256 internal constant STAKING_MIN_BOND = 25_000e18;

    /// The ceiling in the base fixture: a dollar a token, in micro-USD.
    string internal constant MAX_PRICE = "1000000";

    /// Every variable this suite writes sits under this prefix, and the script is pinned to it.
    /// Foundry's environment is process-wide and is not part of the EVM state it snapshots, so
    /// the core deployment suite driving its own script writes the same variable names at the
    /// same time. Sharing them made this suite fail on an address from someone else's fixture,
    /// about one run in three.
    string internal constant ENV = "TOKENDEPLOY_";

    DeployToken internal script;
    AdminTimelock internal timelock;
    MockUsdg internal settlement;
    MockPoolManager internal manager;

    address internal treasury = makeAddr("treasury");
    address internal slashSink = makeAddr("slashSink");
    address internal community = makeAddr("community");
    address internal liquidity = makeAddr("liquidity");
    address internal founderA = makeAddr("founderA");
    address internal founderB = makeAddr("founderB");
    address internal signerA = makeAddr("signerA");
    address internal signerB = makeAddr("signerB");
    address internal signerC = makeAddr("signerC");
    address internal guardian = makeAddr("guardian");

    uint256 internal homeChain;

    function setUp() public {
        // A start date can be backdated by up to ninety days, so the clock has to be past
        // that before any of this is meaningful.
        vm.warp(1_789_000_000);

        homeChain = block.chainid;

        script = new DeployToken();
        script.pinEnvPrefix(ENV);
        timelock = new AdminTimelock([signerA, signerB, signerC], guardian, PERIOD);
        settlement = new MockUsdg();
        manager = new MockPoolManager(settlement, IERC20(address(0)), 0);

        vm.etch(DEFAULT_SENDER, address(new TokenDeployRunner()).code);
    }

    /// `run` attributes the deployment to its own caller and signs with the broadcast key, so
    /// the two have to be the same address for the readback to hold. Under the harness that
    /// means calling from forge-std's default sender, which a prank cannot do: a broadcast
    /// cannot be opened under one.
    function _run() private returns (DeployToken.Deployment memory) {
        return TokenDeployRunner(DEFAULT_SENDER).go(script);
    }

    function _set(string memory key, string memory value) private {
        vm.setEnv(string.concat(ENV, key), value);
    }

    function _key(string memory key) private pure returns (string memory) {
        return string.concat(ENV, key);
    }

    /// Ordered so the cases that stay on the home chain run before the ones that move to chain
    /// 4663, because `vm.chainId` and the etched USDG persist for the rest of the test.
    function test_deployToken_placesTheSupplyAndHandsEveryLeverToGovernance() public {
        _theWholeSupplyIsPlacedAndTheDeployKeyKeepsNone();
        _nothingIsAdministrableByAnEoaAfterTheRun();
        _theTokenItselfHasNoAdminToHandOver();
        _theGrantSetIsClosedByTheRunItself();
        _theStakingPoolAndBuybackAreWiredToEachOther();
        _governanceTurnsOnTheParametersTheRunLeftOff();
        _theGuardianStopsTheStakingPoolAndTheBuybackTogether();
        _aBackdatedStartInsideTheRangeVestsNothingOnDeployDay();

        _theRunRefusesAChainItWasNotBuiltFor();
        _theRunRefusesAMissingVariable();
        _theRunRefusesAnAssetThatDoesNotAnswerDecimals();
        _theRunRefusesAnAssetAtTheWrongScale();
        _theRunRefusesGovernanceWithNoDelay();
        _theRunRefusesAPoolManagerWithNoCodeBehindIt();
        _theRunRefusesADynamicFeePool();
        _theRunRefusesAPoolKeyThatCannotMatchALivePool();
        _anUnsetPriceCeilingDeploysABuybackThatRefusesEveryTrade();
        _theRunRefusesTheRetiredPriceFloorVariable();
        _theRunRefusesAPriceCeilingThatIsNotAPrice();
        _aForeignEnvironmentCannotReachThisRun();
        _theRunClosesTheResolverBondWiringOnTheCoreDeployment();
        _theRunRefusesARegistryItCannotWire();
        _theRunRefusesAValueTooLargeForItsField();
        _theRunRefusesAnAddressWearingTwoHats();
        _theRunRefusesABeneficiaryWearingAnotherHat();
        _theRunRefusesGrantsThatDoNotAddUpToTheTeamShare();
        _theRunRefusesAVestingStartOutsideItsRange();

        // Everything from here runs on chain 4663. The first one has to stay first: it proves
        // the empty-balance refusal and then funds the deploy key for the cases after it.
        _theRunRefusesADeployKeyHoldingNoSettlementAsset();
        _theRunRefusesAnAssetThatIsNotUsdg();
        _theRunRefusesToStartWhileUsdgIsPaused();
        _theRunRefusesAFrozenDeployKeyOrTreasury();
        _theRunCompletesAgainstThePinnedUsdgAddress();
    }

    /// Foundry runs `setUp` once and snapshots the EVM, but the process environment is not
    /// part of that snapshot: a variable one test writes is still there for the next one. Every
    /// test lays the whole set down before it changes the one it is about.
    function _setBaseEnv() private {
        _set("BURSAR_CHAIN_ID", vm.toString(homeChain));
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(address(settlement)));
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(timelock)));
        _set("BURSAR_TREASURY", vm.toString(treasury));
        _set("BURSAR_SLASH_SINK", vm.toString(slashSink));
        _set("BURSAR_BRSR_COMMUNITY", vm.toString(community));
        _set("BURSAR_BRSR_LIQUIDITY", vm.toString(liquidity));
        _set("BURSAR_STAKING_UNBONDING_PERIOD", vm.toString(uint256(14 days)));
        _set("BURSAR_STAKING_MIN_BOND", vm.toString(STAKING_MIN_BOND));
        // No core deployment to close the last link to in most cases; the one that does names
        // a registry of its own.
        _set("BURSAR_ORACLE_REGISTRY", vm.toString(address(0)));
        // Cleared, not assumed absent, because one case sets it to prove the run rejects it.
        _set("BURSAR_BUYBACK_MIN_OUT_PER_USDC", "");

        _set("BURSAR_BUYBACK_POOL_MANAGER", vm.toString(address(manager)));
        _set("BURSAR_BUYBACK_POOL_FEE", "3000");
        _set("BURSAR_BUYBACK_POOL_TICK_SPACING", "60");
        _set("BURSAR_BUYBACK_POOL_HOOKS", vm.toString(address(0)));
        _set("BURSAR_BUYBACK_SPEND_PER_CALL", "100000000");
        _set("BURSAR_BUYBACK_MAX_SPEND_PER_WINDOW", "500000000");
        _set("BURSAR_BUYBACK_MIN_SPEND", "10000000");
        _set("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR", MAX_PRICE);
        _set("BURSAR_BUYBACK_WINDOW", "86400");
        _set("BURSAR_BUYBACK_MIN_INTERVAL", "3600");

        _set("BURSAR_VESTING_START", vm.toString(block.timestamp));
        _set("BURSAR_VESTING_BENEFICIARIES", string.concat(vm.toString(founderA), ",", vm.toString(founderB)));
        _set("BURSAR_VESTING_AMOUNTS", "60000000000000000000000000,40000000000000000000000000");
    }

    function _oracleConfig() private pure returns (IOracleRegistry.Config memory) {
        return IOracleRegistry.Config({
            commitWindow: 1 hours,
            revealWindow: 1 hours,
            unbondingPeriod: 7 days,
            quorum: 2,
            maxVoters: 5,
            maxDeviation: 10,
            slashBps: 2_000
        });
    }

    /// Moves the fixture onto chain 4663, where the preflight checks the pinned asset address
    /// and the compliance surface as well as everything it checks everywhere.
    ///
    /// USDG is etched rather than deployed, because the script pins its address. Storage
    /// survives a re-etch, so the balance the first case mints is still there for the ones
    /// after it.
    function _useRobinhoodChain() private returns (MockUsdg usdg) {
        vm.etch(RHC_USDG, address(new MockUsdg()).code);

        vm.chainId(RHC_CHAIN_ID);
        _set("BURSAR_CHAIN_ID", vm.toString(RHC_CHAIN_ID));
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(RHC_USDG));
        // No governance pin: the timelock this set joins on 4663 is deployed per run.
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(timelock)));

        usdg = MockUsdg(RHC_USDG);
        usdg.setPaused(false);
    }

    function _theWholeSupplyIsPlacedAndTheDeployKeyKeepsNone() private {
        _setBaseEnv();
        DeployToken.Deployment memory out = _run();
        BRSR brsr = BRSR(out.brsr);

        assertEq(brsr.totalSupply(), 1_000_000_000e18);
        assertEq(brsr.balanceOf(community), 800_000_000e18);
        assertEq(brsr.balanceOf(out.vesting), TEAM_ALLOCATION);
        assertEq(brsr.balanceOf(treasury), 50_000_000e18);
        assertEq(brsr.balanceOf(liquidity), 50_000_000e18);
        assertEq(brsr.balanceOf(DEFAULT_SENDER), 0);
        assertEq(brsr.balanceOf(address(script)), 0);
        assertEq(brsr.balanceOf(out.brsr), 0);
    }

    /// The one that has to hold on the day: after the run, no key that signs from a shell can
    /// change a parameter, take a stake, or move a token.
    function _nothingIsAdministrableByAnEoaAfterTheRun() private {
        _setBaseEnv();
        DeployToken.Deployment memory out = _run();

        assertEq(Staking(out.staking).admin(), address(timelock));
        assertEq(Staking(out.staking).pendingAdmin(), address(0));
        assertEq(Buyback(out.buyback).admin(), address(timelock));
        assertEq(Buyback(out.buyback).pendingAdmin(), address(0));
        assertEq(Vesting(out.vesting).admin(), address(timelock));
        assertEq(Vesting(out.vesting).pendingAdmin(), address(0));

        vm.startPrank(DEFAULT_SENDER);

        vm.expectRevert(IStaking.NotAdmin.selector);
        Staking(out.staking).setCreditManager(DEFAULT_SENDER);
        vm.expectRevert(IStaking.NotAdmin.selector);
        Staking(out.staking).setMinBond(1);
        vm.expectRevert(IStaking.NotAdmin.selector);
        Staking(out.staking).pause();
        vm.expectRevert(IStaking.NotAdmin.selector);
        Staking(out.staking).setTreasury(DEFAULT_SENDER);

        vm.expectRevert(Buyback.NotAdmin.selector);
        Buyback(out.buyback).pause();
        vm.expectRevert(Buyback.NotAdmin.selector);
        Buyback(out.buyback).sweep(address(settlement), 1);

        vm.expectRevert(Vesting.NotAdmin.selector);
        Vesting(out.vesting).revoke(founderA);
        vm.expectRevert(Vesting.NotAdmin.selector);
        Vesting(out.vesting).sweep();

        // Nothing can take stake until governance names the credit lane.
        vm.expectRevert(IStaking.NotCreditManager.selector);
        Staking(out.staking).slash(1, bytes32(0));

        vm.stopPrank();

        assertEq(Staking(out.staking).creditManager(), address(0));
    }

    /// BRSR has no administered surface at all, which is why no address appears in the
    /// readback for it.
    function _theTokenItselfHasNoAdminToHandOver() private {
        _setBaseEnv();
        DeployToken.Deployment memory out = _run();

        string[6] memory absent =
            ["admin()", "owner()", "pause()", "mint(address,uint256)", "burn(uint256)", "transferOwnership(address)"];
        for (uint256 i; i < absent.length; ++i) {
            (bool ok,) = out.brsr.call(abi.encodeWithSignature(absent[i], DEFAULT_SENDER, uint256(1)));
            assertFalse(ok);
        }
    }

    /// The deploy key keeps exactly one call, it is used inside the run, and it does not
    /// survive it.
    function _theGrantSetIsClosedByTheRunItself() private {
        _setBaseEnv();
        DeployToken.Deployment memory out = _run();
        Vesting vesting = Vesting(out.vesting);

        assertTrue(vesting.grantsWritten());
        assertEq(vesting.deployer(), DEFAULT_SENDER);
        assertEq(vesting.outstandingWei(), TEAM_ALLOCATION);
        assertEq(vesting.unallocatedWei(), 0);
        assertEq(vesting.grantOf(founderA).totalWei, 60_000_000e18);
        assertEq(vesting.grantOf(founderB).totalWei, 40_000_000e18);
        assertEq(vesting.claimableOf(founderA), 0);

        address[] memory who = new address[](1);
        who[0] = founderA;
        uint128[] memory howMuch = new uint128[](1);
        howMuch[0] = 1e18;

        vm.prank(DEFAULT_SENDER);
        vm.expectRevert(Vesting.AlreadyWritten.selector);
        vesting.createGrants(who, howMuch, uint64(block.timestamp));
    }

    function _theStakingPoolAndBuybackAreWiredToEachOther() private {
        _setBaseEnv();
        DeployToken.Deployment memory out = _run();

        assertEq(address(Staking(out.staking).stakeToken()), out.brsr);
        assertEq(address(Staking(out.staking).rewardToken()), address(settlement));
        assertEq(Staking(out.staking).slashSink(), slashSink);
        assertEq(Staking(out.staking).treasury(), treasury);
        assertEq(Staking(out.staking).unbondingPeriod(), 14 days);
        // The dispute layer reads this floor. It arrives with the pool, because a later
        // proposal would leave resolvers unable to bond for two days.
        assertEq(Staking(out.staking).minBond(), STAKING_MIN_BOND);
        assertTrue(Staking(out.staking).isBondable(founderA, STAKING_MIN_BOND));
        assertFalse(Staking(out.staking).isBondable(founderA, STAKING_MIN_BOND - 1));

        assertEq(address(Buyback(out.buyback).staking()), out.staking);
        assertEq(address(Buyback(out.buyback).brsr()), out.brsr);
        assertEq(address(Buyback(out.buyback).settlementAsset()), address(settlement));
        assertEq(Buyback(out.buyback).treasury(), treasury);
        assertEq(Buyback(out.buyback).params().maxPriceMicroUsdPerBrsr, 1_000_000);
    }

    /// The safe value for a price ceiling is the one that blocks every trade, and it is what a
    /// run with the variable unset deploys. A buyback pointed at a pool with no price yet
    /// should buy nothing, not buy at any price.
    function _anUnsetPriceCeilingDeploysABuybackThatRefusesEveryTrade() private {
        _setBaseEnv();
        _set("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR", "");
        DeployToken.Deployment memory out = _run();

        assertEq(Buyback(out.buyback).params().maxPriceMicroUsdPerBrsr, 0);
        assertEq(Buyback(out.buyback).available(), 0);

        settlement.mint(out.buyback, 1_000e6);
        vm.expectRevert(Buyback.PriceCeilingUnset.selector);
        Buyback(out.buyback).buyback();
    }

    /// The variable this replaced held BRSR wei per whole USDC, and the deployed value asked
    /// for one BRSR per dollar. That only blocks a fill above a dollar a token, so in practice
    /// it blocked nothing and a permissionless buyback ran with almost no floor. Left in a
    /// shell it would now read as a price of a million million dollars a token. The run names
    /// it and stops there.
    function _theRunRefusesTheRetiredPriceFloorVariable() private {
        _setBaseEnv();
        _set("BURSAR_BUYBACK_MIN_OUT_PER_USDC", "1000000000000000000");
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployToken.RetiredEnv.selector,
                _key("BURSAR_BUYBACK_MIN_OUT_PER_USDC"),
                _key("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR")
            )
        );
        _run();
    }

    /// A number that is not a price, which is what a figure in the retired unit looks like.
    function _theRunRefusesAPriceCeilingThatIsNotAPrice() private {
        _setBaseEnv();
        _set("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR", "1000000000001");
        vm.expectRevert(
            abi.encodeWithSelector(DeployToken.PriceCeilingNotAPrice.selector, uint128(1e12 + 1), uint128(1e12))
        );
        _run();
    }

    /// The failure this namespace exists to stop: another suite, or an operator with the
    /// parameter file sourced, writing the same variable names into the same process. Nothing
    /// outside the namespace reaches this run, whatever it says.
    function _aForeignEnvironmentCannotReachThisRun() private {
        _setBaseEnv();

        vm.setEnv("BURSAR_CHAIN_ID", vm.toString(homeChain + 99));
        vm.setEnv("BURSAR_SETTLEMENT_ASSET", vm.toString(makeAddr("someoneElsesAsset")));
        vm.setEnv("BURSAR_BRSR_COMMUNITY", vm.toString(address(0)));
        vm.setEnv("BURSAR_BUYBACK_MIN_OUT_PER_USDC", "1000000000000000000");

        DeployToken.Deployment memory out = _run();
        assertEq(address(Staking(out.staking).rewardToken()), address(settlement));
    }

    /// The last wiring call in the system: resolver bonds have nowhere to go until this run
    /// names the pool that prices them.
    function _theRunClosesTheResolverBondWiringOnTheCoreDeployment() private {
        _setBaseEnv();
        // The core run deploys the registry from the same key the token run broadcasts as,
        // which is what lets this run close the pairing.
        vm.prank(DEFAULT_SENDER);
        OracleRegistry registry = new OracleRegistry(address(settlement), address(timelock), slashSink, _oracleConfig());

        _set("BURSAR_ORACLE_REGISTRY", vm.toString(address(registry)));
        DeployToken.Deployment memory out = _run();

        assertEq(address(registry.staking()), out.staking);
        assertEq(address(registry.bondAsset()), out.brsr);
    }

    /// Everything about that call is checked before the mint, because `setStaking` takes one
    /// call and a failure after the mint is a redeploy of the whole set.
    function _theRunRefusesARegistryItCannotWire() private {
        _setBaseEnv();
        address notAContract = makeAddr("notARegistry");
        _set("BURSAR_ORACLE_REGISTRY", vm.toString(notAContract));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.OracleRegistryNotContract.selector, notAContract));
        _run();

        // Deployed by someone else, so this run's key cannot close the pairing.
        OracleRegistry foreign = new OracleRegistry(address(settlement), address(timelock), slashSink, _oracleConfig());
        _set("BURSAR_ORACLE_REGISTRY", vm.toString(address(foreign)));
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployToken.OracleRegistryNotReady.selector, "deployer", address(this), DEFAULT_SENDER
            )
        );
        _run();
    }

    /// Governance is the only way any of the three move, and every move waits out the delay.
    function _governanceTurnsOnTheParametersTheRunLeftOff() private {
        _setBaseEnv();
        DeployToken.Deployment memory out = _run();
        Staking staking = Staking(out.staking);
        address creditLane = makeAddr("creditLane");

        IStaking.Tier[] memory tiers = new IStaking.Tier[](2);
        tiers[0] = IStaking.Tier({minStake: 1_000e18, rebateBps: 500});
        tiers[1] = IStaking.Tier({minStake: 50_000e18, rebateBps: 2_000});

        _pass(out.staking, abi.encodeCall(Staking.setMinBond, (25_000e18)));
        _pass(out.staking, abi.encodeCall(Staking.setTiers, (tiers)));
        _pass(out.staking, abi.encodeCall(Staking.setCreditManager, (creditLane)));

        assertEq(staking.minBond(), 25_000e18);
        assertEq(staking.tiers().length, 2);
        assertEq(staking.creditManager(), creditLane);
        assertTrue(staking.isBondable(founderA, 25_000e18));
    }

    /// The brake reaches both administered contracts in one call, with no approvals and no
    /// delay, and restarting them is a proposal like any other change.
    function _theGuardianStopsTheStakingPoolAndTheBuybackTogether() private {
        _setBaseEnv();
        DeployToken.Deployment memory out = _run();

        address[] memory targets = new address[](2);
        targets[0] = out.staking;
        targets[1] = out.buyback;

        vm.prank(guardian);
        timelock.guardianPause(targets);

        assertTrue(Staking(out.staking).paused());
        assertTrue(Buyback(out.buyback).paused());

        vm.prank(guardian);
        vm.expectRevert(AdminTimelock.NotSigner.selector);
        timelock.propose(out.staking, abi.encodeCall(Staking.unpause, ()));

        _pass(out.staking, abi.encodeCall(Staking.unpause, ()));
        assertFalse(Staking(out.staking).paused());
    }

    function _pass(address target, bytes memory data) private {
        vm.prank(signerA);
        uint256 id = timelock.propose(target, data);
        vm.prank(signerB);
        timelock.approve(id);
        vm.warp(block.timestamp + PERIOD);
        vm.prank(signerA);
        timelock.execute(id);
    }

    function _theRunRefusesAChainItWasNotBuiltFor() private {
        _setBaseEnv();
        _set("BURSAR_CHAIN_ID", vm.toString(homeChain + 1));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.WrongChain.selector, homeChain + 1, homeChain));
        _run();
    }

    function _theRunRefusesAMissingVariable() private {
        _setBaseEnv();
        _set("BURSAR_BRSR_COMMUNITY", vm.toString(address(0)));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.MissingEnv.selector, _key("BURSAR_BRSR_COMMUNITY")));
        _run();
    }

    function _theRunRefusesAnAssetThatDoesNotAnswerDecimals() private {
        _setBaseEnv();
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(address(timelock)));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.AssetNotContract.selector, address(timelock)));
        _run();
    }

    function _theRunRefusesAnAssetAtTheWrongScale() private {
        _setBaseEnv();
        WideAsset wide = new WideAsset();
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(address(wide)));
        vm.expectRevert(
            abi.encodeWithSelector(DeployToken.AssetDecimalsMismatch.selector, address(wide), uint8(18), uint8(6))
        );
        _run();
    }

    function _theRunRefusesGovernanceWithNoDelay() private {
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(settlement)));
        vm.expectRevert();
        _run();
    }

    function _theRunRefusesAPoolManagerWithNoCodeBehindIt() private {
        _setBaseEnv();
        address empty = makeAddr("empty");
        _set("BURSAR_BUYBACK_POOL_MANAGER", vm.toString(empty));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.PoolManagerNotContract.selector, empty));
        _run();
    }

    /// A dynamic-fee pool lets its hook set the fee per swap, which hands the venue a lever
    /// over the price of every buyback the contract will ever make.
    function _theRunRefusesADynamicFeePool() private {
        _setBaseEnv();
        _set("BURSAR_BUYBACK_POOL_FEE", vm.toString(uint256(0x800000)));
        vm.expectRevert(DeployToken.DynamicFeePoolRejected.selector);
        _run();
    }

    function _theRunRefusesAPoolKeyThatCannotMatchALivePool() private {
        _setBaseEnv();
        address hook = makeAddr("hook");
        _set("BURSAR_BUYBACK_POOL_HOOKS", vm.toString(hook));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.PoolHookNotContract.selector, hook));
        _run();

        _set("BURSAR_BUYBACK_POOL_HOOKS", vm.toString(address(0)));
        _set("BURSAR_BUYBACK_POOL_TICK_SPACING", "0");
        vm.expectRevert(abi.encodeWithSelector(DeployToken.TickSpacingOutOfRange.selector, int24(0)));
        _run();
    }

    function _theRunRefusesAValueTooLargeForItsField() private {
        _setBaseEnv();
        _set("BURSAR_BUYBACK_POOL_FEE", vm.toString(uint256(type(uint24).max) + 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployToken.EnvOutOfRange.selector,
                _key("BURSAR_BUYBACK_POOL_FEE"),
                uint256(type(uint24).max) + 1,
                uint256(type(uint24).max)
            )
        );
        _run();
    }

    /// The deploy key signs from a shell and the token's mint is final. Nothing it names as a
    /// recipient may be itself, and no two may be the same.
    function _theRunRefusesAnAddressWearingTwoHats() private {
        _setBaseEnv();
        _set("BURSAR_BRSR_COMMUNITY", vm.toString(DEFAULT_SENDER));
        vm.expectRevert(
            abi.encodeWithSelector(DeployToken.RoleCollision.selector, "community", "deployer", DEFAULT_SENDER)
        );
        _run();

        _set("BURSAR_BRSR_COMMUNITY", vm.toString(liquidity));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.RoleCollision.selector, "community", "liquidity", liquidity));
        _run();

        _set("BURSAR_BRSR_COMMUNITY", vm.toString(community));
        _set("BURSAR_SLASH_SINK", vm.toString(treasury));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.RoleCollision.selector, "slashSink", "treasury", treasury));
        _run();
    }

    function _theRunRefusesABeneficiaryWearingAnotherHat() private {
        _setBaseEnv();
        _set("BURSAR_VESTING_BENEFICIARIES", string.concat(vm.toString(founderA), ",", vm.toString(treasury)));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.RoleCollision.selector, "beneficiary", "treasury", treasury));
        _run();
    }

    function _theRunRefusesGrantsThatDoNotAddUpToTheTeamShare() private {
        _setBaseEnv();
        _set("BURSAR_VESTING_AMOUNTS", "60000000000000000000000000,30000000000000000000000000");
        vm.expectRevert(
            abi.encodeWithSelector(DeployToken.VestingAmountsMismatch.selector, 90_000_000e18, TEAM_ALLOCATION)
        );
        _run();

        _set("BURSAR_VESTING_AMOUNTS", "100000000000000000000000000");
        vm.expectRevert(abi.encodeWithSelector(DeployToken.VestingListLengthMismatch.selector, 2, 1));
        _run();
    }

    /// A start backdated past the cliff unlocks a quarter of the team allocation in the first
    /// block. That is a typo, not a term.
    function _theRunRefusesAVestingStartOutsideItsRange() private {
        _setBaseEnv();
        uint64 earliest = uint64(block.timestamp) - 90 days;
        uint64 latest = uint64(block.timestamp) + 90 days;

        _set("BURSAR_VESTING_START", vm.toString(uint256(earliest - 1)));
        vm.expectRevert(
            abi.encodeWithSelector(DeployToken.VestingStartOutOfRange.selector, earliest - 1, earliest, latest)
        );
        _run();

        _set("BURSAR_VESTING_START", vm.toString(uint256(latest + 1)));
        vm.expectRevert(
            abi.encodeWithSelector(DeployToken.VestingStartOutOfRange.selector, latest + 1, earliest, latest)
        );
        _run();
    }

    /// A backdated start inside the range is legitimate for a grant agreed before the
    /// contracts existed, and it must still leave nothing claimable on the day.
    function _aBackdatedStartInsideTheRangeVestsNothingOnDeployDay() private {
        _setBaseEnv();
        _set("BURSAR_VESTING_START", vm.toString(block.timestamp - 89 days));
        DeployToken.Deployment memory out = _run();

        assertEq(Vesting(out.vesting).claimableOf(founderA), 0);
        (uint64 cliffAt,) = Vesting(out.vesting).scheduleOf(founderA);
        assertGt(cliffAt, block.timestamp);
    }

    /// The mint spends no USDG, so this is not a funding check. It is the proof that the
    /// address in the parameter file is the asset the system settles in, and an empty balance
    /// is what a wrong address that happens to hold code looks like.
    ///
    /// This case funds the deploy key at the end, so every case below it starts from a key
    /// that clears the floor.
    function _theRunRefusesADeployKeyHoldingNoSettlementAsset() private {
        _setBaseEnv();
        MockUsdg usdg = _useRobinhoodChain();

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployToken.SettlementBalanceTooLow.selector, DEFAULT_SENDER, uint256(0), MIN_SETTLEMENT_BALANCE
            )
        );
        _run();

        usdg.mint(DEFAULT_SENDER, MIN_SETTLEMENT_BALANCE);
    }

    function _theRunRefusesAnAssetThatIsNotUsdg() private {
        _setBaseEnv();
        _useRobinhoodChain();
        MockUsdg other = new MockUsdg();
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(address(other)));
        vm.expectRevert(abi.encodeWithSelector(DeployToken.AssetNotUsdg.selector, address(other), RHC_USDG));
        _run();
    }

    /// A paused settlement asset stops every transfer at once, and a run that starts into one
    /// strands a token set whose supply is already placed and cannot be moved.
    function _theRunRefusesToStartWhileUsdgIsPaused() private {
        _setBaseEnv();
        MockUsdg usdg = _useRobinhoodChain();
        usdg.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(DeployToken.AssetPaused.selector, RHC_USDG));
        _run();
        usdg.setPaused(false);
    }

    function _theRunRefusesAFrozenDeployKeyOrTreasury() private {
        _setBaseEnv();
        MockUsdg usdg = _useRobinhoodChain();

        usdg.setFrozen(DEFAULT_SENDER, true);
        vm.expectRevert(abi.encodeWithSelector(DeployToken.AddressFrozen.selector, "deployer", DEFAULT_SENDER));
        _run();

        usdg.setFrozen(DEFAULT_SENDER, false);
        usdg.setFrozen(treasury, true);
        vm.expectRevert(abi.encodeWithSelector(DeployToken.AddressFrozen.selector, "treasury", treasury));
        _run();
        usdg.setFrozen(treasury, false);
    }

    function _theRunCompletesAgainstThePinnedUsdgAddress() private {
        _setBaseEnv();
        _useRobinhoodChain();
        DeployToken.Deployment memory out = _run();

        assertEq(address(Staking(out.staking).rewardToken()), RHC_USDG);
        assertEq(Staking(out.staking).admin(), address(timelock));
        assertEq(Buyback(out.buyback).admin(), address(timelock));
        assertEq(BRSR(out.brsr).balanceOf(DEFAULT_SENDER), 0);
    }
}
