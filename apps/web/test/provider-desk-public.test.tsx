import { micro } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { toWithdrawal } from '@/app/(app)/providers/desk';
import type { ProviderDesk, ProviderLock } from '@/app/(app)/providers/desk';
import type { DeploymentTag } from '@/chain';
import { DeskHeadline, DeskStanding } from '@/app/(app)/providers/desk-view';
import { ReputationPanel } from '@/app/(app)/providers/reputation';
import { stageDetail } from '@/app/(app)/providers/stages';
import { UnreadablePayee } from '@/app/(app)/providers/[payee]/unreadable-payee';

/**
 * The desk used to be wallet-gated to nothing: escrow locks, the settlement record and the ceiling
 * that record earns are all public, and a payee weighing this product saw a connect prompt and an
 * empty page. These hold the public reading to two rules.
 *
 * One, it reads in the third person. Copy written for the payee tells a stranger to deliver work
 * they were never hired for, which is not a tone problem; it is the page saying something untrue
 * about who owes what.
 *
 * Two, a figure that did not arrive is never a figure of zero. A score of nothing is a real answer
 * about a real address, and rendering an unread one that way is the difference between "this payee
 * has delivered nothing" and "the chain did not answer".
 */
const PAYEE = '0x1111111111111111111111111111111111111111' as Address;
const PAYER = '0x2222222222222222222222222222222222222222' as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

const DAY = 86_400;
const NOW = new Date('2026-09-22T12:00:00.000Z');

const CURRENT: DeploymentTag = {
  name: 'rhc-mainnet-v2',
  contractSet: 'v2',
  current: true,
  escrow: '0x4315F8be7C9661345710910577Ec31cb867f3c20',
  oracleRegistry: '0xE38349668f0C470C814487E95C14e7652F713B17',
};

function lock(over: Partial<ProviderLock> = {}): ProviderLock {
  return {
    deployment: CURRENT,
    id: 7n,
    payer: PAYER,
    disputer: PAYER,
    capabilityId: ZERO_HASH,
    inputCommit: ZERO_HASH,
    inputURI: '',
    outputURI: '',
    amount: micro(10_000_000n),
    fee: micro(200_000n),
    net: micro(9_800_000n),
    payout: { kind: 'expected', amount: micro(9_800_000n), fee: micro(200_000n) },
    deadline: new Date(NOW.getTime() + DAY * 1000),
    releasedAt: null,
    disputedAt: null,
    bond: micro(0n),
    status: LockStatus.Locked,
    counted: false,
    recordableAt: null,
    stage: 'awaiting-delivery',
    dispute: undefined,
    ...over,
  };
}

function desk(over: Partial<ProviderDesk> = {}): ProviderDesk {
  return {
    payee: PAYEE,
    blockNumber: 57_681_720n,
    chainTime: NOW,
    readAt: NOW,
    requests: 2,
    complete: true,
    failures: 0,
    terms: {
      feeBps: 200,
      disputeWindow: 86_400n,
      minLock: micro(10_000n),
      minTtl: 300n,
      maxTtl: 2_592_000n,
      disputeBondBps: 500,
      resolverFeeBps: 50,
    },
    record: {
      released: 3n,
      timedOut: 0n,
      disputed: 1n,
      score: 75,
      cap: micro(100_000_000n),
      baseCap: micro(25_000_000n),
      capPerScore: micro(1_000_000n),
      maxCap: micro(250_000_000n),
      credit: null,
      minScored: null,
      edgeCap: null,
      fullCredit: null,
    },
    standing: {
      name: 'acme_transcribe',
      registered: true,
      active: true,
      taking: true,
      barred: false,
      stake: micro(10_000_000n),
      minStake: micro(5_000_000n),
      registeredAt: new Date(NOW.getTime() - 30 * DAY * 1000),
      maxSlash: micro(1_000_000n),
      slashBps: 1_000,
      withdrawalDelay: 604_800n,
      withdrawal: null,
      registryPaused: false,
      allowance: micro(0n),
    },
    balance: micro(42_000_000n),
    owed: undefined,
    paidOut: micro(29_400_000n),
    blocked: false,
    tokenPaused: false,
    locks: [],
    working: [],
    settled: [],
    contested: [],
    unrecorded: [],
    recordable: [],
    projectedCap: micro(100_000_000n),
    scanned: { from: 1n, to: 12n, truncated: false },
    earlier: [],
    ...over,
  };
}

describe('a lock read by somebody who is not the payee', () => {
  it('does not tell a stranger the money is coming to them', () => {
    const detail = stageDetail(lock(), NOW, 'public');

    expect(detail).toContain('is held for this address');
    expect(detail).not.toContain('reaches you');
    expect(detail).not.toContain('you release');
  });

  it('still reads in the second person for the payee, which is who it is addressed to', () => {
    expect(stageDetail(lock(), NOW, 'payee')).toContain('when you release it');
  });

  it('keeps every stage free of the second person on the public reading', () => {
    const stages = [
      'awaiting-delivery',
      'deadline-passed',
      'paid-open-to-dispute',
      'paid-unrecorded',
      'paid-recorded',
      'ruled',
      'returned-to-payer',
      'declined',
    ] as const;

    for (const stage of stages) {
      const detail = stageDetail(
        lock({ stage, releasedAt: new Date(NOW.getTime() - DAY * 1000), recordableAt: new Date(NOW.getTime() - 1000) }),
        NOW,
        'public',
      );

      expect(detail, stage).not.toMatch(/\byou\b|\byour\b/i);
    }
  });

  /** Contested after payment is the one branch where the money stays put and the record still moves. */
  it('says whose hands a contested payment stayed in without addressing them', () => {
    const contested = lock({
      stage: 'contested',
      status: LockStatus.Disputed,
      releasedAt: new Date(NOW.getTime() - DAY * 1000),
      disputedAt: new Date(NOW.getTime() - 3_600 * 1000),
    });

    expect(stageDetail(contested, NOW, 'public')).toContain('The payee keeps the money');
    expect(stageDetail(contested, NOW, 'public')).not.toMatch(/\byou\b|\byour\b/i);
    expect(stageDetail(contested, NOW, 'payee')).toContain('You keep the money');
  });

  it('defaults to the reading the payee gets, so an existing call site is unchanged', () => {
    expect(stageDetail(lock(), NOW)).toBe(stageDetail(lock(), NOW, 'payee'));
  });
});

describe('the record panel a payer reads before naming a counterparty', () => {
  it('shows the counts, the volume and what the score is worth at each end of the curve', () => {
    const markup = renderToStaticMarkup(<ReputationPanel desk={desk()} owned={false} />);

    expect(markup).toContain('Delivered');
    expect(markup).toContain('Contested');
    expect(markup).toContain('75 / 100');
    expect(markup).toContain('$29.40');
    expect(markup).toContain('$25.00');
    expect(markup).toContain('$125.00');
  });

  it('speaks about the address rather than to it', () => {
    const markup = renderToStaticMarkup(<ReputationPanel desk={desk()} owned={false} />);

    expect(markup).toContain('this address');
    expect(markup).not.toMatch(/\byour\b/);
  });

  it('says a figure was not read instead of rendering it as nothing', () => {
    const unread = desk({
      complete: false,
      paidOut: undefined,
      record: { ...desk().record, released: undefined, disputed: undefined, score: undefined },
    });
    const markup = renderToStaticMarkup(<ReputationPanel desk={unread} owned={false} />);

    expect(markup).toContain('Not read');
    expect(markup).not.toContain('0 / 100');
  });

  it('says the curve could not be read rather than quoting a curve of zero', () => {
    const unread = desk({ record: { ...desk().record, baseCap: undefined, capPerScore: undefined, maxCap: undefined } });
    const markup = renderToStaticMarkup(<ReputationPanel desk={unread} owned={false} />);

    expect(markup).toContain('the curve could not be read');
  });

  it('shows no credit on contracts that count jobs and weigh nothing', () => {
    const markup = renderToStaticMarkup(<ReputationPanel desk={desk()} owned={false} />);

    expect(markup).not.toContain('Credit toward a full score');
    expect(markup).not.toContain('scaled by');
  });
});

/**
 * From v4 a clean record scores by the credit its delivered work has earned, so a payee with every
 * job delivered and one payer sees 25 and has to be told why, in the two factors that make it.
 */
describe('the credit behind a score', () => {
  const weighed = {
    released: 2n,
    timedOut: 0n,
    disputed: 0n,
    score: 25,
    cap: micro(81_250_000n),
    baseCap: micro(25_000_000n),
    capPerScore: micro(2_250_000n),
    maxCap: micro(250_000_000n),
    credit: micro(62_500_000n),
    minScored: micro(1_000_000n),
    edgeCap: micro(62_500_000n),
    fullCredit: micro(250_000_000n),
  };

  it('shows the credit earned against the full credit, and says why the score is where it is', () => {
    const markup = renderToStaticMarkup(<ReputationPanel desk={desk({ record: weighed })} owned={true} />);

    expect(markup).toContain('Credit toward a full score');
    expect(markup).toContain('$62.50');
    expect(markup).toContain('of $250.00');
    expect(markup).toContain('2 of 2 settled jobs were delivered, earning $62.50 of the $250.00 a full score takes.');
    expect(markup).toContain('The score combines the two: 25 of 100.');
    expect(markup).toContain('Each payer counts for up to $62.50, so once a payer reaches that, only work from new payers adds credit.');
    expect(markup).toContain('Jobs under $1.00 do not count.');
    expect(markup).toContain('weighted by the credit that work earned');
  });

  it('counts credit past the top as the top, and says the score now moves with delivered work alone', () => {
    const markup = renderToStaticMarkup(<ReputationPanel desk={desk({ record: { ...weighed, credit: micro(900_000_000n), score: 100 } })} owned={true} />);

    expect(markup).toContain('$250.00 of the $250.00');
    expect(markup).toContain('The credit is full, so your score now moves with the delivered share alone.');
    expect(markup).not.toContain('only work from new payers');
  });

  it('tells a new payee what the first job earns and how many payers a full score takes', () => {
    const fresh = { ...weighed, released: 0n, score: 0, cap: micro(25_000_000n), credit: micro(0n) };
    const markup = renderToStaticMarkup(<ReputationPanel desk={desk({ record: fresh })} owned={false} />);

    expect(markup).toContain('No job has been recorded for this address yet.');
    expect(markup).toContain('a full score takes $250.00 from at least 4 payers');
  });

  it('says the credit was not read rather than showing none', () => {
    const markup = renderToStaticMarkup(<ReputationPanel desk={desk({ record: { ...weighed, credit: undefined } })} owned={false} />);

    expect(markup).toContain('Not read');
    expect(markup).toContain('The credit behind this score could not be read right now.');
    expect(markup).not.toContain('$0.00 of');
  });
});

/**
 * Zero is the registry saying nothing is pending. Undefined is nobody knowing. A withdrawal panel
 * that merges the two offers a stranger the button to take a stake that may already be on its way.
 */
describe('a stake on its way out', () => {
  it('reads a request with the delay applied to the moment it was asked for', () => {
    const requestedAt = 1_758_000_000n;
    const request = toWithdrawal([3_000_000n, requestedAt], 604_800n, NOW);

    expect(request).not.toBeNull();
    expect(request?.amount).toBe(3_000_000n);
    expect(request?.maturesAt?.getTime()).toBe(Number(requestedAt + 604_800n) * 1000);
  });

  it('separates no request from no reading', () => {
    expect(toWithdrawal([0n, 0n], 604_800n, NOW)).toBeNull();
    expect(toWithdrawal(undefined, 604_800n, NOW)).toBeUndefined();
  });

  it('leaves the maturity unknown when the delay did not answer, rather than calling it matured', () => {
    const request = toWithdrawal([3_000_000n, 1_758_000_000n], undefined, NOW);

    expect(request?.maturesAt).toBeNull();
    expect(request?.matured).toBeUndefined();
  });

  it('calls a request matured only once chain time has passed it', () => {
    const past = BigInt(Math.floor(NOW.getTime() / 1000)) - 604_801n;
    expect(toWithdrawal([1n, past], 604_800n, NOW)?.matured).toBe(true);

    const fresh = BigInt(Math.floor(NOW.getTime() / 1000));
    expect(toWithdrawal([1n, fresh], 604_800n, NOW)?.matured).toBe(false);
  });
});

/**
 * Three conditions refuse a payment on their own, and a reading that did not land is a fourth
 * answer. Collapsing any of them into a single "ready" light throws away the one thing that says
 * who has to act: the registry, the token issuer, or nobody because it was never read.
 */
describe('whether a payer can reach this address', () => {
  it('names each condition separately when all three are clear', () => {
    const markup = renderToStaticMarkup(<DeskStanding desk={desk()} owned={false} />);

    expect(markup).toContain('Listed as acme_transcribe');
    expect(markup).toContain('Taking work.');
    expect(markup).toContain('One ruling can take up to 10% of it, $1.00 at today');
  });

  /**
   * The clear case used to fall through to the sentence for a pause that never answered, so an
   * address with both readings in hand showed a green dot beside the word unknown. A compliance
   * state that can never read as clear is worse than none: it trains a payee to ignore the panel
   * that decides whether their payout lands.
   */
  it('says the address can be paid when both compliance readings landed clear', () => {
    const markup = renderToStaticMarkup(<DeskStanding desk={desk()} owned={false} />);

    expect(markup).toContain('Payouts can land here.');
    expect(markup).not.toContain('Could not read whether USDG is paused');
  });

  it('still says the pause is unknown when only the blocklist answered', () => {
    const markup = renderToStaticMarkup(<DeskStanding desk={desk({ tokenPaused: undefined })} owned={false} />);

    expect(markup).toContain('Could not read whether USDG is paused');
    expect(markup).toContain('aria-label="Unknown"');
  });

  it('separates a condition that failed from one that was never read', () => {
    const unknown = desk({
      standing: { ...desk().standing, active: undefined },
      blocked: undefined,
      tokenPaused: false,
    });
    const markup = renderToStaticMarkup(<DeskStanding desk={unknown} owned={false} />);

    expect(markup).toContain('Could not read the registry');
    expect(markup).toContain('Could not read the USDG blocklist');
  });

  /** A payout to a blocked address reverts on the token whatever the escrow and the registry say. */
  it('says the token blocks the address even while the registry is happy', () => {
    const markup = renderToStaticMarkup(<DeskStanding desk={desk({ blocked: true })} owned={false} />);

    expect(markup).toContain('USDG issuer has blocked this address');
  });

  it('tells the payee where their own control is, and does not send a stranger looking for it', () => {
    const stopped = desk({ standing: { ...desk().standing, active: false } });

    expect(renderToStaticMarkup(<DeskStanding desk={stopped} owned />)).toContain('from the stake panel above');
    expect(renderToStaticMarkup(<DeskStanding desk={stopped} owned={false} />)).toContain(
      'Only this address can start it again',
    );
  });

  it('flags a stake that has fallen under the registry minimum', () => {
    const short = desk({ standing: { ...desk().standing, stake: micro(1_000_000n) } });

    expect(renderToStaticMarkup(<DeskStanding desk={short} owned />)).toContain('the stake is below the minimum');
  });
});

describe('the headline figures', () => {
  it('shows the ceiling and the stake, and says which they are measured against', () => {
    const markup = renderToStaticMarkup(<DeskHeadline desk={desk()} owned={false} />);

    expect(markup).toContain('Largest single job');
    expect(markup).toContain('$100.00');
    expect(markup).toContain('Stake posted');
    expect(markup).toContain('Minimum $5.00');
  });

  it('shows a dash and says Not read when the escrow did not answer, never a total of zero', () => {
    const markup = renderToStaticMarkup(<DeskHeadline desk={desk({ complete: false })} owned={false} />);

    expect(markup).toContain('Not read');
    expect(markup).not.toContain('0 jobs held against a deadline');
  });
});

describe('a desk URL that names something the escrow could never pay', () => {
  it('blames the address and not the page, and offers the way back', () => {
    const markup = renderToStaticMarkup(<UnreadablePayee typed="0xnope" />);

    expect(markup).toContain('not an address');
    expect(markup).toContain('0xnope');
    expect(markup).toContain('/providers');
  });
});
