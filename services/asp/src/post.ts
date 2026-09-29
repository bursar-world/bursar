import { shieldedEntrypointAbi } from '@bursar/sdk';
import { BaseError, ContractFunctionRevertedError, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from 'viem';

import type { PublishedSet } from './set.js';

export type PostOutcome =
  | { readonly action: 'posted'; readonly hash: Hex; readonly root: string; readonly cid: string }
  | { readonly action: 'skipped'; readonly reason: string; readonly root: string };

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
 * Posts the set's root when it differs from the one on chain. Every post invalidates proofs made
 * against the previous root (the pool only accepts the latest), so an unchanged set is never
 * reposted.
 */
export async function syncRoot(args: {
  client: Pick<PublicClient, 'readContract' | 'simulateContract' | 'waitForTransactionReceipt'>;
  wallet?: WalletClient;
  chain: Chain;
  entrypoint: Address;
  set: PublishedSet;
}): Promise<PostOutcome> {
  const { set } = args;
  if (set.labels.length === 0) return { action: 'skipped', reason: 'no admissible deposits yet', root: set.root };
  const current = await latestRoot(args.client, args.entrypoint);
  if (current !== null && current.toString() === set.root) {
    return { action: 'skipped', reason: 'the chain already holds this root', root: set.root };
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
