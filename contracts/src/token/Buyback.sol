// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IStaking} from "./interfaces/IStaking.sol";

/// The AMM this trades against is a live deployment on Robinhood Chain and is not built from this
/// repository. Vendoring its source would pull in a second compiler version, a second EVM
/// target and a submodule pinned to an upstream revision, for five function signatures. The
/// five are reproduced instead, and they are ABI-exact: `Currency` and `IHooks` are value
/// types over `address`, and `BalanceDelta` is a value type over `int256`, so the encodings
/// below match the deployed manager byte for byte.
interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);

    function sync(address currency) external;

    function settle() external payable returns (uint256 paid);

    function take(address currency, address to, uint256 amount) external;
}

/// Currencies are sorted numerically. `hooks` is the zero address for a pool with no hook.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// A negative `amountSpecified` is an exact-input swap, which is the only kind this contract
/// makes: it knows how much it is willing to spend, never how much it expects to receive.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// Turns protocol revenue into staked-side distribution: spends USDG on the BRSR pool and
/// compounds what it bought into the staking pool, which raises what every earning share is
/// worth without minting a single new one.
///
/// It buys and distributes rather than burning. Bonds in the dispute layer are posted in
/// BRSR, so backing adjudication is the first thing the token is for, and destroying supply
/// to raise a price works directly against it. Distributed tokens stay in the hands that can
/// bond them, and they land where the capital already at risk is.
///
/// Funding is a transfer in and never an allowance out. The treasury moves USDG here and this
/// contract spends only what it has been given. Every guard below failing at once is bounded
/// by this contract's own balance, never the treasury's. It holds no approval on any other
/// address and cannot claim the escrow's fee destination, which stays with an address that can
/// answer for itself.
///
/// ## Who may call this, and what that costs
///
/// `buyback` pays no bounty. The caller chooses no amount, no price, no deadline and no
/// recipient, and the proceeds leave for the staking contract in the same transaction, so
/// triggering one is worth nothing beyond the gas it costs.
///
/// It is still not open to anyone. An open buyback can be wrapped in a single transaction:
/// push the pool price up, trigger the buy, sell back into it, and keep the difference. That
/// needs no mempool and no luck, and on a thin pool the fill can be pushed right up to the
/// ceiling every time. Only `keeper`, an address governance names, can call it, which closes
/// the atomic version. The keeper's own transaction can still be seen and bracketed by whoever
/// orders the block. Four things bound that, and none of them removes it:
///
/// - **The ceiling.** `maxPriceMicroUsdPerBrsr` is the most governance will pay for a whole
///   BRSR, in micro-USD, and it is not read from the pool during the trade. A sandwicher can
///   push the fill up to the ceiling and no further. The gap between the ceiling and the
///   market is the size of the prize, which makes setting that number the decision that
///   matters here. A slippage check against the pool's own pre-trade price would look tighter
///   and be weaker: a price read inside this transaction is a price the sandwicher has already
///   moved, so it measures this contract's own impact and reports it as protection.
///
///   The unit is the one a person can check against a screen. A deployment starts at zero, and
///   zero blocks every trade, so an untuned buyback buys nothing at all. There is no value
///   that means "no ceiling". A ceiling also ages: it carries the time governance last set it,
///   and after `maxCeilingAge` every buyback refuses until governance sets it again. A market
///   moves, and a ceiling nobody has looked at in a week is a guess.
/// - **The size.** One call spends at most `spendPerCall`, which bounds the sandwich that is
///   profitable around it.
/// - **The window.** `maxSpendPerWindow` bounds what the whole strategy extracts per window,
///   however many calls the keeper makes.
/// - **The interval.** `minInterval` stops a window's budget being spent across consecutive
///   blocks. The cap is a rate limit, not a lump anyone can pull at once.
///
/// Robinhood Chain settles in well under a second, which shortens the interval in which a
/// pending call can be seen and bracketed. It does not close it, and a sequencer reordering
/// its own block never needed the mempool.
///
/// The ceiling moves on governance time, behind the timelock's delay (48 hours at launch). A
/// ceiling left above the market widens the prize; a ceiling left below it blocks buybacks
/// entirely. Only the second failure is safe, so the fast response to a fast move is the brake:
/// the guardian pauses this contract in one call, governance retunes, and the pause lifts on a
/// proposal like any other change.
///
/// ## Robinhood Chain
///
/// The settlement asset is USDG at `0x5fc5…d168`, a six-decimal ERC-20. Gas is ETH, a separate
/// asset at a separate address, so nothing here has to reconcile two views of one balance. The
/// pool must still be keyed to the USDG address rather than the zero address: v4 reads zero as
/// native currency and settles it through `msg.value`, which would price this pool in gas. The
/// constructor rejects a pool with a zero currency for that reason.
///
/// USDG carries issuer controls. `paused()` and `isFrozen(address)` both answer on chain, and a
/// transfer out of here reverts while the token is paused or while this address or the manager
/// is frozen. `isBlacklisted` is not one of them: USDG is a diamond proxy and that selector
/// reverts with `FacetNotFound`, so a caller looking for Circle's name for this finds nothing
/// and must not read that as an all-clear. Either case stops a buyback and nothing here works
/// around it: the money stays where it is.
contract Buyback is Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// One whole BRSR in wei. Amounts named `…MicroUsd` are six-decimal USDG; amounts named
    /// `…Wei` are eighteen-decimal BRSR. A price carries both units and converts between them.
    uint256 private constant BRSR_UNIT = 1e18;

    /// The largest number that is still a price. One BRSR at a million dollars values the whole
    /// supply at a thousand trillion, which no governance intends; a number that large is a
    /// figure entered in some other unit, most likely BRSR wei, where everyday values start at
    /// 1e18. Rejecting anything above this catches that class of mistake before it is stored.
    /// It does not make a ceiling correct, and nothing in this contract can: only governance
    /// knows what BRSR is worth.
    uint128 private constant MAX_PRICE_MICRO_USD_PER_BRSR = 1e12;

    uint8 private constant SETTLEMENT_DECIMALS = 6;
    uint8 private constant BRSR_DECIMALS = 18;

    /// The extreme bounds of v4's price range. Passing the extreme means the swap is limited
    /// by `minOut` and by nothing else, which is the intent: a price limit is a second, worse
    /// expression of the same guard, denominated in a unit governance cannot reason about.
    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /// A window longer than this is a fat finger. A cap that resets once a quarter is not a
    /// rate limit.
    uint64 private constant MAX_WINDOW = 30 days;

    /// Bounds on how long a ceiling stays usable. Under a day asks governance to restate the price
    /// more often than any proposal cadence will; over a month is not a price anyone checked.
    uint64 public constant MIN_CEILING_AGE = 1 days;
    uint64 public constant MAX_CEILING_AGE = 30 days;

    /// Governance-owned, and every field is load-bearing. Read the invariants in `_validate`
    /// before changing any of them.
    struct Params {
        /// Target spend per call. The actual spend is this, the balance, or the remaining
        /// window headroom, whichever is smallest.
        uint128 spendPerCallMicroUsd;
        /// Ceiling on total spend within one window.
        uint128 maxSpendPerWindowMicroUsd;
        /// Below this a buyback is refused. A dust buy costs more gas than it moves and
        /// hands an observer a cheap price print.
        uint128 minSpendMicroUsd;
        /// The most this contract will pay for one whole BRSR, in micro-USD. Five cents is
        /// `50_000`. Zero blocks every trade, and is where a deployment starts.
        uint128 maxPriceMicroUsdPerBrsr;
        uint64 window;
        uint64 minInterval;
    }

    struct Window {
        uint128 spentMicroUsd;
        uint64 start;
    }

    // forge-lint: disable-start(screaming-snake-case-immutable)
    IERC20 public immutable settlementAsset;
    IERC20 public immutable brsr;
    IPoolManager public immutable poolManager;
    IStaking public immutable staking;

    /// Where a sweep sends recovered funds, fixed at construction. Governance can return money
    /// but cannot choose a new destination for it. A compromised admin key inherits the
    /// treasury's address.
    address public immutable treasury;

    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;
    address public immutable poolHooks;

    /// True when the settlement asset is the pool's `currency0`, so a buy of BRSR is a
    /// zero-for-one swap.
    bool public immutable settlementIsCurrency0;
    // forge-lint: disable-end

    address public admin;
    address public pendingAdmin;

    /// The only address that can trigger a buyback. Unset, nothing can.
    address public keeper;

    uint64 public lastBuybackAt;

    /// When governance last set the parameters, and with them the ceiling, and how long the
    /// ceiling is trusted after that.
    uint64 public ceilingSetAt;
    uint64 public maxCeilingAge;

    Params private _params;
    Window private _window;

    /// Set for the length of one `unlock`. The manager will call back into any address that
    /// unlocks it, so the callback has to be able to tell a callback this contract asked for
    /// from one an unrelated caller arranged.
    bool private _unlocking;

    event BuybackExecuted(address indexed caller, uint256 spentMicroUsd, uint256 receivedWei, uint256 minOutWei);
    event ParamsUpdated(Params params);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event KeeperUpdated(address indexed keeper);
    event MaxCeilingAgeUpdated(uint64 age);
    event Swept(address indexed token, uint256 amount);

    error ZeroAddress();
    error NotAdmin();
    error NotAuthorized();
    error NotKeeper();
    error NotPoolManager();
    error NotUnlocking();
    error AssetDecimalsMismatch(address token, uint8 found, uint8 expected);
    error StakingTokenMismatch(address found, address expected);
    error NoStakeToDistributeTo();
    error NativeCurrencyNotSupported();
    error PoolCurrencyMismatch(address currency0, address currency1);
    error BadParams(string what);
    error TooSoon(uint64 readyAt);
    error BelowMinimumSpend(uint256 availableMicroUsd, uint128 minSpendMicroUsd);
    error PriceCeilingUnset();
    error PriceCeilingStale(uint64 staleSince);
    error SwapConsumedWrongAmount(uint256 requestedMicroUsd, uint256 spentMicroUsd);
    error SwapDirectionWrong(int256 inDelta, int256 outDelta);
    error MinimumOutNotMet(uint256 receivedWei, uint256 minOutWei);
    error SettlementShort(uint256 paid, uint256 owed);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        address settlementAsset_,
        address brsr_,
        address poolManager_,
        uint24 poolFee_,
        int24 poolTickSpacing_,
        address poolHooks_,
        address staking_,
        address admin_,
        address treasury_,
        Params memory params_
    ) {
        if (
            settlementAsset_ == address(0) || brsr_ == address(0) || poolManager_ == address(0)
                || staking_ == address(0) || admin_ == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();

        // Decimals are read from each token, because the whole of this contract's arithmetic
        // is one conversion between a six-decimal price and an eighteen-decimal one. A token
        // that disagrees with either would not fail loudly; it would buy the wrong amount and
        // look like a bad market.
        uint8 assetDecimals = IERC20Metadata(settlementAsset_).decimals();
        if (assetDecimals != SETTLEMENT_DECIMALS) {
            revert AssetDecimalsMismatch(settlementAsset_, assetDecimals, SETTLEMENT_DECIMALS);
        }
        uint8 brsrDecimals = IERC20Metadata(brsr_).decimals();
        if (brsrDecimals != BRSR_DECIMALS) {
            revert AssetDecimalsMismatch(brsr_, brsrDecimals, BRSR_DECIMALS);
        }

        (address c0, address c1) = settlementAsset_ < brsr_ ? (settlementAsset_, brsr_) : (brsr_, settlementAsset_);
        // v4 reads the zero address as native currency, which on 4663 is ETH settled through
        // `msg.value`. This contract accounts in six-decimal USDG and holds no ETH beyond gas,
        // so neither side of this pool may be it.
        if (c0 == address(0)) revert NativeCurrencyNotSupported();
        if (c0 == c1) revert PoolCurrencyMismatch(c0, c1);

        // The pool this buys into has to be the pool the proceeds go to. A staking contract
        // holding a different stake token would accept the compound and credit it to shares
        // denominated in something else.
        IStaking pool = IStaking(staking_);
        if (address(pool.stakeToken()) != brsr_) {
            revert StakingTokenMismatch(address(pool.stakeToken()), brsr_);
        }
        if (address(pool.rewardToken()) != settlementAsset_) {
            revert StakingTokenMismatch(address(pool.rewardToken()), settlementAsset_);
        }

        settlementAsset = IERC20(settlementAsset_);
        brsr = IERC20(brsr_);
        poolManager = IPoolManager(poolManager_);
        staking = pool;
        treasury = treasury_;

        // The pool identity is fixed here and governance cannot move it. A buyback that can
        // be pointed at a new pool can be pointed at a new price, and the cheapest version of
        // that is a pool the mover made earlier. Changing venue is a redeploy, and the address
        // the treasury chooses to fund is what names the live one.
        currency0 = c0;
        currency1 = c1;
        poolFee = poolFee_;
        poolTickSpacing = poolTickSpacing_;
        poolHooks = poolHooks_;
        settlementIsCurrency0 = settlementAsset_ == c0;

        admin = admin_;

        _validate(params_);
        _params = params_;
        // forge-lint: disable-next-line(unsafe-typecast)
        _window.start = uint64(block.timestamp);
        ceilingSetAt = uint64(block.timestamp);
        maxCeilingAge = 7 days;

        emit ParamsUpdated(params_);
        emit MaxCeilingAgeUpdated(7 days);
        emit AdminTransferred(address(0), admin_);
    }

    /// Spends what the caps allow, at a price no worse than the governance ceiling, and hands
    /// the result to the staking pool. Reverts rather than buying badly.
    function buyback() external nonReentrant whenNotPaused returns (uint256 spentMicroUsd, uint256 receivedWei) {
        if (msg.sender != keeper) revert NotKeeper();

        Params memory p = _params;

        // The state a deployment starts in and the state governance can return it to. Checked
        // first so an untuned contract says what is missing instead of failing further down on
        // a cooldown or a balance.
        if (p.maxPriceMicroUsdPerBrsr == 0) revert PriceCeilingUnset();
        uint64 staleSince = ceilingSetAt + maxCeilingAge;
        if (block.timestamp > staleSince) revert PriceCeilingStale(staleSince);

        uint64 readyAt = lastBuybackAt == 0 ? 0 : lastBuybackAt + p.minInterval;
        if (block.timestamp < readyAt) revert TooSoon(readyAt);

        // Compounding into an empty pool has nobody to credit, and the staking contract
        // refuses it. Checked before the swap: the refusal costs one view call, not a
        // reverted trade.
        if (staking.totalShares() == 0) revert NoStakeToDistributeTo();

        Window memory w = _rolled(_window, p.window);

        // Clamped, not subtracted. Governance lowering the cap below what the live window has
        // already spent is a legitimate tightening. It must close the window rather than
        // revert every call until the period rolls.
        uint256 headroom =
            w.spentMicroUsd >= p.maxSpendPerWindowMicroUsd ? 0 : p.maxSpendPerWindowMicroUsd - w.spentMicroUsd;
        uint256 balance = settlementAsset.balanceOf(address(this));

        uint256 spend = p.spendPerCallMicroUsd;
        if (headroom < spend) spend = headroom;
        if (balance < spend) spend = balance;
        if (spend < p.minSpendMicroUsd) revert BelowMinimumSpend(spend, p.minSpendMicroUsd);

        // Rounds up, so the conversion can only tighten what governance asked for. Spend is
        // micro-USD and the ceiling is micro-USD per whole BRSR, so the quotient is whole BRSR
        // and the factor carries it into wei.
        uint256 minOutWei = Math.ceilDiv(spend * BRSR_UNIT, p.maxPriceMicroUsdPerBrsr);

        // The window is charged and the clock is stamped before the manager is called.
        // Re-entry through the callback is expected, and it has to find the caps already spent
        // rather than still available. The cast is bounded by the clamp to `spendPerCall`.
        // forge-lint: disable-next-line(unsafe-typecast)
        w.spentMicroUsd += uint128(spend);
        _window = w;
        lastBuybackAt = uint64(block.timestamp);

        _unlocking = true;
        bytes memory result = poolManager.unlock(abi.encode(spend, minOutWei));
        // Cleared here as well as in the callback, so a manager that returns without calling
        // back cannot leave the flag armed for someone else's unlock.
        _unlocking = false;

        (spentMicroUsd, receivedWei) = abi.decode(result, (uint256, uint256));

        // The pool pulls, so it gets an allowance for exactly this buy and nothing beyond it.
        // `compound` takes the whole amount, which leaves the allowance back at zero.
        brsr.forceApprove(address(staking), receivedWei);
        staking.compound(receivedWei);

        emit BuybackExecuted(msg.sender, spentMicroUsd, receivedWei, minOutWei);
    }

    /// The manager's re-entry point. Everything between the unlock and the return runs with
    /// the manager's accounting open, and it has to close to zero or the manager reverts the
    /// whole call.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_unlocking) revert NotUnlocking();
        _unlocking = false;

        (uint256 spend, uint256 minOutWei) = abi.decode(data, (uint256, uint256));

        bool zeroForOne = settlementIsCurrency0;
        // forge-lint: disable-start(unsafe-typecast)
        int256 delta = poolManager.swap(
            PoolKey({
                currency0: currency0, currency1: currency1, fee: poolFee, tickSpacing: poolTickSpacing, hooks: poolHooks
            }),
            SwapParams({
                zeroForOne: zeroForOne,
                // Negative is exact input. The cast is bounded by the balance check in
                // `buyback`, and a USDG balance cannot reach the int256 ceiling.
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // The delta packs two signed 128-bit amounts into one word, amount0 above amount1.
        int256 delta0 = int256(int128(delta >> 128));
        int256 delta1 = int256(int128(delta));
        // forge-lint: disable-end

        (int256 inDelta, int256 outDelta) = zeroForOne ? (delta0, delta1) : (delta1, delta0);

        // A hook on this pool can rewrite both legs of a swap. Neither side is inferred from
        // what was asked for; both are read back from what the manager says happened.
        if (inDelta >= 0 || outDelta <= 0) revert SwapDirectionWrong(inDelta, outDelta);

        uint256 owed = uint256(-inDelta);
        uint256 received = uint256(outDelta);

        // An exact-input swap that consumed less than it was given hit the price limit, which
        // at the extreme bound means the pool ran out of liquidity underneath the trade. The
        // partial fill would pass the minimum-out check on a much smaller amount and leave the
        // difference sitting here, so the call reverts.
        if (owed != spend) revert SwapConsumedWrongAmount(spend, owed);
        if (received < minOutWei) revert MinimumOutNotMet(received, minOutWei);

        // Settlement is measured by the manager as the change in its own balance since
        // `sync`, so the order of these three calls is the payment.
        poolManager.sync(address(settlementAsset));
        settlementAsset.safeTransfer(address(poolManager), owed);
        uint256 paid = poolManager.settle();
        // A fee-on-transfer settlement asset would credit less than was sent and leave the
        // manager's books open. USDG is not one. A deployment against a token that is should
        // stop here, before the accounting hides it.
        if (paid < owed) revert SettlementShort(paid, owed);

        poolManager.take(address(brsr), address(this), received);

        return abi.encode(owed, received);
    }

    /// Every call restates the ceiling, so every call refreshes its age. A proposal that only
    /// meant to move the spend still has to carry a ceiling somebody is prepared to sign today.
    function setParams(Params calldata params_) external onlyAdmin {
        Params memory current = _params;
        // Rolled against the old duration first. Changing the window length must not hand the
        // current window a reset, which is what applying the new duration to an old start
        // would do for any caller willing to time the proposal.
        Window memory w = _rolled(_window, current.window);
        _window = w;

        _validate(params_);
        _params = params_;
        ceilingSetAt = uint64(block.timestamp);

        emit ParamsUpdated(params_);
    }

    /// Zero leaves nobody able to call `buyback`.
    function setKeeper(address keeper_) external onlyAdmin {
        keeper = keeper_;
        emit KeeperUpdated(keeper_);
    }

    function setMaxCeilingAge(uint64 age) external onlyAdmin {
        if (age < MIN_CEILING_AGE || age > MAX_CEILING_AGE) revert BadParams("maxCeilingAge");
        maxCeilingAge = age;
        emit MaxCeilingAgeUpdated(age);
    }

    /// Returns money to the treasury when the venue is gone, the pool is unusable, or a token
    /// arrived here that has no business being here. The destination is fixed at construction.
    ///
    /// The settlement asset is sweepable: it is the same address the revenue came from, and a
    /// buyback that can never run should not strand the treasury's own money. BRSR is sweepable
    /// for the same reason, and only ever before it has been handed to the staking pool, which
    /// happens inside the same transaction that buys it.
    function sweep(address token, uint256 amount) external onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(treasury, amount);
        emit Swept(token, amount);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(msg.sender, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAuthorized();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    function params() external view returns (Params memory) {
        return _params;
    }

    /// The window as it stands now, rolled forward if its period has elapsed. The stored copy
    /// lags until the next call that touches it.
    function window() external view returns (Window memory) {
        return _rolled(_window, _params.window);
    }

    /// What a buyback would spend if the keeper called it in this block, and zero when one
    /// would be refused. The keeper checks this before paying for a transaction that reverts.
    function available() external view returns (uint256 spendMicroUsd) {
        if (paused() || keeper == address(0)) return 0;
        if (staking.totalShares() == 0) return 0;

        Params memory p = _params;
        if (p.maxPriceMicroUsdPerBrsr == 0) return 0;
        if (block.timestamp > ceilingSetAt + maxCeilingAge) return 0;
        if (lastBuybackAt != 0 && block.timestamp < lastBuybackAt + p.minInterval) return 0;

        Window memory w = _rolled(_window, p.window);
        uint256 headroom =
            w.spentMicroUsd >= p.maxSpendPerWindowMicroUsd ? 0 : p.maxSpendPerWindowMicroUsd - w.spentMicroUsd;
        uint256 balance = settlementAsset.balanceOf(address(this));

        spendMicroUsd = p.spendPerCallMicroUsd;
        if (headroom < spendMicroUsd) spendMicroUsd = headroom;
        if (balance < spendMicroUsd) spendMicroUsd = balance;
        if (spendMicroUsd < p.minSpendMicroUsd) return 0;
    }

    function nextBuybackAt() external view returns (uint64) {
        if (lastBuybackAt == 0) return 0;
        return lastBuybackAt + _params.minInterval;
    }

    /// Advances the start by whole periods, so the elapsed part of the current period stays on
    /// the clock. Snapping to now would let a caller who waits out a window buy a fresh one on
    /// a schedule of their choosing.
    function _rolled(Window memory w, uint64 duration) private view returns (Window memory) {
        uint256 elapsed = block.timestamp - w.start;
        if (elapsed < duration) return w;

        unchecked {
            // forge-lint: disable-next-line(divide-before-multiply)
            w.start += uint64((elapsed / duration) * duration);
        }
        w.spentMicroUsd = 0;

        return w;
    }

    function _validate(Params memory p) private pure {
        if (p.spendPerCallMicroUsd == 0) revert BadParams("spendPerCall");
        if (p.minSpendMicroUsd == 0) revert BadParams("minSpend");
        if (p.minSpendMicroUsd > p.spendPerCallMicroUsd) revert BadParams("minSpend > spendPerCall");
        if (p.spendPerCallMicroUsd > p.maxSpendPerWindowMicroUsd) {
            revert BadParams("spendPerCall > maxSpendPerWindow");
        }
        // Zero is legal and is the safe end of this parameter: it blocks every trade. The upper
        // bound only catches a figure entered in the wrong unit. Everything this contract does
        // to resist being front-run reduces to the number in between being set honestly, and
        // no code here can tell whether it was.
        if (p.maxPriceMicroUsdPerBrsr > MAX_PRICE_MICRO_USD_PER_BRSR) revert BadParams("maxPrice");
        if (p.window == 0) revert BadParams("window");
        if (p.window > MAX_WINDOW) revert BadParams("window > 30 days");
        // A cooldown longer than the window puts the cap out of reach and turns a rate limit
        // into a single buy per period, which is not what either number is meant to say.
        if (p.minInterval > p.window) revert BadParams("minInterval > window");
    }
}
