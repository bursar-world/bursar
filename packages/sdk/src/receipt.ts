import { isAddressEqual } from 'viem';
import type { Address, Hex, Log, TransactionReceipt } from 'viem';

import type { Connection } from './connection.js';
import { SubmittedButUnconfirmedError, TransactionRevertedError } from './errors.js';
import { checkAddress } from './guards.js';

/** Keeps a log emitted by an unrelated contract in the same transaction out of a match. */
export function logsFrom(logs: readonly Log[], emitter: Address): Log[] {
  const address = checkAddress('emitter', emitter);

  return logs.filter((log) => isAddressEqual(log.address, address));
}

/**
 * Waits for the receipt of a write and accepts nothing but a mined success. viem resolves
 * reverted receipts as ordinary results, so without this check a transaction that failed on
 * chain reads as one that worked.
 */
export async function awaitReceipt(
  connection: Connection,
  hash: Hex,
  action: string,
): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;

  try {
    receipt = await connection.publicClient.waitForTransactionReceipt({
      hash,
      timeout: connection.receiptTimeoutMs,
    });
  } catch (error) {
    // Matched by name, not by class. `instanceof` is only true for the copy of viem that
    // threw, and a workspace resolving two copies is ordinary; against the wrong copy the timeout
    // would be rethrown raw and the caller would lose the one error that says do not resend.
    if (error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError') {
      throw new SubmittedButUnconfirmedError(hash, connection.receiptTimeoutMs, error);
    }

    throw error;
  }

  if (receipt.status !== 'success') throw new TransactionRevertedError(action, hash);

  return receipt;
}
