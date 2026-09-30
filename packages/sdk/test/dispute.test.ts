import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';

import { DisputePhase, disputes } from '../src/dispute.js';
import { LockStatus } from '../src/types.js';
import { ADDRESSES, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

const PAYER: Address = '0x1111111111111111111111111111111111111111';
const PROVIDER: Address = '0x2222222222222222222222222222222222222222';
const OPENED_AT = 1_800_000_000n;

const LOCK = {
  payer: PAYER,
  payee: PROVIDER,
  disputer: PAYER,
  capabilityId: `0x${'11'.repeat(32)}` as Hex,
  inputCommit: `0x${'22'.repeat(32)}` as Hex,
  outputCommit: `0x${'00'.repeat(32)}` as Hex,
  inputURI: 'data:application/json;base64,e30=',
  outputURI: '',
  amount: 2_500_000n,
  deadline: OPENED_AT + 600n,
  releasedAt: 0n,
  bond: 125_000n,
  disputedAt: OPENED_AT,
  status: LockStatus.Disputed,
  counted: false,
};

const VOTE = {
  escrowId: 7n,
  openedAt: OPENED_AT,
  commitEndsAt: OPENED_AT + 21_600n,
  revealEndsAt: OPENED_AT + 43_200n,
  commitCount: 3,
  revealCount: 0,
  medianScore: 0,
  refundBps: 0,
  rewardShares: 0,
  status: DisputePhase.Committing,
};

const CONFIG = {
  commitWindow: 21_600n,
  revealWindow: 21_600n,
  unbondingPeriod: 604_800n,
  quorum: 2,
  maxVoters: 5,
  maxDeviation: 20,
  slashBps: 1_000,
};

function answers(overrides: Record<string, unknown> = {}) {
  return (call: ReadCall): unknown => {
    if (call.functionName in overrides) return overrides[call.functionName];

    switch (call.functionName) {
      case 'resolver':
        return ADDRESSES.oracleRegistry;
      case 'feeBps':
        return 100;
      case 'resolverFeeBps':
        return 50;
      case 'disputeBondBps':
        return 500;
      case 'config':
        return CONFIG;
      case 'getLock':
        return LOCK;
      case 'disputeIdOf':
        return 4n;
      case 'getDispute':
        return VOTE;
      default:
        return undefined;
    }
  };
}

async function client(overrides: Record<string, unknown> = {}) {
  return disputes(fakeConnection({ read: answers(overrides) }).connection);
}

describe('a contested payment, from the side that paid', () => {
  it('reads the voting parameters off the registry rather than assuming them', async () => {
    const reader = await client();

    expect(reader.terms).toEqual(CONFIG);
    expect(reader.registry).toBe(ADDRESSES.oracleRegistry);
  });

  it('answers nothing for a payment nobody has contested', async () => {
    const reader = await client({ getLock: { ...LOCK, disputedAt: 0n, status: LockStatus.Locked } });

    expect(await reader.of(7n)).toBeNull();
  });

  it('reports the phase, the clock and what the disputer put up', async () => {
    const record = await (await client()).of(7n);

    expect(record?.disputeId).toBe(4n);
    expect(record?.phase).toBe('committing');
    expect(record?.openedBy).toBe(PAYER);
    expect(record?.bond).toBe(125_000n);
    expect(record?.commitEndsAt?.toISOString()).toBe(new Date(Number(OPENED_AT + 21_600n) * 1000).toISOString());
    // The vote closes at the end of the reveal window, and from then anyone can settle it.
    expect(record?.resolveBy?.toISOString()).toBe(new Date(Number(VOTE.revealEndsAt) * 1000).toISOString());
    expect(record?.ruling).toBeNull();
    expect(record?.next).toContain('sealing their scores');
  });

  /**
   * The escrow zeroes the bond when it pays it back or forfeits it, so a settled lock reports
   * none. What was posted is recomputed from the rate the escrow charged.
   */
  it('reads the ruling, and cuts the lock exactly as the escrow cut it', async () => {
    const reader = await client({
      getLock: { ...LOCK, status: LockStatus.Resolved, bond: 0n, counted: true },
      getDispute: { ...VOTE, status: DisputePhase.Finalized, revealCount: 3, medianScore: 60, refundBps: 7_500 },
    });

    const record = await reader.of(7n);

    expect(record?.phase).toBe('finalized');
    expect(record?.ruling).toEqual({
      medianScore: 60,
      refundBps: 7_500,
      refundedToPayer: 1_865_625n,
      paidToProvider: 615_657n,
      resolverFee: 12_500n,
      protocolFee: 6_218n,
      bondReturned: true,
    });

    const ruling = record?.ruling;
    const total =
      (ruling?.refundedToPayer ?? 0n) +
      (ruling?.paidToProvider ?? 0n) +
      (ruling?.protocolFee ?? 0n) +
      (ruling?.resolverFee ?? 0n);

    expect(total).toBe(LOCK.amount);
    expect(record?.bond).toBe(125_000n);
    expect(record?.next).toContain('scored the delivery 60 out of 100');
  });

  it('keeps the disputer’s bond where the ruling went the other way', async () => {
    const reader = await client({
      getLock: { ...LOCK, status: LockStatus.Resolved, bond: 0n },
      getDispute: { ...VOTE, status: DisputePhase.Finalized, revealCount: 3, medianScore: 95, refundBps: 0 },
    });

    expect((await reader.of(7n))?.ruling?.bondReturned).toBe(false);
  });

  /**
   * A complaint about a payment the provider already took never reaches a resolver. Reporting it
   * as a vote in progress would leave a payer waiting for a ruling nobody is going to make.
   */
  it('separates a complaint about a payment already made from a vote', async () => {
    const reader = await client({
      getLock: { ...LOCK, releasedAt: OPENED_AT - 100n, counted: true },
    });

    const record = await reader.of(7n);

    expect(record?.recordOnly).toBe(true);
    expect(record?.disputeId).toBe(0n);
    expect(record?.bond).toBe(0n);
    expect(record?.resolveBy).toBeNull();
    expect(record?.next).toContain('nothing left to split');
    expect(record?.next).toContain('settlement history');
  });

  /**
   * A vote with no result puts the payment back on hold, and the provider can still deliver. A lock
   * released after that was paid after the dispute, and is not a complaint about a payment made.
   */
  it('follows a payment the vote put back on hold to where it ended', async () => {
    const reopened = { ...VOTE, status: DisputePhase.Failed };
    const delivered = await (
      await client({ getLock: { ...LOCK, status: LockStatus.Released, releasedAt: OPENED_AT + 50_000n }, getDispute: reopened })
    ).of(7n);

    expect(delivered?.recordOnly).toBe(false);
    expect(delivered?.disputeId).toBe(4n);
    expect(delivered?.next).toContain('delivered after that and was paid');

    const lapsed = await (await client({ getLock: { ...LOCK, status: LockStatus.TimedOut }, getDispute: reopened })).of(7n);
    expect(lapsed?.next).toContain('Nothing was delivered by that deadline');
  });

  it('says a failed vote refunds the payer rather than describing it as a ruling', async () => {
    const reader = await client({
      getLock: { ...LOCK, status: LockStatus.Resolved },
      getDispute: { ...VOTE, status: DisputePhase.Failed, refundBps: 10_000 },
    });

    const record = await reader.of(7n);

    expect(record?.phase).toBe('failed');
    expect(record?.ruling).toBeNull();
    expect(record?.next).toContain('refunded the payer in full');
  });

  it('reaches the same record by the registry’s own dispute id', async () => {
    const reader = await client();

    expect((await reader.get(4n))?.settlementId).toBe(7n);
    expect(await reader.get(99n)).not.toBeNull();
  });

  it('says plainly when an escrow has nobody to hear a dispute', async () => {
    const reader = await client({ resolver: '0x0000000000000000000000000000000000000000' });

    expect(reader.hasResolver).toBe(false);
    expect(reader.terms).toBeNull();
    expect((await reader.of(7n))?.next).toContain('no dispute layer');
  });
});
