import { shieldedEntrypointAbi } from '@bursar/sdk';
import { BaseError, ContractFunctionRevertedError, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from 'viem';

import type { PublishedSet } from './set.js';

export type PostOutcome =
  | { readonly action: 'posted'; readonly hash: Hex; readonly root: string; readonly cid: string }
  | { readonly action: 'skipped'; readonly reason: string; readonly root: string };

/**
 * The shortest gap between two posts. Each post turns away every withdrawal proved against the
 * root before it, so posting on each deposit would keep proofs failing while deposits arrive. A
 * fixed window batches every deposit that lands inside it into the next post.
 */
export const POST_CADENCE_SECONDS = 600n;

/** The root the Entrypoint holds now, or null before the first post. */
export async function latestRoot(client: Pick<PublicClient, 'readContract'>, entrypoint: Address): Promise<bigint | null> {
  try {
    return await client.readContract({ address: entrypoint, abi: shieldedEntrypointAbi, functionName: 'latestRoot' });
  } catch (error) {
    const revert = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'NoRootsAvailable') return null;
    throw error;
  }
}

/**
 * When the Entrypoint took its newest root, in seconds, or null before the first post. The sets are
 * an array with no length getter, so this walks the indices out and back, a few dozen reads at most.
 */
export async function lastPostedAt(client: Pick<PublicClient, 'readContract'>, entrypoint: Address): Promise<bigint | null> {
  const at = async (index: bigint): Promise<bigint | null> => {
    try {
      const [, , timestamp] = await client.readContract({ address: entrypoint, abi: shieldedEntrypointAbi, functionName: 'associationSets', args: [index] });
      return timestamp;
    } catch (error) {
      if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError)) return null;
      throw error;
    }
  };
  if ((await at(0n)) === null) return null;
  let low = 0n;
  let high = 1n;
  while ((await at(high)) !== null) {
    low = high;
    high *= 2n;
  }
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if ((await at(mid)) === null) high = mid;
    else low = mid;
  }
  return at(low);
}

/**
 * Posts the set's root when it differs from the one on chain. Every post invalidates proofs made
 * against the previous root (the pool only accepts the latest), so an unchanged set is never
 * reposted, and with `window` a changed one waits until the last post is a cadence old.
 */
export async function syncRoot(args: {
  client: Pick<PublicClient, 'readContract' | 'simulateContract' | 'waitForTransactionReceipt'>;
  wallet?: WalletClient;
  chain: Chain;
  entrypoint: Address;
  set: PublishedSet;
  window?: { readonly now: bigint; readonly notBefore: bigint };
}): Promise<PostOutcome> {
  const { set } = args;
  if (set.labels.length === 0) return { action: 'skipped', reason: 'no admissible deposits yet', root: set.root };
  const current = await latestRoot(args.client, args.entrypoint);
  if (current !== null && current.toString() === set.root) {
    return { action: 'skipped', reason: 'the chain already holds this root', root: set.root };
  }
  if (args.window && args.window.now < args.window.notBefore) {
    const due = new Date(Number(args.window.notBefore) * 1000).toISOString();
    return { action: 'skipped', reason: `batching deposits until the next post window at ${due}`, root: set.root };
  }
  if (!args.wallet?.account) return { action: 'skipped', reason: 'dry run', root: set.root };

  const { request } = await args.client.simulateContract({
    account: args.wallet.account,
    chain: args.chain,
    address: args.entrypoint,
    abi: shieldedEntrypointAbi,
    functionName: 'updateRoot',
    args: [BigInt(set.root), set.cid],
  });
  const hash = await args.wallet.writeContract(request);
  const receipt = await args.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`updateRoot ${hash} reverted.`);
  return { action: 'posted', hash, root: set.root, cid: set.cid };
}

/**
 * Keeps posts at least `cadence` seconds apart across calls: the first changed set after a window
 * opens is posted, and everything that changes inside the window rides on the next one. Seeded with
 * the chain's own last post, so a restart does not open a window early.
 */
export function cadencedPoster(args: {
  readonly client: Pick<PublicClient, 'readContract' | 'simulateContract' | 'waitForTransactionReceipt'>;
  readonly wallet?: WalletClient;
  readonly chain: Chain;
  readonly entrypoint: Address;
  readonly lastPostedAt: bigint | null;
  readonly now: () => bigint;
  readonly cadence?: bigint;
}) {
  const cadence = args.cadence ?? POST_CADENCE_SECONDS;
  let last = args.lastPostedAt;
  return {
    async sync(set: PublishedSet): Promise<PostOutcome> {
      const now = args.now();
      const outcome = await syncRoot({ ...args, set, window: { now, notBefore: last === null ? 0n : last + cadence } });
      if (outcome.action === 'posted') last = now;
      return outcome;
    },
  };
}
