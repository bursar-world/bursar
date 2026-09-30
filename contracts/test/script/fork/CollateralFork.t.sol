// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RecordKeys as K} from "../../../script/lib/RecordKeys.sol";

import {AgentRegistry} from "../../../src/AgentRegistry.sol";
import {MandateAccountFactory} from "../../../src/MandateAccountFactory.sol";
import {IMandateAccount} from "../../../src/interfaces/IMandateAccount.sol";
import {CollateralVault} from "../../../src/rwa/CollateralVault.sol";
import {CreditPool} from "../../../src/rwa/CreditPool.sol";
import {IAggregatorV3} from "../../../src/rwa/interfaces/IRwaExternal.sol";
import {ForkWorld} from "./ForkWorld.sol";

/// The collateral lane the scripts deploy, against the live SPY feed and pinned pool: a mandate
/// with no USDG of its own spends on credit against posted stock and repays, a prefunded mandate
/// cannot borrow, a line governance pushes under water is liquidated through the pinned pool back to
/// its target, and a line drawn to its headroom mid-week is still healthy when the after-hours
/// haircut takes over.
contract CollateralForkTest is ForkWorld {
    bytes32 internal constant CAPABILITY = keccak256("service:demo.x402:1");
    uint256 internal constant POSTED = 0.01e18;

    address internal principal = makeAddr("principal");
    address internal payee = makeAddr("payee");
    address internal keeper = makeAddr("keeper");

    CollateralVault internal vault;
    CreditPool internal pool;
    address internal spy;

    function _prefix() internal pure override returns (string memory) {
        return "COLLATERALFORK_";
    }

    function setUp() public {
        _fork("fork-collateral");
        _core();
        _staking();
        _rwa();
        _collateral();
        vault = CollateralVault(_readAddress(path, K.COLLATERAL_VAULT));
        pool = CreditPool(_readAddress(path, K.CREDIT_POOL));
        spy = _asset("SPY");

        // The lender the record names funds the pool, as the runbook's lender does.
        address lender = _readAddress(path, K.LENDER);
        _usdg(lender, 30e6);
        vm.startPrank(lender);
        IERC20(USDG).approve(address(pool), 30e6);
        pool.fund(30e6);
        vm.stopPrank();

        // The escrow pays registered payees only.
        AgentRegistry registry = AgentRegistry(_readAddress(path, K.AGENT_REGISTRY));
        uint128 stake = registry.minStake();
        _usdg(payee, stake);
        vm.startPrank(payee);
        IERC20(USDG).approve(address(registry), stake);
        registry.register("fork_payee", stake);
        vm.stopPrank();
        _save();
    }

    function test_fork_collateralLaneAgainstTheLiveMarket() public {
        _requireSession("SPY");
        _aLineDrawsOnCreditAndRepays();
        _aPrefundedMandateCannotBorrow();
        _aLineUnderWaterIsLiquidatedThroughThePinnedPool();
        _aLineDrawnMidWeekIsHealthyWhenTheWeekendHaircutStarts();
    }

    function _aLineDrawsOnCreditAndRepays() private {
        _restore();
        IMandateAccount acct = _collateralMandate("draw");
        (uint256 value, uint256 adjusted,, uint256 headroom, uint256 before) = vault.account(address(acct));
        console2.log("value", value, "adjusted", adjusted);
        console2.log("headroom", headroom);
        assertGt(value, 5e6, "0.01 SPY is worth less than five dollars");
        assertEq(before, type(uint256).max, "a line with no debt is not at infinite health");

        vm.prank(principal);
        acct.spend(_request(2e6), new bytes32[](0));
        assertEq(pool.debtOf(address(acct)), 2e6);
        assertGt(vault.health(address(acct)), 1.25e18, "the draw left the line under its borrowing floor");

        _usdg(principal, 3e6);
        vm.startPrank(principal);
        IERC20(USDG).approve(address(pool), 3e6);
        pool.repay(address(acct), 3e6);
        vm.stopPrank();
        assertEq(pool.debtOf(address(acct)), 0);
        assertEq(vault.health(address(acct)), type(uint256).max);
    }

    function _aPrefundedMandateCannotBorrow() private {
        _restore();
        IMandateAccount prefund = _mandate("prefund", 0);
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotCollateralLane.selector, address(prefund), 0));
        vault.openLine(address(prefund));
        vm.prank(principal);
        vm.expectRevert();
        prefund.spend(_request(1e6), new bytes32[](0));
    }

    /// Governance tightens the index tier past the line; anyone may then sell just enough of the
    /// collateral through the pinned pool to bring it back to its target, for a bounty.
    function _aLineUnderWaterIsLiquidatedThroughThePinnedPool() private {
        _restore();
        IMandateAccount acct = _collateralMandate("liquidate");
        vm.prank(principal);
        acct.spend(_request(3.5e6), new bytes32[](0));

        CollateralVault.Tier memory tight = CollateralVault.Tier(6_000, 6_500, 93_600, 360_000, "Index fund");
        // `tierOf` counts from one, zero meaning not collateral; `setTier` takes the position in
        // the tier list, which counts from zero.
        uint8 index = vault.tierOf(spy) - 1;
        vm.prank(_readAddress(path, K.ADMIN_TIMELOCK));
        vault.setTier(index, tight);
        uint256 under = vault.health(address(acct));
        console2.log("health before liquidation", under);
        assertLt(under, 1e18);

        vm.prank(keeper);
        uint256 sold = vault.liquidate(address(acct), spy);
        uint256 restored = vault.health(address(acct));
        console2.log("sold raw", sold, "health after", restored);
        assertLt(sold, POSTED, "the liquidation sold everything");
        assertGe(restored, 1.05e18, "the line is below its liquidation target");
        assertLt(restored, 1.1e18, "the liquidation sold more than it needed to");
        assertGt(IERC20(USDG).balanceOf(keeper), 0, "the keeper earned no bounty");
    }

    /// The draw is checked against the after-hours haircut as well as the session one, so the line
    /// is still above water at Saturday 00:00 UTC, when the feed's last answer is Friday's close.
    function _aLineDrawnMidWeekIsHealthyWhenTheWeekendHaircutStarts() private {
        _restore();
        IMandateAccount acct = _collateralMandate("weekend");
        (,,, uint256 headroom,) = vault.account(address(acct));
        vm.prank(principal);
        acct.spend(_request(uint128(headroom)), new bytes32[](0));

        address feed = _readAddress(path, string.concat(K.EXTERNAL_ASSETS, ".SPY.feed"));
        uint256 saturday = _nextSaturday(block.timestamp);
        (uint80 round, int256 answer,,, uint80 answeredIn) = IAggregatorV3(feed).latestRoundData();
        vm.warp(saturday + 1);
        vm.mockCall(
            feed,
            abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(round, answer, saturday - 4 hours, saturday - 4 hours, answeredIn)
        );

        (, bool afterHours) = vault.haircutOf(spy);
        assertTrue(afterHours, "the after-hours haircut did not start at Saturday 00:00 UTC");
        uint256 h = vault.health(address(acct));
        console2.log("headroom drawn", headroom, "health at Saturday 00:00 UTC", h);
        assertGe(h, 1.2e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.Healthy.selector, h));
        vault.liquidate(address(acct), spy);
        vm.clearMockedCalls();
    }

    /// Saturday 00:00 UTC after `ts`; 1970-01-01 was a Thursday.
    function _nextSaturday(uint256 ts) private pure returns (uint256) {
        uint256 day = ts / 1 days;
        uint256 ahead = (13 - (day + 4) % 7) % 7;
        return (day + (ahead == 0 ? 7 : ahead)) * 1 days;
    }

    /// A lane-1 mandate with no USDG of its own and 0.01 SPY, borrowed from the pool manager's
    /// balance, posted as collateral.
    function _collateralMandate(string memory salt) private returns (IMandateAccount acct) {
        acct = _mandate(salt, vault.COLLATERAL_LANE());
        vm.prank(POOL_MANAGER);
        IERC20(spy).transfer(principal, POSTED);
        vm.startPrank(principal);
        acct.setTreasuryPark(address(vault));
        vault.openLine(address(acct));
        IERC20(spy).approve(address(vault), POSTED);
        vault.deposit(address(acct), spy, POSTED);
        vm.stopPrank();
    }

    function _mandate(string memory salt, uint8 lane) private returns (IMandateAccount m) {
        IMandateAccount.Limits memory limits = IMandateAccount.Limits({
            perCallCap: 10e6,
            dailyCap: 50e6,
            monthlyCap: 100e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 10e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 3,
            totalCap: 0,
            lane: lane
        });
        MandateAccountFactory factory = MandateAccountFactory(_readAddress(path, K.FACTORY));
        vm.prank(principal);
        m = IMandateAccount(factory.create(principal, principal, keccak256(bytes(salt)), limits));
        vm.startPrank(principal);
        m.setCapability(CAPABILITY, true);
        m.setMerchant(payee, true);
        vm.stopPrank();
    }

    function _request(uint128 amount) private view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: payee,
            capabilityId: CAPABILITY,
            inputCommit: bytes32(0),
            inputURI: "",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }
}
