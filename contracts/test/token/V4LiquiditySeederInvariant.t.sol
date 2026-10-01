// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {LocalPoolManager} from "../../script/local/LocalPoolManager.sol";
import {V4Math} from "../../script/lib/V4Math.sol";
import {PoolKey} from "../../src/token/Buyback.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {MockBRSR} from "../mocks/MockBRSR.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {PoolIdentity} from "./V4LiquiditySeeder.t.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// Random but legal traffic against the seeder: anyone adds liquidity over one of a few ranges,
/// offering exactly what the position costs, more, or one unit less; the owner and strangers
/// try to take it out, open the pool and sweep; tokens land on the seeder by mistake; and the
/// seat is offered and taken.
///
/// The pool manager is the local stand-in with v4's own position arithmetic, so every add and
/// removal can be priced here with `V4Math` before the call and checked against what moved.
/// Every action swallows its own revert, and counters carry the findings out.
contract SeederHandler is CommonBase, StdUtils {
    struct Range {
        int24 lower;
        int24 upper;
    }

    /// One amount of each currency.
    struct Legs {
        uint256 amount0;
        uint256 amount1;
    }

    /// Balances read before a call: the party paying or being paid, and the seeder itself.
    struct Marks {
        uint256 party0;
        uint256 party1;
        uint256 kept0;
        uint256 kept1;
    }

    V4LiquiditySeeder public immutable seeder;
    LocalPoolManager public immutable manager;
    IERC20 public immutable currency0;
    IERC20 public immutable currency1;
    bytes32 public immutable id;
    uint160 public immutable openingPrice;

    /// Who the handler believes owns the seeder: the deployment's owner until an outsider the
    /// sitting owner named takes the offer.
    address public owner;
    /// Providers and strangers. The deployment's owner is among them so it is held to a
    /// stranger's refusals once it hands over.
    address[] public outsiders;
    Range[] internal _ranges;

    mapping(address token => uint256) public donated;
    mapping(address token => uint256) public swept;

    uint256 public adds;
    uint256 public removes;
    bool public opened;

    /// An adder told or charged something other than what the position cost, a seeder balance
    /// that moved on an add or a removal, a removal that paid the wrong address or more than the
    /// liquidity could be worth or more than was held, a reserved call that went through for a
    /// stranger or a second opening, a seat taken unoffered, and a legitimate call refused. All
    /// asserted to be zero.
    uint256 public costBreaks;
    uint256 public residueBreaks;
    uint256 public payoutBreaks;
    uint256 public authBreaks;
    uint256 public seatBreaks;
    uint256 public refusals;

    constructor(
        V4LiquiditySeeder seeder_,
        LocalPoolManager manager_,
        uint160 openingPrice_,
        address owner_,
        address[] memory outsiders_,
        Range[] memory ranges_
    ) {
        seeder = seeder_;
        manager = manager_;
        currency0 = IERC20(seeder_.currency0());
        currency1 = IERC20(seeder_.currency1());
        id = seeder_.poolId();
        openingPrice = openingPrice_;
        owner = owner_;
        outsiders = outsiders_;
        for (uint256 i; i < ranges_.length; ++i) {
            _ranges.push(ranges_[i]);
        }

        _approve(owner_);
        for (uint256 i; i < outsiders_.length; ++i) {
            _approve(outsiders_[i]);
        }
    }

    function open(uint256 who) external {
        address actor = _actor(who);
        vm.prank(actor);
        try seeder.initializePool(openingPrice) returns (int24) {
            if (actor != owner || opened) authBreaks += 1;
            opened = true;
        } catch {
            if (actor == owner && !opened) refusals += 1;
        }
    }

    /// A stingy adder offers one unit less than the position costs on a leg that costs anything,
    /// and has to be refused whole. Everyone else offers between the cost and twice the cost and
    /// has to be charged exactly the cost.
    function add(uint256 who, uint256 rangeSeed, uint256 liquiditySeed, uint256 slackSeed, bool stingy) external {
        _add(_actor(who), rangeSeed % _ranges.length, uint128(bound(liquiditySeed, 1e12, 1e17)), slackSeed, stingy);
    }

    /// One removal in eight asks for one unit more than the range holds.
    function remove(uint256 who, uint256 rangeSeed, uint256 amountSeed, uint256 toSeed) external {
        address actor = _actor(who);
        Range memory range = _ranges[rangeSeed % _ranges.length];
        address to = _actor(toSeed);
        uint128 held = seeder.liquidityOf(range.lower, range.upper);
        uint128 liquidity = held == 0 || amountSeed % 8 == 0 ? held + 1 : uint128(bound(amountSeed, 1, held));
        Marks memory marks = _marks(to);

        vm.prank(actor);
        try seeder.removeLiquidity(range.lower, range.upper, liquidity, 0, 0, to) returns (uint256 out0, uint256 out1) {
            removes += 1;
            if (actor != owner) authBreaks += 1;
            _checkRemoval(range, liquidity, held, to, marks, Legs(out0, out1));
        } catch {
            if (actor == owner && opened && liquidity <= held) refusals += 1;
        }
    }

    function sweep(uint256 who, bool first, uint256 amountSeed, uint256 toSeed) external {
        address actor = _actor(who);
        IERC20 token = first ? currency0 : currency1;
        uint256 held = token.balanceOf(address(seeder));
        uint256 amount = held == 0 || amountSeed % 8 == 0 ? held + 1 : bound(amountSeed, 1, held);

        vm.prank(actor);
        try seeder.sweep(address(token), _actor(toSeed), amount) {
            if (actor != owner || amount > held) authBreaks += 1;
            swept[address(token)] += amount;
        } catch {
            if (actor == owner && amount <= held) refusals += 1;
        }
    }

    /// A transfer nobody asked for. It stays until the owner sweeps it, and is never handed to
    /// whoever adds next.
    function donate(bool first, uint256 amount) external {
        IERC20 token = first ? currency0 : currency1;
        amount = bound(amount, 1, 1e18);
        IMintable(address(token)).mint(address(seeder), amount);
        donated[address(token)] += amount;
    }

    function offerSeat(uint256 who) external {
        vm.prank(owner);
        try seeder.transferOwnership(_outsider(who)) {} catch {}
        if (seeder.owner() != owner) seatBreaks += 1;
    }

    function takeSeat(uint256 who) external {
        address taker = _outsider(who);
        address offered = seeder.pendingOwner();

        vm.prank(taker);
        try seeder.acceptOwnership() {
            if (taker != offered) seatBreaks += 1;
            owner = taker;
        } catch {}
    }

    /// Opens the pool and seeds it when the run never did, then takes every position out, so a
    /// run ends with the seeder holding no liquidity and the manager holding only rounding.
    function drain() external {
        if (!opened) {
            vm.prank(owner);
            seeder.initializePool(openingPrice);
            opened = true;
        }
        if (adds == 0) _add(owner, 0, 1e15, 0, false);

        for (uint256 i; i < _ranges.length; ++i) {
            Range memory range = _ranges[i];
            uint128 held = seeder.liquidityOf(range.lower, range.upper);
            if (held == 0) continue;
            vm.prank(owner);
            seeder.removeLiquidity(range.lower, range.upper, held, 0, 0, owner);
            removes += 1;
        }
    }

    function rangeCount() external view returns (uint256) {
        return _ranges.length;
    }

    function rangeAt(uint256 i) external view returns (Range memory) {
        return _ranges[i];
    }

    /// Whether the pool's price sits inside the range, by the manager's own test.
    function inRange(Range memory range) public view returns (bool) {
        (uint160 price,,,) = manager.getSlot0(id);
        (uint160 sqrtA, uint160 sqrtB) = _bounds(range);
        return price >= sqrtA && price < sqrtB;
    }

    function _add(address actor, uint256 rangeIndex, uint128 liquidity, uint256 slackSeed, bool stingy) private {
        Range memory range = _ranges[rangeIndex];
        (uint160 price,,,) = manager.getSlot0(id);
        if (price == 0) {
            _addBeforeOpening(actor, range, liquidity);
            return;
        }

        Legs memory cost = _cost(range, liquidity);
        (Legs memory offer, bool short) = _offer(cost, slackSeed, stingy);
        IMintable(address(currency0)).mint(actor, offer.amount0);
        IMintable(address(currency1)).mint(actor, offer.amount1);
        Marks memory marks = _marks(actor);

        vm.prank(actor);
        try seeder.addLiquidity(range.lower, range.upper, liquidity, offer.amount0, offer.amount1) returns (
            uint256 paid0, uint256 paid1
        ) {
            adds += 1;
            if (short) costBreaks += 1;
            _checkAdd(actor, marks, cost, Legs(paid0, paid1));
        } catch {
            if (!short) refusals += 1;
        }
    }

    /// The manager refuses a position in a pool nobody opened, whatever is offered for it.
    function _addBeforeOpening(address actor, Range memory range, uint128 liquidity) private {
        vm.prank(actor);
        try seeder.addLiquidity(range.lower, range.upper, liquidity, type(uint256).max, type(uint256).max) returns (
            uint256, uint256
        ) {
            adds += 1;
            authBreaks += 1;
        } catch {}
    }

    /// Exactly the cost to twice the cost on each leg, or one unit short on a leg that costs
    /// anything when the adder is stingy. A position that costs nothing on either leg cannot be
    /// offered less, so that adder is treated as an ordinary one.
    function _offer(Legs memory cost, uint256 slackSeed, bool stingy)
        private
        pure
        returns (Legs memory offer, bool short)
    {
        if (stingy && cost.amount0 != 0) return (Legs(cost.amount0 - 1, cost.amount1), true);
        if (stingy && cost.amount1 != 0) return (Legs(cost.amount0, cost.amount1 - 1), true);
        offer.amount0 = cost.amount0 + bound(slackSeed, 0, cost.amount0);
        offer.amount1 = cost.amount1 + bound(slackSeed >> 128, 0, cost.amount1);
    }

    function _checkAdd(address actor, Marks memory marks, Legs memory cost, Legs memory paid) private {
        if (paid.amount0 != cost.amount0 || paid.amount1 != cost.amount1) costBreaks += 1;
        if (
            marks.party0 - currency0.balanceOf(actor) != paid.amount0
                || marks.party1 - currency1.balanceOf(actor) != paid.amount1
        ) costBreaks += 1;
        if (!_kept(marks)) residueBreaks += 1;
    }

    /// Adds round in the pool's favour and removals round against the caller, so a removal
    /// never pays more than the same liquidity costs to add, and never more than it reports.
    function _checkRemoval(
        Range memory range,
        uint128 liquidity,
        uint128 held,
        address to,
        Marks memory marks,
        Legs memory out
    ) private {
        if (liquidity > held) payoutBreaks += 1;
        if (
            currency0.balanceOf(to) - marks.party0 != out.amount0
                || currency1.balanceOf(to) - marks.party1 != out.amount1
        ) {
            payoutBreaks += 1;
        }
        Legs memory cost = _cost(range, liquidity);
        if (out.amount0 > cost.amount0 || out.amount1 > cost.amount1) payoutBreaks += 1;
        if (!_kept(marks)) residueBreaks += 1;
    }

    /// What `liquidity` over `range` costs to add at the pool's price, by v4's own arithmetic.
    function _cost(Range memory range, uint128 liquidity) private view returns (Legs memory cost) {
        (uint160 price,,,) = manager.getSlot0(id);
        (uint160 sqrtA, uint160 sqrtB) = _bounds(range);
        cost.amount0 = V4Math.amount0For(price, sqrtA, sqrtB, liquidity);
        cost.amount1 = V4Math.amount1For(price, sqrtA, sqrtB, liquidity);
    }

    function _marks(address party) private view returns (Marks memory marks) {
        marks.party0 = currency0.balanceOf(party);
        marks.party1 = currency1.balanceOf(party);
        marks.kept0 = currency0.balanceOf(address(seeder));
        marks.kept1 = currency1.balanceOf(address(seeder));
    }

    function _kept(Marks memory marks) private view returns (bool) {
        return
            currency0.balanceOf(address(seeder)) == marks.kept0 && currency1.balanceOf(address(seeder)) == marks.kept1;
    }

    function _bounds(Range memory range) private pure returns (uint160 sqrtA, uint160 sqrtB) {
        sqrtA = V4Math.getSqrtPriceAtTick(range.lower);
        sqrtB = V4Math.getSqrtPriceAtTick(range.upper);
    }

    function _approve(address who) private {
        vm.startPrank(who);
        currency0.approve(address(seeder), type(uint256).max);
        currency1.approve(address(seeder), type(uint256).max);
        vm.stopPrank();
    }

    /// The owner or an outsider, with the owner drawn as often as every outsider together.
    function _actor(uint256 seed) private view returns (address) {
        if (seed % 2 == 0) return owner;
        return _outsider(seed >> 1);
    }

    function _outsider(uint256 seed) private view returns (address) {
        return outsiders[seed % outsiders.length];
    }
}

/// The seeder's book against the manager's, under any sequence of the calls above: the
/// liquidity it records is the liquidity the pool holds, an adder pays exactly what the
/// position costs and gets the rest back, nothing but strays ever sits on the seeder, only the
/// owner opens, removes and sweeps, and the seat moves only by offer and acceptance.
contract V4LiquiditySeederInvariantTest is Test {
    MockBRSR internal brsr;
    MockUsdg internal usdg;
    LocalPoolManager internal manager;
    V4LiquiditySeeder internal seeder;
    SeederHandler internal handler;

    address internal owner = makeAddr("timelock");

    function setUp() public {
        brsr = new MockBRSR();
        usdg = new MockUsdg();
        (address c0, address c1) =
            address(brsr) < address(usdg) ? (address(brsr), address(usdg)) : (address(usdg), address(brsr));

        manager = new LocalPoolManager();
        seeder = new V4LiquiditySeeder(address(manager), address(new PoolIdentity(c0, c1, 3000, 60, address(0))), owner);

        // One BRSR at two ten-thousandths of a USDG, near where the live pool opened: a raw
        // ratio of 1e18 BRSR wei to 200 USDG units, whichever side of the pool each is on.
        uint160 price =
            c0 == address(brsr) ? V4Math.initialSqrtPriceX96(1e18, 200) : V4Math.initialSqrtPriceX96(200, 1e18);

        // Four ranges on the pool's spacing: the whole curve, a band around the price, and one
        // band on each side of it, so positions that hold one currency and positions that hold
        // both are all in play.
        int24 tick = _tickAt(price);
        int24 anchor = tick - (tick % 60);
        SeederHandler.Range[] memory ranges = new SeederHandler.Range[](4);
        ranges[0] = SeederHandler.Range({lower: -887_220, upper: 887_220});
        ranges[1] = SeederHandler.Range({lower: anchor - 600, upper: anchor + 600});
        ranges[2] = SeederHandler.Range({lower: anchor - 6_000, upper: anchor - 600});
        ranges[3] = SeederHandler.Range({lower: anchor + 600, upper: anchor + 6_000});

        address[] memory outsiders = new address[](3);
        outsiders[0] = owner;
        outsiders[1] = makeAddr("provider");
        outsiders[2] = makeAddr("stranger");

        handler = new SeederHandler(seeder, manager, price, owner, outsiders, ranges);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = SeederHandler.open.selector;
        selectors[1] = SeederHandler.add.selector;
        selectors[2] = SeederHandler.add.selector;
        selectors[3] = SeederHandler.add.selector;
        selectors[4] = SeederHandler.remove.selector;
        selectors[5] = SeederHandler.remove.selector;
        selectors[6] = SeederHandler.sweep.selector;
        selectors[7] = SeederHandler.donate.selector;
        selectors[8] = SeederHandler.offerSeat.selector;
        selectors[9] = SeederHandler.takeSeat.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// The seeder is the pool's only provider here, so the liquidity the manager reports in
    /// range is the sum of the seeder's positions whose range holds the price, and no more.
    function invariant_theSeedersBookIsTheManagersLiquidity() public view {
        uint256 inRange;
        for (uint256 i; i < handler.rangeCount(); ++i) {
            SeederHandler.Range memory range = handler.rangeAt(i);
            if (handler.inRange(range)) inRange += seeder.liquidityOf(range.lower, range.upper);
        }
        assertEq(manager.getLiquidity(handler.id()), inRange, "the seeder's book disagrees with the pool");
    }

    /// An adder is charged exactly what the position costs at the pool's price, is refused whole
    /// when it offers a unit less, and gets every unit it offered beyond the cost straight back.
    function invariant_everyAdderPaysExactlyWhatThePositionCosts() public view {
        assertEq(handler.costBreaks(), 0, "an add charged or reported something other than the position's cost");
        assertEq(handler.refusals(), 0, "a legitimate call was refused");
    }

    /// Nothing sits on the seeder but what was sent there by mistake and not yet swept. Adds and
    /// removals pass through it without leaving a unit behind or taking one with them.
    function invariant_theSeederKeepsNothingButStrays() public view {
        assertEq(
            IERC20(seeder.currency0()).balanceOf(address(seeder)),
            handler.donated(seeder.currency0()) - handler.swept(seeder.currency0()),
            "currency0 on the seeder is not the unswept strays"
        );
        assertEq(
            IERC20(seeder.currency1()).balanceOf(address(seeder)),
            handler.donated(seeder.currency1()) - handler.swept(seeder.currency1()),
            "currency1 on the seeder is not the unswept strays"
        );
        assertEq(handler.residueBreaks(), 0, "an add or a removal moved the seeder's own balance");
    }

    /// A removal pays its recipient exactly what it reports, never more than the liquidity cost
    /// to add, and never more liquidity than the range holds.
    function invariant_aRemovalPaysItsRecipientAndNoMoreThanThePositionIsWorth() public view {
        assertEq(handler.payoutBreaks(), 0, "a removal paid the wrong address, too much, or liquidity not held");
    }

    /// Adding is open to anyone and gives the liquidity away. Opening the pool, taking liquidity
    /// out and sweeping are the owner's alone, and the pool opens once.
    function invariant_onlyTheOwnerOpensRemovesOrSweeps() public view {
        assertEq(handler.authBreaks(), 0, "a reserved call went through for a stranger, or the pool opened twice");
    }

    function invariant_theSeatMovesOnlyByOfferAndAcceptance() public view {
        assertEq(seeder.owner(), handler.owner(), "the seat moved without an accepted offer");
        assertEq(handler.seatBreaks(), 0, "a stranger took the seat, or an offer moved it on its own");
    }

    /// Every run ends with every position taken back out. What the manager then holds is
    /// rounding: two units at most on each leg of each add and each removal, which is what v4's
    /// arithmetic keeps for the pool. Nothing of value is stuck on either side.
    function afterInvariant() public {
        handler.drain();

        for (uint256 i; i < handler.rangeCount(); ++i) {
            SeederHandler.Range memory range = handler.rangeAt(i);
            assertEq(seeder.liquidityOf(range.lower, range.upper), 0, "liquidity left on the seeder's book");
        }
        assertEq(manager.getLiquidity(handler.id()), 0, "liquidity left in the pool");

        uint256 dust = 2 * (handler.adds() + handler.removes());
        assertLe(
            IERC20(seeder.currency0()).balanceOf(address(manager)), dust, "currency0 stuck in the pool beyond rounding"
        );
        assertLe(
            IERC20(seeder.currency1()).balanceOf(address(manager)), dust, "currency1 stuck in the pool beyond rounding"
        );
        assertGt(handler.adds(), 0, "no position was ever added");

        invariant_theSeederKeepsNothingButStrays();
        invariant_everyAdderPaysExactlyWhatThePositionCosts();
        invariant_aRemovalPaysItsRecipientAndNoMoreThanThePositionIsWorth();
    }

    /// The highest tick whose price is at or below `sqrtPriceX96`, found the way the local
    /// manager finds it, so the ranges above sit where the handler thinks they do.
    function _tickAt(uint160 sqrtPriceX96) private pure returns (int24) {
        int256 low = V4Math.MIN_TICK;
        int256 high = V4Math.MAX_TICK;
        while (low < high) {
            int256 mid = low + (high - low + 1) / 2;
            if (V4Math.getSqrtPriceAtTick(int24(mid)) <= sqrtPriceX96) low = mid;
            else high = mid - 1;
        }
        return int24(low);
    }
}
