import { encodeFunctionData, erc20Abi } from 'viem';
import type { Address } from 'viem';

import { requireSigner, type Connection } from './connection.js';
import { sendCall, type Sent } from './send.js';

/**
 * Approves `spender` for exactly `amount` of `token` from the connection's signer, when what the
 * signer already allows it is short. Returns the approval it sent, or nothing when none was needed.
 *
 * `action` is the call the approval is for, so a read-only connection is refused under the name of
 * the call the caller made.
 */
export async function approveIfShort(
  connection: Connection,
  input: { token: Address; spender: Address; amount: bigint; action: string },
): Promise<Sent | undefined> {
  const { account } = requireSigner(connection, input.action);
  const allowance = await connection.publicClient.readContract({
    address: input.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, input.spender],
  });
  if (allowance >= input.amount) return undefined;

  return sendCall(connection, {
    to: input.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [input.spender, input.amount] }),
    action: 'approve',
  });
}
