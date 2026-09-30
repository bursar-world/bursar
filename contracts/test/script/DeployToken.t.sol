// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployToken} from "../../script/DeployToken.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {BRSR} from "../../src/token/BRSR.sol";
import {Vesting} from "../../src/token/Vesting.sol";
import {World} from "./World.sol";

/// The mint: BRSR and the team's vesting schedule, placed once and never again. On Robinhood Chain
/// the record already names both, so the case that matters most there is the refusal. Every case
/// that changes the environment runs in order inside one test, from the same saved chain.
contract DeployTokenTest is World {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant TEAM = 100_000_000e18;

    address internal community;
    address internal liquidity;
    address internal treasury;
    address internal beneficiary;

    function _prefix() internal pure override returns (string memory) {
        return "DEPLOYTOKEN_";
    }

    function setUp() public {
        _world("deploy-token");
        _core();
        community = vm.envAddress(_key("BURSAR_BRSR_COMMUNITY"));
        liquidity = vm.envAddress(_key("BURSAR_BRSR_LIQUIDITY"));
        treasury = _readAddress(path, K.TREASURY);
        beneficiary = vm.envAddress(_key("BURSAR_VESTING_BENEFICIARIES"));
        _save();
    }

    function test_deployToken_mintsOnceAndRecordsIt() public {
        _theWholeSupplyIsPlacedAndTheDeployKeyKeepsNone();
        _theTokenHasNoAdminAndTheScheduleIsClosed();
        _aSecondMintIsRefused();
        _aRecordThatAlreadyNamesTheTokenIsRefused();
        _governanceHasToBeInTheRecord();
        _theRetiredTimelockVariableIsRefused();
        _aShellThatNamesOtherGovernanceIsRefused();
        _aMissingRecipientIsRefused();
        _anAddressWearingTwoHatsIsRefused();
        _grantsHaveToAddUpToTheTeamShare();
        _aVestingStartOutsideItsRangeIsRefused();
        _aBackdatedStartInsideTheRangeVestsNothingOnDeployDay();
    }

    function _mint() private returns (DeployToken.Deployment memory) {
        return abi.decode(_run(DEPLOYER, address(new DeployToken())), (DeployToken.Deployment));
    }

    function _expectMintRefused(bytes memory reason) private {
        address script = _pinned(address(new DeployToken()));
        vm.expectRevert(reason);
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));
    }

    function _theWholeSupplyIsPlacedAndTheDeployKeyKeepsNone() private {
        _restore();
        DeployToken.Deployment memory out = _mint();
        BRSR brsr = BRSR(out.brsr);

        assertEq(brsr.totalSupply(), SUPPLY);
        assertEq(brsr.balanceOf(community), 800_000_000e18);
        assertEq(brsr.balanceOf(out.vesting), TEAM);
        assertEq(brsr.balanceOf(treasury), 50_000_000e18);
        assertEq(brsr.balanceOf(liquidity), 50_000_000e18);
        assertEq(brsr.balanceOf(DEPLOYER), 0);

        assertEq(_readAddress(path, K.BRSR), out.brsr);
        assertEq(_readAddress(path, K.VESTING), out.vesting);
        assertEq(_readAddress(path, K.COMMUNITY), community);
        assertEq(_readAddress(path, K.LIQUIDITY), liquidity);
        assertEq(_readUint(path, ".parameters.Vesting.start"), block.timestamp);
    }

    /// BRSR has no administered surface at all. The deploy key keeps one call on the vesting
    /// contract, uses it inside the run, and it does not survive the run.
    function _theTokenHasNoAdminAndTheScheduleIsClosed() private {
        _restore();
        DeployToken.Deployment memory out = _mint();

        string[5] memory absent = ["admin()", "owner()", "pause()", "mint(address,uint256)", "burn(uint256)"];
        for (uint256 i; i < absent.length; ++i) {
            (bool ok,) = out.brsr.call(abi.encodeWithSignature(absent[i], DEPLOYER, uint256(1)));
            assertFalse(ok, absent[i]);
        }

        Vesting vesting = Vesting(out.vesting);
        assertEq(vesting.admin(), _readAddress(path, K.ADMIN_TIMELOCK));
        assertTrue(vesting.grantsWritten());
        assertEq(vesting.outstandingWei(), TEAM);
        assertEq(vesting.claimableOf(beneficiary), 0);

        address[] memory who = new address[](1);
        who[0] = beneficiary;
        uint128[] memory howMuch = new uint128[](1);
        howMuch[0] = 1e18;
        vm.prank(DEPLOYER);
        vm.expectRevert(Vesting.AlreadyWritten.selector);
        vesting.createGrants(who, howMuch, uint64(block.timestamp));
    }

    function _aSecondMintIsRefused() private {
        _restore();
        DeployToken.Deployment memory first = _mint();
        _expectMintRefused(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.BRSR, first.brsr));
    }

    /// The mainnet record carries BRSR and Vesting over from the first deployment. Whatever the
    /// shell says, the run stops before a second supply exists.
    function _aRecordThatAlreadyNamesTheTokenIsRefused() private {
        _restore();
        address live = _readAddress(path, K.ADMIN_TIMELOCK);
        vm.writeJson(vm.toString(live), path, K.BRSR);
        _expectMintRefused(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.BRSR, live));
    }

    function _governanceHasToBeInTheRecord() private {
        _restore();
        address nothing = makeAddr("noGovernanceHere");
        vm.writeJson(vm.toString(nothing), path, K.ADMIN_TIMELOCK);
        _expectMintRefused(abi.encodeWithSelector(BursarScript.NotContract.selector, K.ADMIN_TIMELOCK, nothing));
    }

    /// A shell that still sets `BURSAR_TIMELOCK` stops the run and is pointed at the record.
    function _theRetiredTimelockVariableIsRefused() private {
        _restore();
        _set("BURSAR_TIMELOCK", vm.toString(DEPLOYER));
        _expectMintRefused(
            abi.encodeWithSelector(
                BursarScript.RetiredEnv.selector, _key("BURSAR_TIMELOCK"), "the record's contracts.AdminTimelock"
            )
        );
        _unset("BURSAR_TIMELOCK");
    }

    function _aShellThatNamesOtherGovernanceIsRefused() private {
        _restore();
        address other = makeAddr("otherGovernance");
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(other));
        _expectMintRefused(
            abi.encodeWithSelector(
                BursarScript.RecordMismatch.selector, K.ADMIN_TIMELOCK, _readAddress(path, K.ADMIN_TIMELOCK), other
            )
        );
        _set("BURSAR_ADMIN_TIMELOCK", vm.toString(address(0)));
    }

    function _aMissingRecipientIsRefused() private {
        _restore();
        _set("BURSAR_BRSR_COMMUNITY", vm.toString(address(0)));
        _expectMintRefused(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_BRSR_COMMUNITY")));
        _set("BURSAR_BRSR_COMMUNITY", vm.toString(community));
    }

    /// The mint is final. Nothing it names as a recipient may be the key that signs it, and no
    /// two recipients may be the same.
    function _anAddressWearingTwoHatsIsRefused() private {
        _restore();
        _set("BURSAR_BRSR_COMMUNITY", vm.toString(DEPLOYER));
        _expectMintRefused(
            abi.encodeWithSelector(DeployToken.RoleCollision.selector, "community", "deployer", DEPLOYER)
        );

        _set("BURSAR_BRSR_COMMUNITY", vm.toString(liquidity));
        _expectMintRefused(
            abi.encodeWithSelector(DeployToken.RoleCollision.selector, "community", "liquidity", liquidity)
        );
        _set("BURSAR_BRSR_COMMUNITY", vm.toString(community));

        _set("BURSAR_VESTING_BENEFICIARIES", vm.toString(treasury));
        _expectMintRefused(
            abi.encodeWithSelector(DeployToken.RoleCollision.selector, "beneficiary", "treasury", treasury)
        );
        _set("BURSAR_VESTING_BENEFICIARIES", vm.toString(beneficiary));
    }

    function _grantsHaveToAddUpToTheTeamShare() private {
        _restore();
        _set("BURSAR_VESTING_AMOUNTS", "90000000000000000000000000");
        _expectMintRefused(abi.encodeWithSelector(DeployToken.VestingAmountsMismatch.selector, 90_000_000e18, TEAM));

        _set("BURSAR_VESTING_AMOUNTS", "60000000000000000000000000,40000000000000000000000000");
        _expectMintRefused(abi.encodeWithSelector(DeployToken.VestingListLengthMismatch.selector, 1, 2));
        _set("BURSAR_VESTING_AMOUNTS", "100000000000000000000000000");
    }

    /// A start backdated past the cliff unlocks a quarter of the team allocation in the first
    /// block, so the run treats it as a typo.
    function _aVestingStartOutsideItsRangeIsRefused() private {
        _restore();
        uint64 earliest = uint64(block.timestamp) - 90 days;
        uint64 latest = uint64(block.timestamp) + 90 days;

        _set("BURSAR_VESTING_START", vm.toString(uint256(earliest - 1)));
        _expectMintRefused(
            abi.encodeWithSelector(DeployToken.VestingStartOutOfRange.selector, earliest - 1, earliest, latest)
        );
        _set("BURSAR_VESTING_START", vm.toString(uint256(latest + 1)));
        _expectMintRefused(
            abi.encodeWithSelector(DeployToken.VestingStartOutOfRange.selector, latest + 1, earliest, latest)
        );
        _set("BURSAR_VESTING_START", vm.toString(block.timestamp));
    }

    function _aBackdatedStartInsideTheRangeVestsNothingOnDeployDay() private {
        _restore();
        _set("BURSAR_VESTING_START", vm.toString(block.timestamp - 89 days));
        DeployToken.Deployment memory out = _mint();

        assertEq(Vesting(out.vesting).claimableOf(beneficiary), 0);
        (uint64 cliffAt,) = Vesting(out.vesting).scheduleOf(beneficiary);
        assertGt(cliffAt, block.timestamp);
        _set("BURSAR_VESTING_START", vm.toString(block.timestamp));
    }
}
