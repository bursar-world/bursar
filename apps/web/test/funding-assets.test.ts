import { RHC_MAINNET, micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { MerchantGate, WindowKind } from '@bursar/sdk';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import type { ChainSnapshot, FundingRead, MandateRead } from '@/chain/reader';
import { wei } from '@/money';
import { ROUND_TRIP_FEE, evaluateFunding } from '@/state/evaluate';

/**
 * Two assets, and the sentence that says which one is short.
 *
 * On the previous chain a payment and the fee for sending it were the same token, so "the account
 * is low" was true of both at once and one sentence covered them. Here the mandate holds USDG and
 * the signer pays in ETH. An account can hold a year of USDG and not have the ETH to send the
 * transaction that pauses it, and the reader who is told only that funding is low will top up the
 * balance that was never the problem.
 *
 * So every sentence names its asset, the two are never added or compared, and neither is offered
 * as a fix for the other.
 */
const MANDATE = '0x1111111111111111111111111111111111111111' as Address;
const OWNER = '0x2222222222222222222222222222222222222222' as Address;
const AGENT = '0x3333333333333333333333333333333333333333' as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

const NOW = new Date('2026-09-22T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 86_400_000);

/** Enough ETH for hundreds of payments, so nothing here trips the low-fee warning by accident. */
const FULL_TANK = wei(ROUND_TRIP_FEE * 500n);

function window_(kind: 0 | 1, cap: bigint) {
  return {
    kind: kind === 0 ? WindowKind.Daily : WindowKind.Monthly,
    cap: micro(cap),
    spent: micro(0n),
    remaining: micro(cap),
    duration: BigInt(kind === 0 ? 86_400 : 2_592_000),
    startsAt: NOW,
    resetsAt: LATER,
    epoch: 1n,
  };
}

function account(): MandateRead {
  const daily = window_(0, 100_000_000n);
  const monthly = window_(1, 1_000_000_000n);

  return {
    contractSet: 'v1',
    totalSpent: undefined,
    address: MANDATE,
    principal: OWNER,
    pendingPrincipal: '0x0000000000000000000000000000000000000000' as Address,
    agent: AGENT,
    escrow: '0x5555555555555555555555555555555555555555' as Address,
    settlementAsset: RHC_MAINNET.usdg as Address,
    paused: false,
    revoked: false,
    version: 1n,
    limits: {
      perCallCap: micro(10_000_000n),
      dailyCap: daily.cap,
      monthlyCap: monthly.cap,
      dailyWindow: daily.duration,
      monthlyWindow: monthly.duration,
      approvalThreshold: micro(50_000_000n),
      validFrom: 0n,
      validUntil: 0n,
      classMask: 0,
      totalCap: micro(0n),
      lane: 0,
    },
    remaining: {
      perCall: micro(10_000_000n),
      daily: daily.remaining,
      monthly: monthly.remaining,
      dailyResetsAt: LATER,
      monthlyResetsAt: LATER,
    },
    daily,
    monthly,
    merchantGate: MerchantGate.Allowlist,
    merchantRoot: ZERO_HASH,
    documentHash: ZERO_HASH,
    nonce: 0n,
    balance: micro(500_000_000n) as Micro,
  };
}

function snapshot(funding: Partial<FundingRead>): ChainSnapshot {
  return {
    blockNumber: 1_000n,
    chainTime: NOW,
    readAt: NOW,
    calls: 40,
    failures: 0,
    mandate: account(),
    asset: {
      token: RHC_MAINNET.usdg as Address,
      symbol: 'USDG',
      decimals: 6,
      tokenPaused: false,
      controller: OWNER,
      blocked: {},
      incomplete: false,
    },
    permission: undefined,
    funding: {
      mandateBalance: micro(500_000_000n),
      gasPayer: OWNER,
      gasBalance: FULL_TANK,
      principalBalance: micro(50_000_000n),
      ...funding,
    },
    provider: undefined,
    escrow: {
      address: '0x5555555555555555555555555555555555555555' as Address,
      feeBps: 100,
      minTtl: 60n,
      maxTtl: 86_400n,
      disputeWindow: 3_600n,
      disputeBondBps: 500,
      resolverFeeBps: 50,
      treasury: OWNER,
      minLock: undefined,
      owed: undefined,
    },
    governance: { timelock: OWNER, period: 172_800n },
  };
}

describe('a mandate full of USDG and a signer with no ETH', () => {
  const state = evaluateFunding(snapshot({ gasBalance: wei(0n) }), NOW, false);

  it('is blocked, because nothing can be sent', () => {
    expect(state.level).toBe('blocked');
  });

  it('names ETH as the asset that is short', () => {
    expect(state.headline).toContain('ETH');
    expect(state.detail).toContain('ETH');
  });

  it('says outright that funding the mandate will not fix it', () => {
    expect(state.detail).toContain('USDG in the mandate cannot pay fees');
  });

  it('asks for the asset it is short of, not for money in general', () => {
    expect(state.nextAction?.label).toBe('Send ETH to the signer');
    expect(state.nextAction?.owner).toBe('principal');
  });

  it('quotes the fee in ETH and never with a currency symbol', () => {
    expect(state.detail).not.toContain('$');
  });
});

describe('a signer with ETH and a mandate with no USDG', () => {
  const state = evaluateFunding(snapshot({ mandateBalance: micro(0n) }), NOW, false);

  it('is blocked on the settlement asset, and says which one', () => {
    expect(state.level).toBe('blocked');
    expect(state.headline).toBe('The mandate account holds no USDG.');
  });

  it("says the signer ETH is not what pays a provider", () => {
    expect(state.detail).toContain('Providers are paid in USDG');
  });

  it('sends the reader to the mandate, not to the wallet', () => {
    expect(state.nextAction?.label).toBe('Fund the mandate');
  });
});

describe('the two readings never share a figure', () => {
  it('reports both assets separately when both are funded', () => {
    const state = evaluateFunding(snapshot({}), NOW, false);

    expect(state.level).toBe('ok');
    expect(state.detail).toContain('USDG for payments');
    expect(state.detail).toContain('ETH for fees');
  });

  it('labels each check with the asset it counts', () => {
    const state = evaluateFunding(snapshot({}), NOW, false);
    const labels = state.checks.map((check) => check.label);

    expect(labels).toContain('Mandate account, USDG');
    expect(labels).toContain('Transaction fees, ETH');
  });

  it('counts remaining payments against the ETH fee, not against the balance being spent', () => {
    const state = evaluateFunding(snapshot({ gasBalance: wei(ROUND_TRIP_FEE * 3n) }), NOW, false);

    expect(state.level).toBe('attention');
    expect(state.headline).toBe('ETH for about 3 more payments.');
    expect(state.detail).toContain('Add ETH');
  });

  it('keeps a full mandate from covering for an empty signer in the same report', () => {
    const state = evaluateFunding(snapshot({ gasBalance: wei(0n) }), NOW, false);
    const gas = state.checks.find((check) => check.id === 'gas-float');
    const balance = state.checks.find((check) => check.id === 'mandate-balance');

    expect(gas?.level).toBe('blocked');
    expect(balance?.level).toBe('ok');
  });

  it('carries the fee as ETH on the facts, so nothing downstream can format it as money', () => {
    const state = evaluateFunding(snapshot({}), NOW, false);

    expect(state.facts.roundTripFee).toBe(ROUND_TRIP_FEE);
    expect(state.facts.gasBalance).toBe(FULL_TANK);
  });
});

describe('before anything is read', () => {
  it('names both assets, so a reader knows there are two', () => {
    const state = evaluateFunding(undefined, NOW, false);

    expect(state.level).toBe('not-applicable');
    expect(state.detail).toContain('USDG');
    expect(state.detail).toContain('ETH');
  });
});

/**
 * A balance that was asked for and did not answer.
 *
 * "Funded in both assets" rendered over a funding panel whose ETH line read Unread: the state was
 * claiming a reading it never got, and it is the claim a reader acts on. They stop topping up the
 * wallet that may well be empty, and the next transaction fails on a fee.
 */
describe('a reading that did not land', () => {
  it('does not report a signer whose ETH went unread as funded', () => {
    const state = evaluateFunding(snapshot({ gasBalance: undefined }), NOW, false);

    expect(state.level).toBe('unknown');
    expect(state.headline).not.toContain('Funded for payments and fees');
    expect(state.detail).toContain('did not answer');
    expect(state.nextAction?.label).toBe('Read again');
  });

  it('still says what it did read, so the USDG figure is not lost with it', () => {
    const state = evaluateFunding(snapshot({ gasBalance: undefined }), NOW, false);
    expect(state.detail).toContain('USDG for payments');
  });

  it('does not report a mandate whose USDG went unread as funded', () => {
    const state = evaluateFunding(snapshot({ mandateBalance: undefined }), NOW, false);

    expect(state.level).toBe('unknown');
    expect(state.headline).not.toContain('Funded for payments and fees');
    expect(state.detail).toContain('did not answer');
  });

  it('separates a balance nobody asked about from one that failed to answer', () => {
    // No signer is connected, so there is nothing whose ETH pays a fee and nothing failed.
    const state = evaluateFunding(snapshot({ gasPayer: undefined, gasBalance: undefined }), NOW, false);

    expect(state.level).toBe('ok');
    expect(state.headline).not.toContain('Funded for payments and fees');
    expect(state.headline).toContain('USDG for payments');
    expect(state.detail).toContain('Connect a wallet');
  });
});

describe('a mandate that draws parked value or credit inside a payment', () => {
  it('is not told to fund itself while what it can draw covers the largest payment', () => {
    const state = evaluateFunding(snapshot({ mandateBalance: micro(0n) }), NOW, false, micro(10_000_000_000n) as Micro);
    expect(state.level).toBe('ok');
    expect(state.detail).toContain('can draw');
    expect(state.nextAction).toBeNull();
  });

  it('still warns when the two together fall short, and says both', () => {
    const state = evaluateFunding(snapshot({ mandateBalance: micro(1n) }), NOW, false, micro(1n) as Micro);
    expect(state.level).toBe('attention');
    expect(state.detail).toContain('Together that is less than');
  });
});
