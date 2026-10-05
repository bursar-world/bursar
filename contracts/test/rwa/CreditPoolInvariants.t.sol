// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {Buyback} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {MockBRSR} from "../mocks/MockBRSR.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// Stands in for the collateral vault, the only caller the pool lets borrow and write off, and
/// drives the pool through random lending, repayment, write-offs, sweeps and time, while
/// governance restates the Buyback's ceiling and names or clears the pool as Staking's slasher.
///
/// Every action swallows its own revert, as in the system-wide handler. The ghost totals record
/// what crossed the pool's edge: what the lender put in and took out, the spread borrowers paid
/// and the principal the pool wrote off.
contract CreditPoolHandler is CommonBase, StdUtils {
    CreditPool public immutable pool;
    MockERC20 public immutable usdg;
    Staking public immutable staking;
    Buyback public immutable buyback;
    address public immutable lender;
    address public immutable governance;
    address internal constant SINK = address(0xB0B);

    address[] public mandates;

    uint256 public funded;
    uint256 public withdrawn;
    uint256 public spreadReceived;
    uint256 public principalLost;
    uint256 public writeOffBreaks;
    uint256 public slashBreaks;
    uint256 public coverBreaks;

    constructor(CreditPool pool_, MockERC20 usdg_, address lender_, address governance_) {
        pool = pool_;
        usdg = usdg_;
        staking = Staking(address(pool_.staking()));
        buyback = pool_.buyback();
        lender = lender_;
        governance = governance_;
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
    /// The vault names what its seizure covers at the feed, anywhere from nothing to past the
    /// debt here, and the pool counts no more of it than the debt. The stake the write-off takes
    /// is the uncovered loss at the Buyback's ceiling cut to the slash allowance, none for a loss
    /// the collateral covers, and none unless the pool is the slasher and the ceiling is set and
    /// fresh.
    function writeOff(uint256 who, uint256 covered) external {
        address m = _mandate(who);
        uint256 principal = pool.principalOf(m);
        uint256 debt = pool.debtOf(m);
        covered = bound(covered, 0, debt * 2 + 1);
        uint256 counted = Math.min(covered, debt);
        uint256 reserves = pool.reserves();
        uint256 bad = pool.badDebt();
        uint256 wasCovered = pool.lossCovered();
        uint256 staked = staking.totalStaked();
        uint256 due = Math.min(_atCeiling(debt - counted), staking.slashAllowance());
        try pool.writeOff(m, covered) returns (uint256 amount) {
            principalLost += principal;
            if (
                amount != debt || pool.debtOf(m) != 0 || pool.principalOf(m) != 0 || pool.reserves() != reserves
                    || pool.badDebt() != bad + debt
            ) ++writeOffBreaks;
            if (staked - staking.totalStaked() != due) ++slashBreaks;
            if (pool.lossCovered() != wasCovered + counted) ++coverBreaks;
        } catch {}
    }

    /// Anywhere from unset to a dollar a BRSR.
    function restate(uint256 price) external {
        Buyback.Params memory p = buyback.params();
        p.maxPriceMicroUsdPerBrsr = uint128(bound(price, 0, 1e6));
        vm.prank(governance);
        buyback.setParams(p);
    }

    function nameSlasher(bool named) external {
        vm.prank(governance);
        staking.setSlasher(named ? address(pool) : address(0));
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

    function _atCeiling(uint256 loss) internal view returns (uint256) {
        if (staking.slasher() != address(pool)) return 0;
        uint256 ceiling = buyback.params().maxPriceMicroUsdPerBrsr;
        if (ceiling == 0 || block.timestamp > buyback.ceilingSetAt() + buyback.maxCeilingAge()) return 0;
        return Math.mulDiv(loss, 1e18, ceiling);
    }
}

contract CreditPoolInvariantTest is Test {
    uint128 internal constant TOTAL_CAP = 25e6;
    uint128 internal constant MANDATE_CAP = 10e6;
    uint256 internal constant STAKE = 1_000_000e18;

    MockERC20 usdg;
    MockBRSR brsr;
    Staking staking;
    CreditPool pool;
    CreditPoolHandler handler;
    address lender = makeAddr("lender");
    address governance = makeAddr("timelock");
    address staker = makeAddr("staker");

    function setUp() public {
        usdg = new MockERC20();
        brsr = new MockBRSR();
        address treasury = makeAddr("treasury");
        staking = new Staking(
            IERC20(address(brsr)), IERC20(address(usdg)), governance, makeAddr("slashSink"), treasury, 7 days, 1
        );
        Buyback buyback = new Buyback(
            address(usdg),
            address(brsr),
            makeAddr("poolManager"),
            3000,
            60,
            address(0),
            address(staking),
            governance,
            treasury,
            Buyback.Params({
                spendPerCallMicroUsd: 1e6,
                maxSpendPerWindowMicroUsd: 10e6,
                minSpendMicroUsd: 0.1e6,
                maxPriceMicroUsdPerBrsr: 50_000,
                window: 1 days,
                minInterval: 1 hours
            })
        );
        pool = new CreditPool(
            address(usdg), address(staking), address(buyback), governance, lender, TOTAL_CAP, MANDATE_CAP, 200, 1_800
        );
        handler = new CreditPoolHandler(pool, usdg, lender, governance);
        pool.bindVault(address(handler));
        vm.startPrank(governance);
        staking.setCreditManager(address(pool));
        staking.setSlasher(address(pool));
        vm.stopPrank();

        brsr.mint(staker, STAKE);
        vm.startPrank(staker);
        brsr.approve(address(staking), STAKE);
        staking.stake(STAKE);
        vm.stopPrank();

        handler.fund(TOTAL_CAP);
        targetContract(address(handler));
    }

    /// Every unit in the pool or lent out came from the lender or from spread a borrower paid,
    /// less what the lender took back, what was swept to stakers and what was written off.
    function invariant_cashLentAndReservesAreConserved() public view {
        assertEq(
            pool.cash() + _lent() + pool.reserves(),
            handler.funded() - handler.withdrawn() - handler.principalLost() + handler.spreadReceived()
                - usdg.balanceOf(address(staking)),
            "the pool's books drifted from what crossed its edge"
        );
        assertEq(usdg.balanceOf(address(pool)), pool.cash() + pool.reserves(), "reserves ran past the balance");
    }

    function invariant_stakersOnlyEverGetPaidSpread() public view {
        assertEq(
            pool.reserves() + usdg.balanceOf(address(staking)),
            handler.spreadReceived(),
            "stakers were owed spread no one paid"
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

    /// Every write-off takes the uncovered loss at a live ceiling, cut to what the window's
    /// allowance had left, nothing for the part seized collateral covers, and nothing while the
    /// pool is not the slasher or the ceiling is unset or stale.
    function invariant_slashIsTheLossAtTheCeilingInsideTheAllowance() public view {
        assertEq(handler.slashBreaks(), 0, "a write-off slashed off the ceiling or past the allowance");
    }

    /// What the vault says its seizure covers is booked against the debt and no further: the
    /// covered loss never runs past what was written off.
    function invariant_coveredLossNeverExceedsTheWriteOff() public view {
        assertEq(handler.coverBreaks(), 0, "a write-off booked cover past the debt");
        assertLe(pool.lossCovered(), pool.badDebt(), "cover past the bad debt");
    }

    function _lent() internal view returns (uint256 sum) {
        for (uint256 i; i < handler.mandateCount(); ++i) {
            sum += pool.principalOf(handler.mandates(i));
        }
    }
}
