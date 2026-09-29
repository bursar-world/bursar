import { solvencyLogAbi } from '@bursar/core';
import type { Account, Address, Chain, Hex, PublicClient, WalletClient } from 'viem';

import { epochOf, latestTree, type EpochSnapshot } from './epoch.js';

export type PostResult = EpochSnapshot & { readonly epoch: bigint; readonly hash?: Hex };

/**
 * Snapshots at the confirmed head and posts the root for today's epoch. The log refuses an epoch
 * at or below the latest one, so a second run on the same day is reported and skipped.
 */
export async function postEpoch(args: {
  client: PublicClient;
  wallet?: WalletClient;
  account?: Account;
  chain?: Chain;
  log: Address;
  now?: number;
}): Promise<PostResult & { skipped?: string }> {
  const epoch = epochOf(args.now ?? Date.now() / 1000);
  const tree = await latestTree(args.client);
  if (!args.wallet || !args.account) return { ...tree, epoch };

  const latest = await args.client.readContract({ address: args.log, abi: solvencyLogAbi, functionName: 'latestEpoch' });
  if (BigInt(latest) >= epoch) return { ...tree, epoch, skipped: `epoch ${epoch} is already posted` };

  const { request } = await args.client.simulateContract({
    address: args.log,
    abi: solvencyLogAbi,
    functionName: 'post',
    args: [epoch, tree.asOfBlock, tree.root, tree.liabilities, tree.assets],
    account: args.account,
    chain: args.chain,
  });
  const hash = await args.wallet.writeContract(request);
  const receipt = await args.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`post ${hash} reverted`);
  return { ...tree, epoch, hash };
}
