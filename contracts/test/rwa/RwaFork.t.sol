// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IMandateAccount} from "../../src/interfaces/IMandateAccount.sol";
import {PriceGuard} from "../../src/rwa/PriceGuard.sol";
import {DeployRwa} from "../../script/DeployRwa.s.sol";
import {RwaConfig} from "../../script/lib/RwaConfig.sol";

/// Runs the RWA lane against live Robinhood Chain state: the real feeds, the real pinned pools,
/// the real access registry.
///
///   BURSAR_RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/rwa/RwaFork.t.sol -vv
contract RwaForkTest is Test {
    address internal constant TIMELOCK = 0x135eF562ac57845AeA1Bb650fc0E74D67A4a866B;
    address internal constant ESCROW = 0x4315F8be7C9661345710910577Ec31cb867f3c20;
    /// The deep USDG/SGOV v3 pool, used here only as a USDG balance to borrow from.
    address internal constant USDG_HOLDER = 0xfAb520051f96F4D2a32c22B6a3dD7fFfdf231bFe;
    address internal constant EXAMPLE = 0x420BeB507F72173E7d78e0f956968f64fb508356;

    IERC20 internal constant USDG = IERC20(RwaConfig.USDG);

    DeployRwa.Deployed d;
    address principal = makeAddr("principal");
    address agent = makeAddr("agent");

    function setUp() public {
        string memory rpc = vm.envOr("BURSAR_RHC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("BURSAR_RHC_FORK_RPC is unset; skipping the fork run.");
            vm.skip(true);
        }
        vm.createSelectFork(rpc);
        d = new DeployRwa().deploy(TIMELOCK, ESCROW);
    }

    function test_fork_buySpyAndParkSgov() public {
        IMandateAccount acct = _newMandate();

        uint256 spyPrice = d.guard.tradePrice(RwaConfig.SPY, address(acct));
        console2.log("SPY feed E8", spyPrice, "pool E8", d.guard.poolPriceE8(RwaConfig.SPY));
        vm.prank(agent);
        uint256 out = acct.buy(RwaConfig.SPY, 1e6, 0, spyPrice);
        assertEq(IERC20(RwaConfig.SPY).balanceOf(address(acct)), out);
        uint256 atFeed = out * spyPrice / 1e20;
        console2.log("SPY raw", out, "worth USDG", atFeed);
        assertApproxEqRel(atFeed, 1e6, 0.01e18);

        uint256 raw = _park(address(acct), 2e6);
        (,, uint256 value,,, bool fresh) = d.park.position(address(acct), address(d.sgovAdapter));
        console2.log("SGOV raw", raw, "value USDG", value);
        assertTrue(fresh);
        assertApproxEqRel(value, 2e6, 0.005e18);

        uint256 before = USDG.balanceOf(address(acct));
        vm.prank(principal);
        uint256 back = d.park.unpark(address(acct), address(d.sgovAdapter), raw, 0);
        console2.log("unparked USDG", back);
        assertEq(USDG.balanceOf(address(acct)), before + back);
        assertApproxEqRel(back, 2e6, 0.005e18);
    }

    function test_fork_buyUnparksShortfall() public {
        IMandateAccount acct = _newMandate();
        _park(address(acct), 5e6);
        uint256 held = USDG.balanceOf(address(acct));
        vm.prank(principal);
        acct.withdraw(RwaConfig.USDG, principal, held);

        uint256 price = d.guard.tradePrice(RwaConfig.NVDA, address(acct));
        vm.prank(agent);
        uint256 out = acct.buy(RwaConfig.NVDA, 1e6, 0, price);
        assertGt(out, 0);
        assertEq(USDG.balanceOf(address(acct)), 0);
    }

    /// Past the trade bound nothing trades while parked SGOV still counts; past its valuation
    /// bound it stops counting toward what the mandate can spend.
    function test_fork_staleRefuses() public {
        IMandateAccount acct = _newMandate();
        _park(address(acct), 2e6);

        vm.warp(block.timestamp + 30 hours);
        vm.prank(agent);
        vm.expectPartialRevert(PriceGuard.StalePrice.selector);
        acct.buy(RwaConfig.SPY, 1e6, 0, 1);
        (uint256 total,) = d.park.parkedValue(address(acct));
        assertGt(total, 0);

        vm.warp(block.timestamp + 4 days);
        (total,) = d.park.parkedValue(address(acct));
        assertEq(total, 0);
        assertEq(d.park.spendingPower(address(acct)), USDG.balanceOf(address(acct)));
    }

    /// The live proof, rehearsed on the example v2 mandate before it is sent. The example has
    /// spent down since, so the fork tops it up rather than depend on what it holds today.
    function test_fork_exampleMandateProof() public {
        IMandateAccount acct = IMandateAccount(EXAMPLE);
        address owner = acct.principal();
        vm.prank(USDG_HOLDER);
        USDG.transfer(EXAMPLE, 100_000);
        IMandateAccount.Limits memory l = acct.limits();
        l.classMask = 7;

        address[] memory list = new address[](3);
        list[0] = RwaConfig.SPY;
        list[1] = RwaConfig.NVDA;
        list[2] = RwaConfig.AAPL;
        bool[] memory yes = new bool[](3);
        yes[0] = yes[1] = yes[2] = true;

        vm.startPrank(owner);
        acct.setLimits(l);
        acct.setRouter(address(d.router));
        d.router.setPolicy(EXAMPLE, 100, list, yes);
        vm.stopPrank();

        uint256 price = d.guard.tradePrice(RwaConfig.SPY, EXAMPLE);
        vm.prank(acct.agent());
        uint256 out = acct.buy(RwaConfig.SPY, 50_000, 0, price);
        assertGt(out, 0);

        address vault = d.park.vaultOf(EXAMPLE);
        vm.startPrank(owner);
        acct.withdraw(RwaConfig.USDG, vault, 50_000);
        uint256 raw = d.park.park(EXAMPLE, address(d.sgovAdapter), 50_000, 0);
        uint256 back = d.park.unpark(EXAMPLE, address(d.sgovAdapter), raw, 0);
        vm.stopPrank();
        console2.log("example: SPY raw", out, "SGOV raw", raw);
        console2.log("example: unparked", back);
        assertApproxEqRel(back, 50_000, 0.01e18);
    }

    function _newMandate() internal returns (IMandateAccount acct) {
        IMandateAccount.Limits memory l = IMandateAccount.Limits({
            perCallCap: 10e6,
            dailyCap: 50e6,
            monthlyCap: 100e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 10e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: 1
        });
        vm.prank(principal);
        acct = IMandateAccount(d.factory.create(principal, agent, keccak256("fork"), l));
        vm.prank(USDG_HOLDER);
        USDG.transfer(address(acct), 20e6);

        address[] memory list = new address[](3);
        list[0] = RwaConfig.SPY;
        list[1] = RwaConfig.NVDA;
        list[2] = RwaConfig.AAPL;
        bool[] memory yes = new bool[](3);
        yes[0] = yes[1] = yes[2] = true;
        vm.startPrank(principal);
        acct.setRouter(address(d.router));
        acct.setTreasuryPark(address(d.park));
        d.router.setPolicy(address(acct), 0, list, yes);
        vm.stopPrank();
    }

    function _park(address acct, uint256 amount) internal returns (uint256 raw) {
        address vault = d.park.vaultOf(acct);
        vm.startPrank(principal);
        IMandateAccount(acct).withdraw(RwaConfig.USDG, vault, amount);
        raw = d.park.park(acct, address(d.sgovAdapter), amount, 0);
        vm.stopPrank();
    }
}
