// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployPrivacy} from "../../script/DeployPrivacy.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {Escrow} from "../../src/Escrow.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {World} from "./World.sol";

/// Committed mandates, disclosures and the solvency log: one factory on the record's escrow, a
/// ceiling every committed account shares, and a poster named on purpose.
contract DeployPrivacyTest is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant CEILING = 25e6;

    function _prefix() internal pure override returns (string memory) {
        return "DEPLOYPRIVACY_";
    }

    function setUp() public {
        _world("deploy-privacy");
        _core();
        _save();
    }

    function test_deployPrivacy_buildsOnTheRecordsEscrowWithTheNamedPoster() public {
        _theLaneIsBuiltOnTheRecord();
        _aSecondRunIsRefused();
        _thePosterIsNeverInferred();
        _aRecordedPosterOutranksTheShellOnlyWhenTheyAgree();
        _retiredVariablesAreRefused();
        _anEscrowOnAnotherAssetIsRefused();
    }

    function _deploy() private returns (DeployPrivacy.Deployment memory) {
        return abi.decode(_run(DEPLOYER, address(new DeployPrivacy())), (DeployPrivacy.Deployment));
    }

    function _expectRefused(bytes memory reason) private {
        address script = _pinned(address(new DeployPrivacy()));
        vm.expectRevert(reason);
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));
    }

    function _theLaneIsBuiltOnTheRecord() private {
        _restore();
        DeployPrivacy.Deployment memory out = _deploy();
        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        address poster = vm.envAddress(_key("BURSAR_SOLVENCY_POSTER"));

        assertEq(out.factory.escrow(), _readAddress(path, K.ESCROW));
        assertEq(out.factory.settlementAsset(), USDG);
        assertEq(out.factory.verifier(), address(out.verifier));
        assertEq(out.factory.ceiling(), CEILING);
        assertEq(out.solvency.admin(), timelock);
        assertEq(out.solvency.poster(), poster);

        assertEq(_readAddress(path, K.VERIFIER), address(out.verifier));
        assertEq(_readAddress(path, K.COMMITTED_FACTORY), address(out.factory));
        assertEq(_readAddress(path, K.DISCLOSURES), address(out.disclosures));
        assertEq(_readAddress(path, K.SOLVENCY_LOG), address(out.solvency));
        assertEq(_readAddress(path, K.SOLVENCY_POSTER), poster);
        assertEq(_readUint(path, K.PRIVACY_FROM_BLOCK), block.number);
        assertEq(
            vm.parseJsonString(vm.readFile(path), ".parameters.CommittedMandateFactory.ceiling"), vm.toString(CEILING)
        );
    }

    function _aSecondRunIsRefused() private {
        _restore();
        DeployPrivacy.Deployment memory out = _deploy();
        _expectRefused(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.VERIFIER, address(out.verifier)));
    }

    /// The poster writes what the log says about reserves, so the run never falls back to
    /// whichever key signs.
    function _thePosterIsNeverInferred() private {
        _restore();
        string memory poster = vm.envString(_key("BURSAR_SOLVENCY_POSTER"));
        _set("BURSAR_SOLVENCY_POSTER", vm.toString(address(0)));
        _expectRefused(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_SOLVENCY_POSTER")));
        _set("BURSAR_SOLVENCY_POSTER", poster);
    }

    /// A poster the record already names is the one the run uses. A shell that names another is
    /// a mistake in one of the two, and the run stops without picking.
    function _aRecordedPosterOutranksTheShellOnlyWhenTheyAgree() private {
        _restore();
        address recorded = makeAddr("recordedPoster");
        vm.writeJson(vm.toString(recorded), path, K.SOLVENCY_POSTER);
        address named = vm.envAddress(_key("BURSAR_SOLVENCY_POSTER"));
        _expectRefused(abi.encodeWithSelector(BursarScript.RecordMismatch.selector, K.SOLVENCY_POSTER, recorded, named));

        _restore();
        string memory poster = vm.envString(_key("BURSAR_SOLVENCY_POSTER"));
        _set("BURSAR_SOLVENCY_POSTER", vm.toString(address(0)));
        vm.writeJson(vm.toString(recorded), path, K.SOLVENCY_POSTER);
        DeployPrivacy.Deployment memory out = _deploy();
        assertEq(out.solvency.poster(), recorded);
        _set("BURSAR_SOLVENCY_POSTER", poster);
    }

    /// Names an earlier layout used. Set in a shell, each would be silently ignored, so each
    /// stops the run and says what replaced it.
    function _retiredVariablesAreRefused() private {
        _restore();
        _set("BURSAR_POSTER", vm.toString(DEPLOYER));
        _expectRefused(
            abi.encodeWithSelector(BursarScript.RetiredEnv.selector, _key("BURSAR_POSTER"), "BURSAR_SOLVENCY_POSTER")
        );
        _unset("BURSAR_POSTER");

        _set("BURSAR_ESCROW_V1", vm.toString(DEPLOYER));
        _expectRefused(
            abi.encodeWithSelector(
                BursarScript.RetiredEnv.selector, _key("BURSAR_ESCROW_V1"), "nothing: this set has one escrow"
            )
        );
        _unset("BURSAR_ESCROW_V1");
    }

    /// A committed account locks on the escrow in the asset the factory names, so an escrow that
    /// settles in anything else would take locks the factory cannot fund.
    function _anEscrowOnAnotherAssetIsRefused() private {
        _restore();
        MockUsdg other = new MockUsdg();
        Escrow elsewhere = new Escrow(
            address(other),
            _readAddress(path, K.REPUTATION),
            _readAddress(path, K.TREASURY),
            100,
            50,
            500,
            300,
            7 days,
            1 hours,
            10_000
        );
        vm.writeJson(vm.toString(address(elsewhere)), path, K.ESCROW);
        _expectRefused(
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "escrow.settlementAsset", USDG, address(other))
        );
    }
}
