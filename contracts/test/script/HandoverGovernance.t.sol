// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AcceptGovernance} from "../../script/AcceptGovernance.s.sol";
import {HandoverGovernance} from "../../script/HandoverGovernance.s.sol";
import {Verify} from "../../script/Verify.s.sol";
import {VerifyCore} from "../../script/VerifyCore.s.sol";
import {IShieldedPoolReads} from "../../script/VerifyShielded.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {Governance} from "../../script/lib/Governance.sol";
import {IEntrypointRoles} from "../../script/lib/Handover.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {AdminTimelock} from "../../src/AdminTimelock.sol";
import {Escrow} from "../../src/Escrow.sol";
import {Reputation} from "../../src/Reputation.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {Vesting} from "../../src/token/Vesting.sol";
import {World} from "./World.sol";

/// The move from the one-hour timelock to a 48-hour one with hardware signers, through the real
/// scripts, on a set built and wired the way the live one is: the new timelock deployed and
/// recorded on its own, the old timelock's batch offering everything it administers, the new
/// timelock's batch accepting it and taking the old owner role away, and the record rewritten only
/// once the chain says the handover is whole.
contract HandoverGovernanceTest is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");
    uint64 internal constant PERIOD = 48 hours;
    uint256 internal constant COMMUNITY = 1_000e18;
    /// The old timelock's batch and the new one's.
    uint256 internal constant OFFERS = 14;
    uint256 internal constant ACCEPTANCES = 13;

    address internal constant HW_1 = address(0x4801);
    address internal constant HW_2 = address(0x4802);
    address internal constant HW_3 = address(0x4803);

    address internal previous;
    address internal guardian;
    address internal brsr;
    address[] internal oldSigners;

    function _prefix() internal pure override returns (string memory) {
        return "HANDOVER_";
    }

    function setUp() public {
        _world("handover");
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

        previous = _readAddress(path, K.ADMIN_TIMELOCK);
        guardian = _readAddress(path, K.GUARDIAN);
        brsr = _readAddress(path, K.BRSR);
        oldSigners = vm.parseJsonAddressArray(vm.readFile(path), K.SIGNERS);
        // The community allocation sits with the timelock, as it does on the chain.
        vm.prank(_readAddress(path, K.COMMUNITY));
        IERC20(brsr).transfer(previous, COMMUNITY);

        _set("BURSAR_SIGNERS_48H", _list(HW_1, HW_2, HW_3));
        _unset("BURSAR_GUARDIAN_48H");
        _save();
    }

    function _list(address a, address b, address c) private pure returns (string memory) {
        return string.concat(vm.toString(a), ",", vm.toString(b), ",", vm.toString(c));
    }

    function _handover(address key, string memory sig) private {
        _as(key, _pinned(address(new HandoverGovernance())), abi.encodeWithSignature(sig));
    }

    function _accept(address key, string memory sig) private {
        _as(key, _pinned(address(new AcceptGovernance())), abi.encodeWithSignature(sig));
    }

    function _expectRefused(address key, address script, string memory sig, bytes memory reason) private {
        address pinned = _pinned(script);
        vm.expectRevert(reason);
        _as(key, pinned, abi.encodeWithSignature(sig));
    }

    function _next() private view returns (AdminTimelock) {
        return AdminTimelock(_readAddress(path, K.GOVERNANCE48_TIMELOCK));
    }

    function test_handover_deploysOffersAcceptsAndRewritesTheRecordLast() public {
        _theDeployRefusesASignerSetThatIsNotThreeDistinctKeys();
        _theDeployRecordsTheNewGovernanceAndTouchesNothingElse();
        _theOldTimelockOffersEverythingInOneBatch();
        _theRecordWaitsForTheAcceptance();
        _theNewTimelockAcceptsEverythingAndTheRecordFollows();
    }

    function _theDeployRefusesASignerSetThatIsNotThreeDistinctKeys() private {
        _restore();
        _set("BURSAR_SIGNERS_48H", string.concat(vm.toString(HW_1), ",", vm.toString(HW_2)));
        _expectRefused(
            DEPLOYER,
            address(new HandoverGovernance()),
            "deploy()",
            abi.encodeWithSelector(HandoverGovernance.SignerCountMismatch.selector, 2)
        );

        _set("BURSAR_SIGNERS_48H", _list(HW_1, HW_2, HW_1));
        _expectRefused(
            DEPLOYER,
            address(new HandoverGovernance()),
            "deploy()",
            abi.encodeWithSelector(HandoverGovernance.DuplicateSigner.selector, HW_1)
        );

        _set("BURSAR_SIGNERS_48H", _list(HW_1, guardian, HW_3));
        _expectRefused(
            DEPLOYER,
            address(new HandoverGovernance()),
            "deploy()",
            abi.encodeWithSelector(HandoverGovernance.RoleCollision.selector, "guardian", "timelockSigner", guardian)
        );

        _set("BURSAR_SIGNERS_48H", _list(HW_1, HW_2, DEPLOYER));
        _expectRefused(
            DEPLOYER,
            address(new HandoverGovernance()),
            "deploy()",
            abi.encodeWithSelector(HandoverGovernance.RoleCollision.selector, "deployer", "timelockSigner", DEPLOYER)
        );

        // Hardware keys are plain keys too, so the acknowledgement stands.
        _set("BURSAR_SIGNERS_48H", _list(HW_1, HW_2, HW_3));
        string memory ack = vm.envString(_key("BURSAR_ALLOW_EOA_GOVERNANCE"));
        _unset("BURSAR_ALLOW_EOA_GOVERNANCE");
        _expectRefused(
            DEPLOYER,
            address(new HandoverGovernance()),
            "deploy()",
            abi.encodeWithSelector(HandoverGovernance.GovernanceHasNoMultisig.selector)
        );
        _set("BURSAR_ALLOW_EOA_GOVERNANCE", ack);

        // Only the deploy key puts governance up.
        _expectRefused(
            HW_1,
            address(new HandoverGovernance()),
            "deploy()",
            abi.encodeWithSelector(BursarScript.WrongDeployer.selector, DEPLOYER, HW_1)
        );
    }

    function _theDeployRecordsTheNewGovernanceAndTouchesNothingElse() private {
        _restore();
        _handover(DEPLOYER, "deploy()");
        AdminTimelock next = _next();
        assertEq(next.timelockPeriod(), PERIOD);
        assertEq(next.guardian(), guardian, "the guardian defaults to the record's");
        address[3] memory signers = next.getSigners();
        assertEq(signers[0], HW_1);
        assertEq(signers[1], HW_2);
        assertEq(signers[2], HW_3);

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddressArray(json, K.GOVERNANCE48_SIGNERS)[2], HW_3);
        assertEq(vm.parseJsonAddress(json, K.GOVERNANCE48_GUARDIAN), guardian);
        assertEq(vm.parseJsonUint(json, K.GOVERNANCE48_PERIOD), PERIOD);
        assertEq(vm.parseJsonAddress(json, K.GOVERNANCE48_PREVIOUS), previous);
        assertEq(vm.parseJsonUint(json, K.GOVERNANCE48_FROM_BLOCK), block.number);
        // The set is still the old timelock's, and the record says so.
        assertEq(vm.parseJsonAddress(json, K.ADMIN_TIMELOCK), previous);
        assertEq(vm.parseJsonAddressArray(json, K.SIGNERS)[0], oldSigners[0]);
        assertTrue(vm.parseJsonBool(json, ".dev"));
        assertFalse(vm.keyExistsJson(json, K.ESCROW_PAUSER));
        _check(address(new VerifyCore()));

        _expectRefused(
            DEPLOYER,
            address(new HandoverGovernance()),
            "deploy()",
            abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.GOVERNANCE48_TIMELOCK, address(next))
        );

        // Another guardian, named for the new governance alone.
        _restore();
        address brake = makeAddr("newGuardian");
        _set("BURSAR_GUARDIAN_48H", vm.toString(brake));
        _handover(DEPLOYER, "deploy()");
        assertEq(_next().guardian(), brake);
        assertEq(_readAddress(path, K.GUARDIAN), guardian, "the record's guardian moved before the handover");
        _unset("BURSAR_GUARDIAN_48H");
    }

    /// Fourteen proposals: eleven admins, the seeder, the Entrypoint's owner role and the BRSR. A
    /// second run proposes nothing, and a token sent to the old timelock after the transfer landed
    /// puts no second transfer up.
    function _theOldTimelockOffersEverythingInOneBatch() private {
        _restore();
        _handover(DEPLOYER, "deploy()");
        AdminTimelock old = AdminTimelock(previous);
        address next = address(_next());
        uint256 before = old.proposalCount();

        _expectRefused(
            HW_1,
            address(new HandoverGovernance()),
            "propose()",
            abi.encodeWithSelector(Governance.NotSigner.selector, previous, HW_1)
        );
        _handover(oldSigners[0], "status()");
        _handover(oldSigners[0], "propose()");
        assertEq(old.proposalCount(), before + OFFERS);
        _handover(oldSigners[1], "propose()");
        assertEq(old.proposalCount(), before + OFFERS, "proposed twice");
        _handover(oldSigners[1], "approve()");

        address early = _pinned(address(new HandoverGovernance()));
        vm.expectPartialRevert(Governance.DelayNotPassed.selector);
        _as(oldSigners[0], early, abi.encodeWithSignature("execute()"));

        vm.warp(block.timestamp + old.timelockPeriod());
        _handover(oldSigners[2], "execute()");
        assertEq(Reputation(_readAddress(path, K.REPUTATION)).pendingAdmin(), next);
        assertEq(Vesting(_readAddress(path, K.VESTING)).pendingAdmin(), next);
        assertEq(CreditPool(_readAddress(path, K.CREDIT_POOL)).pendingAdmin(), next);
        assertEq(V4LiquiditySeeder(_readAddress(path, K.SEEDER)).pendingOwner(), next);
        IEntrypointRoles entrypoint = IEntrypointRoles(_readAddress(path, K.ENTRYPOINT));
        assertTrue(entrypoint.hasRole(OWNER_ROLE, next), "the new timelock does not own the Entrypoint yet");
        assertTrue(entrypoint.hasRole(OWNER_ROLE, previous), "the old timelock lost the Entrypoint before it accepted");
        assertEq(IERC20(brsr).balanceOf(next), COMMUNITY, "the community allocation did not move");
        assertEq(IERC20(brsr).balanceOf(previous), 0);
        // Nothing has been accepted: the old timelock still administers everything.
        assertEq(Staking(_readAddress(path, K.STAKING)).admin(), previous);

        vm.prank(_readAddress(path, K.COMMUNITY));
        IERC20(brsr).transfer(previous, 1);
        uint256 after_ = old.proposalCount();
        _handover(oldSigners[0], "propose()");
        assertEq(old.proposalCount(), after_, "a unit sent afterwards put a second transfer up");
        vm.prank(previous);
        IERC20(brsr).transfer(_readAddress(path, K.COMMUNITY), 1);
    }

    /// The record follows the chain, never the other way round.
    function _theRecordWaitsForTheAcceptance() private {
        _restore();
        _handover(DEPLOYER, "deploy()");
        address next = address(_next());
        _expectRefused(
            DEPLOYER,
            address(new HandoverGovernance()),
            "finish()",
            abi.encodeWithSelector(HandoverGovernance.NotHandedOver.selector, "Reputation.admin", next, previous)
        );
        assertEq(_readAddress(path, K.ADMIN_TIMELOCK), previous);
    }

    /// Thirteen proposals on the new timelock, the revoke last, from the hardware keys; then the
    /// record is rewritten and the strict check finds nothing owed.
    function _theNewTimelockAcceptsEverythingAndTheRecordFollows() private {
        _restore();
        _handover(DEPLOYER, "deploy()");
        AdminTimelock old = AdminTimelock(previous);
        AdminTimelock next = _next();
        _handover(oldSigners[0], "propose()");
        _handover(oldSigners[1], "approve()");
        vm.warp(block.timestamp + old.timelockPeriod());
        _handover(oldSigners[0], "execute()");

        // The lines the hardware keys sign, and the batch as a script.
        _handover(DEPLOYER, "handover()");
        _expectRefused(
            oldSigners[0],
            address(new AcceptGovernance()),
            "propose()",
            abi.encodeWithSelector(Governance.NotSigner.selector, address(next), oldSigners[0])
        );
        _accept(HW_1, "status()");
        _accept(HW_1, "propose()");
        assertEq(next.proposalCount(), ACCEPTANCES);
        _accept(HW_2, "propose()");
        assertEq(next.proposalCount(), ACCEPTANCES, "proposed twice");
        _accept(HW_2, "approve()");
        address early = _pinned(address(new AcceptGovernance()));
        vm.expectPartialRevert(Governance.DelayNotPassed.selector);
        _as(HW_1, early, abi.encodeWithSignature("execute()"));

        vm.warp(block.timestamp + PERIOD);
        _accept(HW_3, "execute()");
        _handover(DEPLOYER, "handover()");
        assertEq(Reputation(_readAddress(path, K.REPUTATION)).admin(), address(next));
        assertEq(Staking(_readAddress(path, K.STAKING)).admin(), address(next));
        assertEq(Vesting(_readAddress(path, K.VESTING)).admin(), address(next));
        assertEq(V4LiquiditySeeder(_readAddress(path, K.SEEDER)).owner(), address(next));
        IEntrypointRoles entrypoint = IEntrypointRoles(_readAddress(path, K.ENTRYPOINT));
        assertTrue(entrypoint.hasRole(OWNER_ROLE, address(next)));
        assertFalse(entrypoint.hasRole(OWNER_ROLE, previous), "the old timelock still owns the Entrypoint");
        assertEq(Escrow(_readAddress(path, K.ESCROW)).pauser(), previous, "the escrow's pauser moved");
        assertFalse(IShieldedPoolReads(_readAddress(path, K.SHIELDED_POOL)).dead());

        // A unit sent to the old timelock holds the record back until the signers move it or the
        // run is forced past it.
        vm.prank(_readAddress(path, K.COMMUNITY));
        IERC20(brsr).transfer(previous, 1);
        _expectRefused(
            DEPLOYER,
            address(new HandoverGovernance()),
            "finish()",
            abi.encodeWithSelector(HandoverGovernance.StillHeld.selector, "BRSR on the previous timelock", 1)
        );
        vm.prank(previous);
        IERC20(brsr).transfer(_readAddress(path, K.COMMUNITY), 1);

        _handover(DEPLOYER, "finish()");
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, K.ADMIN_TIMELOCK), address(next));
        assertEq(vm.parseJsonAddress(json, K.ESCROW_PAUSER), previous);
        assertEq(vm.parseJsonAddressArray(json, K.SIGNERS)[1], HW_2);
        assertEq(vm.parseJsonAddress(json, K.GUARDIAN), guardian);
        assertFalse(vm.parseJsonBool(json, ".dev"));
        assertEq(vm.parseJsonUint(json, ".parameters.AdminTimelock.timelockPeriod"), PERIOD);
        assertTrue(vm.indexOf(vm.parseJsonString(json, ".note"), "48-hour") != type(uint256).max);

        _set("BURSAR_VERIFY_STRICT", "1");
        _check(address(new Verify()));
        _unset("BURSAR_VERIFY_STRICT");

        // Every step has nothing left to do.
        _handover(oldSigners[0], "propose()");
        _accept(HW_1, "propose()");
        assertEq(next.proposalCount(), ACCEPTANCES);
        _handover(DEPLOYER, "finish()");
    }
}
