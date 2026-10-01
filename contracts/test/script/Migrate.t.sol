// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {DeployStaking} from "../../script/DeployStaking.s.sol";
import {MigrateCredit} from "../../script/MigrateCredit.s.sol";
import {MigrateExamples} from "../../script/MigrateExamples.s.sol";
import {MigratePayee} from "../../script/MigratePayee.s.sol";
import {MigrateResolvers} from "../../script/MigrateResolvers.s.sol";
import {ProposeWiring} from "../../script/ProposeWiring.s.sol";
import {RetireRecords} from "../../script/RetireRecords.s.sol";
import {Verify} from "../../script/Verify.s.sol";
import {VerifyCore} from "../../script/VerifyCore.s.sol";
import {IShieldedPoolReads} from "../../script/VerifyShielded.s.sol";
import {VerifyStaking} from "../../script/VerifyStaking.s.sol";
import {VerifyWiring} from "../../script/VerifyWiring.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {Governance} from "../../script/lib/Governance.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {OracleRegistry} from "../../src/OracleRegistry.sol";
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {Buyback} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockStock} from "../rwa/RwaMocks.sol";
import {LaneFlows} from "./LaneFlows.sol";
import {World} from "./World.sol";

contract VerifyStakingProbe is VerifyStaking {
    function tally() external view returns (uint256, uint256) {
        return (mismatches, owed);
    }
}

contract VerifyProbe is Verify {
    function tally() external view returns (uint256, uint256) {
        return (mismatches, owed);
    }
}

/// The move from one deployment to the next, through the real scripts. A whole set is built and
/// used the way the live one is: wired, funded, a payee registered, the resolvers bonded, the three
/// examples created, a payment settled and one left to expire. Then a record is planned on top of
/// it, carrying the timelock and the token set over, and every step of `MIGRATION.md` runs against
/// the two records in the runbook's order. It ends with one flow per lane against the new set.
contract MigrateTest is World, LaneFlows {
    using stdStorage for StdStorage;

    address internal constant EXAMPLE_PAYER = address(0xE2E00011);
    address internal constant OLD_PAYER = address(0xE2E00012);
    uint256 internal constant FLOOR = 30_000e18;

    string internal previousPath;
    string internal nextPath;
    address internal payee;
    address internal timelock;
    address[] internal signers;
    address[] internal resolvers;
    address internal treasury;

    address internal pool;
    address internal previousPool;
    Staking internal staking;

    uint256 private _state;
    string private _previousSaved;
    string private _nextSaved;

    function _prefix() internal pure override returns (string memory) {
        return "MIGRATE_";
    }

    function setUp() public {
        _world("migrate-previous");
        previousPath = path;
        payee = vm.envAddress(_key("BURSAR_EXAMPLE_PAYEE"));
        _core();
        _token();
        _staking();
        _seed();
        _rwa();
        _collateral();
        _privacy();
        _as(DEPLOYER, _deployShieldedScript(), abi.encodeWithSignature("run()"));
        _wiring();
        _fundCredit();

        timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        signers = vm.parseJsonAddressArray(vm.readFile(path), K.SIGNERS);
        resolvers = vm.parseJsonAddressArray(vm.readFile(path), K.RESOLVERS);
        treasury = _readAddress(path, K.TREASURY);

        _usePreviousSet();
        _plan();
        _mark();
    }

    /// The previous set in use: its payee and resolvers seated through the same scripts a first
    /// deployment seats them with, its examples created, one payment released and one left to run
    /// out, and its record live.
    function _usePreviousSet() private {
        MockUsdg(USDG).mint(payee, 5e6);
        _set("BURSAR_PAYEE_NAME", "example_payee");
        _run(payee, address(new MigratePayee()));
        _unset("BURSAR_PAYEE_NAME");
        assertTrue(AgentRegistry(_readAddress(path, K.AGENT_REGISTRY)).isActive(payee));

        _as(treasury, _pinned(address(new MigrateResolvers())), abi.encodeWithSignature("fund()"));
        for (uint256 i; i < resolvers.length; ++i) {
            _as(resolvers[i], _pinned(address(new MigrateResolvers())), abi.encodeWithSignature("bond()"));
        }

        MockUsdg(USDG).mint(EXAMPLE_PAYER, 1e6);
        MockStock(_readAddress(path, string.concat(K.RWA_ASSETS, ".SPY.address"))).mint(EXAMPLE_PAYER, 1e18);
        _committedTerms(true);
        _as(EXAMPLE_PAYER, _pinned(address(new MigrateExamples())), abi.encodeWithSignature("create()"));
        _committedTerms(false);
        assertEq(
            CollateralVault(_readAddress(path, K.COLLATERAL_VAULT))
                .collateralOf(_readAddress(path, ".exampleCollateralMandate.address"), _stock("SPY")),
            1e18,
            "the collateral example holds no SPY"
        );

        Escrow escrow = Escrow(_readAddress(path, K.ESCROW));
        MockUsdg(USDG).mint(OLD_PAYER, 2e6);
        vm.startPrank(OLD_PAYER);
        IERC20(USDG).approve(address(escrow), 2e6);
        uint256 paid = escrow.lock(payee, keccak256("job"), bytes32(0), "", 1e6, uint64(block.timestamp + 30 minutes));
        escrow.lock(payee, keccak256("job"), bytes32(0), "", 1e6, uint64(block.timestamp + 30 minutes));
        vm.stopPrank();
        vm.prank(payee);
        escrow.release(paid, keccak256("delivered"), "");

        _step(DEPLOYER, address(new RetireRecords()), "goLive()");
        assertEq(vm.parseJsonString(vm.readFile(path), K.STATUS), "live");

        // The deploy key lent its USDG to the credit pool. The next core run asks it for one USDG
        // again, as proof of the settlement asset, the way the runbook's balances do.
        MockUsdg(USDG).mint(DEPLOYER, 1e6);
    }

    /// The next record, planned the way `deployments/rhc-mainnet-v4.json` is: governance, the token
    /// set, the roles and the outside contracts carried over, nothing of its own yet.
    function _plan() private {
        string memory prev = vm.readFile(previousPath);
        nextPath = string.concat(RECORDS, "/migrate-next.json");
        vm.writeFile(
            nextPath,
            string.concat(
                '{"network":"local-4663-next","chainId":4663,"status":"planned","local":true,"dev":true,',
                '"settlementAsset":"',
                vm.toString(USDG),
                '","settlementDecimals":6,"supersedes":"',
                vm.parseJsonString(prev, K.NETWORK),
                '","deployer":"',
                vm.toString(DEPLOYER),
                '","external":{"assets":{}},"roles":{},"contracts":{},"token":{},"verifiedOnChain":{}}'
            )
        );
        string[8] memory addresses = [
            K.POOL_MANAGER,
            K.STATE_VIEW,
            K.ACCESS_REGISTRY,
            K.EXTERNAL_POSEIDON_T3,
            K.EXTERNAL_POSEIDON_T4,
            K.GUARDIAN,
            K.TREASURY,
            K.SLASH_SINK
        ];
        for (uint256 i; i < addresses.length; ++i) {
            _copyAddress(prev, addresses[i]);
        }
        string[8] memory token =
            [K.LIQUIDITY, K.COMMUNITY, K.ADMIN_TIMELOCK, K.BRSR, K.VESTING, K.STAKING, K.BUYBACK, K.SEEDER];
        for (uint256 i; i < token.length; ++i) {
            _copyAddress(prev, token[i]);
        }
        _copyAddress(prev, K.KEEPER);
        vm.writeJson(_quoted(vm.toString(vm.parseJsonBytes32(prev, ".token.poolId"))), nextPath, ".token.poolId");
        vm.writeJson(vm.toString(vm.parseJsonUint(prev, K.TOKEN_FROM_BLOCK)), nextPath, K.TOKEN_FROM_BLOCK);
        _copyAddresses(prev, K.SIGNERS);
        _copyAddresses(prev, K.RESOLVERS);
        string[4] memory symbols = ["SGOV", "SPY", "NVDA", "AAPL"];
        for (uint256 i; i < symbols.length; ++i) {
            string memory at = string.concat(K.EXTERNAL_ASSETS, ".", symbols[i]);
            _copyAddress(prev, string.concat(at, ".address"));
            _copyAddress(prev, string.concat(at, ".feed"));
            vm.writeJson(
                _quoted(vm.parseJsonString(prev, string.concat(at, ".kind"))), nextPath, string.concat(at, ".kind")
            );
        }
    }

    function _copyAddress(string memory prev, string memory key) private {
        if (vm.keyExistsJson(prev, key)) vm.writeJson(vm.toString(vm.parseJsonAddress(prev, key)), nextPath, key);
    }

    function _copyAddresses(string memory prev, string memory key) private {
        address[] memory values = vm.parseJsonAddressArray(prev, key);
        string memory list = "[";
        for (uint256 i; i < values.length; ++i) {
            list = string.concat(list, i == 0 ? "" : ",", _quoted(vm.toString(values[i])));
        }
        vm.writeJson(string.concat(list, "]"), nextPath, key);
    }

    function _quoted(string memory value) private pure returns (string memory) {
        return string.concat('"', value, '"');
    }

    /// The chain and both records as they stood before the case.
    function _mark() private {
        _previousSaved = vm.readFile(previousPath);
        _nextSaved = vm.readFile(nextPath);
        _state = vm.snapshotState();
    }

    function _back() private {
        vm.revertToState(_state);
        _state = vm.snapshotState();
        vm.writeFile(previousPath, _previousSaved);
        vm.writeFile(nextPath, _nextSaved);
        path = nextPath;
        _set("BURSAR_RECORD", nextPath);
        _set("BURSAR_PREVIOUS_RECORD", previousPath);
    }

    function _committedTerms(bool on) private {
        _set("BURSAR_COMMITTED_TERMS", on ? "1" : "");
        _set("BURSAR_COMMITTED_COUNTER", on ? "0" : "");
        _set("BURSAR_COMMITTED_CIPHERTEXT", on ? "0x01" : "");
    }

    function _stock(string memory symbol) private view returns (address) {
        return _readAddress(path, string.concat(K.RWA_ASSETS, ".", symbol, ".address"));
    }

    function _step(address key, address script, string memory sig) private {
        _as(key, _pinned(script), abi.encodeWithSignature(sig));
    }

    function _expectRefused(address key, address script, string memory sig, bytes memory reason) private {
        address pinned = _pinned(script);
        vm.expectRevert(reason);
        _as(key, pinned, abi.encodeWithSignature(sig));
    }

    function _tally(address probe) private returns (uint256 mismatched, uint256 owedCount) {
        (bool ok,) = probe.call(abi.encodeWithSignature("run()"));
        assertTrue(ok, "the check failed");
        (mismatched, owedCount) = VerifyStakingProbe(probe).tally();
    }

    function test_migrate_joinsTheCarriedSetAndMovesEverythingTheRunbookMoves() public {
        _theJoinDeploysNothingAndWritesWhatTheChainHolds();
        _theJoinClosesThePairingWhenTheCoreRunDidNot();
        _theJoinRefusesASetThatIsNotTheRecords();
        _theJoinRefusesFloorsNobodyNamed();
        _aPreviousRecordTheNewOneDoesNotSupersedeIsRefused();
        _theWholeMoveInTheRunbooksOrder();
    }

    /// With the three contracts carried, the staking run deploys nothing, recognises the pairing
    /// the core run closed, and records the figures the carried contracts hold.
    function _theJoinDeploysNothingAndWritesWhatTheChainHolds() private {
        _back();
        _run(DEPLOYER, address(new Deploy()));
        _check(address(new VerifyCore()));
        OracleRegistry registry = OracleRegistry(_readAddress(path, K.ORACLE_REGISTRY));
        address carried = _readAddress(path, K.STAKING);
        assertEq(address(registry.staking()), carried, "the core run did not pair the registry to the carried pool");

        uint256 nonce = vm.getNonce(DEPLOYER);
        DeployStaking.Deployment memory out =
            abi.decode(_run(DEPLOYER, address(new DeployStaking())), (DeployStaking.Deployment));
        assertEq(vm.getNonce(DEPLOYER), nonce, "the join deployed something");
        assertEq(out.staking, carried);
        assertEq(out.buyback, _readAddress(previousPath, K.BUYBACK));
        assertEq(out.seeder, _readAddress(previousPath, K.SEEDER));

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonString(json, ".parameters.Staking.resolverBondFloor"), vm.toString(FLOOR));
        assertEq(vm.parseJsonUint(json, ".parameters.Staking.unbondingPeriod"), Staking(carried).unbondingPeriod());
        assertEq(vm.parseJsonUint(json, ".parameters.Buyback.poolFee"), 3000);
        assertEq(vm.parseJsonUint(json, ".parameters.Buyback.window"), 86_400);
        assertEq(vm.parseJsonUint(json, K.TOKEN_FROM_BLOCK), vm.parseJsonUint(_previousSaved, K.TOKEN_FROM_BLOCK));
        assertEq(vm.parseJsonBytes32(json, ".token.poolId"), vm.parseJsonBytes32(_previousSaved, ".token.poolId"));

        // The carried pool still answers to the previous credit pool, which is owed, not wrong.
        (uint256 mismatched, uint256 owedCount) = _tally(_pinned(address(new VerifyStakingProbe())));
        assertEq(mismatched, 0);
        assertEq(owedCount, 2, "the previous credit pool's two roles");

        // A second run is the same join: nothing to deploy, nothing to refuse.
        _run(DEPLOYER, address(new DeployStaking()));
    }

    /// A record that names the token set only after the core run has gone out leaves the pairing
    /// to the join, which closes it.
    function _theJoinClosesThePairingWhenTheCoreRunDidNot() private {
        _back();
        string memory carried = vm.readFile(nextPath);
        vm.writeJson("{}", nextPath, ".token");
        _run(DEPLOYER, address(new Deploy()));
        OracleRegistry registry = OracleRegistry(_readAddress(path, K.ORACLE_REGISTRY));
        assertEq(address(registry.staking()), address(0));

        string[7] memory token = [K.BRSR, K.VESTING, K.STAKING, K.BUYBACK, K.SEEDER, K.KEEPER, K.TOKEN_FROM_BLOCK];
        for (uint256 i; i < 6; ++i) {
            vm.writeJson(vm.toString(vm.parseJsonAddress(carried, token[i])), nextPath, token[i]);
        }
        vm.writeJson(vm.toString(vm.parseJsonUint(carried, token[6])), nextPath, token[6]);
        _run(DEPLOYER, address(new DeployStaking()));
        assertEq(address(registry.staking()), _readAddress(path, K.STAKING), "the join did not close the pairing");
        assertEq(address(registry.bondAsset()), _readAddress(path, K.BRSR));
        assertEq(
            vm.parseJsonBytes32(vm.readFile(nextPath), ".token.poolId"), vm.parseJsonBytes32(carried, ".token.poolId")
        );
    }

    /// Each carried contract has to be the one the record implies.
    function _theJoinRefusesASetThatIsNotTheRecords() private {
        _back();
        address carried = _readAddress(path, K.STAKING);
        address buyback = _readAddress(path, K.BUYBACK);
        address poolManager = _readAddress(path, K.POOL_MANAGER);

        // Two of three carried is not a carried set: the run deploys afresh and refuses what the
        // record holds, as it always did.
        vm.writeJson(vm.toString(makeAddr("neverLanded")), nextPath, K.SEEDER);
        _expectRefused(
            DEPLOYER,
            address(new DeployStaking()),
            "run()",
            abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.STAKING, carried)
        );

        // An entry that names another kind of contract fails on the first read it lacks.
        _back();
        address escrow = _readAddress(previousPath, K.ESCROW);
        vm.writeJson(vm.toString(escrow), nextPath, K.STAKING);
        _expectRefused(
            DEPLOYER,
            address(new DeployStaking()),
            "run()",
            abi.encodeWithSelector(BursarScript.NoAnswer.selector, "Staking.stakeToken", escrow)
        );

        // A buyback that compounds into another pool.
        _back();
        address other = address(
            new Staking(
                IERC20(_readAddress(path, K.BRSR)), IERC20(USDG), timelock, makeAddr("sink"), treasury, 7 days, 1e27
            )
        );
        vm.writeJson(vm.toString(_foreignBuyback(buyback, other)), nextPath, K.BUYBACK);
        _expectRefused(
            DEPLOYER,
            address(new DeployStaking()),
            "run()",
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "buyback.staking", carried, other)
        );

        // A seeder someone else owns.
        _back();
        address stranger = makeAddr("stranger");
        vm.writeJson(vm.toString(address(new V4LiquiditySeeder(poolManager, buyback, stranger))), nextPath, K.SEEDER);
        _expectRefused(
            DEPLOYER,
            address(new DeployStaking()),
            "run()",
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "seeder.owner", timelock, stranger)
        );
    }

    /// The carried buyback's twin, compounding into another staking pool.
    function _foreignBuyback(address buyback, address other) private returns (address) {
        return address(
            new Buyback(
                USDG,
                _readAddress(path, K.BRSR),
                _readAddress(path, K.POOL_MANAGER),
                3000,
                60,
                address(0),
                other,
                timelock,
                treasury,
                Buyback(buyback).params()
            )
        );
    }

    /// The floor is recorded as one figure, so every recorded resolver has to hold it.
    function _theJoinRefusesFloorsNobodyNamed() private {
        _back();
        address[] memory four = new address[](4);
        for (uint256 i; i < 3; ++i) {
            four[i] = resolvers[i];
        }
        four[3] = address(0x1004);
        _copyAddressesInto(four, K.RESOLVERS);
        _expectRefused(
            DEPLOYER,
            address(new DeployStaking()),
            "run()",
            abi.encodeWithSelector(DeployStaking.BondFloorNotSet.selector, address(0x1004))
        );

        _back();
        vm.prank(timelock);
        Staking(_readAddress(path, K.STAKING)).setBondFloor(resolvers[2], 40_000e18);
        _expectRefused(
            DEPLOYER,
            address(new DeployStaking()),
            "run()",
            abi.encodeWithSelector(DeployStaking.BondFloorsDiffer.selector, resolvers[2], 40_000e18, FLOOR)
        );
    }

    function _copyAddressesInto(address[] memory values, string memory key) private {
        string memory list = "[";
        for (uint256 i; i < values.length; ++i) {
            list = string.concat(list, i == 0 ? "" : ",", _quoted(vm.toString(values[i])));
        }
        vm.writeJson(string.concat(list, "]"), nextPath, key);
    }

    /// The previous record has to be the one `supersedes` names.
    function _aPreviousRecordTheNewOneDoesNotSupersedeIsRefused() private {
        _back();
        _set("BURSAR_PREVIOUS_RECORD", nextPath);
        _expectRefused(
            DEPLOYER,
            address(new MigrateCredit()),
            "run()",
            abi.encodeWithSelector(BursarScript.PreviousRecordMismatch.selector, "local-4663", "local-4663-next")
        );
        _set("BURSAR_PREVIOUS_RECORD", "");
        _expectRefused(
            DEPLOYER,
            address(new MigrateCredit()),
            "run()",
            abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_PREVIOUS_RECORD"))
        );
    }

    /// Every step of the runbook, in its order, with the waits skipped on the clock.
    function _theWholeMoveInTheRunbooksOrder() private {
        _back();
        _deployTheNewSet();
        _proposeTheWiring();
        _moveWhatNeedsNoGovernance();
        _landTheWiringAndGoLive();
        _reclaimAndRetire();
        _lanes(path);
    }

    /// 1. The new set, on top of the carried one. The apps cannot move yet: no examples, and the
    /// wiring has not landed.
    function _deployTheNewSet() private {
        _run(DEPLOYER, address(new Deploy()));
        _run(DEPLOYER, address(new DeployStaking()));
        _rwa();
        _collateral();
        _privacy();
        // The lanes' shielded proofs were made for a pool at the address this nonce gives it.
        vm.setNonce(DEPLOYER, SHIELDED_NONCE);
        _as(DEPLOYER, _deployShieldedScript(), abi.encodeWithSignature("run()"));
        pool = _readAddress(path, K.CREDIT_POOL);
        previousPool = _readAddress(previousPath, K.CREDIT_POOL);
        staking = Staking(_readAddress(path, K.STAKING));
        assertEq(staking.creditManager(), previousPool);
        (uint256 mismatched, uint256 owedCount) = _tally(_pinned(address(new VerifyStakingProbe())));
        assertEq(mismatched, 0);
        assertEq(owedCount, 2, "both roles still name the previous pool");

        _expectRefused(
            DEPLOYER,
            address(new RetireRecords()),
            "goLive()",
            abi.encodeWithSelector(
                RetireRecords.NotReadyForLive.selector, "exampleMandate: MigrateExamples.s.sol create() has not run"
            )
        );
    }

    /// 2. The wiring: only what differs on the carried contracts, and the wind-down.
    function _proposeTheWiring() private {
        AdminTimelock governance = AdminTimelock(timelock);
        uint256 before = governance.proposalCount();
        _step(signers[0], address(new ProposeWiring()), "propose()");
        assertEq(governance.proposalCount(), before + 3, "keeper, floors and tiers were proposed again");
        _step(signers[1], address(new ProposeWiring()), "approve()");
        address early = _pinned(address(new ProposeWiring()));
        vm.expectPartialRevert(Governance.DelayNotPassed.selector);
        _as(signers[0], early, abi.encodeWithSignature("execute()"));
    }

    /// 3. What needs no governance: the previous escrow settled, the examples drained, the lending
    /// cash moved, the payee and the resolvers seated on the new set, the examples created.
    function _moveWhatNeedsNoGovernance() private {
        IERC20 usdg = IERC20(USDG);
        Escrow previousEscrow = Escrow(_readAddress(previousPath, K.ESCROW));
        vm.warp(block.timestamp + 31 minutes);
        _step(DEPLOYER, address(new RetireRecords()), "settle()");
        assertEq(uint8(previousEscrow.getLock(2).status), uint8(IEscrow.LockStatus.TimedOut));
        assertEq(previousEscrow.feesAccrued(), 0);
        assertEq(usdg.balanceOf(address(previousEscrow)), 0, "the previous escrow still holds USDG");

        uint256 payerBefore = usdg.balanceOf(EXAMPLE_PAYER);
        _step(EXAMPLE_PAYER, address(new MigrateExamples()), "drain()");
        assertEq(usdg.balanceOf(EXAMPLE_PAYER), payerBefore + 200_000 + 50_000, "the examples' USDG did not come back");
        assertEq(IERC20(_stock("SPY")).balanceOf(EXAMPLE_PAYER), 1e18, "the collateral example's SPY did not come back");
        assertEq(IERC20(_stock("SPY")).balanceOf(_readAddress(previousPath, K.COLLATERAL_VAULT)), 0);

        uint256 lenderBefore = usdg.balanceOf(DEPLOYER);
        _run(DEPLOYER, address(new MigrateCredit()));
        assertEq(CreditPool(previousPool).cash(), 0);
        assertEq(usdg.balanceOf(DEPLOYER), lenderBefore + 10e6);
        MigrateCredit credit = MigrateCredit(_pinned(address(new MigrateCredit())));
        _as(DEPLOYER, address(credit), abi.encodeCall(credit.fund, (10e6)));
        assertEq(CreditPool(pool).cash(), 10e6);

        _seatThePayeeAndTheResolvers();

        _committedTerms(true);
        _step(EXAMPLE_PAYER, address(new MigrateExamples()), "create()");
        _committedTerms(false);
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonBytes32(json, ".exampleMandate.salt"), keccak256("bursar.example-mandate.local-4663-next"));
        assertTrue(vm.parseJsonAddress(json, ".exampleCommittedMandate.address").code.length != 0);
        assertEq(
            CollateralVault(_readAddress(path, K.COLLATERAL_VAULT))
                .collateralOf(vm.parseJsonAddress(json, ".exampleCollateralMandate.address"), _stock("SPY")),
            1e18,
            "the SPY was not posted to the new vault"
        );
    }

    /// The payee registers under its old name and leaves the previous registry; each resolver
    /// bonds at once, because the floors live on the carried pool, and asks for its old bond back.
    function _seatThePayeeAndTheResolvers() private {
        MockUsdg(USDG).mint(payee, 5e6);
        _run(payee, address(new MigratePayee()));
        AgentRegistry agents = AgentRegistry(_readAddress(path, K.AGENT_REGISTRY));
        AgentRegistry previousAgents = AgentRegistry(_readAddress(previousPath, K.AGENT_REGISTRY));
        assertTrue(agents.isActive(payee), "the payee is not active on the new registry");
        assertEq(agents.getAgent(payee).name, "example_payee", "the payee lost its name");
        assertFalse(previousAgents.isActive(payee));
        (uint128 leaving,) = previousAgents.withdrawals(payee);
        assertEq(leaving, 5e6, "the old stake was not asked back");

        OracleRegistry registry = OracleRegistry(_readAddress(path, K.ORACLE_REGISTRY));
        OracleRegistry previousRegistry = OracleRegistry(_readAddress(previousPath, K.ORACLE_REGISTRY));
        _step(treasury, address(new MigrateResolvers()), "fund()");
        for (uint256 i; i < resolvers.length; ++i) {
            _step(resolvers[i], address(new MigrateResolvers()), "bond()");
            assertEq(registry.getResolver(resolvers[i]).bond, FLOOR);
            assertEq(
                uint8(previousRegistry.getResolver(resolvers[i]).status),
                uint8(IOracleRegistry.ResolverStatus.Unbonding)
            );
        }
    }

    /// 4. The wiring lands, the records change hands, and the strict check finds nothing owed. The
    /// previous record cannot retire yet: the old stake and bonds are still held.
    function _landTheWiringAndGoLive() private {
        vm.warp(block.timestamp + AdminTimelock(timelock).timelockPeriod());
        _step(signers[0], address(new ProposeWiring()), "execute()");
        _check(address(new VerifyWiring()));
        assertEq(staking.creditManager(), pool);
        assertEq(staking.slasher(), pool);
        assertTrue(
            IShieldedPoolReads(_readAddress(previousPath, K.SHIELDED_POOL)).dead(), "the previous pool takes deposits"
        );
        assertFalse(IShieldedPoolReads(_readAddress(path, K.SHIELDED_POOL)).dead());

        _step(DEPLOYER, address(new RetireRecords()), "goLive()");
        assertEq(vm.parseJsonString(vm.readFile(path), K.STATUS), "live");
        assertEq(vm.parseJsonString(vm.readFile(previousPath), K.STATUS), "superseded");
        assertEq(vm.parseJsonString(vm.readFile(previousPath), K.SUPERSEDED_BY), "local-4663-next");

        _set("BURSAR_VERIFY_STRICT", "1");
        (uint256 mismatched, uint256 owedCount) = _tally(_pinned(address(new VerifyProbe())));
        assertEq(mismatched, 0);
        assertEq(owedCount, 0, "something is still owed after the wiring landed");
        _set("BURSAR_VERIFY_STRICT", "0");

        _expectRefused(
            DEPLOYER, address(new RetireRecords()), "run()", abi.encodeWithSelector(RetireRecords.StillOpen.selector, 2)
        );
    }

    /// Stock a write-off seized sits in the previous vault until the lender claims it, and holds
    /// the record open until then. The seizure is written into the vault's ledger here, the way a
    /// write-off would leave it.
    function _claimWhatAWriteOffSeized() private {
        CollateralVault vault = CollateralVault(_readAddress(previousPath, K.COLLATERAL_VAULT));
        address spy = _stock("SPY");
        MockStock(spy).mint(address(vault), 1e17);
        stdstore.target(address(vault)).sig(vault.seized.selector).with_key(spy).checked_write(uint256(1e17));
        _expectRefused(
            DEPLOYER, address(new RetireRecords()), "run()", abi.encodeWithSelector(RetireRecords.StillOpen.selector, 1)
        );

        uint256 before = IERC20(spy).balanceOf(DEPLOYER);
        _step(DEPLOYER, address(new MigrateCredit()), "claimSeized()");
        assertEq(IERC20(spy).balanceOf(DEPLOYER), before + 1e17, "the lender was not paid what was seized");
        assertEq(vault.seized(spy), 0);
    }

    /// 5. Seven days later the old bonds and stake come back, and the previous record retires. The
    /// buyback's ceiling has aged out by then, as the runbook warns, and governance restates it
    /// before the last strict check.
    function _reclaimAndRetire() private {
        vm.warp(block.timestamp + 7 days + 1);
        Buyback buyback = Buyback(_readAddress(path, K.BUYBACK));
        Buyback.Params memory params = buyback.params();
        vm.prank(timelock);
        buyback.setParams(params);
        IERC20 brsr = IERC20(_readAddress(path, K.BRSR));
        IERC20 usdg = IERC20(USDG);
        uint256 treasuryBefore = brsr.balanceOf(treasury);
        for (uint256 i; i < resolvers.length; ++i) {
            _step(resolvers[i], address(new MigrateResolvers()), "reclaim()");
        }
        assertEq(brsr.balanceOf(treasury), treasuryBefore + 3 * FLOOR);
        assertEq(OracleRegistry(_readAddress(previousPath, K.ORACLE_REGISTRY)).totalBonded(), 0);
        uint256 payeeBefore = usdg.balanceOf(payee);
        _step(payee, address(new MigratePayee()), "reclaim()");
        assertEq(usdg.balanceOf(payee), payeeBefore + 5e6);
        _step(DEPLOYER, address(new RetireRecords()), "settle()");
        _step(EXAMPLE_PAYER, address(new MigrateExamples()), "drain()");
        _claimWhatAWriteOffSeized();

        _run(DEPLOYER, address(new RetireRecords()));
        string memory previous = vm.readFile(previousPath);
        assertEq(vm.parseJsonString(previous, K.STATUS), "retired");
        assertEq(vm.parseJsonString(previous, K.SUPERSEDED_BY), "local-4663-next");
        assertGt(bytes(vm.parseJsonString(previous, K.RETIRED)).length, 0);
        assertEq(vm.parseJsonString(vm.readFile(path), K.STATUS), "live");
        // What the record held is kept: retiring only adds fields.
        assertEq(vm.parseJsonAddress(previous, K.ESCROW), _readAddress(previousPath, K.ESCROW));

        _set("BURSAR_VERIFY_STRICT", "1");
        (uint256 mismatched, uint256 owedCount) = _tally(_pinned(address(new VerifyProbe())));
        assertEq(mismatched, 0);
        assertEq(owedCount, 0);
        _set("BURSAR_VERIFY_STRICT", "0");
    }
}
