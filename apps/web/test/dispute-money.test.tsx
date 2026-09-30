import { micro } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';

import type { ContestedSettlement, DisputeRow, ResolverDesk } from '@/app/(app)/resolvers/desk';
import type { DeploymentTag } from '@/chain';
import { DisputeList } from '@/app/(app)/resolvers/dispute-list';
import { DisputeStatus, silenceSlash } from '@/app/(app)/resolvers/phases';
import type { DisputeRead, ProviderLock } from '@/app/(app)/providers/desk';
import { stageDetail } from '@/app/(app)/providers/stages';
import { rebateReason, rebateSentence } from '@/app/(app)/token/rebate';
import { splitSettlement } from '@/chain/settlement';
import { brsr } from '@/money';

/** A dispute card reads its published ruling through the query client, as it does in the app. */
function renderToStaticMarkup(node: ReactNode): string {
  return renderMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}

/**
 * The figures in here are the ones dispute 1 produced on chain on 2026-09-24: a 0.100000 USDG
 * lock, a 0.005000 USDG contest bond, `refundBps` of 10,000, and a payer who received 0.104500 and
 * was 0.000500 short. Three surfaces told the payer, the resolver and the payee something else.
 */

const REGISTRY = '0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF' as Address;
const PAYER = '0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4' as Address;
const PAYEE = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

const LOCK = micro(100_000n);
const BOND = micro(5_000n);
const RESOLVER_FEE_BPS = 50;
const FEE_BPS = 200;

const NOW = new Date('2026-09-24T10:44:00Z');

describe('Escrow._split, copied so a screen can quote it', () => {
  it('takes the resolver fee off the lock before it applies the refund', () => {
    const split = splitSettlement(LOCK, 10_000, RESOLVER_FEE_BPS, FEE_BPS);

    expect(split.resolverFee).toBe(500n);
    expect(split.refunded).toBe(99_500n);
    expect(split.paid).toBe(0n);
    expect(split.protocolFee).toBe(0n);
  });

  it('charges the settlement fee on the payee share alone', () => {
    const split = splitSettlement(LOCK, 0, RESOLVER_FEE_BPS, FEE_BPS);

    expect(split.refunded).toBe(0n);
    expect(split.resolverFee).toBe(500n);
    expect(split.protocolFee).toBe(1_990n);
    expect(split.paid).toBe(97_510n);
  });

  it('conserves the lock across every leg', () => {
    for (const refundBps of [0, 3_500, 7_500, 10_000]) {
      const split = splitSettlement(LOCK, refundBps, RESOLVER_FEE_BPS, FEE_BPS);
      expect(split.resolverFee + split.refunded + split.protocolFee + split.paid).toBe(LOCK);
    }
  });
});

describe('who a close without a ruling slashes', () => {
  const clock = {
    status: DisputeStatus.Committing,
    commitEndsAt: new Date('2026-09-23T23:26:31Z'),
    revealEndsAt: new Date('2026-09-24T05:26:31Z'),
    commitCount: 2,
    revealCount: 0,
  };

  it('spares a committer while the reveal window is still open', () => {
    expect(silenceSlash(clock, new Date('2026-09-24T01:00:00Z'))).toEqual({ silent: 2, counted: false });
  });

  it('slashes the same committer once that window has closed', () => {
    expect(silenceSlash(clock, new Date('2026-09-24T06:00:00Z'))).toEqual({ silent: 2, counted: true });
  });

  it('reaches only the committers who never revealed', () => {
    expect(silenceSlash({ ...clock, revealCount: 2 }, new Date('2026-09-24T06:00:00Z')).silent).toBe(0);
  });

  it('treats a window it could not read as closed, which is the answer that warns', () => {
    expect(silenceSlash({ ...clock, revealEndsAt: null }, NOW).counted).toBe(true);
  });
});

function settlement(): ContestedSettlement {
  return {
    id: 5n,
    payer: PAYER,
    payee: PAYEE,
    disputer: PAYER,
    amount: LOCK,
    bond: BOND,
    capabilityId: ZERO_HASH,
    inputURI: '',
    outputURI: '',
    deadline: new Date('2026-09-23T22:00:00Z'),
    disputedAt: new Date('2026-09-23T23:26:31Z'),
    status: LockStatus.Disputed,
  };
}

/** The set that answers for the chain. Every set from v2 on closes a short vote the same way. */
const CURRENT: DeploymentTag = {
  name: 'rhc-mainnet-v3',
  contractSet: 'v3',
  current: true,
  escrow: '0x3333333333333333333333333333333333333333',
  oracleRegistry: '0x4444444444444444444444444444444444444444',
};

/** Where dispute 1 actually ran, on the first contracts. */
const V1: DeploymentTag = {
  name: 'rhc-mainnet',
  contractSet: 'v1',
  current: false,
  escrow: '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4',
  oracleRegistry: REGISTRY,
};

function dispute(over: Partial<DisputeRow> = {}): DisputeRow {
  return {
    deployment: CURRENT,
    config: { commitWindow: 21_600n, revealWindow: 21_600n, unbondingPeriod: 604_800n, quorum: 2, maxVoters: 5, maxDeviation: 20, slashBps: 1_000 },
    resolverFeeBps: RESOLVER_FEE_BPS,
    id: 1n,
    escrowId: 5n,
    status: DisputeStatus.Revealing,
    openedAt: new Date('2026-09-23T23:26:31Z'),
    commitEndsAt: new Date('2026-09-23T23:26:31Z'),
    revealEndsAt: new Date('2026-09-24T05:26:31Z'),
    commitCount: 1,
    revealCount: 0,
    medianScore: 0,
    refundBps: 0,
    rewardShares: 0,
    phase: 'ruling',
    deadline: null,
    exit: 'fail',
    settlement: settlement(),
    yours: undefined,
    ...over,
  };
}

function desk(over: Partial<ResolverDesk> = {}): ResolverDesk {
  const disputes = over.disputes ?? [];
  return {
    registry: REGISTRY,
    chainTime: NOW,
    readAt: NOW,
    requests: 2,
    complete: true,
    failures: 0,
    disputesReadable: true,
    config: { commitWindow: 21_600n, revealWindow: 21_600n, unbondingPeriod: 604_800n, quorum: 2, maxVoters: 5, maxDeviation: 20, slashBps: 1_000 },
    bondAsset: '0x00e503925880c4b07E5Fb70232D83aD871F57a7d',
    bondPool: '0x3f2a0E7822B30aD928488F053348b137866Cf962',
    rewardAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    escrow: '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4',
    slashSink: '0xb4A7D77a710f6b1fF4cDDd9D3c9b66E3f917A4FF',
    minBond: brsr(25_000n * 10n ** 18n),
    totalBonded: brsr(25_000n * 10n ** 18n),
    resolverCount: 1,
    unallocatedRewards: micro(0n),
    resolverFeeBps: RESOLVER_FEE_BPS,
    disputes,
    open: over.open ?? disputes,
    settled: over.settled ?? [],
    standing: undefined,
    scanned: { from: 1n, to: 1n, truncated: false },
    earlier: [],
    ...over,
  };
}

function card(row: DisputeRow, chainTime: Date): string {
  return renderToStaticMarkup(
    <DisputeList
      desk={desk({ disputes: [row], chainTime })}
      error={null}
      account={undefined}
      blockedBy={[]}
      onDone={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

describe('the resolver desk, before a dispute is closed without a ruling', () => {
  it('never promises a refund in full', () => {
    expect(card(dispute(), NOW)).not.toContain('refunds the payer in full');
  });

  it('says a close without a ruling puts the payment back on hold and takes no fee', () => {
    const html = card(dispute(), NOW);

    expect(html).toContain('Closing it puts the payment back on hold for the payee');
    expect(html).toContain('Nothing is refunded and no resolver fee is taken');
    expect(html).toContain('once that deadline passes');
    expect(html).not.toContain('$0.0995');
  });

  it('says the contest bond comes back whole, because it does', () => {
    expect(card(dispute(), NOW)).toContain('$0.005 contest bond goes back to the disputer in full');
  });

  it('promises nobody is slashed only while the reveal window is open', () => {
    const html = card(dispute(), new Date('2026-09-24T01:00:00Z'));

    expect(html).toContain('Nobody is slashed by closing it now');
    expect(html).toContain('Closing it after that moment slashes');
  });

  it('says who is slashed once that window has closed', () => {
    const html = card(dispute(), NOW);

    expect(html).toContain('so silence counts');
    expect(html).toContain('never revealed, 10% of the bond behind each');
    expect(html).not.toContain('Nobody is slashed');
  });

  it('spares a panel that revealed everything it sealed', () => {
    const html = card(dispute({ commitCount: 1, revealCount: 1 }), NOW);

    expect(html).toContain('Every sealed score on this dispute was revealed');
  });

  it('keeps an unread fee apart from a fee of nothing', () => {
    const ruling = dispute({ resolverFeeBps: undefined, exit: 'finalize', commitCount: 2, revealCount: 2 });
    const html = renderToStaticMarkup(
      <DisputeList
        desk={desk({ disputes: [ruling], resolverFeeBps: undefined })}
        error={null}
        account={undefined}
        blockedBy={[]}
        onDone={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain('The amounts behind it were not read here');
    expect(html).not.toContain('$0.0995');
  });
});

function disputeRead(over: Partial<DisputeRead> = {}): DisputeRead {
  return {
    id: 1n,
    status: DisputeStatus.Failed,
    openedAt: new Date('2026-09-23T23:26:31Z'),
    commitEndsAt: new Date('2026-09-23T23:26:31Z'),
    revealEndsAt: new Date('2026-09-24T05:26:31Z'),
    commitCount: 1,
    revealCount: 1,
    medianScore: 0,
    refundBps: 10_000,
    rewardShares: 0,
    ...over,
  };
}

function providerLock(over: Partial<ProviderLock> = {}): ProviderLock {
  return {
    deployment: CURRENT,
    id: 5n,
    payer: PAYER,
    disputer: PAYER,
    capabilityId: ZERO_HASH,
    inputCommit: ZERO_HASH,
    inputURI: '',
    outputURI: '',
    amount: LOCK,
    fee: micro(2_000n),
    net: micro(98_000n),
    payout: { kind: 'none' },
    deadline: new Date('2026-09-23T22:00:00Z'),
    releasedAt: null,
    disputedAt: new Date('2026-09-23T23:26:31Z'),
    bond: BOND,
    status: LockStatus.Resolved,
    counted: true,
    recordableAt: null,
    stage: 'dispute-closed',
    dispute: disputeRead(),
    ...over,
  };
}

describe('the payee reading back a dispute that is over', () => {
  it('does not claim a ruling on a dispute that never reached one', () => {
    const detail = stageDetail(providerLock({ deployment: V1 }), NOW, 'payee');

    expect(detail).not.toContain('A resolver split this lock');
    expect(detail).toContain('closed without a ruling');
    expect(detail).toContain('Nothing reached you');
  });

  it('names the quorum miss the payer never saw either', () => {
    expect(stageDetail(providerLock({ deployment: V1 }), NOW, 'public')).toContain('1 of 1 sealed score was published');
  });

  // From v2 on a vote short of its quorum puts the lock back on hold, so a lock that closed as
  // failed was a vote with no centre, which refunded the payer whole.
  it('says a vote with no centre refunded the payer with no fee taken', () => {
    const detail = stageDetail(providerLock(), NOW, 'public');

    expect(detail).toContain('nothing to rule by');
    expect(detail).toContain('with no resolver fee taken');
    expect(detail).toContain('Nothing reached the payee');
    expect(detail).not.toContain('less its resolver fee');
  });

  it('tells a real ruling apart from a close, and says what it paid', () => {
    const detail = stageDetail(
      providerLock({
        stage: 'ruled',
        dispute: disputeRead({ status: DisputeStatus.Finalized, medianScore: 60, refundBps: 7_500 }),
        payout: { kind: 'paid', amount: micro(24_377n), fee: micro(497n) },
      }),
      NOW,
      'payee',
    );

    expect(detail).toContain('median score of 60');
    expect(detail).toContain('75%');
    expect(detail).toContain('$0.024377 reached you');
  });

  it('separates a dispute nobody closed from one the panel failed', () => {
    const detail = stageDetail(
      providerLock({ deployment: V1, dispute: disputeRead({ status: DisputeStatus.Revealing, refundBps: 0 }) }),
      NOW,
      'payee',
    );

    expect(detail).toContain('returned the lock to the payer without one');
    expect(detail).toContain('no fee was taken from it');
    expect(detail).not.toMatch(/timeout/i);
  });

  it('says the outcome is unknown rather than nothing when the dispute did not read', () => {
    const detail = stageDetail(
      providerLock({ stage: 'dispute-unread', dispute: undefined, payout: { kind: 'unread' } }),
      NOW,
      'payee',
    );

    expect(detail).toContain('unknown rather than nothing');
  });
});

const TIERS = [
  { minStake: brsr(25_000n * 10n ** 18n), rebateBps: 500 },
  { minStake: brsr(100_000n * 10n ** 18n), rebateBps: 1_000 },
  { minStake: brsr(500_000n * 10n ** 18n), rebateBps: 2_000 },
  { minStake: brsr(2_500_000n * 10n ** 18n), rebateBps: 3_000 },
];

describe('why a staked balance earns the rebate it earns', () => {
  it('blames the pending exit, not the table, when the table is set', () => {
    const reason = rebateReason(TIERS, {
      rebateBps: 0,
      activeStake: brsr(20_000n * 10n ** 18n),
      stakedValue: brsr(25_000n * 10n ** 18n),
    });

    expect(reason.kind).toBe('exit-dropped-a-tier');
    const sentence = rebateSentence(reason);
    expect(sentence).toContain('20,000');
    expect(sentence).toContain('25,000');
    expect(sentence).toContain('cancelling the exit would earn 5%');
    expect(sentence).not.toContain('until this table is set');
  });

  it('blames the table only where there is no table', () => {
    const reason = rebateReason([], { rebateBps: 0, activeStake: brsr(0n), stakedValue: brsr(0n) });

    expect(reason.kind).toBe('no-table');
    expect(rebateSentence(reason)).toContain('holds no rebate tiers');
  });

  it('says a small position is small', () => {
    const reason = rebateReason(TIERS, {
      rebateBps: 0,
      activeStake: brsr(1_000n * 10n ** 18n),
      stakedValue: brsr(1_000n * 10n ** 18n),
    });

    expect(reason.kind).toBe('under-the-first-tier');
    expect(rebateSentence(reason)).toContain('first tier starts at 25,000');
  });

  it('names the tier a position clears and the one above it', () => {
    const reason = rebateReason(TIERS, {
      rebateBps: 1_000,
      activeStake: brsr(120_000n * 10n ** 18n),
      stakedValue: brsr(120_000n * 10n ** 18n),
    });

    expect(reason.kind).toBe('earning');
    const sentence = rebateSentence(reason);
    expect(sentence).toContain('clears the 100,000.00 BRSR tier');
    expect(sentence).toContain('next one starts at 500,000');
  });

  it('keeps a reading that failed apart from a rebate of zero', () => {
    const reason = rebateReason(TIERS, { rebateBps: undefined, activeStake: brsr(0n), stakedValue: brsr(0n) });

    expect(reason.kind).toBe('unread');
    expect(rebateSentence(reason)).toContain('only the reading failed');
  });

  it('says so when the whole position is on its way out', () => {
    const reason = rebateReason(TIERS, {
      rebateBps: 0,
      activeStake: brsr(0n),
      stakedValue: brsr(30_000n * 10n ** 18n),
    });

    expect(reason.kind).toBe('all-exiting');
    expect(rebateSentence(reason)).toContain('has been asked back');
  });
});
