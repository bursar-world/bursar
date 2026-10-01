// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Derived from PrivacyPoolComplex in 0xbow privacy-pools-core v1.3.0 (Apache-2.0, see
// contracts/vendor/privacy-pools-core/LICENSE and NOTICE). The deposit, withdrawal, ragequit and
// state logic is the unmodified upstream PrivacyPool; this file only supplies the ERC-20 transfer
// hooks, with four additions: a per-deposit cap, a per-depositor cap per window, a pool-wide cap,
// and the Robinhood access registry, whose blocked addresses may not deposit and are paid out no
// more than they put in.

import {Constants} from "../../vendor/privacy-pools-core/src/contracts/lib/Constants.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PrivacyPool} from "../../vendor/privacy-pools-core/src/contracts/PrivacyPool.sol";
import {IPrivacyPoolComplex} from "../../vendor/privacy-pools-core/src/interfaces/IPrivacyPool.sol";

import {IAccessRegistry} from "./IAccessRegistry.sol";

/// A Privacy Pools pool for one ERC-20, with launch caps and the access-registry check.
///
/// Every outbound transfer goes through `_push`, which runs inside `withdraw` and `ragequit`
/// after the proof checks and before anything is returned. A refusal there reverts the whole
/// call, so a blocked recipient never burns a nullifier and the note stays spendable.
///
/// The pool-wide cap counts what the pool owes its notes, tracked here on every deposit and
/// payout, not the token balance: a transfer sent to the pool outside a deposit belongs to no
/// note, and counting it would let anyone fill the cap and shut deposits out.
///
/// The pool-wide cap is room every depositor shares, so each depositor also has a cap of its own:
/// `MAX_PER_DEPOSITOR` in any one window of `DEPOSITOR_WINDOW`. A window opens at the first
/// deposit after the previous one has run out and runs for `DEPOSITOR_WINDOW` from that moment.
/// It is anchored at a deposit rather than advanced in whole periods from the first one ever, the
/// way the mandate windows roll. There the agent that spends is not the principal who set the cap,
/// so a boundary it cannot move matters; here the depositor sets both clocks and gains nothing by
/// moving one. A window that opened at a deposit is also the one the console can explain: it
/// resets at that deposit plus the window. The cap counts what went in and payouts do not refund
/// it, so churning a position buys no room.
///
/// A blocked address is still paid what it put in, and nothing more. The pool keeps, per address,
/// what it has deposited over the pool's life and what it has been paid while blocked, and `_push`
/// lets the second run up to the first. An address listed after it deposited can still ragequit
/// or withdraw straight to itself; one that never deposited is paid nothing. The allowance counts
/// what the address brought in, not which notes pay it out, so it also bounds what anyone else's
/// note can pay a blocked address.
///
/// Withdrawals relayed through the upstream Entrypoint are refused outright: the Entrypoint
/// pays the final recipient itself, after the pool has pushed to it, so the pool could not
/// screen that recipient. Relayed withdrawals go through `ShieldedRelay`, which screens the
/// recipient before it calls `withdraw`.
contract ShieldedPool is PrivacyPool, IPrivacyPoolComplex {
    using SafeERC20 for IERC20;

    /// The access registry whose `isBlocked` gates deposits into the pool and payments out of it.
    IAccessRegistry public immutable ACCESS_REGISTRY;
    /// The largest single deposit, after the Entrypoint's vetting fee.
    uint256 public immutable MAX_DEPOSIT;
    /// The most the pool may owe its notes at once.
    uint256 public immutable MAX_TOTAL;
    /// The most one depositor may put in during one window.
    uint128 public immutable MAX_PER_DEPOSITOR;
    /// How long a depositor's window runs from the deposit that opened it.
    uint64 public immutable DEPOSITOR_WINDOW;

    struct DepositWindow {
        uint128 deposited;
        uint64 start;
    }

    /// What the pool owes its notes: every deposit in, less every payout.
    uint256 public poolValue;

    /// Each depositor's window as last written. Read through `_rolled`, which reports a window
    /// that has run out as empty; the stored copy catches up on the next deposit.
    mapping(address depositor => DepositWindow window) private _windows;

    /// What each address has deposited over the pool's life, after the vetting fee.
    mapping(address depositor => uint256 amount) public depositedBy;
    /// What each address has been paid while the registry listed it. Never above `depositedBy`.
    mapping(address recipient => uint256 amount) public paidWhileBlocked;

    error DepositAboveCap(uint256 value, uint256 cap);
    error DepositorCapReached(address depositor, uint256 depositedAfter, uint256 cap);
    error PoolCapReached(uint256 valueAfter, uint256 cap);
    error BadWindow();
    error DepositorBlocked(address depositor);
    error RecipientBlocked(address recipient);
    error RelayThroughShieldedRelay();

    constructor(
        address entrypoint,
        address withdrawalVerifier,
        address ragequitVerifier,
        address asset,
        IAccessRegistry accessRegistry,
        uint256 maxDeposit,
        uint256 maxTotal,
        uint128 maxPerDepositor,
        uint64 depositorWindow
    ) PrivacyPool(entrypoint, withdrawalVerifier, ragequitVerifier, asset) {
        if (address(accessRegistry) == address(0)) revert ZeroAddress();
        if (maxDeposit == 0 || maxTotal < maxDeposit) revert InvalidDepositValue();
        // A depositor cap under the deposit cap would refuse a deposit the deposit cap allows, and
        // one over the pool cap would promise room the pool does not have.
        if (maxPerDepositor < maxDeposit || maxPerDepositor > maxTotal) revert InvalidDepositValue();
        if (depositorWindow == 0) revert BadWindow();
        ACCESS_REGISTRY = accessRegistry;
        MAX_DEPOSIT = maxDeposit;
        MAX_TOTAL = maxTotal;
        MAX_PER_DEPOSITOR = maxPerDepositor;
        DEPOSITOR_WINDOW = depositorWindow;
    }

    /// What `depositor` may still put in before its window fills, after the vetting fee.
    function depositRoom(address depositor) external view returns (uint256) {
        return MAX_PER_DEPOSITOR - _rolled(_windows[depositor]).deposited;
    }

    /// When `depositor`'s window runs out and its room is back to `MAX_PER_DEPOSITOR`. Zero while
    /// no window is open, which is when the full room is already there.
    function windowResetsAt(address depositor) external view returns (uint256) {
        DepositWindow memory w = _rolled(_windows[depositor]);
        return w.deposited == 0 ? 0 : uint256(w.start) + DEPOSITOR_WINDOW;
    }

    function _pull(address sender, uint256 amount) internal override(PrivacyPool) {
        if (msg.value != 0) revert NativeAssetNotAccepted();
        // `deposit` has already recorded the depositor under this deposit's label.
        address depositor =
            depositors[uint256(keccak256(abi.encodePacked(SCOPE, nonce))) % Constants.SNARK_SCALAR_FIELD];
        if (ACCESS_REGISTRY.isBlocked(depositor)) revert DepositorBlocked(depositor);
        if (amount > MAX_DEPOSIT) revert DepositAboveCap(amount, MAX_DEPOSIT);
        DepositWindow memory w = _rolled(_windows[depositor]);
        uint256 depositedAfter = w.deposited + amount;
        if (depositedAfter > MAX_PER_DEPOSITOR) {
            revert DepositorCapReached(depositor, depositedAfter, MAX_PER_DEPOSITOR);
        }
        uint256 valueAfter = poolValue + amount;
        if (valueAfter > MAX_TOTAL) revert PoolCapReached(valueAfter, MAX_TOTAL);
        // Within the cap, so within uint128.
        w.deposited = uint128(depositedAfter);
        _windows[depositor] = w;
        depositedBy[depositor] += amount;
        poolValue = valueAfter;
        // `sender` is the Entrypoint, the only caller `deposit` admits, pulling what it approved.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(ASSET).safeTransferFrom(sender, address(this), amount);
    }

    function _push(address recipient, uint256 amount) internal override(PrivacyPool) {
        if (recipient == address(ENTRYPOINT)) revert RelayThroughShieldedRelay();
        if (ACCESS_REGISTRY.isBlocked(recipient)) {
            // Own money only: what has been paid out while blocked may reach what was deposited
            // and no further, whichever notes the payouts come from.
            uint256 paidAfter = paidWhileBlocked[recipient] + amount;
            if (paidAfter > depositedBy[recipient]) revert RecipientBlocked(recipient);
            paidWhileBlocked[recipient] = paidAfter;
        }
        poolValue -= amount;
        IERC20(ASSET).safeTransfer(recipient, amount);
    }

    /// The window as it stands now: untouched while it runs, empty and ready to open at this
    /// block once it has run out or never held a deposit.
    function _rolled(DepositWindow memory w) private view returns (DepositWindow memory) {
        if (w.deposited != 0 && block.timestamp - w.start < DEPOSITOR_WINDOW) return w;
        w.deposited = 0;
        w.start = uint64(block.timestamp);
        return w;
    }
}
