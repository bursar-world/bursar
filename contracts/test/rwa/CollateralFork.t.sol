// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IMandateAccount} from "../../src/interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../../src/interfaces/IMandateAccountFactory.sol";
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {DeployCollateral} from "../../script/DeployCollateral.s.sol";
import {CollateralConfig} from "../../script/lib/CollateralConfig.sol";
import {RwaConfig} from "../../script/lib/RwaConfig.sol";

/// The collateral lane against live Robinhood Chain state: the M3a registry and guard, the v2.1
/// factory, the v2 escrow and its registered payee, the real SPY feed and pinned pool.
///
///   BURSAR_RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/rwa/CollateralFork.t.sol -vv
contract CollateralForkTest is Test {
    address internal constant USDG_HOLDER = 0xfAb520051f96F4D2a32c22B6a3dD7fFfdf231bFe;
    address internal constant PAYEE = 0x5210D8df060A9D5ce4c1305045ED5c9548fca374;
    bytes32 internal constant CAP = keccak256("service:demo.x402:1");

    IERC20 internal constant USDG = IERC20(RwaConfig.USDG);
    IERC20 internal constant SPY = IERC20(RwaConfig.SPY);

    DeployCollateral.Deployed d;
    IMandateAccount acct;
    address principal = makeAddr("principal");
    address lender = makeAddr("lender");
    address keeper = makeAddr("keeper");

    function setUp() public {
        string memory rpc = vm.envOr("BURSAR_RHC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("BURSAR_RHC_FORK_RPC is unset; skipping the fork run.");
            vm.skip(true);
        }
        vm.createSelectFork(rpc);
        d = new DeployCollateral().deploy(lender);

        vm.prank(USDG_HOLDER);
        USDG.transfer(lender, 30e6);
        vm.startPrank(lender);
        USDG.approve(address(d.pool), 30e6);
        d.pool.fund(30e6);
        vm.stopPrank();

        acct = _mandate(1, "collateral");
        vm.prank(RwaConfig.POOL_MANAGER);
        SPY.transfer(principal, 0.01e18);
        vm.startPrank(principal);
        d.vault.openLine(address(acct));
        SPY.approve(address(d.vault), type(uint256).max);
        d.vault.deposit(address(acct), RwaConfig.SPY, 0.01e18);
        vm.stopPrank();
    }

    function test_fork_drawAndRepay() public {
        (uint256 value, uint256 adjusted,, uint256 headroom, uint256 h0) = d.vault.account(address(acct));
        console2.log("value", value, "adjusted", adjusted);
        console2.log("headroom", headroom);
        assertGt(value, 5e6);
        assertEq(h0, type(uint256).max);

        vm.prank(principal);
        acct.spend(_req(2e6), new bytes32[](0));
        uint256 h1 = d.vault.health(address(acct));
        console2.log("health after draw (1e18 = 1.0)", h1);
        assertEq(d.pool.debtOf(address(acct)), 2e6);
        assertGt(h1, 1.25e18);

        vm.prank(USDG_HOLDER);
        USDG.transfer(principal, 3e6);
        vm.startPrank(principal);
        USDG.approve(address(d.pool), 3e6);
        d.pool.repay(address(acct), 3e6);
        vm.stopPrank();
        assertEq(d.pool.debtOf(address(acct)), 0);
        assertEq(d.vault.health(address(acct)), type(uint256).max);
    }

    function test_fork_prefundCannotBorrow() public {
        IMandateAccount prefund = _mandate(0, "prefund");
        vm.prank(principal);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotCollateralLane.selector, address(prefund), 0));
        d.vault.openLine(address(prefund));
        vm.prank(principal);
        vm.expectRevert();
        prefund.spend(_req(1e6), new bytes32[](0));
    }

    function test_fork_liquidateThroughPinnedPool() public {
        vm.prank(principal);
        acct.spend(_req(4e6), new bytes32[](0));

        // Governance tightens the index tier past the position; health falls below 1.
        CollateralVault.Tier memory t = CollateralVault.Tier(6_000, 6_500, 93_600, 360_000, "Index fund");
        vm.prank(CollateralConfig.TIMELOCK_V2);
        d.vault.setTier(1, t);
        uint256 h = d.vault.health(address(acct));
        console2.log("health before liquidation", h);
        assertLt(h, 1e18);

        vm.prank(keeper);
        uint256 sold = d.vault.liquidate(address(acct), RwaConfig.SPY);
        uint256 after_ = d.vault.health(address(acct));
        console2.log("sold raw", sold, "health after", after_);
        assertLt(sold, 0.01e18);
        assertGe(after_, 1e18);
        assertGt(USDG.balanceOf(keeper), 0);
    }

    function _mandate(uint8 lane, string memory salt) internal returns (IMandateAccount m) {
        IMandateAccount.Limits memory l = IMandateAccount.Limits({
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
        vm.prank(principal);
        m = IMandateAccount(
            IMandateAccountFactory(CollateralConfig.FACTORY_V21).create(principal, principal, keccak256(bytes(salt)), l)
        );
        vm.startPrank(principal);
        m.setTreasuryPark(address(d.vault));
        m.setCapability(CAP, true);
        m.setMerchant(PAYEE, true);
        vm.stopPrank();
    }

    function _req(uint128 amount) internal view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: PAYEE,
            capabilityId: CAP,
            inputCommit: bytes32(0),
            inputURI: "",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }
}
