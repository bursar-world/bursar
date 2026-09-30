// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PoolKey} from "./Buyback.sol";

/// The six pool-manager functions this contract calls, declared here for the reason `Buyback`
/// declares its five: a handful of signatures does not justify a submodule pinned to an upstream
/// revision and a second compiler version. `Currency` and `IHooks` are value types over `address`
/// and `BalanceDelta` is a value type over `int256`, so these encodings match the deployed
/// manager byte for byte. The two `Buyback` does not call, `initialize` and `modifyLiquidity`,
/// were read out of the runtime at `0x8366a39CC670B4001A1121B8F6A443A643e40951` before this file
/// was written.
interface IPoolManagerLiquidity {
    function unlock(bytes calldata data) external returns (bytes memory);

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);

    function sync(address currency) external;

    function settle() external payable returns (uint256 paid);

    function take(address currency, address to, uint256 amount) external;
}

/// A positive `liquidityDelta` adds, a negative one removes. `salt` separates two positions the
/// same address holds over the same range; this contract keeps one position per range and
/// leaves it zero, so the position is the one a reader finds by looking up this address and the
/// two ticks.
struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

/// One liquidity change as the callback receives it. Every field is static, so this decodes the
/// same bytes `_run` encodes field by field.
struct Change {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    uint256 amount0Max;
    uint256 amount1Max;
    address to;
}

/// The five values that name the pool `Buyback` trades. Read from the live buyback at
/// construction rather than passed in.
interface IBuybackPool {
    function currency0() external view returns (address);
    function currency1() external view returns (address);
    function poolFee() external view returns (uint24);
    function poolTickSpacing() external view returns (int24);
    function poolHooks() external view returns (address);
}

/// Opens the BRSR/USDG market and holds the position that makes it one.
///
/// Uniswap v4 keeps every pool inside one manager and will not let an ordinary caller touch a
/// position directly. Liquidity moves during an `unlock`, in a callback, with the manager's
/// books open, and the call reverts unless every currency the caller moved settles back to
/// zero. That is why seeding needs a contract at all, and it is the whole of what this one does.
///
/// ## What it cannot do
///
/// The pool identity is read from the live `Buyback` at construction and held immutably. There
/// is no setter and no key argument on any function here. A seeder that can be pointed at a
/// second pool is a seeder that can open a market the buyback will never trade while looking
/// exactly like the one that does, and the failure would be discovered by the first person who
/// bought into the wrong one. Pointing this contract somewhere else is a redeploy, and the
/// address the liquidity holder funds is what names the live one.
///
/// It also holds no allowance on any address. Tokens are pulled from the caller for the length
/// of one seed and whatever the position did not take goes straight back to them in the same
/// transaction.
///
/// ## Who can do what
///
/// Anyone can add liquidity, paid for out of their own balance, and in doing so gives it away:
/// the position belongs to this contract, and only the owner can take liquidity back out or
/// sweep the fees it earned. On a live deployment the owner is the admin timelock, so the
/// market stays open unless a proposal closes it. Opening the pool is the owner's too, because
/// the opening price is the one decision here that cannot be taken back. Ownership moves in two
/// steps, and the incoming owner has to accept it.
///
/// ## The decimal trap, stated once
///
/// `sqrtPriceX96` is a ratio of **raw token units**. BRSR carries eighteen decimals and USDG
/// carries six, so a price that reads correctly in whole tokens is out by `1e12` in the units v4
/// actually uses. This contract does not compute that number: `script/lib/V4Math.sol` does,
/// `script/SeedPool.s.sol` prints both derivations of it, and `initializePool` takes the result.
/// A pool can be opened once and never reopened, so the number is checked before it is sent and
/// the opening tick is read back afterwards.
///
/// ## Native currency
///
/// v4 reads the zero address as native currency and settles it through `msg.value`. Neither side
/// of this pool may be it, for the same reason `Buyback`'s constructor refuses one: this
/// contract moves ERC-20 balances and holds no ETH beyond gas. Inheriting the currencies from
/// the buyback inherits that refusal.
contract V4LiquiditySeeder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // forge-lint: disable-start(screaming-snake-case-immutable)
    IPoolManagerLiquidity public immutable poolManager;

    /// The buyback whose pool this seeds. Kept so an operator can check the two agree without
    /// comparing five values by eye.
    address public immutable buyback;

    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;
    address public immutable poolHooks;
    // forge-lint: disable-end

    /// Opens the pool, takes liquidity out and sweeps. Nothing else is reserved to it.
    address public owner;
    address public pendingOwner;

    /// Liquidity this contract holds per tick range, its own copy of what the manager records.
    /// A range that reads zero here has nothing of ours in it.
    mapping(int24 tickLower => mapping(int24 tickUpper => uint128 liquidity)) public liquidityOf;

    /// Binds the callback to the payload that asked for it. A bare flag says a callback was
    /// expected; this says which one, so a manager that re-entered with different parameters
    /// would be refused rather than obeyed.
    bytes32 private _callbackHash;

    event PoolInitialized(uint160 sqrtPriceX96, int24 tick);
    event LiquidityAdded(int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0, uint256 amount1);
    event FeesCollected(int24 tickLower, int24 tickUpper, uint256 amount0, uint256 amount1);
    event LiquidityRemoved(
        int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0, uint256 amount1, address to
    );
    event Swept(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error ZeroAddress();
    error NotOwner();
    error NotPendingOwner();
    error NotPoolManager();
    error UnexpectedCallback();
    error CallbackNotConsumed();
    error ZeroLiquidity();
    error BadTicks(int24 tickLower, int24 tickUpper);
    error NativeCurrencyNotSupported();
    error AmountAboveMaximum(address currency, uint256 owed, uint256 maximum);
    error AmountBelowMinimum(address currency, uint256 received, uint256 minimum);
    error InsufficientLiquidity(uint128 held, uint128 requested);
    error SettlementShort(uint256 paid, uint256 owed);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address poolManager_, address buyback_, address owner_) {
        if (poolManager_ == address(0) || buyback_ == address(0) || owner_ == address(0)) revert ZeroAddress();

        IBuybackPool pool = IBuybackPool(buyback_);
        address c0 = pool.currency0();
        address c1 = pool.currency1();
        if (c0 == address(0) || c1 == address(0)) revert NativeCurrencyNotSupported();

        poolManager = IPoolManagerLiquidity(poolManager_);
        buyback = buyback_;
        currency0 = c0;
        currency1 = c1;
        poolFee = pool.poolFee();
        poolTickSpacing = pool.poolTickSpacing();
        poolHooks = pool.poolHooks();
        owner = owner_;

        emit OwnershipTransferred(address(0), owner_);
    }

    /// Opens the pool at `sqrtPriceX96` and returns the tick the manager put it at.
    ///
    /// One shot. The manager refuses a second initialize on the same key, so the number sent
    /// here is the public opening price of BRSR and there is no version of this call that
    /// corrects it. Everything that decides it lives in `script/SeedPool.s.sol`, which derives
    /// it twice and refuses to broadcast unless the two derivations agree.
    function initializePool(uint160 sqrtPriceX96) external onlyOwner returns (int24 tick) {
        tick = poolManager.initialize(key(), sqrtPriceX96);
        emit PoolInitialized(sqrtPriceX96, tick);
    }

    /// Adds `liquidity` over `[tickLower, tickUpper]`, paid for out of the caller's balance.
    ///
    /// Open to anyone. What is added joins this contract's position and only the owner can take
    /// it back out, so calling this gives the liquidity away.
    ///
    /// `amount0Max` and `amount1Max` are the guard that matters. Liquidity is a unit nobody can
    /// check by eye; the two maxima are the amounts of BRSR and USDG the caller is willing to
    /// part with, and the call reverts rather than take a wei more of either. Both are pulled up
    /// front because the manager is paid from this contract's own balance during the callback,
    /// and the remainder goes back in the same transaction. Fees the position had accrued are
    /// credited into the same settlement and stay here for the owner; the caller gets back what
    /// the liquidity did not cost, never the fees.
    function addLiquidity(int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0Max, uint256 amount1Max)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (liquidity == 0) revert ZeroLiquidity();
        _requireTicks(tickLower, tickUpper);

        uint256 before0 = _pull(currency0, amount0Max);
        uint256 before1 = _pull(currency1, amount1Max);

        uint256 fees0;
        uint256 fees1;
        (amount0, amount1, fees0, fees1) =
            _run(tickLower, tickUpper, int256(uint256(liquidity)), amount0Max, amount1Max, address(this));

        liquidityOf[tickLower][tickUpper] += liquidity;

        _refund(currency0, before0 + fees0);
        _refund(currency1, before1 + fees1);

        emit LiquidityAdded(tickLower, tickUpper, liquidity, amount0, amount1);
        if (fees0 != 0 || fees1 != 0) emit FeesCollected(tickLower, tickUpper, fees0, fees1);
    }

    /// Takes `liquidity` back out of the position and sends the proceeds to `to`.
    ///
    /// The exit exists because a seeded pool is not a decision anyone should have to live with
    /// forever: a venue can be abandoned, a key can be rotated, and the alternative to this
    /// function is liquidity nobody can reach. `amount0Min` and `amount1Min` are the caller's
    /// floor on what comes back, which is what a price that moved between the read and the
    /// transaction shows up as. Fees the position accrued come out with it, to the same
    /// recipient.
    function removeLiquidity(
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        address to
    ) external onlyOwner nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (liquidity == 0) revert ZeroLiquidity();
        if (to == address(0)) revert ZeroAddress();

        uint128 held = liquidityOf[tickLower][tickUpper];
        if (held < liquidity) revert InsufficientLiquidity(held, liquidity);
        liquidityOf[tickLower][tickUpper] = held - liquidity;

        (amount0, amount1,,) = _run(tickLower, tickUpper, -int256(uint256(liquidity)), 0, 0, to);

        if (amount0 < amount0Min) revert AmountBelowMinimum(currency0, amount0, amount0Min);
        if (amount1 < amount1Min) revert AmountBelowMinimum(currency1, amount1, amount1Min);

        emit LiquidityRemoved(tickLower, tickUpper, liquidity, amount0, amount1, to);
    }

    /// Sends on whatever sits here. v4 credits a position's fees on the next `modifyLiquidity`
    /// against it: a removal pays them to its own recipient, and an add, which anyone can make,
    /// leaves them here. Anything sent here by mistake leaves the same way.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    /// Step one of two. The current owner keeps every power until the new one accepts.
    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// The pool key, assembled from the five immutables. Every call here sends this and nothing
    /// else.
    function key() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: currency0, currency1: currency1, fee: poolFee, tickSpacing: poolTickSpacing, hooks: poolHooks
        });
    }

    /// keccak256 of the ABI-encoded key, which is the id v4 files the pool under and the id a
    /// reader needs to look the pool up through `StateView`.
    function poolId() external view returns (bytes32) {
        return keccak256(abi.encode(key()));
    }

    /// The manager's re-entry point. Everything between the unlock and the return runs with the
    /// manager's accounting open, and it has to close to zero or the manager reverts the call.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        bytes32 expected = _callbackHash;
        if (expected == bytes32(0) || keccak256(data) != expected) revert UnexpectedCallback();
        delete _callbackHash;

        Change memory change = abi.decode(data, (Change));

        (int256 callerDelta, int256 feesAccrued) = poolManager.modifyLiquidity(
            key(),
            ModifyLiquidityParams({
                tickLower: change.tickLower,
                tickUpper: change.tickUpper,
                liquidityDelta: change.liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        // Each delta packs two signed 128-bit amounts into one word, amount0 above amount1.
        bool adding = change.liquidityDelta > 0;
        (uint256 amount0, uint256 fees0) =
            _leg(currency0, callerDelta >> 128, feesAccrued >> 128, adding, change.amount0Max, change.to);
        (uint256 amount1, uint256 fees1) =
            _leg(currency1, callerDelta, feesAccrued, adding, change.amount1Max, change.to);

        return abi.encode(amount0, amount1, fees0, fees1);
    }

    /// Settles one currency and returns what the liquidity cost in it, or on a removal what it
    /// paid out, with the fees the position had accrued in it. Each argument carries its leg
    /// in the low 128 bits.
    ///
    /// `delta` is the principal and the fees together, and both signs are handled on both paths
    /// rather than assumed from the direction. An add owes the pool on every leg its range
    /// covers, but the fees credited into the same delta can outweigh what a leg owes. A removal
    /// is paid on every leg, and one the manager says owes anything is refused by its zero
    /// maxima.
    function _leg(address currency, int256 packedDelta, int256 packedFees, bool adding, uint256 maximum, address to)
        private
        returns (uint256 amount, uint256 fees)
    {
        // forge-lint: disable-start(unsafe-typecast)
        int256 delta = int256(int128(packedDelta));
        fees = uint256(uint128(int128(packedFees)));
        // forge-lint: disable-end

        uint256 moved = _settleOrTake(currency, delta, maximum, to);
        if (!adding) return (moved, fees);

        // The fees taken back out leave what the liquidity itself cost. That is what the caller
        // pays and what the maximum bounds.
        amount = _cost(delta - int256(fees));
        if (amount > maximum) revert AmountAboveMaximum(currency, amount, maximum);
    }

    /// Pays what is owed or collects what is due, and returns the amount either way.
    function _settleOrTake(address currency, int256 delta, uint256 maximum, address to)
        private
        returns (uint256 moved)
    {
        if (delta == 0) return 0;

        if (delta < 0) {
            moved = uint256(-delta);
            if (moved > maximum) revert AmountAboveMaximum(currency, moved, maximum);
            // Settlement is measured by the manager as the change in its own balance since
            // `sync`, so the order of these three calls is the payment.
            poolManager.sync(currency);
            IERC20(currency).safeTransfer(address(poolManager), moved);
            uint256 paid = poolManager.settle();
            // A fee-on-transfer currency would credit less than was sent and leave the manager's
            // books open. Neither BRSR nor USDG is one; a deployment against a token that is
            // should stop here, before the accounting hides it.
            if (paid < moved) revert SettlementShort(paid, moved);
            return moved;
        }

        moved = uint256(delta);
        poolManager.take(currency, to, moved);
    }

    function _cost(int256 principal) private pure returns (uint256) {
        return principal < 0 ? uint256(-principal) : 0;
    }

    function _run(
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta,
        uint256 amount0Max,
        uint256 amount1Max,
        address to
    ) private returns (uint256 amount0, uint256 amount1, uint256 fees0, uint256 fees1) {
        bytes memory payload = abi.encode(tickLower, tickUpper, liquidityDelta, amount0Max, amount1Max, to);
        _callbackHash = keccak256(payload);
        bytes memory result = poolManager.unlock(payload);
        // Cleared by the callback. A manager that returned without calling back would otherwise
        // leave the hash armed for someone else's unlock.
        if (_callbackHash != bytes32(0)) {
            delete _callbackHash;
            revert CallbackNotConsumed();
        }
        (amount0, amount1, fees0, fees1) = abi.decode(result, (uint256, uint256, uint256, uint256));
    }

    function _requireTicks(int24 tickLower, int24 tickUpper) private view {
        int24 spacing = poolTickSpacing;
        if (tickLower >= tickUpper || tickLower % spacing != 0 || tickUpper % spacing != 0) {
            revert BadTicks(tickLower, tickUpper);
        }
    }

    /// Takes `amount` from the caller and returns the balance this contract held **before** it
    /// arrived, which is the mark `_refund` measures against.
    function _pull(address currency, uint256 amount) private returns (uint256 before) {
        before = IERC20(currency).balanceOf(address(this));
        if (amount != 0) IERC20(currency).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// Sends back whatever of the pulled amount the position did not take. Measured against the
    /// mark, raised by the fees this add collected, rather than against the whole balance, so
    /// neither a stray amount already sitting here nor the position's fees are handed to
    /// whoever happens to add next; both leave through `sweep`.
    ///
    /// The subtraction cannot underflow: the callback refuses to pay more of either currency
    /// than the maximum, and the maximum is what this call pulled.
    function _refund(address currency, uint256 mark) private {
        uint256 unspent = IERC20(currency).balanceOf(address(this)) - mark;
        if (unspent != 0) IERC20(currency).safeTransfer(msg.sender, unspent);
    }
}
