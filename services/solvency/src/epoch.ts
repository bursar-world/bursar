import type { PublicClient } from 'viem';

import { snapshot, type Reader } from './snapshot.js';
import { buildTree, type SumTree } from './tree.js';

export const EPOCH_SECONDS = 86_400;

/** Blocks held back from the head, so the snapshot never reads a block that could still reorg. */
export const CONFIRMATIONS = 5n;

export const epochOf = (unixSeconds: number): bigint => BigInt(Math.floor(unixSeconds / EPOCH_SECONDS));

export type EpochSnapshot = SumTree & { readonly asOfBlock: bigint };

export async function treeAt(client: Reader, asOfBlock: bigint): Promise<EpochSnapshot> {
  return { ...buildTree(await snapshot(client, asOfBlock)), asOfBlock };
}

export async function latestTree(client: Reader & Pick<PublicClient, 'getBlockNumber'>): Promise<EpochSnapshot> {
  return treeAt(client, (await client.getBlockNumber()) - CONFIRMATIONS);
}
