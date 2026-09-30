// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PoolKey} from "../../src/token/Buyback.sol";
import {ModifyLiquidityParams, V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {MockBRSR} from "../mocks/MockBRSR.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// Five reads, which is all `V4LiquiditySeeder`'s constructor takes from the buyback.
contract PoolIdentity {
    address public currency0;
    address public currency1;
    uint24 public poolFee;
    int24 public poolTickSpacing;
    address public poolHooks;

    constructor(address c0, address c1, uint24 fee, int24 spacing, address hooks) {
        currency0 = c0;
        currency1 = c1;
        poolFee = fee;
        poolTickSpacing = spacing;
        poolHooks = hooks;
    }
}

/// A pool manager with the five calls the seeder makes and the one property that makes them
/// worth testing against: the lock closes only when every currency the caller moved settles to
/// zero.
///
/// The position math is a flat constant, so what is under test here is the settlement, the guards
/// and the callback binding. The curve is exercised against the real Uniswap deployment in
/// `TokenRailFork.t.sol`, where a stub could not be made to agree with the contract by accident.
///
/// Fees are the one piece of v4 behaviour modelled closely: set with `setFees`, they are credited
/// into the caller's delta on the next change to the position and reported separately as
/// `feesAccrued`, the way the live manager reports them.
contract StubPoolManager {
    error CurrencyNotSettled(address currency, int256 delta);
    error NotUnlocked();
    error AlreadyInitialized(bytes32 id);
    error PoolNotInitialized(bytes32 id);
    error NothingSynced();

    mapping(bytes32 id => uint160 sqrtPriceX96) public openedAt;
    mapping(address caller => mapping(address currency => int256 delta)) private _delta;

    address public immutable currency0;
    address public immutable currency1;

    /// Raw currency0 and currency1 one unit of liquidity costs, scaled by 1e9.
    uint256 public rate0 = 1e9;
    uint256 public rate1 = 1e9;

    /// Fees the position has accrued since it was last touched, paid out on the next touch.
    uint256 public fees0;
    uint256 public fees1;
    /// Credits less on settle than arrived, the way a fee-taking token would.
    uint256 public settleShortfall;

    mapping(bytes32 id => uint128 liquidity) public liquidityOf;

    bool public unlocked;
    address private syncedCurrency;
    uint256 private syncedBalance;

    PoolKey public lastKey;
    ModifyLiquidityParams public lastParams;

    constructor(address c0, address c1) {
        currency0 = c0;
        currency1 = c1;
    }

    function setRates(uint256 r0, uint256 r1) external {
        rate0 = r0;
        rate1 = r1;
    }

    function setFees(uint256 amount0, uint256 amount1) external {
        fees0 = amount0;
        fees1 = amount1;
    }

    function setSettleShortfall(uint256 amount) external {
        settleShortfall = amount;
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick) {
        bytes32 id = keccak256(abi.encode(key));
        if (openedAt[id] != 0) revert AlreadyInitialized(id);
        openedAt[id] = sqrtPriceX96;
        return -361_501;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);

        int256 owed0 = _delta[msg.sender][currency0];
        if (owed0 != 0) revert CurrencyNotSettled(currency0, owed0);
        int256 owed1 = _delta[msg.sender][currency1];
        if (owed1 != 0) revert CurrencyNotSettled(currency1, owed1);

        unlocked = false;
        syncedCurrency = address(0);
        syncedBalance = 0;
    }

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata)
        external
        returns (int256 callerDelta, int256 feesAccrued)
    {
        if (!unlocked) revert NotUnlocked();
        bytes32 id = keccak256(abi.encode(key));
        if (openedAt[id] == 0) revert PoolNotInitialized(id);

        lastKey = key;
        lastParams = params;

        uint256 magnitude = params.liquidityDelta < 0 ? uint256(-params.liquidityDelta) : uint256(params.liquidityDelta);
        int128 amount0 = int128(int256((magnitude * rate0) / 1e9));
        int128 amount1 = int128(int256((magnitude * rate1) / 1e9));

        bool adding = params.liquidityDelta > 0;
        (int128 leg0, int128 leg1) = adding ? (-amount0, -amount1) : (amount0, amount1);
        leg0 += int128(int256(fees0));
        leg1 += int128(int256(fees1));

        _delta[msg.sender][currency0] += leg0;
        _delta[msg.sender][currency1] += leg1;
        liquidityOf[id] = adding ? liquidityOf[id] + uint128(magnitude) : liquidityOf[id] - uint128(magnitude);

        callerDelta = _pack(leg0, leg1);
        feesAccrued = _pack(int128(int256(fees0)), int128(int256(fees1)));
        fees0 = 0;
        fees1 = 0;
    }

    function _pack(int128 a, int128 b) private pure returns (int256) {
        return int256((uint256(uint128(a)) << 128) | uint256(uint128(b)));
    }

    function sync(address currency) external {
        syncedCurrency = currency;
        syncedBalance = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        address currency = syncedCurrency;
        if (currency == address(0)) revert NothingSynced();
        uint256 arrived = IERC20(currency).balanceOf(address(this)) - syncedBalance;
        paid = arrived > settleShortfall ? arrived - settleShortfall : 0;
        _delta[msg.sender][currency] += int256(paid);
        syncedCurrency = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        if (!unlocked) revert NotUnlocked();
        _delta[msg.sender][currency] -= int256(amount);
        IERC20(currency).transfer(to, amount);
    }

    function deltaOf(address caller, address currency) external view returns (int256) {
        return _delta[caller][currency];
    }
}

contract V4LiquiditySeederTest is Test {
    MockBRSR internal brsr;
    MockUsdg internal usdg;
    PoolIdentity internal identity;
    StubPoolManager internal manager;
    V4LiquiditySeeder internal seeder;

    address internal owner = makeAddr("owner");
    address internal outsider = makeAddr("outsider");

    int24 internal constant TICK_LOWER = -887_220;
    int24 internal constant TICK_UPPER = 887_220;
    uint128 internal constant LIQUIDITY = 1_000_000;

    function setUp() public {
        brsr = new MockBRSR();
        usdg = new MockUsdg();

        // The seeder sorts nothing itself; it inherits the order the buyback fixed.
        (address c0, address c1) =
            address(brsr) < address(usdg) ? (address(brsr), address(usdg)) : (address(usdg), address(brsr));

        identity = new PoolIdentity(c0, c1, 3000, 60, address(0));
        manager = new StubPoolManager(c0, c1);
        seeder = new V4LiquiditySeeder(address(manager), address(identity), owner);

        brsr.mint(owner, 1_000_000e18);
        usdg.mint(owner, 1_000_000e6);
        vm.startPrank(owner);
        brsr.approve(address(seeder), type(uint256).max);
        usdg.approve(address(seeder), type(uint256).max);
        vm.stopPrank();
    }

    function test_itTakesThePoolIdentityFromTheBuyback() public view {
        assertEq(seeder.currency0(), identity.currency0());
        assertEq(seeder.currency1(), identity.currency1());
        assertEq(seeder.poolFee(), identity.poolFee());
        assertEq(seeder.poolTickSpacing(), identity.poolTickSpacing());
        assertEq(seeder.poolHooks(), identity.poolHooks());
        assertEq(seeder.buyback(), address(identity));
        assertEq(seeder.owner(), owner);
        assertEq(seeder.pendingOwner(), address(0));
        assertEq(seeder.poolId(), keccak256(abi.encode(seeder.key())));
    }

    function test_constructorRefusesZeroes() public {
        vm.expectRevert(V4LiquiditySeeder.ZeroAddress.selector);
        new V4LiquiditySeeder(address(0), address(identity), owner);
        vm.expectRevert(V4LiquiditySeeder.ZeroAddress.selector);
        new V4LiquiditySeeder(address(manager), address(0), owner);
        vm.expectRevert(V4LiquiditySeeder.ZeroAddress.selector);
        new V4LiquiditySeeder(address(manager), address(identity), address(0));
    }

    /// v4 reads the zero address as native currency and settles it through `msg.value`. A pool
    /// with either side at zero is refused at construction, the same refusal the buyback makes.
    function test_constructorRefusesNativeCurrency() public {
        PoolIdentity native = new PoolIdentity(address(0), address(usdg), 3000, 60, address(0));
        vm.expectRevert(V4LiquiditySeeder.NativeCurrencyNotSupported.selector);
        new V4LiquiditySeeder(address(manager), address(native), owner);

        PoolIdentity native1 = new PoolIdentity(address(brsr), address(0), 3000, 60, address(0));
        vm.expectRevert(V4LiquiditySeeder.NativeCurrencyNotSupported.selector);
        new V4LiquiditySeeder(address(manager), address(native1), owner);
    }

    function test_initializePool_opensAtTheGivenPriceAndReportsTheTick() public {
        vm.expectEmit(false, false, false, true, address(seeder));
        emit V4LiquiditySeeder.PoolInitialized(1120455419495722798374, -361_501);
        vm.prank(owner);
        int24 tick = seeder.initializePool(1120455419495722798374);
        assertEq(tick, -361_501);
        assertEq(manager.openedAt(seeder.poolId()), 1120455419495722798374);
    }

    function test_onlyTheOwnerOpensThePool() public {
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        vm.prank(outsider);
        seeder.initializePool(1120455419495722798374);
    }

    /// One shot. The manager refuses the second call, and so the opening price is final.
    function test_thePoolOpensOnce() public {
        vm.startPrank(owner);
        seeder.initializePool(1120455419495722798374);
        vm.expectRevert();
        seeder.initializePool(2000000000000000000000);
        vm.stopPrank();
    }

    function test_addLiquidityPaysBothLegsAndRecordsThePosition() public {
        _open();

        IERC20 c0 = IERC20(seeder.currency0());
        IERC20 c1 = IERC20(seeder.currency1());
        uint256 before0 = c0.balanceOf(owner);
        uint256 before1 = c1.balanceOf(owner);

        vm.prank(owner);
        (uint256 amount0, uint256 amount1) =
            seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        assertEq(amount0, LIQUIDITY);
        assertEq(amount1, LIQUIDITY);
        assertEq(seeder.liquidityOf(TICK_LOWER, TICK_UPPER), LIQUIDITY);
        assertEq(manager.deltaOf(address(seeder), seeder.currency0()), 0);
        assertEq(manager.deltaOf(address(seeder), seeder.currency1()), 0);

        // The seeder holds nothing afterwards, and the maxima are what left the owner.
        assertEq(c0.balanceOf(address(seeder)), 0);
        assertEq(c1.balanceOf(address(seeder)), 0);
        assertEq(before0 - c0.balanceOf(owner), LIQUIDITY);
        assertEq(before1 - c1.balanceOf(owner), LIQUIDITY);
    }

    /// The maxima are the guard that matters, and the unspent remainder goes straight back.
    function test_theUnspentRemainderIsRefunded() public {
        _open();
        manager.setRates(5e8, 25e7); // the position takes half and a quarter of what was offered

        IERC20 c0 = IERC20(seeder.currency0());
        IERC20 c1 = IERC20(seeder.currency1());
        uint256 before0 = c0.balanceOf(owner);
        uint256 before1 = c1.balanceOf(owner);

        vm.prank(owner);
        (uint256 amount0, uint256 amount1) =
            seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        assertEq(amount0, LIQUIDITY / 2);
        assertEq(amount1, LIQUIDITY / 4);
        assertEq(before0 - c0.balanceOf(owner), LIQUIDITY / 2);
        assertEq(before1 - c1.balanceOf(owner), LIQUIDITY / 4);
        assertEq(c0.balanceOf(address(seeder)), 0);
        assertEq(c1.balanceOf(address(seeder)), 0);
    }

    function test_aPositionOverTheMaximumIsRefused() public {
        _open();
        manager.setRates(2e9, 1e9); // twice what was offered on currency0

        vm.expectRevert(
            abi.encodeWithSelector(
                V4LiquiditySeeder.AmountAboveMaximum.selector, seeder.currency0(), 2 * uint256(LIQUIDITY), LIQUIDITY
            )
        );
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);
    }

    /// v4 credits a position's accrued fees into the same delta as the principal, so an add against
    /// a position that has already earned can come back in credit on a leg. The callback reads the
    /// sign of each leg from the delta. The fees are the position's, so they stay here for the
    /// owner: the adder pays what the liquidity cost and gets back the rest of what it offered.
    function test_anAddKeepsTheFeesThePositionEarnedForTheOwner() public {
        _open();
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        IERC20 c0 = IERC20(seeder.currency0());
        IERC20 c1 = IERC20(seeder.currency1());
        // More fees than the next add costs on one leg, fewer on the other.
        deal(address(c0), address(manager), c0.balanceOf(address(manager)) + 3 * uint256(LIQUIDITY));
        deal(address(c1), address(manager), c1.balanceOf(address(manager)) + 7);
        manager.setFees(3 * uint256(LIQUIDITY), 7);

        _fund(outsider);
        uint256 before0 = c0.balanceOf(outsider);
        uint256 before1 = c1.balanceOf(outsider);

        vm.expectEmit(false, false, false, true, address(seeder));
        emit V4LiquiditySeeder.FeesCollected(TICK_LOWER, TICK_UPPER, 3 * uint256(LIQUIDITY), 7);
        vm.prank(outsider);
        (uint256 amount0, uint256 amount1) =
            seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        assertEq(amount0, LIQUIDITY);
        assertEq(amount1, LIQUIDITY);
        assertEq(before0 - c0.balanceOf(outsider), LIQUIDITY, "the adder did not pay for its liquidity");
        assertEq(before1 - c1.balanceOf(outsider), LIQUIDITY, "the adder did not pay for its liquidity");
        assertEq(c0.balanceOf(address(seeder)), 3 * uint256(LIQUIDITY), "the fees left with the adder");
        assertEq(c1.balanceOf(address(seeder)), 7, "the fees left with the adder");
        assertEq(manager.deltaOf(address(seeder), seeder.currency0()), 0);
        assertEq(manager.deltaOf(address(seeder), seeder.currency1()), 0);

        vm.prank(outsider);
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        seeder.sweep(address(c0), outsider, 1);

        vm.prank(owner);
        seeder.sweep(address(c0), owner, 3 * uint256(LIQUIDITY));
        assertEq(c0.balanceOf(address(seeder)), 0);
    }

    /// Adding is open to anyone and gives the liquidity away: it joins the owner's position and
    /// only the owner can take it back out.
    function test_anyoneCanAddAndOnlyTheOwnerTakesItOut() public {
        _open();
        _fund(outsider);

        vm.prank(outsider);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);
        assertEq(seeder.liquidityOf(TICK_LOWER, TICK_UPPER), LIQUIDITY);

        vm.prank(outsider);
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0, outsider);

        address recipient = makeAddr("recipient");
        vm.prank(owner);
        seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY, recipient);
        assertEq(IERC20(seeder.currency0()).balanceOf(recipient), LIQUIDITY);
    }

    /// The pool opens once, and a seeder deployed after that adds to it without opening it. This
    /// is the path a redeployed seeder takes against the live pool.
    function test_aSecondSeederAddsToAnInitialisedPool() public {
        _open();
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        address timelock = makeAddr("timelock");
        V4LiquiditySeeder second = new V4LiquiditySeeder(address(manager), address(identity), timelock);
        assertEq(second.poolId(), seeder.poolId());
        assertEq(second.owner(), timelock);

        _fund(outsider);
        vm.startPrank(outsider);
        IERC20(second.currency0()).approve(address(second), type(uint256).max);
        IERC20(second.currency1()).approve(address(second), type(uint256).max);
        second.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);
        vm.stopPrank();

        assertEq(second.liquidityOf(TICK_LOWER, TICK_UPPER), LIQUIDITY);
        assertEq(manager.liquidityOf(seeder.poolId()), 2 * uint256(LIQUIDITY));

        // Opening it again is refused by the manager, whoever asks.
        bytes32 id = second.poolId();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(StubPoolManager.AlreadyInitialized.selector, id));
        second.initializePool(1120455419495722798374);
    }

    /// A removal pays the position's fees out with the principal, to the same recipient.
    function test_aRemovalPaysTheFeesToItsRecipient() public {
        _open();
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        deal(seeder.currency0(), address(manager), IERC20(seeder.currency0()).balanceOf(address(manager)) + 11);
        manager.setFees(11, 0);

        address recipient = makeAddr("recipient");
        vm.prank(owner);
        (uint256 amount0, uint256 amount1) =
            seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY + 11, LIQUIDITY, recipient);

        assertEq(amount0, uint256(LIQUIDITY) + 11);
        assertEq(amount1, LIQUIDITY);
        assertEq(IERC20(seeder.currency0()).balanceOf(recipient), uint256(LIQUIDITY) + 11);
        assertEq(IERC20(seeder.currency0()).balanceOf(address(seeder)), 0);
    }

    /// The owner can hand the position on, and keeps every power until the new owner accepts.
    function test_ownershipMovesInTwoSteps() public {
        address next = makeAddr("timelock");

        vm.prank(outsider);
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        seeder.transferOwnership(next);

        vm.prank(owner);
        vm.expectRevert(V4LiquiditySeeder.ZeroAddress.selector);
        seeder.transferOwnership(address(0));

        vm.expectEmit(true, true, false, false, address(seeder));
        emit V4LiquiditySeeder.OwnershipTransferStarted(owner, next);
        vm.prank(owner);
        seeder.transferOwnership(next);
        assertEq(seeder.owner(), owner);
        assertEq(seeder.pendingOwner(), next);

        vm.prank(outsider);
        vm.expectRevert(V4LiquiditySeeder.NotPendingOwner.selector);
        seeder.acceptOwnership();

        vm.expectEmit(true, true, false, false, address(seeder));
        emit V4LiquiditySeeder.OwnershipTransferred(owner, next);
        vm.prank(next);
        seeder.acceptOwnership();
        assertEq(seeder.owner(), next);
        assertEq(seeder.pendingOwner(), address(0));

        brsr.mint(address(seeder), 7);
        vm.prank(owner);
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        seeder.sweep(address(brsr), owner, 7);
        vm.prank(owner);
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        seeder.initializePool(1120455419495722798374);

        vm.prank(next);
        seeder.sweep(address(brsr), next, 7);
        assertEq(brsr.balanceOf(next), 7);
    }

    function test_zeroLiquidityIsRefused() public {
        _open();
        vm.expectRevert(V4LiquiditySeeder.ZeroLiquidity.selector);
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, 0, LIQUIDITY, LIQUIDITY);
    }

    function test_ticksOffTheSpacingAreRefused() public {
        _open();
        vm.startPrank(owner);

        vm.expectRevert(abi.encodeWithSelector(V4LiquiditySeeder.BadTicks.selector, int24(-61), TICK_UPPER));
        seeder.addLiquidity(-61, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        vm.expectRevert(abi.encodeWithSelector(V4LiquiditySeeder.BadTicks.selector, TICK_LOWER, int24(7)));
        seeder.addLiquidity(TICK_LOWER, 7, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        vm.expectRevert(abi.encodeWithSelector(V4LiquiditySeeder.BadTicks.selector, int24(60), int24(60)));
        seeder.addLiquidity(60, 60, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        vm.expectRevert(abi.encodeWithSelector(V4LiquiditySeeder.BadTicks.selector, int24(120), int24(60)));
        seeder.addLiquidity(120, 60, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        vm.stopPrank();
    }

    /// A currency that credits less than was sent leaves the manager's books open. USDG is not
    /// one; a deployment against a token that is has to stop here.
    function test_aShortSettlementIsRefused() public {
        _open();
        manager.setSettleShortfall(1);

        vm.expectRevert(
            abi.encodeWithSelector(V4LiquiditySeeder.SettlementShort.selector, uint256(LIQUIDITY) - 1, LIQUIDITY)
        );
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);
    }

    function test_removeLiquiditySendsTheProceedsOn() public {
        _open();
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        address recipient = makeAddr("recipient");
        vm.prank(owner);
        (uint256 amount0, uint256 amount1) =
            seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY, recipient);

        assertEq(amount0, LIQUIDITY);
        assertEq(amount1, LIQUIDITY);
        assertEq(seeder.liquidityOf(TICK_LOWER, TICK_UPPER), 0);
        assertEq(IERC20(seeder.currency0()).balanceOf(recipient), LIQUIDITY);
        assertEq(IERC20(seeder.currency1()).balanceOf(recipient), LIQUIDITY);
    }

    function test_removingMoreThanIsHeldIsRefused() public {
        _open();
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        vm.expectRevert(
            abi.encodeWithSelector(V4LiquiditySeeder.InsufficientLiquidity.selector, LIQUIDITY, LIQUIDITY + 1)
        );
        vm.prank(owner);
        seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY + 1, 0, 0, owner);
    }

    function test_aWithdrawalBelowTheFloorIsRefused() public {
        _open();
        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        manager.setRates(5e8, 1e9); // the pool hands back half of currency0

        vm.expectRevert(
            abi.encodeWithSelector(
                V4LiquiditySeeder.AmountBelowMinimum.selector, seeder.currency0(), uint256(LIQUIDITY) / 2, LIQUIDITY
            )
        );
        vm.prank(owner);
        seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, 0, owner);
    }

    function test_removalRefusesAZeroRecipient() public {
        vm.expectRevert(V4LiquiditySeeder.ZeroAddress.selector);
        vm.prank(owner);
        seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0, address(0));
    }

    function test_removalRefusesZeroLiquidity() public {
        vm.expectRevert(V4LiquiditySeeder.ZeroLiquidity.selector);
        vm.prank(owner);
        seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, 0, 0, 0, owner);
    }

    function test_onlyTheOwnerRemoves() public {
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        vm.prank(outsider);
        seeder.removeLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0, outsider);
    }

    function test_theCallbackTakesNobodyElse() public {
        vm.expectRevert(V4LiquiditySeeder.NotPoolManager.selector);
        seeder.unlockCallback("");
    }

    /// A manager that calls back when nothing asked it to is refused.
    function test_anUnexpectedCallbackIsRefused() public {
        vm.expectRevert(V4LiquiditySeeder.UnexpectedCallback.selector);
        vm.prank(address(manager));
        seeder.unlockCallback(abi.encode(TICK_LOWER, TICK_UPPER, int256(1), uint256(0), uint256(0), address(this)));
    }

    function test_theOwnerSweepsATokenToAnyRecipient() public {
        brsr.mint(address(seeder), 7);
        vm.prank(owner);
        seeder.sweep(address(brsr), outsider, 7);
        assertEq(brsr.balanceOf(outsider), 7);
    }

    function test_onlyTheOwnerSweeps() public {
        brsr.mint(address(seeder), 7);
        vm.expectRevert(V4LiquiditySeeder.NotOwner.selector);
        vm.prank(outsider);
        seeder.sweep(address(brsr), outsider, 7);
    }

    function test_sweepRefusesZeroes() public {
        vm.startPrank(owner);
        vm.expectRevert(V4LiquiditySeeder.ZeroAddress.selector);
        seeder.sweep(address(0), outsider, 1);
        vm.expectRevert(V4LiquiditySeeder.ZeroAddress.selector);
        seeder.sweep(address(brsr), address(0), 1);
        vm.stopPrank();
    }

    /// A balance that was already sitting here is not handed to whoever seeds next.
    function test_aStrayBalanceIsNotRefundedToTheSeeder() public {
        _open();
        deal(seeder.currency0(), address(seeder), 500);

        vm.prank(owner);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY, LIQUIDITY, LIQUIDITY);

        assertEq(IERC20(seeder.currency0()).balanceOf(address(seeder)), 500, "the stray balance moved");
    }

    function _open() private {
        vm.prank(owner);
        seeder.initializePool(1120455419495722798374);
    }

    function _fund(address who) private {
        brsr.mint(who, 1_000_000e18);
        usdg.mint(who, 1_000_000e6);
        vm.startPrank(who);
        brsr.approve(address(seeder), type(uint256).max);
        usdg.approve(address(seeder), type(uint256).max);
        vm.stopPrank();
    }
}
