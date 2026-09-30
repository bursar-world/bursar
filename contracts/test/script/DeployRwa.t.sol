// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployRwa} from "../../script/DeployRwa.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {RwaConfig} from "../../script/lib/RwaConfig.sol";

import {MandateAccountFactory} from "../../src/MandateAccountFactory.sol";
import {IMandateAccountFactory} from "../../src/interfaces/IMandateAccountFactory.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {TreasuryPark} from "../../src/rwa/TreasuryPark.sol";
import {MockV4} from "../rwa/RwaMocks.sol";
import {Silent, World} from "./World.sol";

/// The RWA lane: every asset registered on the terms `RwaConfig` sets and the pool the record
/// implies, the park taking mandates from the record's factory alone, and the refusals that keep a
/// wrong token, feed or pool out of it.
contract DeployRwaTest is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function _prefix() internal pure override returns (string memory) {
        return "DEPLOYRWA_";
    }

    function setUp() public {
        _world("deploy-rwa");
        _core();
        _save();
    }

    function test_deployRwa_registersTheLaunchAssetsAndAdmitsOnlyTheRecordsFactory() public {
        _theLaneAnswersToGovernanceAndTheRecordsFactory();
        _aSecondRunIsRefused();
        _aKindTheTermsDoNotSayIsRefused();
        _aMeasuredPoolIdThatDiffersIsRefused();
        _aPoolNobodyOpenedIsRefused();
        _aFactoryOnAnotherEscrowIsRefused();
        _anAccessRegistryThatAnswersNothingIsRefused();
        _aFeedWithNoCodeIsRefused();
    }

    function _deploy() private returns (DeployRwa.Deployment memory) {
        return abi.decode(_run(DEPLOYER, address(new DeployRwa())), (DeployRwa.Deployment));
    }

    function _expectRefused(bytes memory reason) private {
        address script = _pinned(address(new DeployRwa()));
        vm.expectRevert(reason);
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));
    }

    function _theLaneAnswersToGovernanceAndTheRecordsFactory() private {
        _restore();
        DeployRwa.Deployment memory out = _deploy();
        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);

        assertEq(out.registry.admin(), timelock);
        assertEq(out.park.admin(), timelock);
        IMandateAccountFactory[] memory factories = out.park.factories();
        assertEq(factories.length, 1, "the park admits mandates from more than one factory");
        assertEq(address(factories[0]), _readAddress(path, K.FACTORY));
        assertTrue(out.park.isAdapter(address(out.treasuryAdapter)));
        assertTrue(out.park.isAdapter(address(out.usdgAdapter)));

        RwaConfig.Term[] memory terms = RwaConfig.terms();
        for (uint256 i; i < terms.length; ++i) {
            string memory at = string.concat(K.RWA_ASSETS, ".", terms[i].symbol);
            address token = _readAddress(path, string.concat(at, ".address"));
            AssetRegistry.Asset memory a = out.registry.get(token);
            assertEq(a.feed, _readAddress(path, string.concat(at, ".feed")));
            assertEq(a.bandBps, terms[i].bandBps);
            assertEq(a.isTreasury, terms[i].isTreasury);
            assertEq(
                out.registry.poolId(token),
                keccak256(abi.encode(RwaConfig.pool(token, USDG, terms[i].fee, terms[i].tickSpacing)))
            );
        }
        assertEq(_readAddress(path, K.TREASURY_PARK), address(out.park));
        assertEq(_readAddress(path, K.SGOV_ADAPTER), address(out.treasuryAdapter));
        assertEq(_readAddress(path, K.USDG_ADAPTER), address(out.usdgAdapter));
        assertEq(vm.parseJsonString(vm.readFile(path), ".rwa.assets.SGOV.kind"), "treasury");
    }

    function _aSecondRunIsRefused() private {
        _restore();
        DeployRwa.Deployment memory out = _deploy();
        _expectRefused(
            abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.ASSET_REGISTRY, address(out.registry))
        );
    }

    /// A stock recorded as a treasury fund would be parked and valued on the wrong terms.
    function _aKindTheTermsDoNotSayIsRefused() private {
        _restore();
        vm.writeJson('"treasury"', path, ".external.assets.SPY.kind");
        _expectRefused(abi.encodeWithSelector(DeployRwa.AssetKindMismatch.selector, "SPY", "treasury"));
    }

    /// On Robinhood Chain the record carries each pinned pool's id as it was measured. A key that
    /// does not hash to it trades somewhere else.
    function _aMeasuredPoolIdThatDiffersIsRefused() private {
        _restore();
        bytes32 wrong = keccak256("some other pool");
        vm.writeJson(string.concat('"', vm.toString(wrong), '"'), path, ".external.assets.NVDA.poolId");
        address nvda = _readAddress(path, ".external.assets.NVDA.address");
        bytes32 built = keccak256(abi.encode(RwaConfig.pool(nvda, USDG, 100, 1)));
        _expectRefused(abi.encodeWithSelector(DeployRwa.PoolIdMismatch.selector, "NVDA", wrong, built));
    }

    function _aPoolNobodyOpenedIsRefused() private {
        _restore();
        address aapl = _readAddress(path, ".external.assets.AAPL.address");
        MockV4(_readAddress(path, K.STATE_VIEW)).setPrice(RwaConfig.pool(aapl, USDG, 3000, 60), 0);
        bytes32 id = keccak256(abi.encode(RwaConfig.pool(aapl, USDG, 3000, 60)));
        _expectRefused(abi.encodeWithSelector(DeployRwa.PoolNotOpen.selector, "AAPL", id));
    }

    /// The park admits accounts by asking the factory who created them, so the factory has to
    /// build on this deployment's escrow.
    function _aFactoryOnAnotherEscrowIsRefused() private {
        _restore();
        address otherEscrow = _readAddress(path, K.REPUTATION);
        MandateAccountFactory other = new MandateAccountFactory(otherEscrow, USDG);
        vm.writeJson(vm.toString(address(other)), path, K.FACTORY);
        _expectRefused(
            abi.encodeWithSelector(
                BursarScript.WiringFailed.selector, "factory.escrow", _readAddress(path, K.ESCROW), otherEscrow
            )
        );
    }

    function _anAccessRegistryThatAnswersNothingIsRefused() private {
        _restore();
        address silent = address(new Silent());
        vm.writeJson(vm.toString(silent), path, K.ACCESS_REGISTRY);
        _expectRefused(abi.encodeWithSelector(BursarScript.NoAnswer.selector, "AccessRegistry.paused", silent));
    }

    function _aFeedWithNoCodeIsRefused() private {
        _restore();
        address nothing = makeAddr("noFeedHere");
        vm.writeJson(vm.toString(nothing), path, ".external.assets.SPY.feed");
        _expectRefused(abi.encodeWithSelector(BursarScript.NotContract.selector, ".external.assets.SPY.feed", nothing));
    }
}
