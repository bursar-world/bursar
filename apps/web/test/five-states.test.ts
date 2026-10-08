import { RHC_MAINNET, micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { MerchantGate, WindowKind } from '@bursar/sdk';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import type { AssetRead, ChainSnapshot, EscrowRead, FundingRead, MandateRead, PermissionRead } from '@/chain/reader';
import type { ProviderHealth } from '@/chain/client';
import { wei } from '@/money';
import { evaluateAsset, evaluateConnectivity, evaluateFunding, evaluateMandate, evaluatePermission } from '@/state/evaluate';
import type { AnyState, StateLevel } from '@/state/types';

/**
 * The five states, and the one thing that must never happen to them.
 *
 * Each of the five has a different owner: the asset belongs to the token issuer, the mandate and
 * its funding to the principal, the permissions to whoever wrote the allowlist, connectivity to the
 * operator. A screen that reduces them to one light throws away the only thing that tells a
 * treasurer who to call, and a reading that failed is not the same answer as a reading that came
 * back clear. Both of those regressed once.
 */

const MANDATE = '0x1111111111111111111111111111111111111111' as Address;
const OWNER = '0x2222222222222222222222222222222222222222' as Address;
const AGENT = '0x3333333333333333333333333333333333333333' as Address;
const PAYEE = '0x4444444444444444444444444444444444444444' as Address;
const USDG = RHC_MAINNET.usdg as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

const HOUR = 3_600;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-16T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + DAY * 1000);

function window_(kind: 0 | 1, cap: bigint, spent: bigint) {
  return {
    kind: kind === 0 ? WindowKind.Daily : WindowKind.Monthly,
    cap: micro(cap),
    spent: micro(spent),
    remaining: micro(cap - spent),
    duration: BigInt(kind === 0 ? DAY : 30 * DAY),
    startsAt: NOW,
    resetsAt: LATER,
    epoch: 1n,
  };
}

function account(overrides: Partial<MandateRead> = {}): MandateRead {
  const daily = window_(0, 100_000_000n, 0n);
  const monthly = window_(1, 1_000_000_000n, 0n);

  return {
    contractSet: 'v1',
    totalSpent: undefined,
    address: MANDATE,
    principal: OWNER,
    pendingPrincipal: '0x0000000000000000000000000000000000000000' as Address,
    agent: AGENT,
    escrow: '0x5555555555555555555555555555555555555555' as Address,
    settlementAsset: USDG,
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
    balance: micro(500_000_000n),
    ...overrides,
  };
}

function asset(overrides: Partial<AssetRead> = {}): AssetRead {
  return {
    token: USDG,
    symbol: 'USDG',
    decimals: 6,
    tokenPaused: false,
    controller: OWNER,
    blocked: {},
    incomplete: false,
    ...overrides,
  };
}

function funding(overrides: Partial<FundingRead> = {}): FundingRead {
  return {
    mandateBalance: micro(500_000_000n),
    gasPayer: OWNER,
    gasBalance: wei(20_000_000_000_000_000n),
    principalBalance: micro(50_000_000n),
    ...overrides,
  };
}

const ESCROW: EscrowRead = {
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
  paused: false,
};

function snapshot(overrides: Partial<ChainSnapshot> = {}): ChainSnapshot {
  return {
    blockNumber: 1_000n,
    chainTime: NOW,
    readAt: NOW,
    calls: 40,
    failures: 0,
    mandate: account(),
    asset: asset(),
    permission: undefined,
    funding: funding(),
    provider: undefined,
    escrow: ESCROW,
    governance: { timelock: OWNER, period: 172_800n },
    ...overrides,
  };
}

function permission(overrides: Partial<PermissionRead> = {}): PermissionRead {
  return {
    merchant: PAYEE,
    amount: micro(1_000_000n) as Micro,
    merchantAllowed: true,
    merchantLeaf: undefined,
    capability: 'doc.summarize:1',
    capabilityId: '0x8fb1176b549d99281bea37a37ac4ed9bb015c29010b11bd0d9a7acb43d1d19e9' as Hex,
    capabilityAllowed: true,
    preview: { allowed: true, reason: undefined, errorName: undefined },
    ...overrides,
  };
}

function reachable(name: string, chainId: number): ProviderHealth {
  return {
    name,
    url: `https://${name}.example`,
    reachable: true,
    chainId,
    blockNumber: 1_000n,
    latencyMs: 20,
    problem: null,
    breaker: 'closed',
    throttled: 0,
    failures: 0,
  };
}

function five(current: ChainSnapshot | undefined, providers: readonly ProviderHealth[], chainId = RHC_MAINNET.chainId): readonly AnyState[] {
  return [
    evaluateConnectivity(providers, chainId, current?.blockNumber, NOW, false),
    evaluateAsset(current, NOW, false),
    evaluateMandate(current, NOW, false, MANDATE),
    evaluatePermission(current, NOW, false),
    evaluateFunding(current, NOW, false),
  ];
}

describe('the five states are five', () => {
  it('reports one subject each, with its own owner and its own next action', () => {
    const states = five(snapshot({ permission: permission() }), [reachable('primary', RHC_MAINNET.chainId), reachable('fallback', RHC_MAINNET.chainId)]);

    expect(states.map((state) => state.key)).toEqual(['connectivity', 'asset', 'mandate', 'permission', 'funding']);
    expect(new Set(states.map((state) => state.headline)).size).toBe(states.length);
  });

  it('keeps a blocked asset out of the other four', () => {
    const states = five(
      snapshot({ asset: asset({ tokenPaused: true }), permission: permission() }),
      [reachable('primary', RHC_MAINNET.chainId), reachable('fallback', RHC_MAINNET.chainId)],
    );

    const levels = Object.fromEntries(states.map((state) => [state.key, state.level])) as Record<string, StateLevel>;
    expect(levels.asset).toBe('blocked');
    expect(levels.mandate).toBe('ok');
    expect(levels.permission).toBe('ok');
    expect(levels.funding).toBe('ok');
    expect(levels.connectivity).toBe('ok');
  });

  it('filters blockers and never merges them', () => {
    const states = five(
      snapshot({ asset: asset({ tokenPaused: true }), mandate: account({ paused: true }), permission: permission() }),
      [reachable('primary', RHC_MAINNET.chainId), reachable('fallback', RHC_MAINNET.chainId)],
    );

    const blockers = states.filter((state) => state.level === 'blocked');
    expect(blockers.map((state) => state.key)).toEqual(['asset', 'mandate']);
    expect(blockers[0]?.nextAction?.owner).toBe('token-issuer');
    expect(blockers[1]?.nextAction?.owner).toBe('principal');
    expect(blockers[0]?.detail).not.toBe(blockers[1]?.detail);
  });

  it('carries no combined verdict on any report', () => {
    const states = five(snapshot({ permission: permission() }), [reachable('primary', RHC_MAINNET.chainId)]);
    const merged = ['overall', 'verdict', 'ready', 'healthy', 'status', 'summary'];

    for (const state of states) {
      for (const name of merged) {
        expect(Object.hasOwn(state, name), `${state.key} grew a ${name}`).toBe(false);
      }
    }
  });
});

describe('a reading that did not land is never a clear one', () => {
  it('answers unknown before the first reading', () => {
    const states = five(undefined, []);
    const levels = Object.fromEntries(states.map((state) => [state.key, state.level])) as Record<string, StateLevel>;

    expect(levels.asset).toBe('unknown');
    expect(levels.connectivity).toBe('unknown');
    expect(levels.mandate).toBe('unknown');
    for (const state of states) expect(state.level).not.toBe('ok');
  });

  it('answers unknown when a compliance read is missing, not clear', () => {
    const partial = evaluateAsset(snapshot({ asset: asset({ incomplete: true }) }), NOW, false);
    expect(partial.level).toBe('unknown');
    expect(partial.level).not.toBe('ok');
  });

  it('answers unknown when neither allowlist replied, not allowed', () => {
    const unread = evaluatePermission(
      snapshot({ permission: permission({ merchantAllowed: undefined, capabilityAllowed: undefined, preview: undefined }) }),
      NOW,
      false,
    );

    expect(unread.level).toBe('unknown');
    expect(unread.headline).toBe('The payee and work lists did not answer.');
  });

  it('separates a state nothing was asked of from a state that is clear', () => {
    const nothingAsked = evaluateMandate(snapshot(), NOW, false, undefined);
    expect(nothingAsked.level).toBe('not-applicable');
    expect(nothingAsked.level).not.toBe('ok');

    const noPayeeNamed = evaluatePermission(snapshot({ permission: undefined }), NOW, false);
    expect(noPayeeNamed.level).toBe('not-applicable');
  });

  it('keeps an endpoint on the wrong chain out of the reachable count', () => {
    const wrong = evaluateConnectivity([reachable('primary', RHC_MAINNET.chainId), reachable('fallback', 1)], RHC_MAINNET.chainId, 1_000n, NOW, false);
    expect(wrong.level).toBe('blocked');
    expect(wrong.headline).toBe('An endpoint is serving a different chain.');
  });
});

describe('a stopped escrow', () => {
  it('blocks the mandate, because no payment can lock while the guardian holds the brake', () => {
    const state = evaluateMandate(snapshot({ escrow: { ...ESCROW, paused: true } }), NOW, false, MANDATE);

    expect(state.level).toBe('blocked');
    expect(state.headline).toBe('The escrow is stopped.');
    expect(state.checks[0]?.label).toBe('Escrow');
  });
});

describe('approvalSentence', () => {
  it('never prints an unreachable threshold', async () => {
    const { approvalSentence } = await import('@/state/evaluate');
    const max = (1n << 128n) - 1n;
    expect(approvalSentence(20_000n as never, max as never)).toBe('No payment needs the owner’s signature.');
    expect(approvalSentence(20_000n as never, 20_000n as never)).toBe('At or above $0.02, the owner signs personally.');
    expect(approvalSentence(20_000n as never, 0n as never)).toBe('The owner signs every payment personally.');
  });
});
