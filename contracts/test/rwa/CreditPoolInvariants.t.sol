// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockStaking} from "./RwaMocks.sol";

/// Stands in for the collateral vault, the only caller the pool lets borrow and write off, and
/// drives the pool through random lending, repayment, write-offs, sweeps and time.
///
/// Every action swallows its own revert, as in the system-wide handler. The ghost totals record
/// what crossed the pool's edge: what the lender put in and took out, the spread borrowers paid
/// and the principal the pool wrote off.
contract CreditPoolHandler is CommonBase, StdUtils {
    CreditPool public immutable pool;
    MockERC20 public immutable usdg;
    address public immutable lender;
    address internal constant SINK = address(0xB0B);

    address[] public mandates;

    uint256 public funded;
    uint256 public withdrawn;
    uint256 public spreadReceived;
    uint256 public principalLost;
    uint256 public writeOffBreaks;

    constructor(CreditPool pool_, MockERC20 usdg_, address lender_) {
        pool = pool_;
        usdg = usdg_;
        lender = lender_;
        mandates.push(address(0xA1));
        mandates.push(address(0xA2));
        mandates.push(address(0xA3));
        usdg.approve(address(pool_), type(uint256).max);
    }

    function mandateCount() external view returns (uint256) {
        return mandates.length;
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1, 200e6);
        usdg.mint(lender, amount);
        vm.startPrank(lender);
        usdg.approve(address(pool), amount);
        pool.fund(amount);
        vm.stopPrank();
        funded += amount;
    }

    function withdraw(uint256 amount) external {
        uint256 c = pool.cash();
        if (c == 0) return;
        amount = bound(amount, 1, c);
        vm.prank(lender);
        try pool.withdrawLiquidity(lender, amount) {
            withdrawn += amount;
        } catch {}
    }

    function borrow(uint256 who, uint256 amount) external {
        amount = bound(amount, 1, 12e6);
        try pool.borrow(_mandate(who), amount, SINK) {} catch {}
    }

    function repay(uint256 who, uint256 amount) external {
        address m = _mandate(who);
        uint256 owed = pool.debtOf(m);
        if (owed == 0) return;
        amount = bound(amount, 1, owed * 2);
        usdg.mint(address(this), amount);
        uint256 before = pool.principalOf(m);
        try pool.repay(m, amount) returns (uint256 paid) {
            spreadReceived += paid - (before - pool.principalOf(m));
        } catch {}
    }

    /// A write-off clears the debt and the principal behind it and books nothing for stakers.
    function writeOff(uint256 who) external {
        address m = _mandate(who);
        uint256 principal = pool.principalOf(m);
        uint256 debt = pool.debtOf(m);
        uint256 reserves = pool.reserves();
        uint256 bad = pool.badDebt();
        try pool.writeOff(m) returns (uint256 amount) {
            principalLost += principal;
            if (
                amount != debt || pool.debtOf(m) != 0 || pool.principalOf(m) != 0 || pool.reserves() != reserves
                    || pool.badDebt() != bad + debt
            ) ++writeOffBreaks;
        } catch {}
    }

    function sweep() external {
        try pool.sweepSpread() {} catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 30 days));
    }

    function _mandate(uint256 who) internal view returns (address) {
        return mandates[who % mandates.length];
    }
}

contract CreditPoolInvariantTest is Test {
    uint128 internal constant TOTAL_CAP = 25e6;
    uint128 internal constant MANDATE_CAP = 10e6;

    MockERC20 usdg;
    MockStaking staking;
    CreditPool pool;
    CreditPoolHandler handler;
    address lender = makeAddr("lender");

    function setUp() public {
        usdg = new MockERC20();
        staking = new MockStaking(IERC20(address(usdg)));
        pool = new CreditPool(
            address(usdg), address(staking), makeAddr("timelock"), lender, TOTAL_CAP, MANDATE_CAP, 200, 1_800
        );
        handler = new CreditPoolHandler(pool, usdg, lender);
        pool.bindVault(address(handler));
        staking.setCreditManager(address(pool));
        handler.fund(TOTAL_CAP);
        targetContract(address(handler));
    }

    /// Every unit in the pool or lent out came from the lender or from spread a borrower paid,
    /// less what the lender took back, what was swept to stakers and what was written off.
    function invariant_cashLentAndReservesAreConserved() public view {
        assertEq(
            pool.cash() + _lent() + pool.reserves(),
            handler.funded() - handler.withdrawn() - handler.principalLost() + handler.spreadReceived()
                - staking.distributed(),
            "the pool's books drifted from what crossed its edge"
        );
        assertEq(usdg.balanceOf(address(pool)), pool.cash() + pool.reserves(), "reserves ran past the balance");
    }

    function invariant_stakersOnlyEverGetPaidSpread() public view {
        assertEq(
            pool.reserves() + staking.distributed(), handler.spreadReceived(), "stakers were owed spread no one paid"
        );
    }

    /// Caps are checked on the debt at the moment of a draw and principal never grows otherwise,
    /// so no principal outstanding can sit above them.
    function invariant_noPrincipalAboveCaps() public view {
        assertLe(_lent(), TOTAL_CAP, "principal out past the pool's cap");
        for (uint256 i; i < handler.mandateCount(); ++i) {
            address m = handler.mandates(i);
            assertLe(pool.principalOf(m), MANDATE_CAP, "principal out past a mandate's cap");
            assertLe(pool.principalOf(m), pool.debtOf(m), "principal read above the debt");
        }
    }

    function invariant_writeOffsClearDebtAndLeaveReserves() public view {
        assertEq(handler.writeOffBreaks(), 0, "a write-off left debt or principal, or moved reserves");
        assertGe(pool.badDebt(), handler.principalLost(), "bad debt below the principal written off");
    }

    function _lent() internal view returns (uint256 sum) {
        for (uint256 i; i < handler.mandateCount(); ++i) {
            sum += pool.principalOf(handler.mandates(i));
        }
    }
}
