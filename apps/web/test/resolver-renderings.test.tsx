import { micro, requestDocument, requestURI } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { BondPanel } from '@/app/(app)/resolvers/bond-panel';
import type { ContestedSettlement, DisputeRow, ResolverDesk } from '@/app/(app)/resolvers/desk';
import type { DeploymentTag } from '@/chain';
import { DisputeCard } from '@/app/(app)/resolvers/dispute-card';
import { DisputeList } from '@/app/(app)/resolvers/dispute-list';
import { DisputeStatus } from '@/app/(app)/resolvers/phases';
import { countOpen, disputeListState } from '@/app/(app)/resolvers/reading';
import { brsr } from '@/money';

/** A dispute card reads its published ruling through the query client, as it does in the app. */
function renderToStaticMarkup(node: ReactNode): string {
  return renderMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}

/**
 * Loading, unreadable and empty are three answers on the one screen where confusing them is paid
 * for in BRSR.
 *
 * A resolver reads this page to find out what is due. An endpoint that rate-limits produces the
 * same empty array as a registry with nothing open, and a page that renders both as "nothing needs
 * you" sends a resolver away from a reveal window. `empty` is reachable only from a reading that
 * landed, and that is what these assert.
 */

const REGISTRY = '0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF' as Address;
const PAYER = '0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4' as Address;
const PAYEE = '0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21' as Address;

const NOW = new Date('2026-09-22T03:00:00Z');

function settlement(): ContestedSettlement {
  return {
    id: 4n,
    payer: PAYER,
    payee: PAYEE,
    disputer: PAYER,
    amount: micro(125_000_000n),
    bond: micro(6_250_000n),
    capabilityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
    inputURI: '',
    outputURI: '',
    deadline: new Date('2026-09-22T00:00:00Z'),
    disputedAt: new Date('2026-09-22T00:00:00Z'),
    status: LockStatus.Disputed,
  };
}

const CURRENT: DeploymentTag = {
  name: 'rhc-mainnet-v2',
  contractSet: 'v2',
  current: true,
  escrow: '0x4315F8be7C9661345710910577Ec31cb867f3c20',
  oracleRegistry: '0xE38349668f0C470C814487E95C14e7652F713B17',
};

function dispute(over: Partial<DisputeRow> = {}): DisputeRow {
  return {
    deployment: CURRENT,
    config: { commitWindow: 21_600n, revealWindow: 21_600n, unbondingPeriod: 604_800n, quorum: 2, maxVoters: 5, maxDeviation: 20, slashBps: 1_000 },
    resolverFeeBps: 50,
    id: 1n,
    escrowId: 4n,
    status: DisputeStatus.Committing,
    openedAt: new Date('2026-09-22T00:00:00Z'),
    commitEndsAt: new Date('2026-09-22T06:00:00Z'),
    revealEndsAt: new Date('2026-09-22T12:00:00Z'),
    commitCount: 1,
    revealCount: 0,
    medianScore: 0,
    refundBps: 0,
    rewardShares: 0,
    phase: 'commit',
    deadline: new Date('2026-09-22T06:00:00Z'),
    exit: 'none',
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
    totalBonded: brsr(0n),
    resolverCount: 0,
    unallocatedRewards: micro(0n),
    resolverFeeBps: 50,
    disputes,
    open: over.open ?? disputes,
    settled: over.settled ?? [],
    standing: undefined,
    scanned: { from: 1n, to: BigInt(disputes.length), truncated: false },
    earlier: [],
    ...over,
  };
}

function list(over: { readonly desk?: ResolverDesk; readonly error?: unknown } = {}): string {
  return renderToStaticMarkup(
    <DisputeList
      desk={over.desk}
      error={over.error ?? null}
      account={undefined}
      blockedBy={[]}
      onDone={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

describe('disputeListState', () => {
  it('answers four distinct things', () => {
    const answers = [
      disputeListState(undefined, null),
      disputeListState(undefined, new Error('rate limited')),
      disputeListState(desk(), null),
      disputeListState(desk({ disputes: [dispute()] }), null),
    ];

    expect(answers).toEqual(['loading', 'unreadable', 'empty', 'filled']);
  });

  /**
   * The registry answers the count of disputes in its own call, and that call can fail on its own
   * while every other figure on the page lands. An empty panel under an unread count is unknown.
   */
  it('never calls an unread count an empty panel', () => {
    expect(disputeListState(desk({ disputesReadable: false }), null)).toBe('unreadable');
    expect(disputeListState(desk({ disputesReadable: false, disputes: [dispute()] }), null)).toBe('unreadable');
  });

  /**
   * Without the windows and the quorum, nothing can be placed in a phase, every row drops out of
   * the open list and the page would show a clear bench built entirely from a failed read. This is
   * the fail-open the three renderings exist to stop.
   */
  it('never calls an unread voting configuration a clear bench', () => {
    expect(disputeListState(desk({ config: undefined, disputes: [dispute({ phase: 'unknown' })], open: [] }), null)).toBe('unreadable');
  });

  it('offers no headline count from a reading that could not place a dispute in a phase', () => {
    expect(countOpen(desk({ config: undefined }))).toBeUndefined();
    expect(countOpen(desk({ disputesReadable: false }))).toBeUndefined();
    expect(countOpen(desk({ disputes: [dispute()] }))).toBe(1);
    expect(countOpen(desk({ disputes: [dispute()] }), (row) => row.exit !== 'none')).toBe(0);
  });

  it('lets a failed read outrank a reading still in flight', () => {
    expect(disputeListState(undefined, new Error('chain down'))).toBe('unreadable');
  });
});

describe('the three renderings on screen', () => {
  it('says nothing about what is open while the reading is in flight', () => {
    const markup = list();
    expect(markup).not.toContain('No dispute is open.');
    expect(markup).not.toContain('Open disputes could not be read right now');
  });

  it('says the panel is unknown when the reading failed, and offers the reading again', () => {
    const markup = list({ error: new Error('429 Too Many Requests') });
    expect(markup).toContain('Open disputes could not be read right now');
    expect(markup).toContain('Read again');
    expect(markup).not.toContain('No dispute is open.');
  });

  it('says the panel is unknown when the count alone failed', () => {
    const markup = list({ desk: desk({ disputesReadable: false }) });
    expect(markup).toContain('Open disputes could not be read right now');
    expect(markup).not.toContain('No dispute is open.');
  });

  it('calls the bench clear only from a reading that landed', () => {
    const markup = list({ desk: desk() });
    expect(markup).toContain('No dispute is open.');
    expect(markup).not.toContain('Open disputes could not be read right now');
  });

  it('renders a dispute with the money, the phase and the deadline on it', () => {
    const markup = list({ desk: desk({ disputes: [dispute()] }) });
    expect(markup).toContain('Dispute 1');
    expect(markup).toContain('$125.00');
    expect(markup).toContain('Sealing scores');
    expect(markup).toContain('Sealing closes');
    expect(markup).toContain('2026-09-22T06:00:00.000Z');
    expect(markup).not.toContain('No dispute is open.');
  });

  /**
   * The escrow pulled 0.005 USDG when dispute 1 was opened on chain 4663 and this field read
   * $0.00, which tells a resolver the disputer has staked nothing. A bond is basis points of a
   * lock, so two decimal places round most of them away.
   */
  it('shows a contest bond that two decimal places would round to nothing', () => {
    const contested = { ...settlement(), amount: micro(100_000n), bond: micro(5_000n) };
    const markup = list({ desk: desk({ disputes: [dispute({ settlement: contested })] }) });

    expect(markup).toContain('>$0.005</span>');
    expect(markup).not.toContain('>$0.00</span>');
  });

  it('says the amount is unknown when the escrow did not answer for the settlement', () => {
    const markup = list({ desk: desk({ disputes: [dispute({ settlement: undefined })] }) });
    expect(markup).toContain('The amount at stake could not be read right now');
    expect(markup).not.toContain('$0.00');
  });
});

describe('the bond floor without a wallet', () => {
  function bond(over: Partial<ResolverDesk> | undefined): string {
    return renderToStaticMarkup(
      <BondPanel desk={over === undefined ? undefined : desk(over)} account={undefined} blockedBy={[]} onDone={() => undefined} />,
    );
  }

  it('reads the floor from the chain rather than a constant in the page', () => {
    expect(bond({})).toContain('25,000.00 BRSR');
    expect(bond({ minBond: brsr(40_000n * 10n ** 18n) })).toContain('40,000.00 BRSR');
  });

  it('separates a floor still being read from a floor that would not read', () => {
    expect(bond(undefined)).toContain('Reading');
    expect(bond({ minBond: undefined })).toContain('Not read');
  });

  it('offers no control and claims no balance without a wallet', () => {
    const markup = bond({});
    expect(markup).toContain('No wallet');
    expect(markup).not.toContain('Post the bond');
  });
});

/**
 * The brief and the delivery, as a resolver has to read them.
 *
 * A resolver is paid to judge whether one matches the other, and both travel inline on the lock
 * as base64. `data:application/json;base64,eyJkb2N1bWVudCI6…` is not something anybody can rule
 * on, and dispute 1 on Robinhood Chain carried exactly that. Nothing is fetched to do it: a URI
 * pointing elsewhere stays a link, because following one on a counterparty's word from a page
 * holding a wallet is a different product.
 */
describe('published evidence on a dispute card', () => {
  const BRIEF = { document: 'exhausting the daily window (2) at 2026-09-23T17:13:05.659Z' };
  const DELIVERY = { characters: 72, summary: 'A mandate is a budget an agent can', words: 14 };

  function inline(value: unknown): string {
    return `data:application/json;base64,${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`;
  }

  function card(inputURI: string, outputURI = ''): string {
    return renderToStaticMarkup(
      <DisputeCard
        dispute={dispute({ settlement: { ...settlement(), inputURI, outputURI } })}
        config={{ commitWindow: 21_600n, revealWindow: 21_600n, unbondingPeriod: 604_800n, quorum: 2, maxVoters: 5, maxDeviation: 20, slashBps: 1_000 }}
        resolverFeeBps={50}
        chainTime={NOW}
        account={undefined}
        registry={REGISTRY}
        standing={undefined}
        blockedBy={[]}
        onDone={() => undefined}
      />,
    );
  }

  /** What a resolver reads, with the markup and its attributes taken out. */
  function visible(markup: string): string {
    return markup.replace(/<[^>]*>/g, ' ');
  }

  it('shows what was asked for, not the base64 that carried it', () => {
    const shown = card(inline(BRIEF));
    expect(shown).toContain('exhausting the daily window');
    expect(visible(shown)).not.toContain('eyJkb2N1bWVudCI6');
  });

  it('shows what was delivered the same way', () => {
    const shown = card(inline(BRIEF), inline(DELIVERY));
    expect(shown).toContain('A mandate is a budget an agent can');
    expect(shown).toContain('words');
  });

  it('shows the call an x402 payment was opened for, which travels under its own media type', () => {
    const binding = { requestHash: 'ab'.repeat(32), salt: `0x${'5a'.repeat(32)}` as const };
    const shown = card(requestURI(requestDocument({ method: 'POST', url: 'https://api.provider.dev/render', binding })));
    expect(shown).toContain('What was asked for');
    expect(visible(shown)).toContain('https://api.provider.dev/render');
    expect(visible(shown)).toContain('requestNonce');
  });

  it('keeps the raw URI to hand rather than throwing it away', () => {
    expect(card(inline(BRIEF))).toContain('data:application/json;base64,');
  });

  it('leaves a payload it cannot read back as the URI itself, never as mangled text', () => {
    expect(visible(card('data:application/json;base64,not-base64-at-all'))).toContain('not-base64-at-all');
  });

  it('does not turn a URI pointing elsewhere into a decode', () => {
    expect(visible(card('https://payer.example/brief.json'))).toContain('https://payer.example/brief.json');
  });

  it('says so when nothing was published', () => {
    expect(card('', '')).not.toContain('What was asked for');
  });
});
