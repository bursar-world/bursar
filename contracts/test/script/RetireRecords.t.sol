// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RetireRecords} from "../../script/RetireRecords.s.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {World} from "./World.sol";

/// The step that ends the move: it retires the records of the sets being replaced only once
/// nothing on them is open, and says what is.
///
/// A world built by the scripts stands in for the old sets, so each old record here names
/// contracts of that one deployment. Both old records name its escrow, which means an open payment
/// there is counted once for each of them.
contract RetireRecordsTest is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    string[3] internal names = ["V1_RECORD", "V2_RECORD", "TOKEN_RECORD"];
    string[3] internal files;
    string[3] internal written;

    function _prefix() internal pure override returns (string memory) {
        return "RETIRERECORDS_";
    }

    function setUp() public {
        _world("retire");
        _core();
        _token();
        _staking();
        _rwa();
        _collateral();
        _privacy();
        _as(DEPLOYER, _deployShieldedScript(), abi.encodeWithSignature("run()"));

        address seeder = address(
            new V4LiquiditySeeder(
                _readAddress(path, K.POOL_MANAGER), _readAddress(path, K.BUYBACK), _readAddress(path, K.ADMIN_TIMELOCK)
            )
        );
        string memory escrow = vm.toString(_readAddress(path, K.ESCROW));
        written[0] = string.concat('{"network":"old-v1","status":"superseded","contracts":{"Escrow":"', escrow, '"}}');
        written[1] = string.concat(
            '{"network":"old-v2","status":"live","contracts":{"Escrow":"',
            escrow,
            '"},"rwa":{"collateral":{"CreditPool":"',
            vm.toString(_readAddress(path, K.CREDIT_POOL)),
            '","CollateralVault":"',
            vm.toString(_readAddress(path, K.COLLATERAL_VAULT)),
            '"}},"privacy":{"shielded":{"ShieldedPool":"',
            vm.toString(_readAddress(path, K.SHIELDED_POOL)),
            '"}}}'
        );
        written[2] = string.concat(
            '{"network":"old-token","status":"live","contracts":{"V4LiquiditySeeder":"',
            vm.toString(seeder),
            '","Staking":"',
            vm.toString(_readAddress(path, K.STAKING)),
            '","Buyback":"',
            vm.toString(_readAddress(path, K.BUYBACK)),
            '"}}'
        );
        for (uint256 i; i < 3; ++i) {
            files[i] = string.concat(RECORDS, "/retire-old-", vm.toLowercase(names[i]), ".json");
            _set(string.concat("BURSAR_", names[i]), files[i]);
        }
        _save();
    }

    function test_retireRecords_retiresOnlyWhatNothingIsLeftOpenOn() public {
        _withNothingOpenTheOldRecordsRetireAndThisOneGoesLive();
        _cashInTheOldCreditPoolKeepsThemInUse();
        _stakeInTheOldPoolKeepsThemInUse();
        _anOpenPaymentKeepsThemInUseUntilSettleReturnsIt();
    }

    /// The chain and every record as they stood before the case.
    function _reset() private {
        _restore();
        for (uint256 i; i < 3; ++i) {
            vm.writeFile(files[i], written[i]);
        }
    }

    function _retire() private {
        _run(DEPLOYER, address(new RetireRecords()));
    }

    function _expectStillOpen(uint256 count) private {
        address script = _pinned(address(new RetireRecords()));
        vm.expectRevert(abi.encodeWithSelector(RetireRecords.StillOpen.selector, count));
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));
    }

    function _status(string memory file) private view returns (string memory) {
        return vm.parseJsonString(vm.readFile(file), K.STATUS);
    }

    function _withNothingOpenTheOldRecordsRetireAndThisOneGoesLive() private {
        _reset();
        _retire();
        string memory next = vm.parseJsonString(vm.readFile(path), K.NETWORK);
        for (uint256 i; i < 3; ++i) {
            assertEq(_status(files[i]), "retired", names[i]);
            assertGt(bytes(vm.parseJsonString(vm.readFile(files[i]), K.RETIRED)).length, 0, names[i]);
        }
        assertEq(vm.parseJsonString(vm.readFile(files[0]), K.SUPERSEDED_BY), "old-v2");
        assertEq(vm.parseJsonString(vm.readFile(files[1]), K.SUPERSEDED_BY), next);
        assertEq(vm.parseJsonString(vm.readFile(files[2]), K.SUPERSEDED_BY), next);
        assertEq(_status(path), "live");
        // What the records held is kept: retiring adds, it does not rewrite.
        assertEq(vm.parseJsonAddress(vm.readFile(files[0]), ".contracts.Escrow"), _readAddress(path, K.ESCROW));
    }

    function _cashInTheOldCreditPoolKeepsThemInUse() private {
        _reset();
        CreditPool pool = CreditPool(_readAddress(path, K.CREDIT_POOL));
        MockUsdg(USDG).mint(address(this), 1e6);
        IERC20(USDG).approve(address(pool), 1e6);
        pool.fund(1e6);
        _expectStillOpen(1);
        assertEq(_status(files[1]), "live", "a refused run wrote the record");

        // Forced, the records retire anyway, and the run lists what was left.
        _set("BURSAR_FORCE", "1");
        _retire();
        _unset("BURSAR_FORCE");
        assertEq(_status(files[1]), "retired");
    }

    /// Stakers leave the old pool themselves. Until the last one has, the record that shows them
    /// where their stake is stays in use.
    function _stakeInTheOldPoolKeepsThemInUse() private {
        _reset();
        Staking staking = Staking(_readAddress(path, K.STAKING));
        IERC20 brsr = IERC20(_readAddress(path, K.BRSR));
        vm.prank(vm.envAddress(_key("BURSAR_BRSR_COMMUNITY")));
        brsr.transfer(address(this), 1_000e18);
        brsr.approve(address(staking), 1_000e18);
        staking.stake(1_000e18);
        _expectStillOpen(1);
    }

    /// A payment still locked on the old escrow, and the USDG it holds there, count for each record
    /// that names the escrow. Once its deadline passes, `settle` returns it to its payer and sweeps
    /// the fees, and the records retire.
    function _anOpenPaymentKeepsThemInUseUntilSettleReturnsIt() private {
        _reset();
        Escrow escrow = Escrow(_readAddress(path, K.ESCROW));
        address payee = makeAddr("oldPayee");
        AgentRegistry registry = AgentRegistry(_readAddress(path, K.AGENT_REGISTRY));
        uint128 stake = registry.minStake();
        MockUsdg(USDG).mint(payee, stake);
        vm.startPrank(payee);
        IERC20(USDG).approve(address(registry), stake);
        registry.register("old_payee", stake);
        vm.stopPrank();

        address payer = makeAddr("oldPayer");
        MockUsdg(USDG).mint(payer, 1e6);
        vm.startPrank(payer);
        IERC20(USDG).approve(address(escrow), 1e6);
        uint256 id = escrow.lock(payee, keccak256("job"), bytes32(0), "", 1e6, uint64(block.timestamp + 1 hours));
        vm.stopPrank();

        _expectStillOpen(4);

        vm.warp(block.timestamp + 1 hours + 1);
        _as(DEPLOYER, _pinned(address(new RetireRecords())), abi.encodeWithSignature("settle()"));
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.TimedOut));
        assertEq(IERC20(USDG).balanceOf(payer), 1e6, "the payer did not get its payment back");
        _retire();
        assertEq(_status(files[0]), "retired");
    }
}
