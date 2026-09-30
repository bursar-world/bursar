import { DEPLOYMENTS, type Deployment } from '@bursar/core';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { buildTree } from '../src/tree.js';
import { snapshot } from '../src/snapshot.js';
import { verifyEpoch } from '../src/verify.js';

const v2 = DEPLOYMENTS['rhc-mainnet-v2'] as Deployment;
const LOG = '0x000000000000000000000000000000000000501f' as Address;
const PAYER = '0x00000000000000000000000000000000000000a1' as Address;
const PAYEE = '0x00000000000000000000000000000000000000b2' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

type Call = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint };

/** A chain with two open locks, one released lock, some fees, and a reward float. */
function fakeChain(overrides: { escrowBalance?: bigint; posted?: { root: `0x${string}`; liabilities: bigint; assets: bigint } } = {}) {
  const locks: Record<string, { status: number; amount: bigint; bond: bigint; payer: Address; payee: Address; disputer: Address }> = {
    '1': { status: 1, amount: 100n, bond: 0n, payer: PAYER, payee: PAYEE, disputer: ZERO },
    '2': { status: 2, amount: 999n, bond: 0n, payer: PAYER, payee: PAYEE, disputer: ZERO },
    '3': { status: 4, amount: 50n, bond: 3n, payer: PAYER, payee: PAYEE, disputer: PAYER },
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

/**
 * A v3 escrow books a payout the token refused as owed to its recipient, and holds that USDG until
 * it is claimed. It keeps no total of those, so they are read per recipient.
 */
describe('snapshot of a v3 escrow', () => {
  const v3: Deployment = {
    ...v2,
    network: 'rhc-mainnet-v3',
    contracts: {
      ...v2.contracts,
      Escrow: '0x3333333333333333333333333333333333333333',
      OracleRegistry: '0x4444444444444444444444444444444444444444',
    },
  };

  it('adds what it owes each party and the registry to its liabilities, and asks each once', async () => {
    const { client } = fakeChain();
    const owed: Record<string, bigint> = { [PAYEE.toLowerCase()]: 40n, [v3.contracts.OracleRegistry.toLowerCase()]: 5n };
    const asked: string[] = [];
    const reader = {
      async readContract(call: Call) {
        if (call.functionName === 'owed') {
          const party = String(call.args![0]).toLowerCase();
          asked.push(party);
          return owed[party] ?? 0n;
        }
        if (call.functionName === 'balanceOf') return 160n;
        return client.readContract(call);
      },
    };

    const [escrow] = await snapshot(reader as never, 1234n, [v3]);
    expect(escrow).toEqual({ id: 'rhc-mainnet-v3:Escrow', liabilities: 7n + 100n + 50n + 3n + 40n + 5n, assets: 160n });
    expect(asked.sort()).toEqual([PAYER, PAYEE, v3.contracts.OracleRegistry].map((a) => a.toLowerCase()).sort());
  });

  it('never asks an earlier escrow what it owes, since it has no such ledger', async () => {
    const { client, calls } = fakeChain();
    await snapshot(client as never, 1234n, [v2]);
    expect(calls.map((call) => call.functionName)).not.toContain('owed');
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

/**
 * Answers every other record's reads with zeros, so the fake chain only has to model v2. Every
 * other record: v1 now, and v3 as well once its record lands.
 */
function onlyV2(client: { readContract(call: Call): Promise<unknown> }) {
  const modelled = new Set([v2.contracts.Escrow, v2.contracts.OracleRegistry, LOG].map((a) => a.toLowerCase()));
  return {
    async readContract(call: Call) {
      if (call.functionName === 'balanceOf') {
        return modelled.has(String(call.args![0]).toLowerCase()) ? client.readContract(call) : 0n;
      }
      if (!modelled.has(call.address.toLowerCase())) return call.functionName === 'nextId' ? 1n : 0n;
      return client.readContract(call);
    },
  } as never;
}
