// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ProofLib} from "../../vendor/privacy-pools-core/src/contracts/lib/ProofLib.sol";
import {IEntrypoint} from "../../vendor/privacy-pools-core/src/interfaces/IEntrypoint.sol";
import {IPrivacyPool} from "../../vendor/privacy-pools-core/src/interfaces/IPrivacyPool.sol";

import {IAccessRegistry} from "./IAccessRegistry.sol";

/// @title ShieldedRelay
/// @notice Lets anyone submit a withdrawal from the shielded pool on the note owner's behalf, so
///         the transaction, its gas and any gas sent along to the recipient come from the relayer
///         rather than from a wallet the owner has used before.
/// @dev The withdrawal names this contract as `processooor`, and its `data` is the upstream
///      `IEntrypoint.RelayData` (recipient, fee recipient, fee in basis points). Both are bound into
///      the proof's context, so a relayer cannot redirect the funds or raise its fee.
///
///      Both addresses are screened against the access registry before the pool is called, and
///      neither may be this contract, the pool or the Entrypoint, where a payout would sit with no
///      note behind it. A refusal reverts before `withdraw` runs, so no nullifier is spent.
///
///      Any ETH sent with the call is forwarded to the recipient in the same transaction. That is how
///      a fresh stealth address gets its first gas without a transfer from the owner's wallet.
contract ShieldedRelay is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ProofLib for ProofLib.WithdrawProof;

    IPrivacyPool public immutable POOL;
    IERC20 public immutable ASSET;
    address public immutable ENTRYPOINT;
    IAccessRegistry public immutable ACCESS_REGISTRY;
    /// @notice The highest fee a withdrawal may grant its relayer. This is the ceiling that binds:
    ///         the Entrypoint's `maxRelayFeeBPS` applies only to `Entrypoint.relay`, which the pool
    ///         refuses.
    uint256 public immutable MAX_FEE_BPS;

    event Relayed(address indexed relayer, address indexed recipient, uint256 amount, uint256 fee, uint256 gasDrop);

    error ZeroAddress();
    error InvalidProcessooor();
    error InvalidWithdrawalAmount();
    error InvalidRecipient(address recipient);
    error FeeAboveMax(uint256 feeBps, uint256 maxFeeBps);
    error RecipientBlocked(address recipient);
    error GasDropFailed();

    constructor(IPrivacyPool pool, IAccessRegistry accessRegistry, uint256 maxFeeBps) {
        if (address(pool) == address(0) || address(accessRegistry) == address(0)) revert ZeroAddress();
        if (maxFeeBps >= 10_000) revert FeeAboveMax(maxFeeBps, 9_999);
        POOL = pool;
        ASSET = IERC20(pool.ASSET());
        ENTRYPOINT = address(pool.ENTRYPOINT());
        ACCESS_REGISTRY = accessRegistry;
        MAX_FEE_BPS = maxFeeBps;
    }

    /// @notice Withdraws a note to the recipient named in `withdrawal.data`, pays the relayer's fee,
    ///         and forwards `msg.value` to the recipient as gas.
    function relay(IPrivacyPool.Withdrawal calldata withdrawal, ProofLib.WithdrawProof calldata proof)
        external
        payable
        nonReentrant
    {
        if (withdrawal.processooor != address(this)) revert InvalidProcessooor();
        uint256 amount = proof.withdrawnValue();
        if (amount == 0) revert InvalidWithdrawalAmount();

        IEntrypoint.RelayData memory data = abi.decode(withdrawal.data, (IEntrypoint.RelayData));
        if (data.relayFeeBPS > MAX_FEE_BPS) revert FeeAboveMax(data.relayFeeBPS, MAX_FEE_BPS);
        _screen(data.recipient);
        _screen(data.feeRecipient);

        POOL.withdraw(withdrawal, proof);

        uint256 fee = (amount * data.relayFeeBPS) / 10_000;
        ASSET.safeTransfer(data.recipient, amount - fee);
        if (fee != 0) ASSET.safeTransfer(data.feeRecipient, fee);

        if (msg.value != 0) {
            // The caller's own ETH, to the recipient the proof binds, as the last step under the guard.
            // forge-lint: disable-next-line(arbitrary-send-eth, reentrancy-eth)
            (bool ok,) = data.recipient.call{value: msg.value}("");
            if (!ok) revert GasDropFailed();
        }

        emit Relayed(msg.sender, data.recipient, amount, fee, msg.value);
    }

    function _screen(address payee) private view {
        if (payee == address(0)) revert ZeroAddress();
        if (payee == address(this) || payee == address(POOL) || payee == ENTRYPOINT) revert InvalidRecipient(payee);
        if (ACCESS_REGISTRY.isBlocked(payee)) revert RecipientBlocked(payee);
    }
}
