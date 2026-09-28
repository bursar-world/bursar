import { describe, expect, it } from 'vitest';
import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { Underwriter, parseDocument } from '@bursar/underwriter';
import type { AccountState, EscrowTerms, MandateChain, MerchantStanding, PreviewResult } from '@bursar/underwriter';
import { authorizationFrom } from '../src/underwriting/underwriter.js';
import type { MandateUnderwriter, UnderwriteRequest } from '../src/underwriting/underwriter.js';

/**
 * The seam between the decision and the ledger row it becomes.
 *
 * `@bursar/underwriter` is a library with no HTTP surface and this service had a route accepting
 * decisions that nothing produced. The two halves fit or they do not, and only a test that runs a
 * real `Underwriter` into `authorizationFrom` answers that. Everything below the port is the
 * shipped underwriter, unmodified.
 */

const ACCOUNT = '0x07EfBB6214E24a5B97625345D78eca660cAffcAf' as const;
const AGENT = '0xCC5f9c251Fc3C69c04ae2b860b41150282E6B618' as const;
const MERCHANT = '0x7F97980568AD3bFe77B2150b5cdD98eB5f271718' as const;
const ESCROW = '0x4aCAeAdAE9AEf21D23719aa2F3E45A9c7Eda1BD3' as const;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;
const CAPABILITY = '0x220f0024762d0558a93b06e5546a37f5aba35f5c9f7129155e9f1645a80a4a4c' as const;
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

/** The per-call refusal `MandateAccount` raises, taken from the live testnet account. */
const OVER_PER_CALL = '0x71f2ae7a' as const;
const NOW = 1_789_123_156;

/** The limits the live MandateAccount at ACCOUNT was deployed with. */
function accountState(overrides: Partial<AccountState> = {}): AccountState {
  const window = (cap: Micro, seconds: number) => ({
    capMicros: cap,
    spentMicros: micro(0n),
    seconds,
    startSeconds: BigInt(NOW - 60),
    epoch: 1n,
  });
  return {
    account: ACCOUNT,
    principal: AGENT,
    agent: AGENT,
    settlementAsset: USDG,
    escrow: ESCROW,
    paused: false,
    revoked: false,
    version: 1n,
    nonce: 0n,
    documentHash: ZERO,
    limits: {
      perCallCapMicros: micro(2_500_000n),
      dailyCapMicros: micro(50_000_000n),
      monthlyCapMicros: micro(500_000_000n),
      dailyWindowSeconds: 86_400,
      monthlyWindowSeconds: 2_592_000,
      approvalThresholdMicros: micro(1_000_000_000n),
      validFrom: 0n,
      validUntil: 0n,
    },
    daily: window(micro(50_000_000n), 86_400),
    monthly: window(micro(500_000_000n), 2_592_000),
    remaining: { perCall: micro(2_500_000n), daily: micro(50_000_000n), monthly: micro(500_000_000n) },
    merchantGate: { kind: 'allowlist' },
    balanceMicros: micro(10_000_000n),
    ...overrides,
  };
}

const TERMS: EscrowTerms = {
  escrow: ESCROW,
  settlementAsset: USDG,
  reputation: '0x95A14367fA7D9a4F06dd6D41DabbaDB881469a19',
  registry: '0x002750230E742b52F63987704f09f4E44CF4b2C8',
  minTtlSeconds: 300n,
  maxTtlSeconds: 604_800n,
  feeBps: 100,
  disputeBondBps: 500,
};

const STANDING: MerchantStanding = {
  merchant: MERCHANT,
  active: true,
  blacklisted: false,
  capMicros: micro(25_000_000n),
};

function chain(preview: (amount: Micro) => PreviewResult, state = accountState()): MandateChain {
  return {
    async readAccount() {
      return state;
    },
    async previewSpend(_account, _merchant, _capability, amountMicros) {
      return preview(amountMicros);
    },
    async readEscrowTerms() {
      return TERMS;
    },
    async readIssuerControls(asset, parties) {
      // USDG as it answered on 4663 on 2026-09-22: not paused, neither party frozen. A double
      // that left this out would decide every spend without the token's own view of it.
      return {
        asset,
        paused: { state: 'read', value: false },
        parties: parties.map((address) => ({ address, frozen: { state: 'read', value: false } })),
      };
    },
    async readMerchantStanding() {
      return STANDING;
    },
    async readMerchantAllowed() {
      return true;
    },
    async readCapabilityAllowed() {
      return true;
    },
    async blockTimestamp() {
      return BigInt(NOW);
    },
    async simulateSpend() {
      return { ok: true };
    },
  };
}

/** The document a principal publishes alongside the account. It may narrow, never widen. */
function document() {
  return parseDocument({
    subject: 'agent:render-bot',
    account: ACCOUNT,
    chain_id: 4663,
    expires_at: new Date((NOW + 86_400) * 1000).toISOString(),
    rules: [{ effect: 'allow', pattern: 'gpu.*' }],
    ceiling_micros: '100000000',
    per_call_cap_micros: '2500000',
    approval_threshold_micros: '1000000000',
  });
}

function underwriterFor(preview: (amount: Micro) => PreviewResult): MandateUnderwriter {
  const inner = new Underwriter({
    chain: chain(preview),
    chainId: 4663,
    account: ACCOUNT,
    document: document(),
  });
  return { account: ACCOUNT, authorize: (request) => inner.authorize(request) };
}

function spend(amountMicro: Micro, requestNonce: string): UnderwriteRequest {
  return {
    agentId: 'agent:render-bot',
    payerWallet: AGENT,
    repayWallet: AGENT,
    requestNonce,
    network: 'eip155:4663',
    lane: 'prefund',
    poolId: 'prefund-usdg',
    subject: 'agent:render-bot',
    action: 'gpu.render',
    amountMicro,
    merchant: MERCHANT,
    capabilityId: CAPABILITY,
  };
}

describe('the facilitator taking a decision from the underwriter', () => {
  it('records an allowed spend as approved for exactly what was asked', async () => {
    const underwriter = underwriterFor(() => ({ allowed: true, selector: '0x00000000' }));
    const request = spend(micro(1_000_000n), 'req-allow-1');
    const result = await underwriter.authorize({
      requestId: request.requestNonce,
      subject: request.subject,
      action: request.action,
      amountMicros: request.amountMicro,
      at: new Date(NOW * 1000).toISOString(),
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    });

    const row = authorizationFrom(request, result, micro(0n));
    expect(row.approved).toBe(true);
    expect(row.approvedMicro).toBe(1_000_000n);
    expect(row.reasonCodes).toEqual([]);
    // The tightest of the three limits and the balance, which is what the agent can spend next.
    expect(row.availableMicro).toBe(2_500_000n);
    expect(row.documentHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('records a spend the account refuses as unapproved, naming the limit', async () => {
    const underwriter = underwriterFor((amount) =>
      amount > 2_500_000n
        ? { allowed: false, selector: OVER_PER_CALL }
        : { allowed: true, selector: '0x00000000' },
    );
    const request = spend(micro(5_000_000n), 'req-refuse-1');
    const result = await underwriter.authorize({
      requestId: request.requestNonce,
      subject: request.subject,
      action: request.action,
      amountMicros: request.amountMicro,
      at: new Date(NOW * 1000).toISOString(),
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    });

    const row = authorizationFrom(request, result, micro(0n));
    expect(row.approved).toBe(false);
    expect(row.approvedMicro).toBe(0n);
    expect(row.reasonCodes).toContain('over_per_call_cap');
    expect(row.reasonCodes).toContain('per_call');
  });

  it('refuses a capability the document does not cover even when the account allows it', async () => {
    const underwriter = underwriterFor(() => ({ allowed: true, selector: '0x00000000' }));
    const request = { ...spend(micro(1_000_000n), 'req-doc-1'), action: 'search.web' };
    const result = await underwriter.authorize({
      requestId: request.requestNonce,
      subject: request.subject,
      action: request.action,
      amountMicros: request.amountMicro,
      at: new Date(NOW * 1000).toISOString(),
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    });

    const row = authorizationFrom(request, result, micro(0n));
    expect(row.approved).toBe(false);
    expect(row.reasonCodes).toContain('outside_mandate');
  });

  it('answers a repeated request id with the decision already recorded', async () => {
    const underwriter = underwriterFor(() => ({ allowed: true, selector: '0x00000000' }));
    const ask = {
      requestId: 'req-idem-1',
      subject: 'agent:render-bot',
      action: 'gpu.render',
      amountMicros: micro(1_000_000n),
      at: new Date(NOW * 1000).toISOString(),
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    };

    const first = await underwriter.authorize(ask);
    const second = await underwriter.authorize(ask);
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.decision).toEqual(first.decision);
  });
});
