// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AcceptGovernance} from "../../script/AcceptGovernance.s.sol";
import {DeployCollateral} from "../../script/DeployCollateral.s.sol";
import {DeployRwa} from "../../script/DeployRwa.s.sol";
import {HandoverGovernance} from "../../script/HandoverGovernance.s.sol";
import {MigrateCredit} from "../../script/MigrateCredit.s.sol";
import {MigrateExamples} from "../../script/MigrateExamples.s.sol";
import {ProposeWiring} from "../../script/ProposeWiring.s.sol";
import {RetireRecords} from "../../script/RetireRecords.s.sol";
import {Verify} from "../../script/Verify.s.sol";
import {VerifyCollateral} from "../../script/VerifyCollateral.s.sol";
import {VerifyRwa} from "../../script/VerifyRwa.s.sol";
import {IShieldedPoolReads} from "../../script/VerifyShielded.s.sol";
import {VerifyWiring} from "../../script/VerifyWiring.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {Governance} from "../../script/lib/Governance.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {TreasuryPark} from "../../src/rwa/TreasuryPark.sol";
import {Staking} from "../../src/token/Staking.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockStock} from "../rwa/RwaMocks.sol";
import {LaneFlows} from "./LaneFlows.sol";
import {World} from "./World.sol";

contract LaneRwaProbe is VerifyRwa {
    function tally() external view returns (uint256, uint256) {
        return (mismatches, owed);
    }
}

/// The move that rebuilds the collateral lane and carries everything else over, through the real
/// scripts. A whole set is built, wired, funded and in use with its three examples; then a record
/// is planned on top of it naming all of it but the lane, and every step of `MIGRATION-V5.md` runs
/// between the two records in the runbook's order. Once under the set's own one-hour timelock, and
/// once after the 48-hour governance handover has landed, when the wiring goes to the new timelock
/// and waits out its two days. A lane record written for the finished handover while its
/// acceptances still wait is refused before anything is sent.
contract MigrateLaneTest is World, LaneFlows {
    address internal constant EXAMPLE_PAYER = address(0xE2E00021);
    address internal constant HW_1 = address(0x4801);
    address internal constant HW_2 = address(0x4802);
    address internal constant HW_3 = address(0x4803);
    uint256 internal constant COMMUNITY = 1_000e18;

    string internal previousPath;
    string internal nextPath;

    uint256 private _state;
    string private _previousSaved;

    function _prefix() internal pure override returns (string memory) {
        return "MIGRATELANE_";
    }

    function setUp() public {
        _world("lane-previous");
        previousPath = path;
        nextPath = string.concat(RECORDS, "/lane-next.json");
        _core();
        _token();
        _staking();
        _seed();
        _rwa();
        _collateral();
        _privacy();
        // The lanes' shielded proofs were made for a pool at the address this nonce gives it, and
        // the pool carries over to the new record.
        vm.setNonce(DEPLOYER, SHIELDED_NONCE);
        _as(DEPLOYER, _deployShieldedScript(), abi.encodeWithSignature("run()"));
        _wiring();
        _fundCredit();

        // The set in use: the three examples, the collateral one with stock posted, and the record
        // live. The community allocation sits with the timelock, as it does on the chain.
        MockUsdg(USDG).mint(EXAMPLE_PAYER, 1e6);
        MockStock(_stock("SPY")).mint(EXAMPLE_PAYER, 1e18);
        _committedTerms(true);
        _step(EXAMPLE_PAYER, address(new MigrateExamples()), "create()");
        _committedTerms(false);
        _step(DEPLOYER, address(new RetireRecords()), "goLive()");
        vm.prank(_readAddress(path, K.COMMUNITY));
        IERC20(_readAddress(path, K.BRSR)).transfer(_readAddress(path, K.ADMIN_TIMELOCK), COMMUNITY);

        _set("BURSAR_SIGNERS_48H", string.concat(vm.toString(HW_1), ",", vm.toString(HW_2), ",", vm.toString(HW_3)));
        _unset("BURSAR_GUARDIAN_48H");
        _previousSaved = vm.readFile(previousPath);
        _state = vm.snapshotState();
    }

    function _back() private {
        vm.revertToState(_state);
        _state = vm.snapshotState();
        vm.writeFile(previousPath, _previousSaved);
        path = previousPath;
        _set("BURSAR_RECORD", previousPath);
        _unset("BURSAR_PREVIOUS_RECORD");
    }

    /// The next record: the previous one as it stands, less the collateral lane, planned.
    function _plan() private {
        string memory previous = vm.readFile(previousPath);
        vm.writeFile(nextPath, previous);
        vm.writeJson('"local-4663-lane"', nextPath, K.NETWORK);
        vm.writeJson('"planned"', nextPath, K.STATUS);
        vm.writeJson(string.concat('"', vm.parseJsonString(previous, K.NETWORK), '"'), nextPath, K.SUPERSEDES);
        vm.writeJson("{}", nextPath, ".verifiedOnChain");
        _stripLane(nextPath);
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

    function _signers() private view returns (address[] memory) {
        return vm.parseJsonAddressArray(vm.readFile(path), K.SIGNERS);
    }

    function test_migrateLane_rebuildsTheCollateralLaneUnderEitherGovernance() public {
        _theMoveUnderTheRecordsTimelock();
        _theMoveAfterTheHandoverLanded();
        _aLaneRecordWrittenForAPendingHandoverIsRefused();
    }

    function _theMoveUnderTheRecordsTimelock() private {
        _back();
        _plan();
        _theWholeMove();
    }

    /// The handover first, through its own scripts, as `GOVERNANCE-48H.md` runs it. The lane record
    /// is planned on the finished record, so the wiring goes to the 48-hour timelock from the
    /// hardware keys.
    function _theMoveAfterTheHandoverLanded() private {
        _back();
        _handover(true);
        assertEq(_readAddress(previousPath, K.ADMIN_TIMELOCK), _readAddress(previousPath, K.GOVERNANCE48_TIMELOCK));
        _plan();
        assertEq(AdminTimelock(_readAddress(path, K.ADMIN_TIMELOCK)).timelockPeriod(), 48 hours);
        assertEq(_signers()[0], HW_1);
        _theWholeMove();
    }

    /// A lane record written as the fourth reads after `finish()`, while the acceptances still wait:
    /// the carried registry answers to the one-hour timelock, and the join refuses by name.
    function _aLaneRecordWrittenForAPendingHandoverIsRefused() private {
        _back();
        _handover(false);
        address previous = _readAddress(previousPath, K.ADMIN_TIMELOCK);
        address next = _readAddress(previousPath, K.GOVERNANCE48_TIMELOCK);
        _plan();
        vm.writeJson(vm.toString(next), path, K.ADMIN_TIMELOCK);
        vm.writeJson(vm.toString(previous), path, K.ESCROW_PAUSER);
        vm.writeJson(
            string.concat('["', vm.toString(HW_1), '","', vm.toString(HW_2), '","', vm.toString(HW_3), '"]'),
            path,
            K.SIGNERS
        );
        _expectRefused(
            DEPLOYER,
            address(new DeployRwa()),
            "run()",
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "registry.admin", next, previous)
        );
    }

    /// `GOVERNANCE-48H.md` on the previous record: the new timelock deployed, the old one's offers
    /// executed after its hour, the new one's acceptances proposed and approved by the hardware
    /// keys and, when `land` is set, executed after its two days, with the record rewritten.
    function _handover(bool land) private {
        address[] memory old = _signers();
        AdminTimelock timelock = AdminTimelock(_readAddress(path, K.ADMIN_TIMELOCK));
        _step(DEPLOYER, address(new HandoverGovernance()), "deploy()");
        _step(old[0], address(new HandoverGovernance()), "propose()");
        _step(old[1], address(new HandoverGovernance()), "approve()");
        vm.warp(block.timestamp + timelock.timelockPeriod());
        _step(old[0], address(new HandoverGovernance()), "execute()");
        _step(HW_1, address(new AcceptGovernance()), "propose()");
        _step(HW_2, address(new AcceptGovernance()), "approve()");
        if (!land) return;
        vm.warp(block.timestamp + 48 hours);
        _step(HW_3, address(new AcceptGovernance()), "execute()");
        _step(DEPLOYER, address(new HandoverGovernance()), "finish()");
    }

    function _theWholeMove() private {
        _deployTheLane();
        _proposeTheWiring();
        _moveWhatNeedsNoGovernance();
        _landTheWiringAndGoLive();
        _retireThePreviousRecord();
        _lanes(path);
    }

    /// 1. Only the lane: the RWA run joins the carried registry and park and deploys the three
    /// contracts that hold the guard; the collateral run deploys the pool and the vault. The carried
    /// staking pool still answers to the previous pool.
    function _deployTheLane() private {
        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        uint256 nonce = vm.getNonce(DEPLOYER);
        DeployRwa.Deployment memory rwa = abi.decode(_run(DEPLOYER, address(new DeployRwa())), (DeployRwa.Deployment));
        assertEq(
            vm.getNonce(DEPLOYER), nonce + 3, "the RWA run deployed more than the guard, the router and the adapter"
        );
        assertEq(address(rwa.registry), _readAddress(previousPath, K.ASSET_REGISTRY));
        assertEq(address(rwa.park), _readAddress(previousPath, K.TREASURY_PARK));
        assertTrue(address(rwa.guard) != _readAddress(previousPath, K.PRICE_GUARD), "the guard was not rebuilt");
        assertEq(rwa.guard.admin(), timelock);
        assertTrue(rwa.guard.isKeeper(_readAddress(path, ".rwa.guardKeeper")));
        (uint256 mismatched, uint256 owedCount) = _tally(_pinned(address(new LaneRwaProbe())));
        assertEq(mismatched, 0);
        assertEq(owedCount, 1, "the adapter switch is owed to the wiring batch");

        _run(DEPLOYER, address(new DeployCollateral()));
        _check(address(new VerifyCollateral()));
        CreditPool pool = CreditPool(_readAddress(path, K.CREDIT_POOL));
        assertEq(pool.admin(), timelock);
        assertEq(address(CollateralVault(_readAddress(path, K.COLLATERAL_VAULT)).guard()), address(rwa.guard));
        assertEq(Staking(_readAddress(path, K.STAKING)).creditManager(), _readAddress(previousPath, K.CREDIT_POOL));
        assertEq(
            vm.parseJsonUint(vm.readFile(path), K.RWA_FROM_BLOCK),
            vm.parseJsonUint(vm.readFile(previousPath), K.RWA_FROM_BLOCK),
            "the lane's first block was rewritten"
        );
    }

    /// 2. Four calls on the timelock that governs the carried contracts: the credit pool's two
    /// roles on the staking pool and the adapter switch on the park. The carried shielded pool is
    /// not wound down.
    function _proposeTheWiring() private {
        AdminTimelock timelock = AdminTimelock(_readAddress(path, K.ADMIN_TIMELOCK));
        address[] memory signers = _signers();
        uint256 before = timelock.proposalCount();
        _step(signers[0], address(new ProposeWiring()), "propose()");
        assertEq(timelock.proposalCount(), before + 4, "more than the two roles and the adapter switch went up");
        _step(signers[1], address(new ProposeWiring()), "approve()");
        address early = _pinned(address(new ProposeWiring()));
        vm.expectPartialRevert(Governance.DelayNotPassed.selector);
        _as(signers[0], early, abi.encodeWithSignature("execute()"));
    }

    /// 3. The carried escrow has nothing to settle, the public and committed examples stay as they
    /// are, the collateral example's stock comes out of the previous vault, the lending cash moves,
    /// and the new collateral example is created with that stock posted.
    function _moveWhatNeedsNoGovernance() private {
        IERC20 usdg = IERC20(USDG);
        address lender = _readAddress(path, K.LENDER);
        address publicExample = _readAddress(previousPath, ".exampleMandate.address");
        address committed = _readAddress(previousPath, ".exampleCommittedMandate.address");
        address previousPool = _readAddress(previousPath, K.CREDIT_POOL);
        IERC20 spy = IERC20(_stock("SPY"));

        _step(DEPLOYER, address(new RetireRecords()), "settle()");
        uint256 publicBefore = usdg.balanceOf(publicExample);
        uint256 committedBefore = usdg.balanceOf(committed);
        _step(EXAMPLE_PAYER, address(new MigrateExamples()), "drain()");
        assertEq(usdg.balanceOf(publicExample), publicBefore, "the carried public example was drained");
        assertEq(usdg.balanceOf(committed), committedBefore, "the carried committed example was drained");
        assertEq(spy.balanceOf(EXAMPLE_PAYER), 1e18, "the collateral example's SPY did not come back");
        assertEq(spy.balanceOf(_readAddress(previousPath, K.COLLATERAL_VAULT)), 0);

        uint256 lenderBefore = usdg.balanceOf(lender);
        _run(lender, address(new MigrateCredit()));
        assertEq(CreditPool(previousPool).cash(), 0);
        assertEq(usdg.balanceOf(lender), lenderBefore + 10e6);
        MigrateCredit credit = MigrateCredit(_pinned(address(new MigrateCredit())));
        _as(lender, address(credit), abi.encodeCall(credit.fund, (10e6)));
        assertEq(CreditPool(_readAddress(path, K.CREDIT_POOL)).cash(), 10e6);

        _committedTerms(true);
        _step(EXAMPLE_PAYER, address(new MigrateExamples()), "create()");
        _committedTerms(false);
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".exampleMandate.address"), publicExample, "the public example was replaced");
        assertEq(
            vm.parseJsonAddress(json, ".exampleCommittedMandate.address"), committed, "the committed example moved"
        );
        address example = vm.parseJsonAddress(json, ".exampleCollateralMandate.address");
        assertTrue(
            example != _readAddress(previousPath, ".exampleCollateralMandate.address"), "no new collateral example"
        );
        assertEq(
            vm.parseJsonBytes32(json, ".exampleCollateralMandate.salt"),
            keccak256("bursar.collateral-mandate.local-4663-lane")
        );
        assertEq(
            CollateralVault(_readAddress(path, K.COLLATERAL_VAULT)).collateralOf(example, address(spy)),
            1e18,
            "the SPY was not posted to the new vault"
        );

        _expectRefused(
            DEPLOYER,
            address(new RetireRecords()),
            "goLive()",
            abi.encodeWithSelector(
                RetireRecords.NotReadyForLive.selector, "Staking.creditManager: the wiring has not landed"
            )
        );
    }

    /// 4. After the delay the batch lands: the roles move, the park switches adapters, the carried
    /// shielded pool stays open, the record goes live and the strict check finds nothing owed.
    function _landTheWiringAndGoLive() private {
        AdminTimelock timelock = AdminTimelock(_readAddress(path, K.ADMIN_TIMELOCK));
        vm.warp(block.timestamp + timelock.timelockPeriod());
        _step(_signers()[0], address(new ProposeWiring()), "execute()");
        _check(address(new VerifyWiring()));
        address pool = _readAddress(path, K.CREDIT_POOL);
        Staking staking = Staking(_readAddress(path, K.STAKING));
        assertEq(staking.creditManager(), pool);
        assertEq(staking.slasher(), pool);
        TreasuryPark park = TreasuryPark(_readAddress(path, K.TREASURY_PARK));
        assertTrue(park.isAdapter(_readAddress(path, K.SGOV_ADAPTER)), "the new treasury adapter is not listed");
        assertFalse(park.isAdapter(_readAddress(previousPath, K.SGOV_ADAPTER)), "the previous adapter is still listed");
        assertFalse(IShieldedPoolReads(_readAddress(path, K.SHIELDED_POOL)).dead(), "the carried pool was wound down");

        _step(DEPLOYER, address(new RetireRecords()), "goLive()");
        assertEq(vm.parseJsonString(vm.readFile(path), K.STATUS), "live");
        assertEq(vm.parseJsonString(vm.readFile(previousPath), K.STATUS), "superseded");
        assertEq(vm.parseJsonString(vm.readFile(previousPath), K.SUPERSEDED_BY), "local-4663-lane");

        _set("BURSAR_VERIFY_STRICT", "1");
        _check(address(new Verify()));
        _unset("BURSAR_VERIFY_STRICT");
    }

    /// 5. Nothing on the previous lane is still open, so its record retires at once and says what
    /// was checked and what carried over.
    function _retireThePreviousRecord() private {
        _run(DEPLOYER, address(new RetireRecords()));
        string memory previous = vm.readFile(previousPath);
        assertEq(vm.parseJsonString(previous, K.STATUS), "retired");
        string memory reason = vm.parseJsonString(previous, K.RETIRED);
        assertTrue(vm.indexOf(reason, "credit pool or collateral vault") != type(uint256).max, reason);
        assertTrue(vm.indexOf(reason, "escrow, registries and shielded pool carry over") != type(uint256).max, reason);
        assertEq(vm.parseJsonString(vm.readFile(path), K.STATUS), "live");
    }

    function _tally(address probe) private returns (uint256 mismatched, uint256 owedCount) {
        (bool ok,) = probe.call(abi.encodeWithSignature("run()"));
        assertTrue(ok, "the check failed");
        (mismatched, owedCount) = LaneRwaProbe(probe).tally();
    }
}
