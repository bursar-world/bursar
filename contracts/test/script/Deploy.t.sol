// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deploy} from "../../script/Deploy.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {Escrow} from "../../src/Escrow.sol";
import {MandateAccountFactory} from "../../src/MandateAccountFactory.sol";
import {OracleRegistry} from "../../src/OracleRegistry.sol";
import {Reputation} from "../../src/Reputation.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {IReputation} from "../../src/interfaces/IReputation.sol";
import {BrakeTarget, MuteTarget} from "../TimelockAndDeploy.t.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {ScriptHarness} from "./ScriptHarness.sol";

/// A settlement asset at the wrong scale. USDG is six decimals and the whole accounting surface
/// assumes it.
contract WideDecimalsToken {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// The core deploy script, driven through the record and the environment it reads. Every case
/// that varies a variable lives in one function and runs in order, because the environment is
/// process-wide and test functions run in parallel.
contract DeployScriptTest is ScriptHarness {
    uint256 internal constant RHC_CHAIN_ID = 4663;
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant MIN_SETTLEMENT_BALANCE = 1_000_000;
    string internal constant EOA_ACK = "i-accept-eoa-governance";
    string internal constant RECORD = "deploy-core";

    Deploy internal script;
    MockUsdg internal settlement;

    /// The script insists one signer holds code, in practice a multisig, unless told otherwise.
    address internal multisigSigner;
    address internal signerB;
    address internal signerC;
    address internal guardian;
    address internal treasury;
    address internal slashSink;
    uint256 internal homeChain;
    string internal path;

    function _prefix() internal pure override returns (string memory) {
        return "COREDEPLOY_";
    }

    function setUp() public {
        settlement = new MockUsdg();
        multisigSigner = address(new BrakeTarget());
        signerB = makeAddr("deploySignerB");
        signerC = makeAddr("deploySignerC");
        guardian = makeAddr("deployGuardian");
        treasury = makeAddr("deployTreasury");
        slashSink = makeAddr("deploySlashSink");
        homeChain = block.chainid;

        script = new Deploy();
        script.pinEnvPrefix(_prefix());
    }

    function test_deployScript_refusesBadParametersAndDeploysGoodOnes() public {
        _caseWrongChain();
        _caseARecordForAnotherChain();
        _caseALocalRecordNeedsTheLocalFlag();
        _caseSentinelAddressReadsAsUnset();
        _caseEmptyAmountReadsAsUnset();
        _caseAmountThatIsNotANumber();
        _caseAddressThatIsNotAnAddress();
        _caseEmptyBoolean();
        _caseBooleanThatIsNotSpelledOut();
        _caseValueTooWideForItsField();
        _caseAssetIsNotAContract();
        _caseAssetCannotAnswerDecimals();
        _caseAssetAtTheWrongScale();
        _caseAShellThatNamesAnotherAsset();
        _caseFeesConsumeAWholeSettlement();
        _caseEscrowsTighterFeeCeiling();
        _caseDisputeBondAtPar();
        _caseTheRetiredDisputeTimeoutVariableIsRefused();
        _caseAMinimumLockTooSmallToCarryABond();
        _caseACapCeilingNoScoreReaches();
        _caseAVoterCapBelowTheRoster();
        _caseAVoteWindowUnderTenMinutes();
        _caseZeroTimelockPeriod();
        _casePeriodBelowTheTimelocksOwnFloor();
        _caseZeroBaseCap();
        _caseResolverSlashOfZero();
        _caseDeployKeyCarriesGovernance();
        _caseGuardianAlsoCarriesAnApproval();
        _caseDeployKeyIsTheTreasury();
        _caseOneAddressForFeesAndSlashedCollateral();
        _caseEveryChainDemandsAMultisigOrAnExplicitAcknowledgement();
        _caseTheRetiredResolverBondVariableIsRefused();
        _caseAForeignEnvironmentCannotReachThisRun();
        _caseTheMinimalSetLeavesThePartyGateOpen();
        _caseDeploysTheSetThenReadsItsOwnWiringBack();
        _caseTheRunRecordsWhatItDeployed();
        _caseASecondRunRefusesWhatTheRecordHolds();
        _caseAStaleEntryIsReplaced();
        _caseTheRecordedRolesWinAndAShellMayNotDisagree();
        _caseTheRecordedDeployerIsTheOnlyKey();
        _caseGovernanceAddressHoldsNoCode();
        _caseLiveGovernanceDisagreesWithTheParameterFile();
        _caseJoinsGovernanceThatIsAlreadyLive();
        _caseJoinsGovernanceTheRecordNames();
        _caseRobinhoodChainPinsTheUsdgAddress();
        _caseTheSettlementAssetHasToBeAbleToMove();
    }

    function _caseWrongChain() private {
        _setBaseEnv();
        _set("BURSAR_CHAIN_ID", vm.toString(homeChain + 1));

        vm.expectRevert(abi.encodeWithSelector(BursarScript.WrongChain.selector, homeChain + 1, homeChain));
        script.run();
    }

    /// A record belongs to one chain, and an RPC pointed at another stops the run before anything
    /// is read from it.
    function _caseARecordForAnotherChain() private {
        _setBaseEnv();
        path = _useRecord(RECORD, _baseRecord("test-core", homeChain + 7, true, address(settlement)));

        vm.expectRevert(abi.encodeWithSelector(BursarScript.RecordChainMismatch.selector, homeChain + 7, homeChain));
        script.run();
    }

    /// The flag and the record have to agree, so neither a stray flag nor a missing one can
    /// point a rehearsal record at mainnet or the reverse.
    function _caseALocalRecordNeedsTheLocalFlag() private {
        _setBaseEnv();
        _unset("BURSAR_LOCAL");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.LocalFlagMismatch.selector, false, true));
        script.run();

        _setBaseEnv();
        path = _useRecord(RECORD, _baseRecord("test-core", homeChain, false, address(settlement)));
        vm.expectRevert(abi.encodeWithSelector(BursarScript.LocalFlagMismatch.selector, true, false));
        script.run();

        // Off the local flag, only Robinhood Chain is a target.
        _setBaseEnv();
        path = _useRecord(RECORD, _baseRecord("test-core", homeChain, false, address(settlement)));
        _unset("BURSAR_LOCAL");
        vm.expectRevert(abi.encodeWithSelector(BursarScript.WrongChain.selector, RHC_CHAIN_ID, homeChain));
        script.run();
    }

    /// Address zero is how the script tells a variable nobody set from a value someone chose.
    function _caseSentinelAddressReadsAsUnset() private {
        _setBaseEnv();
        _set("BURSAR_TREASURY", vm.toString(address(0)));

        vm.expectRevert(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_TREASURY")));
        script.run();
    }

    function _caseEmptyAmountReadsAsUnset() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", "");

        vm.expectRevert(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_FEE_BPS")));
        script.run();
    }

    /// A value that is set but does not parse is named with what it holds. Foundry's own reader
    /// would have answered it as unset, and the run would have called it missing.
    function _caseAmountThatIsNotANumber() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", "1%");

        vm.expectRevert(abi.encodeWithSelector(BursarScript.InvalidEnv.selector, _key("BURSAR_FEE_BPS"), "1%"));
        script.run();
    }

    function _caseAddressThatIsNotAnAddress() private {
        _setBaseEnv();
        _set("BURSAR_TREASURY", "0x9965507D1a55bcC2695C58ba16FB37d819B0A4");

        vm.expectRevert(
            abi.encodeWithSelector(
                BursarScript.InvalidEnv.selector, _key("BURSAR_TREASURY"), "0x9965507D1a55bcC2695C58ba16FB37d819B0A4"
            )
        );
        script.run();
    }

    /// An unset boolean would otherwise read as false and quietly drop the registry.
    function _caseEmptyBoolean() private {
        _setBaseEnv();
        _set("BURSAR_DEPLOY_AGENT_REGISTRY", "");

        vm.expectRevert(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_DEPLOY_AGENT_REGISTRY")));
        script.run();
    }

    function _caseBooleanThatIsNotSpelledOut() private {
        _setBaseEnv();
        _set("BURSAR_DEPLOY_AGENT_REGISTRY", "yes");

        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.EnvNotBoolean.selector, _key("BURSAR_DEPLOY_AGENT_REGISTRY"), "yes")
        );
        script.run();
    }

    function _caseValueTooWideForItsField() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", "70000");

        vm.expectRevert(
            abi.encodeWithSelector(
                BursarScript.EnvOutOfRange.selector, _key("BURSAR_FEE_BPS"), 70_000, type(uint16).max
            )
        );
        script.run();
    }

    function _caseAssetIsNotAContract() private {
        _setBaseEnv();
        address notAContract = makeAddr("notAContract");
        path = _useRecord(RECORD, _baseRecord("test-core", homeChain, true, notAContract));

        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetNotContract.selector, notAContract));
        script.run();
    }

    function _caseAssetCannotAnswerDecimals() private {
        _setBaseEnv();
        address mute = address(new MuteTarget());
        path = _useRecord(RECORD, _baseRecord("test-core", homeChain, true, mute));

        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetNotContract.selector, mute));
        script.run();
    }

    function _caseAssetAtTheWrongScale() private {
        _setBaseEnv();
        path = _useRecord(RECORD, _baseRecord("test-core", homeChain, true, address(new WideDecimalsToken())));

        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetDecimalsMismatch.selector, uint8(18), uint8(6)));
        script.run();
    }

    /// The record names the asset. A parameter file that still names one has to name the same.
    function _caseAShellThatNamesAnotherAsset() private {
        _setBaseEnv();
        address other = makeAddr("someOtherAsset");
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(other));

        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.RecordMismatch.selector, K.SETTLEMENT_ASSET, address(settlement), other)
        );
        script.run();
    }

    function _caseFeesConsumeAWholeSettlement() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", "6000");
        _set("BURSAR_RESOLVER_FEE_BPS", "4000");

        vm.expectRevert(abi.encodeWithSelector(Deploy.FeeSplitTooLarge.selector, uint16(6_000), uint16(4_000)));
        script.run();
    }

    /// One basis point under the sum the script rejects, the escrow's own ceiling is what stops
    /// the run. The two checks are not the same check.
    function _caseEscrowsTighterFeeCeiling() private {
        _setBaseEnv();
        _set("BURSAR_FEE_BPS", "5999");
        _set("BURSAR_RESOLVER_FEE_BPS", "4000");

        vm.expectRevert(IEscrow.BadFee.selector);
        script.run();
        // The revert lands inside the broadcast, and cheatcode state does not roll back with it.
        vm.stopBroadcast();
    }

    function _caseDisputeBondAtPar() private {
        _setBaseEnv();
        _set("BURSAR_DISPUTE_BOND_BPS", "10000");

        vm.expectRevert(abi.encodeWithSelector(Deploy.DisputeBondTooLarge.selector, uint16(10_000)));
        script.run();
    }

    /// The escrow has no dispute timeout of its own. An operator's file that still carries one
    /// would read as though a third exit existed, so the run refuses it by name.
    function _caseTheRetiredDisputeTimeoutVariableIsRefused() private {
        _setBaseEnv();
        _set("BURSAR_DISPUTE_TIMEOUT", "172800");

        vm.expectRevert(
            abi.encodeWithSelector(
                BursarScript.RetiredEnv.selector,
                _key("BURSAR_DISPUTE_TIMEOUT"),
                "nothing: disputes exit through OracleRegistry"
            )
        );
        script.run();
    }

    /// Nineteen units at five percent is a bond of nothing.
    function _caseAMinimumLockTooSmallToCarryABond() private {
        _setBaseEnv();
        _set("BURSAR_MIN_LOCK", "19");

        vm.expectRevert(IEscrow.BadMinLock.selector);
        script.run();
        vm.stopBroadcast();
    }

    /// A curve of 25 plus 1 per point never reaches 250.
    function _caseACapCeilingNoScoreReaches() private {
        _setBaseEnv();
        _set("BURSAR_CAP_BASE", "25000000");
        _set("BURSAR_CAP_PER_SCORE", "1000000");
        _set("BURSAR_CAP_MAX", "250000000");

        vm.expectRevert(IReputation.BadCurve.selector);
        script.run();
        vm.stopBroadcast();
    }

    /// A cap of five voters lets whoever commits first fill the panel.
    function _caseAVoterCapBelowTheRoster() private {
        _setBaseEnv();
        _set("BURSAR_MAX_VOTERS", "5");

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        script.run();
        vm.stopBroadcast();
    }

    function _caseAVoteWindowUnderTenMinutes() private {
        _setBaseEnv();
        _set("BURSAR_REVEAL_WINDOW", "599");

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        script.run();
        vm.stopBroadcast();
    }

    function _caseZeroTimelockPeriod() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_PERIOD", "0");

        vm.expectRevert(BursarScript.TimelockPeriodZero.selector);
        script.run();
    }

    /// The script rejects only zero. The floor that makes the delay worth having lives in the
    /// timelock, and a period under it stops the run there.
    function _casePeriodBelowTheTimelocksOwnFloor() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_PERIOD", vm.toString(uint256(1 hours - 1)));

        vm.expectRevert(AdminTimelock.BadPeriod.selector);
        script.run();
        vm.stopBroadcast();
    }

    function _caseZeroBaseCap() private {
        _setBaseEnv();
        _set("BURSAR_CAP_BASE", "0");

        vm.expectRevert(Deploy.BaseCapZero.selector);
        script.run();
    }

    /// A slash of zero would leave the only cost a resolver faces a no-op while the slash event
    /// still fires. The registry constructor reverts on that.
    function _caseResolverSlashOfZero() private {
        _setBaseEnv();
        _set("BURSAR_RESOLVER_SLASH_BPS", "0");

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        script.run();
        vm.stopBroadcast();
    }

    function _caseDeployKeyCarriesGovernance() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_SIGNER_2", vm.toString(address(this)));

        vm.expectRevert(abi.encodeWithSelector(Deploy.DeployerIsTimelockSigner.selector, address(this)));
        script.run();
    }

    function _caseGuardianAlsoCarriesAnApproval() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_GUARDIAN", vm.toString(signerC));

        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCollision.selector, "guardian", "timelockSigner", signerC));
        script.run();
    }

    function _caseDeployKeyIsTheTreasury() private {
        _setBaseEnv();
        _set("BURSAR_TREASURY", vm.toString(address(this)));

        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCollision.selector, "treasury", "deployer", address(this)));
        script.run();
    }

    function _caseOneAddressForFeesAndSlashedCollateral() private {
        _setBaseEnv();
        _set("BURSAR_SLASH_SINK", vm.toString(treasury));

        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCollision.selector, "treasury", "slashSink", treasury));
        script.run();
    }

    /// Three plain keys are refused on every chain unless an operator sets the phrase.
    function _caseEveryChainDemandsAMultisigOrAnExplicitAcknowledgement() private {
        _setBaseEnv();
        _set("BURSAR_TIMELOCK_SIGNER_1", vm.toString(makeAddr("hotKey")));

        vm.expectRevert(Deploy.GovernanceHasNoMultisig.selector);
        script.run();

        _set("BURSAR_ALLOW_EOA_GOVERNANCE", "true");
        vm.expectRevert(abi.encodeWithSelector(Deploy.EoaGovernanceNotAcknowledged.selector, "true", EOA_ACK));
        script.run();

        // A near miss is still a miss. The comparison is over the bytes.
        _set("BURSAR_ALLOW_EOA_GOVERNANCE", "I-ACCEPT-EOA-GOVERNANCE");
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.EoaGovernanceNotAcknowledged.selector, "I-ACCEPT-EOA-GOVERNANCE", EOA_ACK)
        );
        script.run();

        _set("BURSAR_ALLOW_EOA_GOVERNANCE", EOA_ACK);
        Deploy.Deployment memory out = _runAsDeployKey();

        assertEq(Escrow(out.escrow).settlementAsset(), address(settlement));
        address[3] memory deployed = AdminTimelock(out.timelock).getSigners();
        for (uint256 i; i < 3; ++i) {
            assertEq(deployed[i].code.length, 0, "a contract signer reached the acknowledged path");
        }
    }

    /// Resolver bonds are posted in BRSR and the floor that admits one lives in the staking pool.
    /// A variable left over from the old parameter set would otherwise sit in the operator's
    /// shell reading as though it still set a floor.
    function _caseTheRetiredResolverBondVariableIsRefused() private {
        _setBaseEnv();
        _set("BURSAR_RESOLVER_MIN_BOND", "1000000");

        vm.expectRevert(
            abi.encodeWithSelector(
                BursarScript.RetiredEnv.selector,
                _key("BURSAR_RESOLVER_MIN_BOND"),
                "BURSAR_STAKING_MIN_BOND, in the staking deployment"
            )
        );
        script.run();
    }

    /// The failure the namespace exists to stop: another suite, or an operator with a parameter
    /// file sourced, writing the same variable names into the same process. Nothing outside the
    /// namespace reaches this run, whatever it says.
    function _caseAForeignEnvironmentCannotReachThisRun() private {
        _setBaseEnv();

        vm.setEnv("BURSAR_CHAIN_ID", vm.toString(homeChain + 99));
        vm.setEnv("BURSAR_SETTLEMENT_ASSET", vm.toString(makeAddr("someoneElsesAsset")));
        vm.setEnv("BURSAR_TREASURY", vm.toString(address(0)));
        vm.setEnv("BURSAR_RESOLVER_MIN_BOND", "1000000");
        vm.setEnv("BURSAR_RECORD", "cache/bursar/someone-elses.json");

        Deploy.Deployment memory out = _runAsDeployKey();
        assertEq(Escrow(out.escrow).settlementAsset(), address(settlement));
    }

    /// The minimal set: no agent registry, and the party gate left open.
    function _caseTheMinimalSetLeavesThePartyGateOpen() private {
        _setBaseEnv();
        _set("BURSAR_DEPLOY_AGENT_REGISTRY", "false");

        Deploy.Deployment memory out = _runAsDeployKey();

        assertEq(Escrow(out.escrow).settlementAsset(), address(settlement));
        assertEq(address(Escrow(out.escrow).registry()), address(0), "the minimal set wired a party gate");
        assertEq(out.agentRegistry, address(0));
        assertFalse(_has(path, K.AGENT_REGISTRY), "the minimal set recorded a registry it did not deploy");
    }

    /// The whole set constructs and wires, and the run reads every pairing back before it
    /// returns. Anything the readback disagrees with stops the run, so reaching the end is the
    /// assertion.
    function _caseDeploysTheSetThenReadsItsOwnWiringBack() private {
        _setBaseEnv();

        Deploy.Deployment memory out = _runAsDeployKey();
        assertEq(Escrow(out.escrow).minLock(), 10_000);

        assertEq(Escrow(out.escrow).deployer(), DEFAULT_SENDER);
        assertEq(Escrow(out.escrow).resolver(), out.oracleRegistry);
        assertEq(OracleRegistry(out.oracleRegistry).escrow(), out.escrow);
        assertEq(Reputation(out.reputation).escrow(), out.escrow);
        assertEq(MandateAccountFactory(out.factory).escrow(), out.escrow);

        // Governance is the timelock everywhere from the first block, the agent registry and the
        // escrow's brake included. The deploy key keeps nothing.
        assertEq(Reputation(out.reputation).admin(), out.timelock);
        assertEq(OracleRegistry(out.oracleRegistry).admin(), out.timelock);
        assertEq(AgentRegistry(out.agentRegistry).admin(), out.timelock);
        assertEq(AgentRegistry(out.agentRegistry).pendingAdmin(), address(0));
        assertEq(Escrow(out.escrow).pauser(), out.timelock);
        assertEq(address(Escrow(out.escrow).registry()), out.agentRegistry);

        // Two capabilities the run leaves absent. No contract can take agent collateral, and no
        // resolver can bond until the staking deployment names a pool.
        assertEq(AgentRegistry(out.agentRegistry).slasher(), address(0));
        assertEq(address(OracleRegistry(out.oracleRegistry).staking()), address(0));
        assertEq(address(OracleRegistry(out.oracleRegistry).bondAsset()), address(0));
    }

    /// What the next script reads: every address, the roles, and the figures as applied.
    function _caseTheRunRecordsWhatItDeployed() private {
        _setBaseEnv();
        Deploy.Deployment memory out = _runAsDeployKey();

        assertEq(_readAddress(path, K.ADMIN_TIMELOCK), out.timelock);
        assertEq(_readAddress(path, K.REPUTATION), out.reputation);
        assertEq(_readAddress(path, K.ESCROW), out.escrow);
        assertEq(_readAddress(path, K.ORACLE_REGISTRY), out.oracleRegistry);
        assertEq(_readAddress(path, K.AGENT_REGISTRY), out.agentRegistry);
        assertEq(_readAddress(path, K.FACTORY), out.factory);
        assertEq(_readAddress(path, K.DEPLOYER), DEFAULT_SENDER);
        assertEq(_readAddress(path, K.TREASURY), treasury);
        assertEq(_readAddress(path, K.SLASH_SINK), slashSink);
        assertEq(_readAddress(path, K.GUARDIAN), guardian);

        address[] memory signers = vm.parseJsonAddressArray(vm.readFile(path), K.SIGNERS);
        assertEq(signers.length, 3);
        assertEq(signers[0], multisigSigner);
        assertEq(signers[2], signerC);

        assertEq(_readUint(path, ".parameters.AdminTimelock.timelockPeriod"), 3 days);
        assertEq(_readUint(path, ".parameters.Escrow.minLock"), 10_000);
        assertEq(_readUint(path, ".parameters.Reputation.maxCap"), 1_100e6);
        assertEq(_readUint(path, ".parameters.OracleRegistry.maxVoters"), 64);
        assertEq(_readUint(path, ".parameters.AgentRegistry.minStake"), 100e6);
        // Amounts are strings, so a reader never has to guess whether a figure fit a double.
        assertEq(vm.parseJsonString(vm.readFile(path), ".parameters.Escrow.minLock"), "10000");
    }

    /// The run refuses to deploy a contract the record holds, unless told to replace it.
    function _caseASecondRunRefusesWhatTheRecordHolds() private {
        _setBaseEnv();
        Deploy.Deployment memory first = _runAsDeployKey();

        // The recorded timelock is joined: it is the governance the rest of the run answers to.
        // The first contract the run would deploy again is what stops it.
        vm.expectRevert(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.REPUTATION, first.reputation));
        _as(DEFAULT_SENDER, address(script), abi.encodeCall(Deploy.run, ()));

        _set("BURSAR_FORCE", "1");
        Deploy.Deployment memory second = _runAsDeployKey();
        assertEq(second.timelock, first.timelock, "a forced run stood up a second timelock");
        assertTrue(second.escrow != first.escrow);
        assertEq(_readAddress(path, K.ESCROW), second.escrow);
        _unset("BURSAR_FORCE");
    }

    /// An entry with nothing behind it is a broadcast that never landed. Replacing it loses
    /// nothing, so the run carries on without being forced.
    function _caseAStaleEntryIsReplaced() private {
        _setBaseEnv();
        vm.writeJson(vm.toString(makeAddr("neverLanded")), path, K.ESCROW);
        vm.writeJson(vm.toString(makeAddr("neverLandedEither")), path, K.ADMIN_TIMELOCK);

        Deploy.Deployment memory out = _runAsDeployKey();
        assertEq(_readAddress(path, K.ESCROW), out.escrow);
        assertEq(_readAddress(path, K.ADMIN_TIMELOCK), out.timelock);
        assertGt(out.timelock.code.length, 0);
    }

    /// A role the record names is the role. A shell carrying another value for it stops the run,
    /// so nothing deploys against last month's treasury.
    function _caseTheRecordedRolesWinAndAShellMayNotDisagree() private {
        _setBaseEnv();
        address recordedTreasury = makeAddr("recordedTreasury");
        vm.writeJson(vm.toString(recordedTreasury), path, K.TREASURY);

        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.RecordMismatch.selector, K.TREASURY, recordedTreasury, treasury)
        );
        script.run();

        _set("BURSAR_TREASURY", vm.toString(address(0)));
        Deploy.Deployment memory out = _runAsDeployKey();
        assertEq(Escrow(out.escrow).treasury(), recordedTreasury);
    }

    /// The one-shot setters answer only to the key that deployed the contracts they wire, so a
    /// record that names a deployer holds every run to that key.
    function _caseTheRecordedDeployerIsTheOnlyKey() private {
        _setBaseEnv();
        address other = makeAddr("anotherDeployKey");
        vm.writeJson(vm.toString(other), path, K.DEPLOYER);

        vm.expectRevert(abi.encodeWithSelector(BursarScript.WrongDeployer.selector, other, DEFAULT_SENDER));
        _as(DEFAULT_SENDER, address(script), abi.encodeCall(Deploy.run, ()));
    }

    /// An address with nothing behind it would deploy a set whose every admin call reverts.
    function _caseGovernanceAddressHoldsNoCode() private {
        address empty = makeAddr("governanceWithNoCode");
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(empty));

        vm.expectRevert(abi.encodeWithSelector(Deploy.TimelockNotContract.selector, empty));
        script.run();
    }

    /// The run never sets the terms of governance it joins, so it checks the live contract against
    /// the parameter file.
    function _caseLiveGovernanceDisagreesWithTheParameterFile() private {
        AdminTimelock shorterDelay = new AdminTimelock([multisigSigner, signerB, signerC], guardian, 2 days);
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(shorterDelay)));

        vm.expectRevert(
            abi.encodeWithSelector(
                BursarScript.ParameterNotApplied.selector, "timelock.timelockPeriod", uint256(3 days), uint256(2 days)
            )
        );
        script.run();

        address otherGuardian = makeAddr("someoneElsesGuardian");
        AdminTimelock otherBrake = new AdminTimelock([multisigSigner, signerB, signerC], otherGuardian, 3 days);
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(otherBrake)));

        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "timelock.guardian", guardian, otherGuardian)
        );
        script.run();

        address otherSigner = makeAddr("someoneElsesSigner");
        AdminTimelock otherSigners = new AdminTimelock([multisigSigner, signerB, otherSigner], guardian, 3 days);
        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(otherSigners)));

        vm.expectRevert(
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "timelock.signer", signerC, otherSigner)
        );
        script.run();
    }

    /// A redeploy of the money path joins the governance that already holds the rest of the
    /// system. Nothing in the run stands up a second timelock, and every admin lands on the live
    /// one.
    function _caseJoinsGovernanceThatIsAlreadyLive() private {
        AdminTimelock live = new AdminTimelock([multisigSigner, signerB, signerC], guardian, 3 days);

        _setBaseEnv();
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(live)));

        Deploy.Deployment memory out = _runAsDeployKey();

        assertEq(out.timelock, address(live));
        assertEq(Reputation(out.reputation).admin(), address(live));
        assertEq(OracleRegistry(out.oracleRegistry).admin(), address(live));
        assertEq(AgentRegistry(out.agentRegistry).admin(), address(live));
        assertEq(_readAddress(path, K.ADMIN_TIMELOCK), address(live));
    }

    /// The same, with governance named by the record.
    function _caseJoinsGovernanceTheRecordNames() private {
        AdminTimelock live = new AdminTimelock([multisigSigner, signerB, signerC], guardian, 3 days);
        _setBaseEnv();
        vm.writeJson(vm.toString(address(live)), path, K.ADMIN_TIMELOCK);

        Deploy.Deployment memory out = _runAsDeployKey();
        assertEq(out.timelock, address(live));
        assertEq(Escrow(out.escrow).pauser(), address(live));
    }

    /// Robinhood Chain is the one chain this run pins an asset address on, because it is the one
    /// chain the address was read off. A typo in the record stops here, before it becomes the
    /// settlement asset of a live deployment.
    function _caseRobinhoodChainPinsTheUsdgAddress() private {
        _setBaseEnv();
        vm.chainId(RHC_CHAIN_ID);
        _set("BURSAR_CHAIN_ID", vm.toString(RHC_CHAIN_ID));
        _unset("BURSAR_LOCAL");
        path = _useRecord(RECORD, _baseRecord("test-core", RHC_CHAIN_ID, false, address(settlement)));

        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetNotUsdg.selector, address(settlement), RHC_USDG));
        script.run();

        vm.chainId(homeChain);
    }

    /// The compliance preflight, which runs only on the chain where the asset is pinned and only
    /// on the selectors USDG answers.
    function _caseTheSettlementAssetHasToBeAbleToMove() private {
        _setBaseEnv();
        MockUsdg usdg = _useRobinhoodChain();

        usdg.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AssetPaused.selector, RHC_USDG));
        script.run();
        usdg.setPaused(false);

        // The script attributes the deployment to its own caller, so a case that calls `run`
        // directly is deploying as this contract and a case that goes through the runner is
        // deploying as forge-std's default sender. Both appear below, each named.
        usdg.setFrozen(address(this), true);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AddressFrozen.selector, "deployer", address(this)));
        script.run();
        usdg.setFrozen(address(this), false);

        // A frozen treasury can never be swept, and the escrow names it immutably.
        usdg.setFrozen(treasury, true);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AddressFrozen.selector, "treasury", treasury));
        script.run();
        usdg.setFrozen(treasury, false);

        // A deploy key holding none of the settlement asset cannot fund the first mandate, and an
        // empty balance is also what a wrong address that happens to hold code looks like.
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.SettlementBalanceTooLow.selector, address(this), uint256(0), MIN_SETTLEMENT_BALANCE
            )
        );
        script.run();

        usdg.mint(DEFAULT_SENDER, MIN_SETTLEMENT_BALANCE);
        Deploy.Deployment memory out = _runAsDeployKey();
        assertEq(Escrow(out.escrow).settlementAsset(), RHC_USDG);

        // A second run says it ran before, whatever the deploy key has spent since the first.
        vm.prank(DEFAULT_SENDER);
        usdg.transfer(treasury, MIN_SETTLEMENT_BALANCE);
        vm.expectRevert(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.REPUTATION, out.reputation));
        _as(DEFAULT_SENDER, address(script), abi.encodeCall(Deploy.run, ()));

        vm.chainId(homeChain);
    }

    /// Moves the fixture onto chain 4663 with USDG at its pinned address and a mainnet record.
    function _useRobinhoodChain() private returns (MockUsdg) {
        vm.etch(RHC_USDG, address(new MockUsdg()).code);
        vm.chainId(RHC_CHAIN_ID);
        _set("BURSAR_CHAIN_ID", vm.toString(RHC_CHAIN_ID));
        _unset("BURSAR_LOCAL");
        path = _useRecord(RECORD, _baseRecord("test-core", RHC_CHAIN_ID, false, RHC_USDG));
        return MockUsdg(RHC_USDG);
    }

    function _runAsDeployKey() private returns (Deploy.Deployment memory) {
        return abi.decode(_as(DEFAULT_SENDER, address(script), abi.encodeCall(Deploy.run, ())), (Deploy.Deployment));
    }

    /// Lays the whole set down before each case changes the one it is about: a variable one case
    /// writes is still there for the next, and the record starts empty every time.
    function _setBaseEnv() private {
        path = _useRecord(RECORD, _baseRecord("test-core", homeChain, true, address(settlement)));
        _set("BURSAR_LOCAL", "1");
        _unset("BURSAR_FORCE");

        // Cleared, because a case sets each to prove the run rejects it.
        _set("BURSAR_RESOLVER_MIN_BOND", "");
        _set("BURSAR_DISPUTE_TIMEOUT", "");
        _set("BURSAR_STAKING", "");
        // Same, and this one matters more: a value left over from the case that acknowledges an
        // EOA signer set would silence the refusal in every case after it.
        _set("BURSAR_ALLOW_EOA_GOVERNANCE", "");
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(0)));
        _set("BURSAR_SETTLEMENT_ASSET", vm.toString(address(0)));

        _set("BURSAR_CHAIN_ID", vm.toString(homeChain));
        _set("BURSAR_TREASURY", vm.toString(treasury));
        _set("BURSAR_SLASH_SINK", vm.toString(slashSink));

        _set("BURSAR_TIMELOCK_SIGNER_1", vm.toString(multisigSigner));
        _set("BURSAR_TIMELOCK_SIGNER_2", vm.toString(signerB));
        _set("BURSAR_TIMELOCK_SIGNER_3", vm.toString(signerC));
        _set("BURSAR_TIMELOCK_GUARDIAN", vm.toString(guardian));
        _set("BURSAR_TIMELOCK_PERIOD", vm.toString(uint256(3 days)));

        _set("BURSAR_FEE_BPS", "50");
        _set("BURSAR_RESOLVER_FEE_BPS", "100");
        _set("BURSAR_DISPUTE_BOND_BPS", "500");
        _set("BURSAR_MIN_TTL", vm.toString(uint256(5 minutes)));
        _set("BURSAR_MAX_TTL", vm.toString(uint256(7 days)));
        _set("BURSAR_DISPUTE_WINDOW", vm.toString(uint256(1 days)));
        _set("BURSAR_MIN_LOCK", "10000");

        _set("BURSAR_CAP_BASE", "100000000");
        _set("BURSAR_CAP_PER_SCORE", "10000000");
        _set("BURSAR_CAP_MAX", "1100000000");

        _set("BURSAR_COMMIT_WINDOW", "3600");
        _set("BURSAR_REVEAL_WINDOW", "3600");
        _set("BURSAR_UNBONDING_PERIOD", "86400");
        _set("BURSAR_RESOLVER_QUORUM", "3");
        _set("BURSAR_MAX_VOTERS", "64");
        _set("BURSAR_MAX_DEVIATION", "15");
        _set("BURSAR_RESOLVER_SLASH_BPS", "2000");

        _set("BURSAR_DEPLOY_AGENT_REGISTRY", "true");
        _set("BURSAR_AGENT_MIN_STAKE", "100000000");
        _set("BURSAR_AGENT_SLASH_BPS", "1000");
    }
}
