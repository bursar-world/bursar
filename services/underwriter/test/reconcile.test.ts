import { toMicro } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import { documentAnchor } from '../src/anchor.js';
import type { AccountState } from '../src/chain.js';
import { documentHash, parseDocument } from '../src/document.js';
import { type Divergence, type DivergenceKind, reconcile } from '../src/reconcile.js';
import { ACCOUNT, CAPABILITY, DAY, MERCHANT, MONTH, fakeChain } from './support/fake-chain.js';

const CHAIN_ID = 4_663;
const SUBJECT = 'wallet:0x1111111111111111111111111111111111111111';

/** A document that says exactly what the fake account says, so any divergence is the test's doing. */
const MATCHING = {
  subject: SUBJECT,
  account: ACCOUNT,
  chain_id: CHAIN_ID,
  version: 1,
  valid_from: '1970-01-01T00:00:00Z',
  expires_at: '2027-01-01T00:00:00Z',
  rules: [{ effect: 'allow', pattern: 'gpu.*' }],
  ceiling_micros: 100_000_000,
  per_call_cap_micros: 1_000_000,
  approval_threshold_micros: 500_000,
  daily_limit_micros: 5_000_000,
  daily_window_seconds: DAY,
  monthly_limit_micros: 50_000_000,
  monthly_window_seconds: MONTH,
  window_anchor: '1970-01-01T00:00:00Z',
  merchant_gate: { kind: 'allowlist', merchants: [MERCHANT] },
  capabilities: [CAPABILITY],
};

function anchoredState(raw: Record<string, unknown>, overrides: Partial<AccountState> = {}): AccountState {
  const document = parseDocument(raw);
  const base = { ...fakeChain().state.account, ...overrides };
  return {
    ...base,
    documentHash: documentAnchor({
      chainId: CHAIN_ID,
      account: base.account,
      version: base.version,
      documentHash: documentHash(document),
    }),
  };
}

function kinds(divergences: readonly Divergence[]): DivergenceKind[] {
  return divergences.map((divergence) => divergence.kind);
}

const CONTEXT = {
  chainId: CHAIN_ID,
  merchant: { address: MERCHANT, allowed: true },
  capability: { id: CAPABILITY, allowed: true },
};

describe('reconcile', () => {
  test('a document that matches the account diverges only on the terms it alone holds', () => {
    const document = parseDocument(MATCHING);
    const result = reconcile(document, anchoredState(MATCHING), CONTEXT);

    // validUntil is zero on the account, so the document narrows it. Nothing else disagrees.
    expect(kinds(result.divergences)).toEqual(['valid_until']);
    expect(result.critical).toBe(false);
    expect(result.anchor.matches).toBe(true);
  });

  test('a looser per-call cap is critical', () => {
    const raw = { ...MATCHING, per_call_cap_micros: 9_000_000 };
    const result = reconcile(parseDocument(raw), anchoredState(raw), CONTEXT);
    const divergence = result.divergences.find((entry) => entry.kind === 'per_call_cap');

    expect(divergence).toMatchObject({ direction: 'document_looser', severity: 'critical', chain: '1000000' });
    expect(result.critical).toBe(true);
  });

  test('a tighter cap is safe and reported as such', () => {
    const raw = { ...MATCHING, per_call_cap_micros: 100_000 };
    const result = reconcile(parseDocument(raw), anchoredState(raw), CONTEXT);

    expect(result.divergences.find((entry) => entry.kind === 'per_call_cap')).toMatchObject({
      direction: 'document_tighter',
      severity: 'info',
    });
    expect(result.critical).toBe(false);
  });

  test('a document that never mentions a limit the account enforces is a warning', () => {
    const { daily_limit_micros: _limit, daily_window_seconds: _seconds, ...raw } = MATCHING;
    const result = reconcile(parseDocument(raw), anchoredState(raw), CONTEXT);

    expect(result.divergences.filter((entry) => entry.kind === 'daily_limit')).toMatchObject([
      { direction: 'document_silent', severity: 'warn', chain: '5000000' },
    ]);
  });

  test('a shorter window is the looser one, because it refills sooner', () => {
    const raw = { ...MATCHING, daily_window_seconds: 3_600 };
    const result = reconcile(parseDocument(raw), anchoredState(raw), CONTEXT);
    expect(result.divergences.find((entry) => entry.kind === 'daily_window')).toMatchObject({
      direction: 'document_looser',
    });
  });

  test('a higher approval threshold is looser, since it asks for consent less often', () => {
    const raw = { ...MATCHING, approval_threshold_micros: 900_000 };
    const result = reconcile(parseDocument(raw), anchoredState(raw), CONTEXT);
    expect(result.divergences.find((entry) => entry.kind === 'approval_threshold')).toMatchObject({
      direction: 'document_looser',
      severity: 'critical',
    });
  });

  test('a version that is not the live one is a mismatch', () => {
    const raw = { ...MATCHING, version: 2 };
    const result = reconcile(parseDocument(raw), anchoredState(MATCHING), CONTEXT);
    expect(result.divergences.find((entry) => entry.kind === 'version')).toMatchObject({
      direction: 'mismatch',
      document: '2',
      chain: '1',
    });
  });

  test('an account that never anchored anything is reported once, as a warning', () => {
    const state = { ...fakeChain().state.account, documentHash: `0x${'0'.repeat(64)}` } as AccountState;
    const result = reconcile(parseDocument(MATCHING), state, CONTEXT);

    expect(kinds(result.divergences)).toContain('unanchored');
    expect(kinds(result.divergences)).not.toContain('anchor');
  });

  test('an anchor for a different document is a mismatch', () => {
    const state = { ...fakeChain().state.account, documentHash: `0x${'ab'.repeat(32)}` } as AccountState;
    const result = reconcile(parseDocument(MATCHING), state, CONTEXT);
    expect(result.divergences.find((entry) => entry.kind === 'anchor')).toMatchObject({ direction: 'mismatch' });
  });

  test('a limit change invalidates the anchor even though the document is untouched', () => {
    const stale = anchoredState(MATCHING);
    const afterSetLimits = { ...stale, version: 2n };
    const result = reconcile(parseDocument(MATCHING), afterSetLimits, CONTEXT);

    expect(kinds(result.divergences)).toContain('anchor');
    expect(result.critical).toBe(true);
  });

  test('a gate the account is not running is a mismatch', () => {
    const raw = { ...MATCHING, merchant_gate: { kind: 'merkleRoot', root: `0x${'11'.repeat(32)}` } };
    const result = reconcile(parseDocument(raw), anchoredState(raw), CONTEXT);
    expect(result.divergences.find((entry) => entry.kind === 'merchant_gate')).toMatchObject({
      direction: 'mismatch',
      document: 'merkleRoot',
      chain: 'allowlist',
    });
  });

  test('a merchant the document lists and the account does not is critical', () => {
    const result = reconcile(parseDocument(MATCHING), anchoredState(MATCHING), {
      ...CONTEXT,
      merchant: { address: MERCHANT, allowed: false },
    });
    expect(result.divergences.find((entry) => entry.kind === 'merchant_allowlist')).toMatchObject({
      direction: 'document_looser',
      severity: 'critical',
    });
  });

  test('a capability the document lists and the account does not is critical', () => {
    const result = reconcile(parseDocument(MATCHING), anchoredState(MATCHING), {
      ...CONTEXT,
      capability: { id: CAPABILITY, allowed: false },
    });
    expect(result.divergences.find((entry) => entry.kind === 'capability')).toMatchObject({
      direction: 'document_looser',
      severity: 'critical',
    });
  });

  test('an account with an expiry the document outlives is critical', () => {
    const state = anchoredState(MATCHING, {
      limits: { ...fakeChain().state.account.limits, validUntil: BigInt(Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000)) },
    });
    const result = reconcile(parseDocument(MATCHING), state, CONTEXT);
    expect(result.divergences.find((entry) => entry.kind === 'valid_until')).toMatchObject({
      direction: 'document_looser',
      severity: 'critical',
    });
  });

  test('amounts are reported as exact atomic micro-USD, never formatted', () => {
    const raw = { ...MATCHING, per_call_cap_micros: 1_234_567 };
    const result = reconcile(parseDocument(raw), anchoredState(raw), CONTEXT);
    expect(result.divergences.find((entry) => entry.kind === 'per_call_cap')?.document).toBe('1234567');
    expect(toMicro('1234567')).toBe(1_234_567n);
  });
});
