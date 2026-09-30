import { LockStatus } from '@bursar/sdk';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The desks read every live deployment on the chain, the current one first. These fixtures are
 * shaped on chain 4663 as it stood before v3: the v2 registry has no dispute yet, and the v1
 * registry holds dispute 1 (closed) and disputes 2 and 3, open on v1 locks 9 and 10. The address
 * book is pinned to those two records so the scenario holds whatever a later deploy adds.
 */
vi.mock('@bursar/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@bursar/core')>();
  const { withRecords } = await import('./support/address-book');
  return withRecords(core, [core.deployment('rhc-mainnet-v2' as never), core.deployment('rhc-mainnet' as never)]);
});

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
const NOW = 1_790_600_000n;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

const CONFIG = {
  commitWindow: 21_600n,
  revealWindow: 21_600n,
  unbondingPeriod: 604_800n,
  quorum: 1,
  maxVoters: 5,
  maxDeviation: 20,
  slashBps: 1_000,
};

function dispute(escrowId: bigint, openedAt: bigint, status: number, refundBps = 0) {
  return {
    escrowId,
    openedAt,
    commitEndsAt: openedAt + 21_600n,
    revealEndsAt: openedAt + 43_200n,
    commitCount: status === 1 ? 0 : 1,
    revealCount: status === 1 ? 0 : 1,
    medianScore: 0,
    refundBps,
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
    disputedAt: status === LockStatus.Disputed ? NOW - 6_000n : 0n,
    status,
    counted: false,
  };
}

/** What each contract answers, keyed by lowercased address, then function, then first argument. */
const CHAIN: Record<string, Record<string, unknown>> = {
  [V2.oracleRegistry.toLowerCase()]: { config: CONFIG, nextDisputeId: 1n },
  [V2.escrow.toLowerCase()]: {
    resolverFeeBps: 50,
    nextId: 3n,
    feeBps: 200,
    disputeWindow: 86_400n,
    'getLock:1': lock(LockStatus.Locked),
    'getLock:2': lock(LockStatus.Locked, PAYER),
  },
  [V1.oracleRegistry.toLowerCase()]: {
    config: CONFIG,
    nextDisputeId: 4n,
    'getDispute:1': dispute(5n, NOW - 400_000n, 4, 10_000),
    'getDispute:2': dispute(9n, NOW - 5_874n, 1),
    'getDispute:3': dispute(10n, NOW - 5_871n, 1),
    'disputeIdOf:9': 2n,
    'disputeIdOf:10': 3n,
  },
  [V1.escrow.toLowerCase()]: {
    resolverFeeBps: 50,
    nextId: 11n,
    feeBps: 200,
    disputeWindow: 86_400n,
    'getLock:5': lock(LockStatus.Resolved, PAYER),
    'getLock:9': lock(LockStatus.Disputed),
    'getLock:10': lock(LockStatus.Disputed),
  },
};

vi.mock('@/chain/client', () => ({ rhcClient: () => ({}), rhcPool: () => undefined, probeProviders: vi.fn(), onPoolEvent: vi.fn() }));

vi.mock('@/chain/batch', async (original) => {
  const actual = await original<typeof import('@/chain/batch')>();
  return {
    ...actual,
    runBatch: async (_client: unknown, batch: InstanceType<typeof actual.ReadBatch>) =>
      new actual.BatchResults(
        batch.calls.map((call) => {
          if (call.functionName === 'getCurrentBlockTimestamp') return { status: 'success', result: NOW };
          const contract = CHAIN[call.address.toLowerCase()];
          const arg = call.args?.[0];
          const key = arg === undefined || typeof arg !== 'bigint' ? call.functionName : `${call.functionName}:${arg}`;
          if (contract === undefined || !(key in contract)) {
            // An unknown lock id reads as an empty lock, the way the escrow answers one.
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
const { readableDeployments } = await import('@/chain');

describe('the deployments a desk reads', () => {
  it('is the current set first, then the v1 set it supersedes', () => {
    const tags = readableDeployments();
    expect(tags.map((tag) => [tag.contractSet, tag.current, tag.oracleRegistry])).toEqual([
      ['v2', true, V2.oracleRegistry],
      ['v1', false, V1.oracleRegistry],
    ]);
  });
});

describe('the resolver desk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the open v1 disputes 2 and 3, labelled v1, next to an empty v2 registry', async () => {
    const desk = await readResolverDesk();

    expect(desk.registry).toBe(V2.oracleRegistry);
    expect(desk.scanned.to).toBe(0n);
    expect(desk.earlier).toEqual([
      expect.objectContaining({ disputesReadable: true, scanned: { from: 1n, to: 3n, truncated: false } }),
    ]);

    const open = desk.open.map((row) => [row.deployment.contractSet, row.deployment.current, row.id, row.escrowId, row.phase]);
    expect(open).toEqual([
      ['v1', false, 3n, 10n, 'commit'],
      ['v1', false, 2n, 9n, 'commit'],
    ]);
    expect(desk.open.every((row) => row.deployment.oracleRegistry === V1.oracleRegistry)).toBe(true);
    expect(desk.open[0]?.settlement?.amount).toBe(100_000n);
    expect(desk.settled.map((row) => [row.deployment.contractSet, row.id])).toEqual([['v1', 1n]]);
  });
});

describe('the provider desk', () => {
  it('shows a payee its v1 locks under dispute, labelled v1, and never offers to record them', async () => {
    const desk = await readProviderDesk(PAYEE);

    expect(desk.working.map((lock) => [lock.deployment.contractSet, lock.id])).toEqual([['v2', 1n]]);
    expect(desk.contested.map((lock) => [lock.deployment.contractSet, lock.id, lock.dispute?.id])).toEqual([
      ['v1', 10n, 3n],
      ['v1', 9n, 2n],
    ]);
    expect(desk.contested.every((lock) => lock.deployment.escrow === V1.escrow)).toBe(true);
    expect(desk.earlier).toEqual([expect.objectContaining({ complete: true, scanned: { from: 1n, to: 10n, truncated: false } })]);
    expect(desk.unrecorded.every((lock) => lock.deployment.current)).toBe(true);
  });
});
