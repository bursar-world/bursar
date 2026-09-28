import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';

import { MAX_AMOUNT_MICROS } from '../src/document.js';
import { evaluateDocument } from '../src/policy.js';
import { SpendLog } from '../src/log.js';
import { reconcile } from '../src/reconcile.js';
import { deriveDocument } from '../src/store/derive.js';
import { CAPABILITY, MERCHANT, fakeChain } from './support/fake-chain.js';

/**
 * The `chain` document source, which is the default.
 *
 * What matters here is that the derived terms cannot be tighter or looser than the account's. A
 * derived document that added a limit would be this service inventing one; a derived document that
 * dropped one would leave a limit to the contract alone, which is safe but makes the quote's
 * headroom wrong.
 */

const CHAIN_ID = 4663;

async function derived(overrides: Parameters<typeof fakeChain>[0] = {}) {
  const chain = fakeChain(overrides);
  const state = await chain.readAccount(chain.state.account.account);
  return { state, document: deriveDocument('agent-1', state, CHAIN_ID) };
}

describe('a mandate derived from the account', () => {
  it('mirrors every limit the account holds', async () => {
    const { state, document } = await derived();

    expect(document.subject).toBe('agent-1');
    expect(document.account).toBe(state.account);
    expect(document.chainId).toBe(CHAIN_ID);
    expect(document.version).toBe(state.version);
    expect(document.perCallCapMicros).toBe(state.limits.perCallCapMicros);
    expect(document.approvalThresholdMicros).toBe(state.limits.approvalThresholdMicros);
    expect(document.daily).toEqual({ limitMicros: state.limits.dailyCapMicros, seconds: 86_400 });
    expect(document.monthly).toEqual({ limitMicros: state.limits.monthlyCapMicros, seconds: 2_592_000 });
  });

  it('adds no limit the contract does not have', async () => {
    const { document } = await derived();

    // No lifetime ceiling exists on chain, so the derived one is the widest amount the account can
    // store and cannot bind.
    expect(document.ceilingMicros).toBe(MAX_AMOUNT_MICROS);
    // No action rules on chain either: the capability allowlist is the contract's gate and
    // `previewSpend` applies it.
    expect(evaluateDocument(document, new SpendLog(), spend('anything.at.all'))).toEqual({ decision: 'allow' });
    // Neither roster can be enumerated through a read, so neither is claimed.
    expect(document.merchantGate).toBeNull();
    expect(document.capabilities).toBeNull();
  });

  it('reports no disagreement with the account it came from', async () => {
    const { state, document } = await derived();

    const { divergences } = reconcile(document, state, {
      chainId: CHAIN_ID,
      merchant: { address: MERCHANT, allowed: true },
      capability: { id: CAPABILITY, allowed: true },
    });

    // The gaps are the two mappings a read cannot enumerate, the account not having anchored a
    // document hash, and an account with no expiry. None is a conflict and none is critical.
    expect(divergences.filter((d) => d.severity === 'critical')).toEqual([]);
    expect(divergences.map((d) => d.kind).sort()).toEqual([
      'capability',
      'merchant_gate',
      'unanchored',
      'valid_until',
    ]);
  });

  it('carries an account that never expires as a document that effectively never does', async () => {
    const { document } = await derived();
    expect(Date.parse(document.expiresAt)).toBeGreaterThan(Date.now() + 1_000 * 86_400 * 365);
  });

  it('carries a validity that runs past the calendar as a document rather than a crash', async () => {
    const forever = 2n ** 64n - 1n;
    const { document } = await derived({
      limits: {
        perCallCapMicros: toMicro(1_000_000),
        dailyCapMicros: toMicro(5_000_000),
        monthlyCapMicros: toMicro(50_000_000),
        dailyWindowSeconds: 86_400,
        monthlyWindowSeconds: 2_592_000,
        approvalThresholdMicros: toMicro(500_000),
        // `_setLimits` only asks that validUntil beat validFrom, so both ends of a uint64 are legal
        // and neither survives `new Date`.
        validFrom: forever - 1n,
        validUntil: forever,
      },
    });

    expect(Date.parse(document.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(document.validFrom ?? '')).toBeLessThan(Date.parse(document.expiresAt));
  });

  it('declares no rolling window where the account runs none', async () => {
    const { document } = await derived({
      limits: {
        perCallCapMicros: toMicro(1_000_000),
        dailyCapMicros: toMicro(0),
        monthlyCapMicros: toMicro(0),
        dailyWindowSeconds: 0,
        monthlyWindowSeconds: 0,
        approvalThresholdMicros: toMicro(500_000),
        validFrom: 0n,
        validUntil: 0n,
      },
    });

    expect(document.daily).toBeNull();
    expect(document.monthly).toBeNull();
    expect(document.windowAnchor).toBeNull();
  });
});

function spend(action: string) {
  return {
    requestId: 'r-1',
    subject: 'agent-1',
    action,
    amountMicros: toMicro(100_000),
    at: new Date().toISOString(),
    merchant: MERCHANT,
    capabilityId: CAPABILITY,
  };
}
