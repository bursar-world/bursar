// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Derived from PrivacyPoolComplex in 0xbow privacy-pools-core v1.3.0 (Apache-2.0, see
// contracts/vendor/privacy-pools-core/LICENSE and NOTICE). The deposit, withdrawal, ragequit and
// state logic is the unmodified upstream PrivacyPool; this file only supplies the ERC-20 transfer
// hooks, with three additions: a per-deposit cap, a pool-wide cap, and the Robinhood access
// registry, whose blocked addresses may neither deposit into nor be paid from the pool.

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

    /// What the pool owes its notes: every deposit in, less every payout.
    uint256 public poolValue;

    error DepositAboveCap(uint256 value, uint256 cap);
    error PoolCapReached(uint256 valueAfter, uint256 cap);
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
        uint256 maxTotal
    ) PrivacyPool(entrypoint, withdrawalVerifier, ragequitVerifier, asset) {
        if (address(accessRegistry) == address(0)) revert ZeroAddress();
        if (maxDeposit == 0 || maxTotal < maxDeposit) revert InvalidDepositValue();
        ACCESS_REGISTRY = accessRegistry;
        MAX_DEPOSIT = maxDeposit;
        MAX_TOTAL = maxTotal;
    }

    function _pull(address sender, uint256 amount) internal override(PrivacyPool) {
        if (msg.value != 0) revert NativeAssetNotAccepted();
        // `deposit` has already recorded the depositor under this deposit's label.
        address depositor =
            depositors[uint256(keccak256(abi.encodePacked(SCOPE, nonce))) % Constants.SNARK_SCALAR_FIELD];
        if (ACCESS_REGISTRY.isBlocked(depositor)) revert DepositorBlocked(depositor);
        if (amount > MAX_DEPOSIT) revert DepositAboveCap(amount, MAX_DEPOSIT);
        uint256 valueAfter = poolValue + amount;
        if (valueAfter > MAX_TOTAL) revert PoolCapReached(valueAfter, MAX_TOTAL);
        poolValue = valueAfter;
        // `sender` is the Entrypoint, the only caller `deposit` admits, pulling what it approved.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(ASSET).safeTransferFrom(sender, address(this), amount);
    }

    function _push(address recipient, uint256 amount) internal override(PrivacyPool) {
        if (recipient == address(ENTRYPOINT)) revert RelayThroughShieldedRelay();
        if (ACCESS_REGISTRY.isBlocked(recipient)) revert RecipientBlocked(recipient);
        poolValue -= amount;
        IERC20(ASSET).safeTransfer(recipient, amount);
    }
}
