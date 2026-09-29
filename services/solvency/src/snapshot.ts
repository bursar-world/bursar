import {
  V1_ABIS,
  V2_ABIS,
  contractSetOf,
  deploymentsForChain,
  settlementAssetAbi,
  type Deployment,
} from '@bursar/core';
import type { Address, PublicClient } from 'viem';

import type { Leaf } from './tree.js';

/** `LockStatus.Locked` and `LockStatus.Disputed`: the only states in which the escrow still holds a lock's money. */
const LOCKED = 1;
const DISPUTED = 4;

export type Reader = Pick<PublicClient, 'readContract'>;

/**
 * Reads every leaf at one block, from public state only.
 *
 * Per escrow: liabilities are the amount and dispute bond of every open lock (Locked or Disputed)
 * plus the fees booked and not yet swept; assets are its USDG balance. Per oracle registry:
 * liabilities are the reward float owed to resolvers; assets are its USDG balance. A released lock
 * has already paid its payee, so it is not owed.
 *
 * Not included: the treasury lane and stock purchases. Those positions sit in per-mandate vaults as
 * SGOV or stock tokens owned by the mandate, not in a pool the protocol owes out of, and valuing
 * them needs a feed price rather than an exact balance. Bonds in BRSR on the staking pool are a
 * different token and are also left out.
 */
export async function snapshot(
  client: Reader,
  blockNumber: bigint,
  deployments: readonly Deployment[] = deploymentsForChain(4663),
): Promise<Leaf[]> {
  const leaves: Leaf[] = [];
  for (const d of deployments) {
    const abis = contractSetOf(d) === 'v1' ? V1_ABIS : V2_ABIS;
    const usdg = (holder: Address) =>
      client.readContract({
        address: d.settlementAsset,
        abi: settlementAssetAbi,
        functionName: 'balanceOf',
        args: [holder],
        blockNumber,
      }) as Promise<bigint>;

    const escrow = d.contracts.Escrow;
    const read = (functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: escrow, abi: abis.Escrow, functionName, args, blockNumber } as never) as Promise<unknown>;

    const nextId = (await read('nextId')) as bigint;
    let owed = (await read('feesAccrued')) as bigint;
    for (let id = 1n; id < nextId; id++) {
      const lock = (await read('getLock', [id])) as { status: number; amount: bigint; bond: bigint };
      if (lock.status === LOCKED || lock.status === DISPUTED) owed += lock.amount + lock.bond;
    }
    leaves.push({ id: `${d.network}:Escrow`, liabilities: owed, assets: await usdg(escrow) });

    const registry = d.contracts.OracleRegistry;
    const rewardFloat = (await client.readContract({
      address: registry,
      abi: abis.OracleRegistry,
      functionName: 'rewardFloat',
      blockNumber,
    } as never)) as bigint;
    leaves.push({ id: `${d.network}:OracleRegistry`, liabilities: rewardFloat, assets: await usdg(registry) });
  }
  return leaves;
}
