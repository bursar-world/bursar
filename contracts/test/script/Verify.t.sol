// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";

import {Verify} from "../../script/Verify.s.sol";
import {VerifyCore} from "../../script/VerifyCore.s.sol";
import {VerifyWiring} from "../../script/VerifyWiring.s.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {Verifier} from "../../script/lib/Verifier.sol";

import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {Staking} from "../../src/token/Staking.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {World} from "./World.sol";

/// The full check with its tallies readable after a run that passes.
contract VerifyProbe is Verify {
    function tally() external view returns (uint256, uint256) {
        return (mismatches, owed);
    }
}

contract VerifyCoreProbe is VerifyCore {
    function tally() external view returns (uint256, uint256) {
        return (mismatches, owed);
    }
}

contract VerifyWiringProbe is VerifyWiring {
    function tally() external view returns (uint256, uint256) {
        return (mismatches, owed);
    }
}

interface ITally {
    function pinEnvPrefix(string calldata prefix) external;
    function tally() external view returns (uint256 mismatches, uint256 owed);
}

/// The verify scripts against a deployment built by the real scripts: what they pass, what they
/// list as owed, and what they fail on. Owed is a value governance or the migration still has to
/// set. A mismatch is anything else that disagrees with the record, including a governed value set
/// to the wrong thing.
contract VerifyTest is World {
    using stdStorage for StdStorage;

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    struct Outcome {
        bool passed;
        uint256 mismatches;
        uint256 owed;
    }

    function _prefix() internal pure override returns (string memory) {
        return "VERIFY_";
    }

    function setUp() public {
        _world("verify");
        _core();
        _token();
        _staking();
        _rwa();
        _collateral();
        _privacy();
        _as(DEPLOYER, _deployShieldedScript(), abi.encodeWithSignature("run()"));
        _save();
    }

    function test_verify_passesWhatIsDoneListsWhatIsOwedAndFailsWhatIsWrong() public {
        _aNewDeploymentPassesAndListsWhatGovernanceOwes();
        _theWiringAndTheLenderSettleWhatIsOwed();
        _aGovernedValueSetWrongIsAMismatch();
        _aRecordThatDisagreesWithTheChainFails();
        _aRecordedContractWithNoCodeFails();
        _theWrongContractIsAListOfMismatchesNotTheEndOfTheRun();
    }

    function _verify() private returns (Outcome memory) {
        return _outcome(address(new VerifyProbe()));
    }

    function _outcome(address probe) private returns (Outcome memory o) {
        ITally(probe).pinEnvPrefix(_prefix());
        (bool ok, bytes memory reason) = probe.call(abi.encodeWithSignature("run()"));
        if (ok) {
            (o.mismatches, o.owed) = ITally(probe).tally();
            o.passed = true;
            return o;
        }
        assertEq(bytes4(reason), Verifier.VerificationFailed.selector, "the check failed for another reason");
        bytes memory args = new bytes(reason.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = reason[i + 4];
        }
        (o.mismatches, o.owed) = abi.decode(args, (uint256, uint256));
    }

    function _strict(bool on) private {
        _set("BURSAR_VERIFY_STRICT", on ? "1" : "0");
    }

    /// Straight after the deploy scripts, the chain matches the record, and what the wiring
    /// batch and the lender still have to do is reported as owed.
    function _aNewDeploymentPassesAndListsWhatGovernanceOwes() private {
        _restore();
        _strict(false);
        Outcome memory o = _verify();
        assertTrue(o.passed);
        assertEq(o.mismatches, 0);
        // Keeper, three bond floors, the rebate table, the credit pool's two roles on staking,
        // the lender's cash, and a market nobody has seeded here.
        assertEq(o.owed, 9);

        // Strict is how the last check after the migration runs: anything owed fails it, and the
        // wiring check counts each of the seven values the batch sets as a mismatch while unset.
        _strict(true);
        o = _verify();
        assertFalse(o.passed);
        assertEq(o.mismatches, 7);
        assertEq(o.owed, 9);

        o = _outcome(address(new VerifyWiringProbe()));
        assertFalse(o.passed);
        assertEq(o.mismatches, 7);
        assertEq(o.owed, 0);
        _strict(false);
    }

    function _theWiringAndTheLenderSettleWhatIsOwed() private {
        _restore();
        _wiring();
        _strict(true);
        Outcome memory o = _verify();
        assertEq(o.mismatches, 0);
        assertEq(o.owed, 2);

        CreditPool pool = CreditPool(_readAddress(path, K.CREDIT_POOL));
        MockUsdg(USDG).mint(address(this), 10e6);
        IERC20(USDG).approve(address(pool), 10e6);
        pool.fund(10e6);
        o = _verify();
        assertEq(o.mismatches, 0);
        assertEq(o.owed, 1, "only the unseeded market should remain");

        o = _outcome(address(new VerifyWiringProbe()));
        assertTrue(o.passed);
        _strict(false);
    }

    /// Unset is owed. Set to anything but what the record intends, it is a mismatch, because a
    /// proposal that named the wrong address is worse than none.
    function _aGovernedValueSetWrongIsAMismatch() private {
        _restore();
        Staking staking = Staking(_readAddress(path, K.STAKING));
        stdstore.target(address(staking)).sig(staking.slasher.selector).checked_write(makeAddr("someoneElse"));
        Outcome memory o = _verify();
        assertFalse(o.passed);
        assertEq(o.mismatches, 1);
    }

    function _aRecordThatDisagreesWithTheChainFails() private {
        _restore();
        vm.writeJson("1209600", path, ".parameters.Staking.unbondingPeriod");
        Outcome memory o = _verify();
        assertFalse(o.passed);
        assertEq(o.mismatches, 1);
    }

    /// A record naming the wrong kind of contract meets reads that contract lacks. Each is a
    /// mismatch naming the read and the address, and every other question is still asked.
    function _theWrongContractIsAListOfMismatchesNotTheEndOfTheRun() private {
        _restore();
        Outcome memory o = _outcome(address(new VerifyCoreProbe()));
        assertTrue(o.passed);

        // The escrow's entry names the reputation contract. Of the escrow's sixteen reads,
        // reputation answers only `deployer`: fifteen mismatches. The reputation contract, the
        // resolver registry and the factory each name the real escrow: three more.
        vm.writeJson(vm.toString(_readAddress(path, K.REPUTATION)), path, K.ESCROW);
        o = _outcome(address(new VerifyCoreProbe()));
        assertFalse(o.passed);
        assertEq(o.mismatches, 18);

        // An address with no code at all is one mismatch, and the rest of the set still checks.
        _restore();
        vm.writeJson(vm.toString(makeAddr("noTimelockHere")), path, K.ADMIN_TIMELOCK);
        o = _outcome(address(new VerifyCoreProbe()));
        assertFalse(o.passed);
        assertGt(o.mismatches, 1);
    }

    function _aRecordedContractWithNoCodeFails() private {
        _restore();
        vm.writeJson(vm.toString(makeAddr("nothingHere")), path, K.DISCLOSURES);
        Outcome memory o = _verify();
        assertFalse(o.passed);
        assertEq(o.mismatches, 1);
    }
}
