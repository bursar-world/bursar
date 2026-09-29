import { solvencyLogAbi } from '@bursar/core';
import type { Address, Hex, PublicClient } from 'viem';

import { treeAt } from './epoch.js';
import type { Reader } from './snapshot.js';
import type { Leaf } from './tree.js';

export type Verdict = {
  readonly epoch: bigint;
  readonly asOfBlock: bigint;
  readonly posted: { root: Hex; liabilities: bigint; assets: bigint };
  readonly recomputed: { root: Hex; liabilities: bigint; assets: bigint };
  readonly leaves: readonly Leaf[];
  readonly match: boolean;
  /** Assets cover liabilities in the recomputed tree, leaf by leaf. */
  readonly covered: boolean;
};

/**
 * Rebuilds a posted epoch from public chain data at its `asOfBlock` and compares roots. Needs an
 * archive-capable RPC for old epochs, since it reads state at that block.
 */
export async function verifyEpoch(
  client: Reader & Pick<PublicClient, 'readContract'>,
  log: Address,
  epoch?: bigint,
): Promise<Verdict> {
  const which = epoch ?? BigInt(await client.readContract({ address: log, abi: solvencyLogAbi, functionName: 'latestEpoch' }));
  if (which === 0n) throw new Error('Nothing has been posted to this log yet.');
  const posted = await client.readContract({ address: log, abi: solvencyLogAbi, functionName: 'epochs', args: [which] });
  if (posted.asOfBlock === 0n && posted.postedAt === 0n) throw new Error(`Epoch ${which} was never posted.`);

  const tree = await treeAt(client, posted.asOfBlock);
  return {
    epoch: which,
    asOfBlock: posted.asOfBlock,
    posted: { root: posted.root, liabilities: posted.liabilities, assets: posted.assets },
    recomputed: { root: tree.root, liabilities: tree.liabilities, assets: tree.assets },
    leaves: tree.leaves,
    match:
      tree.root.toLowerCase() === posted.root.toLowerCase() &&
      tree.liabilities === posted.liabilities &&
      tree.assets === posted.assets,
    covered: tree.leaves.every((leaf) => leaf.assets >= leaf.liabilities),
  };
}

const usdg = (micros: bigint) => {
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac}`;
};

export function formatVerdict(v: Verdict): string {
  const lines = [
    `epoch ${v.epoch} at block ${v.asOfBlock}: ${v.match ? 'MATCH' : 'MISMATCH'}`,
    `  posted     ${v.posted.root}  owed ${usdg(v.posted.liabilities)}  held ${usdg(v.posted.assets)} USDG`,
    `  recomputed ${v.recomputed.root}  owed ${usdg(v.recomputed.liabilities)}  held ${usdg(v.recomputed.assets)} USDG`,
    ...v.leaves.map(
      (l) => `  ${l.id.padEnd(32)} owed ${usdg(l.liabilities).padStart(14)}  held ${usdg(l.assets).padStart(14)}  ${l.assets >= l.liabilities ? 'covered' : 'SHORT'}`,
    ),
  ];
  return lines.join('\n');
}
