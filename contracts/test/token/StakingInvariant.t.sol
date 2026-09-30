// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {BRSR} from "../../src/token/BRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

/// Random but legal traffic against one staking pool: deposits, exit requests, cancellations and
/// exits, compounds, spread, claims, slashes at whatever cap governance last set, pauses, and
/// time passing between them.
///
/// Every action swallows its own revert. The properties under test are about the states the
/// pool reaches, and a call that happens to be inadmissible at step seventeen is still a step
/// worth taking the next one after.
contract StakingHandler is CommonBase, StdUtils {
    Staking public immutable staking;
    BRSR public immutable brsr;
    MockUsdg public immutable usdg;
    address public immutable admin;
    address public immutable credit;
    address public immutable slasher;

    address[] public actors;

    /// Every BRSR that ever reached the pool as a deposit. Shares are never minted faster than
    /// a billion per wei of it, whatever the slashes in between did to the price.
    uint256 public deposited;

    constructor(Staking staking_, BRSR brsr_, MockUsdg usdg_, address admin_, address credit_, address slasher_) {
        staking = staking_;
        brsr = brsr_;
        usdg = usdg_;
        admin = admin_;
        credit = credit_;
        slasher = slasher_;

        for (uint256 i; i < 4; ++i) {
            address actor = address(uint160(uint256(keccak256(abi.encode("staker", i)))));
            actors.push(actor);
            vm.prank(actor);
            brsr_.approve(address(staking_), type(uint256).max);
        }
        brsr_.approve(address(staking_), type(uint256).max);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function stake(uint256 who, uint256 amount) external {
        address actor = _actor(who);
        uint256 held = brsr.balanceOf(actor);
        if (held == 0) return;
        amount = bound(amount, 1, held < 10_000_000e18 ? held : 10_000_000e18);

        vm.prank(actor);
        try staking.stake(amount) {
            deposited += amount;
        } catch {}
    }

    function requestUnbond(uint256 who, uint256 fraction) external {
        address actor = _actor(who);
        uint256 shares = (staking.sharesOf(actor) * bound(fraction, 1, 10_000)) / 10_000;
        if (shares == 0) return;

        vm.prank(actor);
        try staking.requestUnbond(shares) {} catch {}
    }

    function cancelUnbond(uint256 who) external {
        vm.prank(_actor(who));
        try staking.cancelUnbond() {} catch {}
    }

    function completeUnbond(uint256 who) external {
        vm.prank(_actor(who));
        try staking.completeUnbond() {} catch {}
    }

    function compound(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e18);
        try staking.compound(amount) {} catch {}
    }

    function distribute(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e6);
        usdg.mint(credit, amount);
        vm.startPrank(credit);
        usdg.approve(address(staking), amount);
        try staking.distribute(amount) {} catch {}
        vm.stopPrank();
    }

    function claim(uint256 who) external {
        vm.prank(_actor(who));
        try staking.claimRewards() {} catch {}
    }

    /// A third of the time the slash asks for everything but a wei, which would leave old shares
    /// priced against dust if the pool kept them.
    function slash(uint256 amount, uint256 shape) external {
        uint256 pool = staking.totalStaked();
        if (shape % 3 == 0) amount = pool == 0 ? 0 : pool - 1;
        else amount = bound(amount, 0, pool * 2 + 1);

        vm.prank(slasher);
        try staking.slash(amount) {} catch {}
    }

    /// Governance lifting the cap to the whole pool is a case worth landing on often.
    function setSlashLimit(uint256 capBps, uint256 window) external {
        uint16 cap = capBps % 4 == 0 ? 10_000 : uint16(bound(capBps, 1, 10_000));
        vm.prank(admin);
        try staking.setSlashLimit(cap, uint64(bound(window, 1 days, 90 days))) {} catch {}
    }

    /// Lifts a pause whenever it finds one and starts one a third of the time, so the pool spends
    /// most of its life open.
    function pauseOrLift(uint256 seed) external {
        vm.startPrank(admin);
        if (staking.paused()) staking.unpause();
        else if (seed % 3 == 0) staking.pause();
        vm.stopPrank();
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 8 days));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }
}

/// The books the pool keeps against the balances it holds, under any sequence of the calls
/// above. Deep enough for a request to mature and complete inside one run.
/// forge-config: default.invariant.depth = 128
contract StakingInvariantTest is Test {
    Staking internal staking;
    BRSR internal brsr;
    MockUsdg internal usdg;
    StakingHandler internal handler;

    address internal admin = makeAddr("timelock");
    address internal credit = makeAddr("creditManager");
    address internal slasher = makeAddr("slasher");

    function setUp() public {
        usdg = new MockUsdg();
        brsr = new BRSR(
            IBRSR.Allocation({
                community: address(this),
                team: makeAddr("team"),
                treasury: makeAddr("treasury"),
                liquidity: makeAddr("liquidity")
            })
        );
        staking = new Staking(brsr, usdg, admin, makeAddr("slashSink"), makeAddr("treasury"), 7 days, 1_000e18);

        vm.startPrank(admin);
        staking.setCreditManager(credit);
        staking.setSlasher(slasher);
        vm.stopPrank();

        handler = new StakingHandler(staking, brsr, usdg, admin, credit, slasher);
        for (uint256 i; i < handler.actorCount(); ++i) {
            brsr.transfer(handler.actors(i), 100_000_000e18);
        }
        brsr.transfer(address(handler), 100_000_000e18);

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = StakingHandler.stake.selector;
        selectors[1] = StakingHandler.stake.selector;
        selectors[2] = StakingHandler.requestUnbond.selector;
        selectors[3] = StakingHandler.cancelUnbond.selector;
        selectors[4] = StakingHandler.completeUnbond.selector;
        selectors[5] = StakingHandler.completeUnbond.selector;
        selectors[6] = StakingHandler.compound.selector;
        selectors[7] = StakingHandler.distribute.selector;
        selectors[8] = StakingHandler.claim.selector;
        selectors[9] = StakingHandler.slash.selector;
        selectors[10] = StakingHandler.setSlashLimit.selector;
        selectors[11] = StakingHandler.pauseOrLift.selector;
        selectors[12] = StakingHandler.warp.selector;
        selectors[13] = StakingHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_theBalanceCoversTheBooks() public view {
        assertGe(brsr.balanceOf(address(staking)), staking.totalStaked());
    }

    /// Every micro-dollar taken in is divided across shares, carried to the next division, or
    /// parked for the treasury. Nothing else can explain a unit of the balance.
    function invariant_everyMicroDollarIsAccountedFor() public view {
        assertEq(
            usdg.balanceOf(address(staking)),
            staking.rewardsBacked() + staking.rewardResidual() + staking.unallocatedRewards()
        );
    }

    /// What the stakers are owed, earning and on their way out, never adds up to more than the
    /// pool holds for them.
    function invariant_noStakerIsOwedMoreThanThePoolHolds() public view {
        uint256 owed;
        uint256 leaving;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            owed += staking.stakedValueOf(actor);
            (uint256 amount,,) = staking.unbondOf(actor);
            leaving += amount;
        }
        assertLe(owed, staking.totalStaked());
        assertLe(leaving, staking.unbondingStaked());
    }

    /// The unbonding pool is part of the pool, and it is empty exactly when nobody holds a claim
    /// on it.
    function invariant_theUnbondingPoolIsPartOfThePool() public view {
        assertLe(staking.unbondingStaked(), staking.totalStaked());
        if (staking.totalUnbondingShares() == 0) assertEq(staking.unbondingStaked(), 0);
    }

    /// Slashes push the share price down and deposits mint against it. A deposit is refused once
    /// a share is worth less than a millionth of its issue price, so however the two interleave
    /// the share count stays under a billion per wei ever deposited.
    function invariant_sharesStayBounded() public view {
        assertLe(staking.totalShares(), handler.deposited() * 1e9);
    }
}
