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
    // Once the hash exists the call may have landed, whatever went wrong reading it back: a timeout,
    // or every endpoint failing at once. Rethrown raw, either reads as a failure, and a caller that
    // retries a payment pays twice.
    throw new SubmittedButUnconfirmedError(hash, connection.receiptTimeoutMs, error);
  }

  if (receipt.status !== 'success') throw new TransactionRevertedError(action, hash);

  return receipt;
}
