// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Endowment} from "../../src/endowment/Endowment.sol";
import {EndowmentFactory} from "../../src/endowment/EndowmentFactory.sol";
import {PatronMark} from "../../src/endowment/PatronMark.sol";
import {RwaFixture} from "../rwa/RwaFixture.sol";

/// The ERC-8004 identity registry, as far as an endowment reads it.
contract MockIdentity {
    mapping(uint256 => address) private _owners;

    error ERC721NonexistentToken(uint256 tokenId);

    function set(uint256 id, address owner) external {
        _owners[id] = owner;
    }

    function ownerOf(uint256 id) external view returns (address owner) {
        owner = _owners[id];
        if (owner == address(0)) revert ERC721NonexistentToken(id);
    }
}

contract EndowmentTest is RwaFixture {
    uint256 internal constant AGENT = 7;
    uint256 internal constant SUCCESSOR = 8;

    MockIdentity identity;
    EndowmentFactory factory;
    PatronMark marks;

    address settlor = makeAddr("settlor");
    address patron = makeAddr("patron");
    address stranger = makeAddr("stranger");
    address treasury = makeAddr("treasury");
    address guardianKey = makeAddr("guardian");
    address successorOwner = makeAddr("successorOwner");

    function setUp() public override {
        super.setUp();
        identity = new MockIdentity();
        identity.set(AGENT, principal);
        identity.set(SUCCESSOR, successorOwner);
        factory = new EndowmentFactory(
            router,
            guard,
            reg,
            IERC20(address(usdg)),
            IERC721(address(identity)),
            treasury,
            500,
            guardianKey,
            new PatronMark(vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1), "https://app.bursar.world/api/marks/")
        );
        marks = factory.marks();
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? settlor : i == 1 ? patron : stranger;
            usdg.mint(who, 10_000e6);
            vm.prank(who);
            usdg.approve(address(factory), type(uint256).max);
        }
    }

    function test_create_startsTheEndowmentAndMakesTheSettlorItsFirstPatron() public {
        Endowment e = _create(100e6);

        assertEq(usdg.balanceOf(address(e)), 100e6);
        assertEq(e.givenBy(settlor), 100e6);
        assertEq(e.given(), 100e6);
        assertEq(e.patrons(), 1);
        assertEq(marks.ownerOf(1), settlor);
        assertTrue(marks.markOf(1).founding);
        assertEq(marks.markOf(1).endowment, address(e));
        assertEq(factory.count(), 1);
        assertEq(factory.endowmentsOf(AGENT)[0], address(e));
        assertFalse(e.accepted());
        assertEq(e.accrued(), 0);
    }

    function test_create_refusesTermsOutsideTheRules() public {
        Endowment.Terms memory t = _terms();
        t.drawBps = 50;
        vm.expectRevert(abi.encodeWithSelector(EndowmentFactory.BadDraw.selector, 50));
        factory.create(t, 0);

        t = _terms();
        t.assets[0] = address(sgov);
        vm.expectRevert(abi.encodeWithSelector(EndowmentFactory.NotAStock.selector, address(sgov)));
        factory.create(t, 0);

        t = _terms();
        t.weightsBps[0] = 9_000;
        vm.expectRevert(EndowmentFactory.BadWeights.selector);
        factory.create(t, 0);

        t = _terms();
        t.agentId = 99;
        vm.expectRevert(abi.encodeWithSelector(MockIdentity.ERC721NonexistentToken.selector, 99));
        factory.create(t, 0);
    }

    function test_invest_buysTheStockOneTradeAtATime() public {
        Endowment e = _create(60e6);

        uint256 out = e.invest();

        assertGt(out, 0);
        assertEq(spy.balanceOf(address(e)), out);
        assertEq(usdg.balanceOf(address(e)), 35e6);
        e.invest();
        e.invest();
        assertEq(usdg.balanceOf(address(e)), 0);
        vm.expectRevert(Endowment.NothingToInvest.selector);
        e.invest();
    }

    function test_accept_isTheIdentityOwnersAndTakesTheFirstValuation() public {
        Endowment e = _create(100e6);

        vm.prank(stranger);
        vm.expectRevert(Endowment.NotOwner.selector);
        e.accept(address(acct));

        vm.prank(principal);
        e.accept(address(acct));

        assertTrue(e.accepted());
        assertEq(e.mandate(), address(acct));
        assertEq(e.snapshotsTaken(), 1);
        assertEq(e.averageNav(), 100e6);
        assertEq(e.drawPerYear(), 4e6);
    }

    function test_draw_paysTheMandateLessTheFeeAndOnlyToTheAgentsSide() public {
        Endowment e = _accepted(100e6);
        vm.warp(block.timestamp + 73 days);

        vm.prank(stranger);
        vm.expectRevert(Endowment.NotDrawer.selector);
        e.draw();

        uint256 before = usdg.balanceOf(address(acct));
        uint256 owed = e.accrued();
        assertEq(owed, Math.mulDiv(4e6, 73 days, 365 days));
        vm.prank(agent);
        uint256 paid = e.draw();

        assertEq(paid, owed);
        assertEq(usdg.balanceOf(treasury), paid / 20);
        assertEq(usdg.balanceOf(address(acct)), before + paid - paid / 20);
        assertEq(e.drawn(), paid - paid / 20);
        assertEq(e.accrued(), 0);
        assertEq(e.lastActive(), block.timestamp);
    }

    function test_draw_owesNoMoreThanTheSleeve() public {
        Endowment e = _accepted(100e6);
        vm.warp(block.timestamp + 400 days);
        assertEq(e.accrued(), Math.mulDiv(4e6, 90 days, 365 days));
    }

    function test_refill_sellsStockWhenTheSleeveRunsLow() public {
        Endowment e = _accepted(100e6);
        while (usdg.balanceOf(address(e)) > e.sleeveTarget() + 1e6) {
            e.invest();
        }
        vm.warp(block.timestamp + 90 days);
        spyFeed.set(int256(SPY_E8), block.timestamp);
        vm.prank(agent);
        e.draw();
        uint256 cash = usdg.balanceOf(address(e));
        assertLt(cash * 2, e.sleeveTarget());

        uint256 spyBefore = spy.balanceOf(address(e));
        uint256 out = e.refill();

        assertGt(out, 0);
        assertLt(spy.balanceOf(address(e)), spyBefore);
        assertEq(usdg.balanceOf(address(e)), cash + out);
        vm.expectRevert(Endowment.SleeveFull.selector);
        e.refill();
    }

    function test_earn_splitsBetweenThePrincipalAndTheAgent() public {
        Endowment e = _accepted(100e6);
        vm.prank(stranger);
        usdg.approve(address(e), 10e6);
        uint256 before = usdg.balanceOf(address(acct));

        vm.prank(stranger);
        e.earn(10e6);

        assertEq(e.earned(), 10e6);
        assertEq(e.earnedToPrincipal(), 5e6);
        assertEq(usdg.balanceOf(address(acct)), before + 5e6);
        assertEq(usdg.balanceOf(address(e)), 105e6);
    }

    function test_unattributed_isTheSettlorsBeforeAcceptanceAndThePrincipalsAfter() public {
        Endowment e = _create(100e6);
        usdg.mint(address(e), 7e6);
        e.invest();
        assertEq(e.givenBy(settlor), 107e6);

        vm.prank(principal);
        e.accept(address(acct));
        usdg.mint(address(e), 3e6);
        e.invest();
        assertEq(e.unattributed(), 3e6);
        assertEq(e.givenBy(settlor), 107e6);
    }

    function test_gifts_markEachPatronOnce() public {
        Endowment e = _create(100e6);
        vm.startPrank(patron);
        usdg.approve(address(e), type(uint256).max);
        e.give(0.5e6);
        assertEq(e.patrons(), 1);
        e.give(0.5e6);
        e.give(5e6);
        vm.stopPrank();

        assertEq(e.patrons(), 2);
        assertEq(marks.balanceOf(patron), 1);
        assertEq(e.givenBy(patron), 6e6);

        vm.prank(patron);
        vm.expectRevert(PatronMark.Soulbound.selector);
        marks.transferFrom(patron, stranger, 2);
        assertTrue(marks.locked(2));
    }

    function test_lapse_passesTheEndowmentToTheSuccessor() public {
        Endowment e = _create(100e6);
        vm.prank(settlor);
        e.setSuccessor(SUCCESSOR);
        vm.prank(principal);
        e.accept(address(acct));

        vm.expectRevert(abi.encodeWithSelector(Endowment.StillActive.selector, block.timestamp + 180 days));
        e.lapse();

        vm.warp(block.timestamp + 180 days);
        e.lapse();

        assertEq(e.agentId(), SUCCESSOR);
        assertFalse(e.accepted());
        vm.prank(principal);
        vm.expectRevert(Endowment.NotOwner.selector);
        e.accept(address(acct));
        vm.prank(successorOwner);
        e.accept(address(acct));
        assertTrue(e.accepted());
    }

    function test_reclaim_returnsEachPatronsShareInKindOnceRefundsOpen() public {
        Endowment e = _create(75e6);
        vm.startPrank(patron);
        usdg.approve(address(e), type(uint256).max);
        e.give(25e6);
        vm.stopPrank();
        e.invest();
        uint256 spyHeld = spy.balanceOf(address(e));
        uint256 cash = usdg.balanceOf(address(e));

        vm.prank(patron);
        vm.expectRevert(abi.encodeWithSelector(Endowment.RefundsClosed.selector, block.timestamp + 180 days));
        e.reclaim();

        vm.warp(block.timestamp + 180 days);
        vm.prank(patron);
        e.reclaim();

        assertEq(spy.balanceOf(patron), spyHeld / 4);
        assertEq(usdg.balanceOf(patron), 10_000e6 - 25e6 + cash / 4);
        assertEq(e.openGifts(), 75e6);
        vm.prank(patron);
        vm.expectRevert(Endowment.NothingGiven.selector);
        e.reclaim();
    }

    function test_reclaim_opensAtOnceWhenAQuietAgentHasNoSuccessor() public {
        Endowment e = _accepted(100e6);
        vm.warp(block.timestamp + 180 days);
        e.lapse();

        vm.prank(settlor);
        e.reclaim();
        assertEq(usdg.balanceOf(address(e)), 0);
    }

    function test_freeze_stopsTheDrawAndIsTheGuardiansAlone() public {
        Endowment e = _accepted(100e6);
        vm.expectRevert(Endowment.NotGuardian.selector);
        e.setFrozen(true);

        vm.prank(guardianKey);
        e.setFrozen(true);
        vm.warp(block.timestamp + 30 days);
        assertEq(e.accrued(), 0);
        vm.prank(agent);
        vm.expectRevert(Endowment.IsFrozen.selector);
        e.draw();

        vm.prank(guardianKey);
        e.setFrozen(false);
        assertEq(e.accrued(), 0);
    }

    function test_snapshot_isMonthlyAndTheDrawFollowsTheAverage() public {
        Endowment e = _accepted(100e6);
        e.invest();
        e.invest();
        e.invest();

        vm.expectRevert(abi.encodeWithSelector(Endowment.TooSoon.selector, block.timestamp + 30 days));
        e.snapshot();

        vm.warp(block.timestamp + 30 days);
        uint256 higher = SPY_E8 * 2;
        spyFeed.set(int256(higher), block.timestamp);
        _setPool(spy, higher);
        e.snapshot();

        uint256 now_ = e.state().nav;
        assertEq(e.snapshotsTaken(), 2);
        assertEq(e.averageNav(), (100e6 + now_) / 2);
    }

    function _terms() internal view returns (Endowment.Terms memory t) {
        t.agentId = AGENT;
        t.assets = new address[](1);
        t.assets[0] = address(spy);
        t.weightsBps = new uint16[](1);
        t.weightsBps[0] = 10_000;
        t.drawBps = 400;
        t.earnShareBps = 5_000;
    }

    function _create(uint256 gift) internal returns (Endowment e) {
        vm.prank(settlor);
        e = factory.create(_terms(), gift);
    }

    function _accepted(uint256 gift) internal returns (Endowment e) {
        e = _create(gift);
        vm.prank(principal);
        e.accept(address(acct));
    }
}
