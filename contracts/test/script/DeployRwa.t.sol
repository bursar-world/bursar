// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployRwa} from "../../script/DeployRwa.s.sol";
import {VerifyRwa} from "../../script/VerifyRwa.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {RwaConfig} from "../../script/lib/RwaConfig.sol";
import {Verifier} from "../../script/lib/Verifier.sol";

import {MandateAccountFactory} from "../../src/MandateAccountFactory.sol";
import {IMandateAccountFactory} from "../../src/interfaces/IMandateAccountFactory.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {TreasuryPark} from "../../src/rwa/TreasuryPark.sol";
import {MockV4} from "../rwa/RwaMocks.sol";
import {Silent, World} from "./World.sol";

contract VerifyRwaProbe is VerifyRwa {
    function tally() external view returns (uint256, uint256) {
        return (mismatches, owed);
    }
}

/// The RWA lane: every asset registered on the terms `RwaConfig` sets and the pool the record
/// implies, the park taking mandates from the record's factory alone, and the refusals that keep a
/// wrong token, feed or pool out of it. Then the lane move: a record that carries the registry,
/// the park and the USDG adapter gets only the three contracts that hold the guard.
contract DeployRwaTest is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    string internal constant PREVIOUS = "deploy-rwa-previous";

    string internal previousPath;

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
        // The cases share one record file, so the lane move runs in the same test.
        _theJoinDeploysOnlyWhatHoldsTheGuard();
        _theJoinRefusesAParkUnderAnotherAdmin();
        _theJoinRefusesAFeedTheRegistryDoesNotHold();
        _theJoinRefusesARegistryMissingAnAsset();
    }

    function _deploy() private returns (DeployRwa.Deployment memory) {
        return abi.decode(_run(DEPLOYER, address(new DeployRwa())), (DeployRwa.Deployment));
    }

    /// `VerifyRwa` against the record: what it found mismatched and owed, whether or not it failed
    /// on them.
    function _tally() private returns (uint256 mismatched, uint256 owedCount) {
        address probe = _pinned(address(new VerifyRwaProbe()));
        (bool ok, bytes memory reason) = probe.call(abi.encodeWithSignature("run()"));
        if (ok) return VerifyRwaProbe(probe).tally();
        assertEq(bytes4(reason), Verifier.VerificationFailed.selector, "the check failed for another reason");
        bytes memory counts = new bytes(reason.length - 4);
        for (uint256 i; i < counts.length; ++i) {
            counts[i] = reason[i + 4];
        }
        (mismatched, owedCount) = abi.decode(counts, (uint256, uint256));
    }

    /// The record as a lane move plans it: the registry, the park and the USDG adapter of the
    /// first run carried, nothing that holds the guard, and the first run's record kept as the
    /// previous one.
    function _planTheLaneMove() private returns (DeployRwa.Deployment memory first) {
        _restore();
        first = _deploy();
        previousPath = string.concat(RECORDS, "/", PREVIOUS, ".json");
        vm.writeFile(previousPath, vm.readFile(path));
        vm.writeJson(string.concat('"', PREVIOUS, '"'), previousPath, K.NETWORK);
        vm.writeJson(string.concat('"', PREVIOUS, '"'), path, K.SUPERSEDES);
        _stripLane(path);
        vm.roll(block.number + 10);
    }

    function _theJoinDeploysOnlyWhatHoldsTheGuard() private {
        DeployRwa.Deployment memory first = _planTheLaneMove();
        uint256 nonce = vm.getNonce(DEPLOYER);
        DeployRwa.Deployment memory out = _deploy();
        assertEq(vm.getNonce(DEPLOYER), nonce + 3, "the join deployed more than the guard, the router and the adapter");
        assertEq(address(out.registry), address(first.registry));
        assertEq(address(out.park), address(first.park));
        assertEq(address(out.usdgAdapter), address(first.usdgAdapter));
        assertTrue(address(out.guard) != address(first.guard));
        assertEq(out.guard.admin(), _readAddress(path, K.ADMIN_TIMELOCK));
        assertTrue(out.guard.isKeeper(_readAddress(path, ".rwa.guardKeeper")));
        assertEq(address(out.router.guard()), address(out.guard));
        assertEq(address(out.router.registry()), address(first.registry));
        assertEq(out.treasuryAdapter.park(), address(first.park));
        assertEq(address(out.treasuryAdapter.guard()), address(out.guard));
        // The park's list is governance's: the previous adapter stays listed until the wiring batch.
        assertTrue(first.park.isAdapter(address(first.treasuryAdapter)));
        assertFalse(first.park.isAdapter(address(out.treasuryAdapter)));

        _theRecordNamesTheNewThreeAndKeepsTheLanesFirstBlock(out);
        _theUnlistedAdapterIsOwedOnlyWhileTheSwitchIsPending(first, out);

        // A second run finds the guard recorded and refuses, as a fresh run would.
        _expectRefused(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.PRICE_GUARD, address(out.guard)));
    }

    function _theRecordNamesTheNewThreeAndKeepsTheLanesFirstBlock(DeployRwa.Deployment memory out) private view {
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, K.PRICE_GUARD), address(out.guard));
        assertEq(vm.parseJsonAddress(json, K.STOCK_ROUTER), address(out.router));
        assertEq(vm.parseJsonAddress(json, K.SGOV_ADAPTER), address(out.treasuryAdapter));
        assertEq(vm.parseJsonAddress(json, K.TREASURY_PARK), address(out.park));
        assertEq(
            vm.parseJsonUint(json, K.RWA_FROM_BLOCK),
            vm.parseJsonUint(vm.readFile(previousPath), K.RWA_FROM_BLOCK),
            "the join rewrote the lane's first block"
        );
        assertEq(vm.parseJsonUint(json, ".parameters.PriceGuard.minObservationAge"), out.guard.MIN_OBSERVATION_AGE());
    }

    /// Without the previous record an unlisted treasury adapter is wrong. With it, the previous
    /// adapter still listed is owed to the wiring batch, and nothing once the batch has switched
    /// them.
    function _theUnlistedAdapterIsOwedOnlyWhileTheSwitchIsPending(
        DeployRwa.Deployment memory first,
        DeployRwa.Deployment memory out
    ) private {
        (uint256 mismatched, uint256 owedCount) = _tally();
        assertEq(mismatched, 1, "the unlisted adapter passed with nothing saying it is being switched");
        assertEq(owedCount, 0);

        _set("BURSAR_PREVIOUS_RECORD", previousPath);
        (mismatched, owedCount) = _tally();
        assertEq(mismatched, 0, "the pending switch was a mismatch");
        assertEq(owedCount, 1);

        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        vm.prank(timelock);
        first.park.setAdapter(address(out.treasuryAdapter), true);
        vm.prank(timelock);
        first.park.setAdapter(address(first.treasuryAdapter), false);
        (mismatched, owedCount) = _tally();
        assertEq(mismatched, 0);
        assertEq(owedCount, 0, "the switch landed and something is still owed");
        _unset("BURSAR_PREVIOUS_RECORD");
    }

    function _theJoinRefusesAParkUnderAnotherAdmin() private {
        DeployRwa.Deployment memory first = _planTheLaneMove();
        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        address other = makeAddr("anotherAdmin");
        vm.prank(timelock);
        first.park.transferAdmin(other);
        vm.prank(other);
        first.park.acceptAdmin();
        _expectRefused(abi.encodeWithSelector(BursarScript.WiringFailed.selector, "park.admin", timelock, other));
    }

    /// The record's feed for an asset has to be the one the carried registry holds.
    function _theJoinRefusesAFeedTheRegistryDoesNotHold() private {
        _planTheLaneMove();
        address nvdaFeed = _readAddress(path, ".external.assets.NVDA.feed");
        address spyFeed = _readAddress(path, ".external.assets.SPY.feed");
        vm.writeJson(vm.toString(nvdaFeed), path, ".external.assets.SPY.feed");
        _expectRefused(
            abi.encodeWithSelector(BursarScript.WiringFailed.selector, "registry.SPY.feed", nvdaFeed, spyFeed)
        );
    }

    /// A registry that lacks a launch asset is not the one the record implies.
    function _theJoinRefusesARegistryMissingAnAsset() private {
        _planTheLaneMove();
        RwaConfig.Term[] memory terms = RwaConfig.terms();
        address[] memory list = new address[](3);
        AssetRegistry.Asset[] memory configs = new AssetRegistry.Asset[](3);
        for (uint256 i; i < 3; ++i) {
            string memory at = string.concat(K.EXTERNAL_ASSETS, ".", terms[i].symbol);
            list[i] = _readAddress(path, string.concat(at, ".address"));
            configs[i] = RwaConfig.asset(terms[i], list[i], _readAddress(path, string.concat(at, ".feed")), USDG);
        }
        AssetRegistry short = new AssetRegistry(_readAddress(path, K.ADMIN_TIMELOCK), USDG, list, configs);
        vm.writeJson(vm.toString(address(short)), path, K.ASSET_REGISTRY);
        _expectRefused(
            abi.encodeWithSelector(
                DeployRwa.AssetNotRegistered.selector, "AAPL", _readAddress(path, ".external.assets.AAPL.address")
            )
        );
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

    /// A complete record is a carried registry and park with the guard already recorded.
    function _aSecondRunIsRefused() private {
        _restore();
        DeployRwa.Deployment memory out = _deploy();
        _expectRefused(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.PRICE_GUARD, address(out.guard)));
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
