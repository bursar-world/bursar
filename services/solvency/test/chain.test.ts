import { DEPLOYMENTS, type Deployment } from '@bursar/core';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { buildTree } from '../src/tree.js';
import { snapshot } from '../src/snapshot.js';
import { verifyEpoch } from '../src/verify.js';

const v2 = DEPLOYMENTS['rhc-mainnet-v2'] as Deployment;
const LOG = '0x000000000000000000000000000000000000501f' as Address;

type Call = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint };

/** A chain with two open locks, one released lock, some fees, and a reward float. */
function fakeChain(overrides: { escrowBalance?: bigint; posted?: { root: `0x${string}`; liabilities: bigint; assets: bigint } } = {}) {
  const locks: Record<string, { status: number; amount: bigint; bond: bigint }> = {
    '1': { status: 1, amount: 100n, bond: 0n },
    '2': { status: 2, amount: 999n, bond: 0n },
    '3': { status: 4, amount: 50n, bond: 3n },
  };
  const calls: Call[] = [];
  const client = {
    async readContract(call: Call) {
      calls.push(call);
      const { address, functionName, args } = call;
      if (functionName === 'nextId') return 4n;
      if (functionName === 'feesAccrued') return 7n;
      if (functionName === 'getLock') return locks[String(args![0])];
      if (functionName === 'rewardFloat') return 20n;
      if (functionName === 'balanceOf') return args![0] === v2.contracts.Escrow ? (overrides.escrowBalance ?? 160n) : 25n;
      if (address === LOG && functionName === 'latestEpoch') return 20725n;
      if (address === LOG && functionName === 'epochs') return { ...overrides.posted!, asOfBlock: 1234n, postedAt: 1n };
      throw new Error(`unexpected ${functionName}`);
    },
  };
  return { client, calls };
}

describe('snapshot', () => {
  it('counts open and disputed locks with their bonds, plus fees, at the given block', async () => {
    const { client, calls } = fakeChain();
    const leaves = await snapshot(client as never, 1234n, [v2]);
    expect(leaves).toEqual([
      { id: 'rhc-mainnet-v2:Escrow', liabilities: 7n + 100n + 50n + 3n, assets: 160n },
      { id: 'rhc-mainnet-v2:OracleRegistry', liabilities: 20n, assets: 25n },
    ]);
    expect(calls.every((c) => c.blockNumber === 1234n)).toBe(true);
  });
});

describe('verifyEpoch', () => {
  it('matches a root rebuilt from the same state', async () => {
    const tree = buildTree(await snapshot(onlyV2(fakeChain().client), 1234n));
    const { client } = fakeChain({ posted: { root: tree.root, liabilities: tree.liabilities, assets: tree.assets } });
    const verdict = await verifyEpoch(onlyV2(client), LOG);
    expect(verdict.epoch).toBe(20725n);
    expect(verdict.match).toBe(true);
    expect(verdict.covered).toBe(true);
  });

  it('reports a mismatch when the chain disagrees with the posted root', async () => {
    const tree = buildTree(await snapshot(onlyV2(fakeChain().client), 1234n));
    const { client } = fakeChain({
      escrowBalance: 100n,
      posted: { root: tree.root, liabilities: tree.liabilities, assets: tree.assets },
    });
    const verdict = await verifyEpoch(onlyV2(client), LOG, 20725n);
    expect(verdict.match).toBe(false);
    expect(verdict.covered).toBe(false);
  });
});

/** Answers the v1 record's reads with zeros, so the fake chain only has to model v2. */
function onlyV2(client: { readContract(call: Call): Promise<unknown> }) {
  const v1 = DEPLOYMENTS['rhc-mainnet'] as Deployment;
  const v1Addresses = new Set([v1.contracts.Escrow, v1.contracts.OracleRegistry].map((a) => a.toLowerCase()));
  return {
    async readContract(call: Call) {
      if (v1Addresses.has(call.address.toLowerCase())) return call.functionName === 'nextId' ? 1n : 0n;
      if (call.functionName === 'balanceOf' && v1Addresses.has(String(call.args![0]).toLowerCase())) return 0n;
      return client.readContract(call);
    },
  } as never;
}
