// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {BRSR} from "../../src/token/BRSR.sol";
import {Vesting} from "../../src/token/Vesting.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";

/// Random but legal traffic against the team's vesting contract: beneficiaries claim whenever
/// they like, the admin revokes grants and sweeps the surplus, strangers try both, tokens land
/// here by mistake, the admin seat is offered and taken, and months pass between calls.
///
/// Every action swallows its own revert. A claim before the cliff is refused and the run goes
/// on; what is recorded is what the contract did when it did not refuse. Counters carry the
/// findings out, because an assertion here would revert and the runner would discard the very
/// call that found the problem.
contract VestingHandler is CommonBase, StdUtils {
    Vesting public immutable vesting;
    BRSR public immutable brsr;

    address[] public beneficiaries;
    /// Addresses that hold no grant. They stand in for strangers and for the admin's successors,
    /// and the deployment's admin is among them so it becomes a stranger once it hands over.
    address[] public outsiders;

    /// Who the handler believes holds the admin seat: the deployment's admin until an outsider
    /// the sitting admin named takes the offer.
    address public admin;

    /// What each grant was written for, read before anything could rewrite it.
    mapping(address beneficiary => uint128 amount) public allocation;
    mapping(address beneficiary => uint256 amount) public claimed;
    /// The highest vested figure each grant has ever shown. The line only goes up.
    mapping(address beneficiary => uint128 amount) public highWater;
    /// What had vested at the moment of the revocation, which is what the beneficiary keeps.
    mapping(address beneficiary => uint128 amount) public frozenAt;
    mapping(address beneficiary => bool) public revoked;

    uint256 public donated;
    uint256 public forfeited;
    uint256 public swept;
    uint256 public claims;

    /// A claim that paid before the cliff, a vested figure that fell or a revocation that took
    /// more than the unvested remainder, a payout to an address with no grant, a sweep that
    /// took something other than the surplus, and a seat taken by an address the sitting admin
    /// never named or a reserved call that went through for a stranger. All asserted to be zero.
    uint256 public cliffBreaks;
    uint256 public clawbacks;
    uint256 public strangerPayouts;
    uint256 public sweepBreaks;
    uint256 public seatBreaks;

    constructor(
        Vesting vesting_,
        BRSR brsr_,
        address admin_,
        address[] memory beneficiaries_,
        address[] memory outsiders_
    ) {
        vesting = vesting_;
        brsr = brsr_;
        admin = admin_;
        beneficiaries = beneficiaries_;
        outsiders = outsiders_;
        for (uint256 i; i < beneficiaries_.length; ++i) {
            allocation[beneficiaries_[i]] = vesting_.grantOf(beneficiaries_[i]).totalWei;
        }
    }

    function claim(uint256 who) external {
        address beneficiary = _beneficiary(who);
        (uint64 cliffAt,) = vesting.scheduleOf(beneficiary);

        vm.prank(beneficiary);
        try vesting.claim() returns (uint128 amount) {
            claimed[beneficiary] += amount;
            claims += 1;
            if (block.timestamp < cliffAt) cliffBreaks += 1;
        } catch {}
        _observe();
    }

    function claimAsStranger(uint256 who) external {
        vm.prank(_outsider(who));
        try vesting.claim() returns (uint128) {
            strangerPayouts += 1;
        } catch {}
    }

    /// The vested figure is read before the call and compared after it. The contract rewrites
    /// the grant's total on revocation, so its own figure afterwards is not evidence on its own.
    function revoke(uint256 who) external {
        address beneficiary = _beneficiary(who);
        uint128 vested = vesting.vestedOf(beneficiary);

        vm.prank(admin);
        try vesting.revoke(beneficiary) returns (uint128 taken) {
            forfeited += taken;
            revoked[beneficiary] = true;
            frozenAt[beneficiary] = vested;
            if (vesting.vestedOf(beneficiary) != vested || taken != allocation[beneficiary] - vested) clawbacks += 1;
        } catch {}
        _observe();
    }

    function revokeAsStranger(uint256 who, uint256 target) external {
        address stranger = _outsider(who);
        if (stranger == admin) return;

        vm.prank(stranger);
        try vesting.revoke(_beneficiary(target)) returns (uint128) {
            seatBreaks += 1;
        } catch {}
    }

    function sweep() external {
        uint256 surplus = vesting.unallocatedWei();

        vm.prank(admin);
        try vesting.sweep() returns (uint256 amount) {
            swept += amount;
            if (amount != surplus) sweepBreaks += 1;
        } catch {}
    }

    function sweepAsStranger(uint256 who) external {
        address stranger = _outsider(who);
        if (stranger == admin) return;

        vm.prank(stranger);
        try vesting.sweep() returns (uint256) {
            seatBreaks += 1;
        } catch {}
    }

    /// A transfer nobody asked for. It is surplus from the moment it lands.
    function donate(uint256 amount) external {
        uint256 held = brsr.balanceOf(address(this));
        if (held == 0) return;
        amount = bound(amount, 1, held < 1_000e18 ? held : 1_000e18);
        brsr.transfer(address(vesting), amount);
        donated += amount;
    }

    /// The sitting admin offers the seat. Nothing moves until the offer is taken.
    function offerSeat(uint256 who) external {
        vm.prank(admin);
        try vesting.transferAdmin(_outsider(who)) {} catch {}
        if (vesting.admin() != admin) seatBreaks += 1;
    }

    /// An outsider takes the seat, whether or not it was offered to them.
    function takeSeat(uint256 who) external {
        address taker = _outsider(who);
        address offered = vesting.pendingAdmin();

        vm.prank(taker);
        try vesting.acceptAdmin() {
            if (taker != offered) seatBreaks += 1;
            admin = taker;
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 240 days));
        _observe();
    }

    /// Runs the schedule out and pays every grant, so a run ends with the whole allocation
    /// either claimed or forfeited. A grant with nothing left to pay is skipped, not caught: a
    /// claim that has something to pay is expected to land.
    function driveToTheEnd() external {
        (, uint64 endsAt) = vesting.scheduleOf(beneficiaries[0]);
        if (block.timestamp < endsAt) vm.warp(endsAt);

        for (uint256 i; i < beneficiaries.length; ++i) {
            address beneficiary = beneficiaries[i];
            if (vesting.claimableOf(beneficiary) == 0) continue;
            vm.prank(beneficiary);
            claimed[beneficiary] += vesting.claim();
            claims += 1;
        }
        _observe();
    }

    function beneficiaryCount() external view returns (uint256) {
        return beneficiaries.length;
    }

    /// Read after every step that could move the clock or a grant, because the invariant
    /// functions see only the end of a sequence and a dip that recovered would be gone by then.
    function _observe() private {
        for (uint256 i; i < beneficiaries.length; ++i) {
            address beneficiary = beneficiaries[i];
            uint128 vested = vesting.vestedOf(beneficiary);
            if (vested < highWater[beneficiary]) clawbacks += 1;
            else highWater[beneficiary] = vested;
        }
    }

    function _beneficiary(uint256 seed) private view returns (address) {
        return beneficiaries[seed % beneficiaries.length];
    }

    function _outsider(uint256 seed) private view returns (address) {
        return outsiders[seed % outsiders.length];
    }
}

/// The team allocation under any sequence of the calls above. A grant is a line the schedule
/// draws from the start date to the end of the fourth year, gated by the cliff: what the
/// contract pays is never ahead of that line, a revocation can only freeze the line where it
/// stands, the balance covers every unit still owed, and the seat moves only by offer and
/// acceptance.
contract VestingInvariantTest is Test {
    uint128 internal constant TEAM_ALLOCATION = 100_000_000e18;
    uint128 internal constant TREASURY_ALLOCATION = 50_000_000e18;
    uint64 internal constant CLIFF = 365 days;
    uint64 internal constant DURATION = 1460 days;

    BRSR internal brsr;
    Vesting internal vesting;
    VestingHandler internal handler;

    address internal admin = makeAddr("timelock");
    address internal treasury = makeAddr("treasury");

    address[] internal beneficiaries;
    uint64 internal start;
    uint256 internal granted;

    function setUp() public {
        vm.warp(1_790_000_000);

        // The deployment's circular dependency, reproduced: the token mints into an address the
        // vesting contract will occupy, and the vesting contract names a token that does not
        // exist yet.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vesting = new Vesting(predicted, admin, treasury);
        brsr = new BRSR(
            IBRSR.Allocation({
                community: address(this), team: address(vesting), treasury: treasury, liquidity: makeAddr("liquidity")
            })
        );
        assertEq(address(brsr), predicted);

        // Four grants of different sizes, one of them odd so the line rounds. They sum to less
        // than the allocation, so a surplus exists from the first block and a sweep has
        // something to take before anyone donates.
        uint128[4] memory amounts = [uint128(45_000_000e18), 30_000_000e18, 15_000_000e18, 7_000_000e18 + 1];
        uint128[] memory grants = new uint128[](4);
        for (uint256 i; i < 4; ++i) {
            beneficiaries.push(makeAddr(string.concat("beneficiary", vm.toString(i))));
            grants[i] = amounts[i];
            granted += amounts[i];
        }
        start = uint64(block.timestamp);
        vesting.createGrants(beneficiaries, grants, start);

        address[] memory outsiders = new address[](3);
        outsiders[0] = admin;
        outsiders[1] = makeAddr("successor");
        outsiders[2] = makeAddr("stranger");

        handler = new VestingHandler(vesting, brsr, admin, beneficiaries, outsiders);
        brsr.transfer(address(handler), 1_000_000e18);

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = VestingHandler.claim.selector;
        selectors[1] = VestingHandler.claim.selector;
        selectors[2] = VestingHandler.claimAsStranger.selector;
        selectors[3] = VestingHandler.revoke.selector;
        selectors[4] = VestingHandler.revokeAsStranger.selector;
        selectors[5] = VestingHandler.sweep.selector;
        selectors[6] = VestingHandler.sweepAsStranger.selector;
        selectors[7] = VestingHandler.donate.selector;
        selectors[8] = VestingHandler.offerSeat.selector;
        selectors[9] = VestingHandler.takeSeat.selector;
        selectors[10] = VestingHandler.warp.selector;
        selectors[11] = VestingHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// For every grant: what was paid never runs ahead of what has vested, what has vested never
    /// runs ahead of what was granted, and what the beneficiary holds is exactly what the
    /// contract says it paid.
    function invariant_claimedNeverRunsAheadOfVestedNorVestedOfTheGrant() public view {
        for (uint256 i; i < beneficiaries.length; ++i) {
            address beneficiary = beneficiaries[i];
            Vesting.Grant memory grant = vesting.grantOf(beneficiary);
            uint128 vested = vesting.vestedOf(beneficiary);

            assertLe(grant.claimedWei, vested, "a grant paid out more than had vested");
            assertLe(vested, handler.allocation(beneficiary), "a grant vested more than was granted");
            assertEq(grant.claimedWei, handler.claimed(beneficiary), "the claimed figure drifted from the claims paid");
            assertEq(
                brsr.balanceOf(beneficiary), handler.claimed(beneficiary), "a beneficiary holds what no claim paid"
            );
            assertEq(
                vesting.claimableOf(beneficiary), vested - grant.claimedWei, "claimable is not vested less claimed"
            );
        }
    }

    /// Vested is the line the schedule draws, nothing before the cliff, the whole grant after
    /// four years and the straight line between, or the point where a revocation froze it.
    function invariant_vestedIsTheScheduleLineOrWhereRevocationFrozeIt() public view {
        for (uint256 i; i < beneficiaries.length; ++i) {
            address beneficiary = beneficiaries[i];
            uint128 vested = vesting.vestedOf(beneficiary);
            if (handler.revoked(beneficiary)) {
                assertEq(vested, handler.frozenAt(beneficiary), "a revoked grant's vested figure moved");
            } else {
                assertEq(vested, _line(handler.allocation(beneficiary)), "vested left the schedule's line");
            }
        }
    }

    function invariant_nothingVestsOrPaysBeforeTheCliff() public view {
        if (block.timestamp < start + CLIFF) {
            for (uint256 i; i < beneficiaries.length; ++i) {
                assertEq(vesting.vestedOf(beneficiaries[i]), 0, "a grant vested before the cliff");
                assertEq(handler.claimed(beneficiaries[i]), 0, "a grant paid before the cliff");
            }
        }
        assertEq(handler.cliffBreaks(), 0, "a claim landed before the cliff");
    }

    /// The vested figure never falls, and a revocation takes exactly the unvested remainder.
    function invariant_vestedNeverFallsAndRevocationNeverReachesBack() public view {
        for (uint256 i; i < beneficiaries.length; ++i) {
            assertGe(vesting.vestedOf(beneficiaries[i]), handler.highWater(beneficiaries[i]), "vested fell");
        }
        assertEq(handler.clawbacks(), 0, "a revocation moved vested tokens, or vested fell between steps");
    }

    /// The balance is what the grants are still owed plus the surplus, and nothing else.
    function invariant_theBalanceIsWhatIsOwedPlusTheSurplus() public view {
        uint256 owed;
        for (uint256 i; i < beneficiaries.length; ++i) {
            Vesting.Grant memory grant = vesting.grantOf(beneficiaries[i]);
            owed += grant.totalWei - grant.claimedWei;
        }
        uint256 surplus = (TEAM_ALLOCATION - granted) + handler.donated() - handler.swept();

        assertEq(vesting.outstandingWei(), owed, "outstanding drifted from the grants still owed");
        assertEq(brsr.balanceOf(address(vesting)), owed + surplus, "the balance is not what is owed plus the surplus");
        assertEq(vesting.unallocatedWei(), surplus, "the surplus the contract reports is not the surplus");
    }

    /// Every token that left went to a beneficiary as a claim or to the treasury as a forfeit or
    /// a sweep. Nobody else was ever paid.
    function invariant_everyTokenThatLeftIsAClaimAForfeitOrASweep() public view {
        uint256 claimed;
        for (uint256 i; i < beneficiaries.length; ++i) {
            claimed += handler.claimed(beneficiaries[i]);
        }

        assertEq(
            TEAM_ALLOCATION + handler.donated(),
            brsr.balanceOf(address(vesting)) + claimed + handler.forfeited() + handler.swept(),
            "tokens left the contract by a path other than a claim, a forfeit or a sweep"
        );
        assertEq(
            brsr.balanceOf(treasury),
            TREASURY_ALLOCATION + handler.forfeited() + handler.swept(),
            "the treasury received something other than forfeits and sweeps"
        );
        assertEq(handler.strangerPayouts(), 0, "an address with no grant was paid");
        assertEq(handler.sweepBreaks(), 0, "a sweep took something other than the surplus");
    }

    /// The seat moves only to the address the sitting admin named, and only when that address
    /// takes it. Until then the sitting admin keeps every power and nobody else has any.
    function invariant_theAdminSeatMovesOnlyByOfferAndAcceptance() public view {
        assertEq(vesting.admin(), handler.admin(), "the admin seat moved without an accepted offer");
        assertEq(handler.seatBreaks(), 0, "a stranger used an admin power, or took the seat unoffered");
    }

    /// Every run ends with the schedule run out and every grant claimed, which proves the whole
    /// allocation was either paid to its beneficiary or forfeited to the treasury, with nothing
    /// left owed and nothing paid twice. A run that revoked every grant before the cliff has
    /// nothing to claim, and forfeited the lot instead.
    function afterInvariant() public {
        handler.driveToTheEnd();

        uint256 claimed;
        for (uint256 i; i < beneficiaries.length; ++i) {
            claimed += handler.claimed(beneficiaries[i]);
            assertEq(vesting.claimableOf(beneficiaries[i]), 0, "a grant still had something to claim at the end");
        }
        assertEq(vesting.outstandingWei(), 0, "a grant was still owed after the schedule ran out");
        assertEq(claimed + handler.forfeited(), granted, "the allocation did not end up claimed or forfeited in full");
        assertTrue(
            handler.claims() > 0 || handler.forfeited() == granted, "no claim was paid and not everything was forfeited"
        );
        invariant_theBalanceIsWhatIsOwedPlusTheSurplus();
        invariant_everyTokenThatLeftIsAClaimAForfeitOrASweep();
    }

    /// The published term, stated here on its own so the contract is held to it rather than to
    /// itself.
    function _line(uint128 total) private view returns (uint128) {
        if (block.timestamp < start + CLIFF) return 0;
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= DURATION) return total;
        return uint128((uint256(total) * elapsed) / DURATION);
    }
}
