import { LockStatus } from '@bursar/sdk';
import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';

/**
 * Chain 4663 once v3 lands on top of v2 and v1. The v3 set answers for the chain and is the only
 * one written to; v2 and v1 stay readable for what they still hold. The v3 record is made up, so
 * this holds before the real one exists and after.
 */
const V3 = {
  escrow: '0x3333333333333333333333333333333333333333',
  oracleRegistry: '0x4444444444444444444444444444444444444444',
} as const;
const V2 = {
  escrow: '0x4315F8be7C9661345710910577Ec31cb867f3c20',
  oracleRegistry: '0xE38349668f0C470C814487E95C14e7652F713B17',
} as const;
const V1 = {
  escrow: '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4',
  oracleRegistry: '0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF',
} as const;

const PAYEE = '0x9999999999999999999999999999999999999999' as Address;
const PAYER = '0x8888888888888888888888888888888888888888' as Address;
const MANDATE = '0x7777777777777777777777777777777777777777' as Address;
const NOW = 1_790_600_000n;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

vi.mock('@bursar/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@bursar/core')>();
  const { v3Record, withRecords } = await import('./support/address-book');
  // Its escrow and registry are the ones V3 names below.
  return withRecords(core, [
    v3Record(core),
    core.deployment('rhc-mainnet-v2' as never),
    core.deployment('rhc-mainnet' as never),
  ]);
});

const CONFIG = {
  commitWindow: 600n,
  revealWindow: 600n,
  unbondingPeriod: 604_800n,
  quorum: 1,
  maxVoters: 64,
  maxDeviation: 20,
  slashBps: 1_000,
};

function dispute(escrowId: bigint, openedAt: bigint, status: number) {
  return {
    escrowId,
    openedAt,
    commitEndsAt: openedAt + 600n,
    revealEndsAt: openedAt + 1_200n,
    commitCount: 0,
    revealCount: 0,
    medianScore: 0,
    refundBps: 0,
    rewardShares: 0,
    status,
  };
}

function lock(status: number, payee: Address = PAYEE) {
  return {
    payer: PAYER,
    payee,
    disputer: PAYER,
    capabilityId: ZERO_HASH,
    inputCommit: ZERO_HASH,
    outputCommit: ZERO_HASH,
    inputURI: '',
    outputURI: '',
    amount: 100_000n,
    deadline: NOW + 3_600n,
    releasedAt: 0n,
    bond: 5_000n,
    disputedAt: status === LockStatus.Disputed ? NOW - 300n : 0n,
    status,
    counted: false,
  };
}

const ESCROW_TERMS = { resolverFeeBps: 50, feeBps: 200, disputeWindow: 86_400n };

/** What each contract answers, keyed by lowercased address, then function, then first argument. */
const CHAIN: Record<string, Record<string, unknown>> = {
  [V3.oracleRegistry.toLowerCase()]: { config: CONFIG, nextDisputeId: 1n },
  [V3.escrow.toLowerCase()]: {
    ...ESCROW_TERMS,
    nextId: 2n,
    minLock: 10_000n,
    [`owed:${PAYEE}`]: 2_500n,
    [`owed:${MANDATE}`]: 1_250n,
    'getLock:1': lock(LockStatus.Locked),
  },
  [V2.oracleRegistry.toLowerCase()]: { config: { ...CONFIG, maxVoters: 5 }, nextDisputeId: 1n },
  [V2.escrow.toLowerCase()]: { ...ESCROW_TERMS, nextId: 2n, 'getLock:1': lock(LockStatus.Locked) },
  [V1.oracleRegistry.toLowerCase()]: {
    config: { ...CONFIG, maxVoters: 5 },
    nextDisputeId: 2n,
    'getDispute:1': dispute(4n, NOW - 300n, 1),
    'disputeIdOf:4': 1n,
  },
  [V1.escrow.toLowerCase()]: { ...ESCROW_TERMS, nextId: 5n, 'getLock:4': lock(LockStatus.Disputed) },
};

/** Every call the batches made, so a test can say which contract was asked what. */
const asked: { address: string; functionName: string }[] = [];

vi.mock('@/chain/client', () => ({ rhcClient: () => ({}), rhcPool: () => undefined, probeProviders: vi.fn(), onPoolEvent: vi.fn() }));

vi.mock('@/chain/batch', async (original) => {
  const actual = await original<typeof import('@/chain/batch')>();
  return {
    ...actual,
    runBatch: async (_client: unknown, batch: InstanceType<typeof actual.ReadBatch>) =>
      new actual.BatchResults(
        batch.calls.map((call) => {
          asked.push({ address: call.address.toLowerCase(), functionName: call.functionName });
          if (call.functionName === 'getCurrentBlockTimestamp') return { status: 'success', result: NOW };
          if (call.functionName === 'arbBlockNumber') return { status: 'success', result: 1_000n };
          const contract = CHAIN[call.address.toLowerCase()];
          const arg = call.args?.[0];
          const key = arg === undefined ? call.functionName : `${call.functionName}:${String(arg)}`;
          if (contract === undefined || !(key in contract)) {
            if (call.functionName === 'getLock') return { status: 'success', result: { ...lock(LockStatus.None), payee: PAYER } };
            return { status: 'failure', error: new Error(`no fixture for ${key}`) };
          }
          return { status: 'success', result: contract[key] };
        }),
      ),
  };
});

const { readResolverDesk } = await import('@/app/(app)/resolvers/desk');
const { readProviderDesk } = await import('@/app/(app)/providers/desk');
const { readSystem } = await import('@/chain/reader');
const { deploymentLabel, readableDeployments } = await import('@/chain');

function askedOf(functionName: string): readonly string[] {
  return [...new Set(asked.filter((call) => call.functionName === functionName).map((call) => call.address))];
}

describe('a chain carrying three sets', () => {
  it('reads v3 as current and v2 and v1 as earlier contracts, read only', () => {
    const tags = readableDeployments();

    expect(tags.map((tag) => [tag.contractSet, tag.current])).toEqual([
      ['v3', true],
      ['v2', false],
      ['v1', false],
    ]);
    expect(tags.map(deploymentLabel)).toEqual(['current contracts', 'earlier contracts, read only', 'earlier contracts, read only']);
  });

  it('shows the resolver the open v1 dispute beside empty v3 and v2 registries', async () => {
    const desk = await readResolverDesk();

    expect(desk.registry).toBe(V3.oracleRegistry);
    expect(desk.earlier.map((entry) => entry.deployment.contractSet)).toEqual(['v2', 'v1']);
    expect(desk.open.map((row) => [row.deployment.contractSet, row.deployment.current, row.id, row.escrowId])).toEqual([
      ['v1', false, 1n, 4n],
    ]);
  });

  it('reads the floor and what is held for the payee from the v3 escrow alone', async () => {
    asked.length = 0;
    const desk = await readProviderDesk(PAYEE);

    expect(desk.terms.minLock).toBe(10_000n);
    expect(desk.owed).toBe(2_500n);
    expect(askedOf('minLock')).toEqual([V3.escrow.toLowerCase()]);
    expect(askedOf('owed')).toEqual([V3.escrow.toLowerCase()]);
    expect(desk.working.map((entry) => [entry.deployment.contractSet, entry.id])).toEqual([
      ['v3', 1n],
      ['v2', 1n],
    ]);
    expect(desk.contested.map((entry) => [entry.deployment.contractSet, entry.id])).toEqual([['v1', 4n]]);
  });

  it('reads a mandate’s floor and held payout from the v3 escrow and asks no earlier one', async () => {
    asked.length = 0;
    const snapshot = await readSystem({ mandate: MANDATE });

    expect(snapshot.escrow.address).toBe(V3.escrow);
    expect(snapshot.escrow.minLock).toBe(10_000n);
    expect(snapshot.escrow.owed).toBe(1_250n);
    expect(askedOf('minLock')).toEqual([V3.escrow.toLowerCase()]);
    expect(askedOf('owed')).toEqual([V3.escrow.toLowerCase()]);
  });
});
