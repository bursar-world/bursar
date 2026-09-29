import {
  associationSetCid,
  blockedDepositors,
  buildAssociationSet,
  fetchPoolEvents,
  type AssociationSet,
} from '@bursar/sdk';
import type { Address, PublicClient } from 'viem';

export type Pool = {
  readonly chainId: number;
  readonly pool: Address;
  readonly scope: bigint;
  readonly registry: Address;
  readonly fromBlock: bigint;
};

export type PublishedSet = AssociationSet & { readonly cid: string };

/**
 * The association set as of `toBlock`: every deposit, screened against the access registry as it
 * reads now. A depositor blocked after depositing drops out of the next set, so its note can
 * only leave by ragequit, and the pool refuses that too while the block stands.
 */
export async function computeSet(
  client: Pick<PublicClient, 'getLogs' | 'getBlockNumber' | 'readContract'>,
  pool: Pool,
  toBlock?: bigint,
): Promise<PublishedSet> {
  const events = await fetchPoolEvents(client, { pool: pool.pool, fromBlock: pool.fromBlock, toBlock });
  const blocked = await blockedDepositors(
    client,
    events.deposits.map((d) => d.depositor),
    pool.registry,
  );
  const set = buildAssociationSet({
    chainId: pool.chainId,
    pool: pool.pool,
    scope: pool.scope,
    deposits: events.deposits,
    blocked,
    throughBlock: events.toBlock,
  });
  return { ...set, cid: associationSetCid(set) };
}
