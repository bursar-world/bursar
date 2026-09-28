import { toMicro } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import { RefuseReason, allow, hold, refuse } from '../src/decision.js';
import { type Hex32, parseDocument } from '../src/document.js';
import { RequestError } from '../src/errors.js';
import { SpendLog } from '../src/log.js';
import { merchantLeaf } from '../src/merkle.js';
import { type SpendRequest, evaluateDocument, windowStartMs } from '../src/policy.js';

const SUBJECT = 'wallet:0x1111111111111111111111111111111111111111';
const MERCHANT = '0x4444444444444444444444444444444444444444';
const OTHER_MERCHANT = '0x5555555555555555555555555555555555555555';
const CAPABILITY: Hex32 = `0x${'ab'.repeat(32)}`;

const BASE = {
  subject: SUBJECT,
  valid_from: '2026-01-01T00:00:00Z',
  expires_at: '2027-01-01T00:00:00Z',
  rules: [
    { effect: 'allow', pattern: 'gpu.*' },
    { effect: 'deny', pattern: 'gpu.experimental' },
  ],
  ceiling_micros: 2_000_000,
  per_call_cap_micros: 1_000_000,
  approval_threshold_micros: 500_000,
};

function request(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    requestId: 'r1',
    subject: SUBJECT,
    action: 'gpu.lease',
    amountMicros: toMicro(100_000),
    at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('evaluateDocument', () => {
  const document = parseDocument(BASE);

  test('allows a request inside every limit', () => {
    expect(evaluateDocument(document, new SpendLog(), request())).toEqual(allow());
  });

  test('refuses a subject the mandate was not written for', () => {
    expect(evaluateDocument(document, new SpendLog(), request({ subject: 'wallet:0xdead' }))).toEqual(
      refuse(RefuseReason.WrongSubject),
    );
  });

  test('refuses a zero amount, because the contract reverts on it', () => {
    expect(evaluateDocument(document, new SpendLog(), request({ amountMicros: toMicro(0) }))).toEqual(
      refuse(RefuseReason.ZeroAmount),
    );
  });

  test('refuses before valid_from and at or after expires_at', () => {
    expect(evaluateDocument(document, new SpendLog(), request({ at: '2025-12-31T23:59:59Z' }))).toEqual(
      refuse(RefuseReason.NotYetValid),
    );
    expect(evaluateDocument(document, new SpendLog(), request({ at: '2027-01-01T00:00:00Z' }))).toEqual(
      refuse(RefuseReason.Expired),
    );
    expect(evaluateDocument(document, new SpendLog(), request({ at: '2026-12-31T23:59:59Z' }))).toEqual(allow());
  });

  test('an action nobody mentioned is outside the mandate', () => {
    expect(evaluateDocument(document, new SpendLog(), request({ action: 'storage.put' }))).toEqual(
      refuse(RefuseReason.OutsideMandate),
    );
    expect(evaluateDocument(document, new SpendLog(), request({ action: 'gpu.experimental' }))).toEqual(
      refuse(RefuseReason.OutsideMandate),
    );
  });

  test('refuses over the per-call cap and allows exactly at it', () => {
    expect(evaluateDocument(document, new SpendLog(), request({ amountMicros: toMicro(1_000_001) }))).toEqual(
      refuse(RefuseReason.OverPerCallCap),
    );
    expect(evaluateDocument(document, new SpendLog(), request({ amountMicros: toMicro(1_000_000) }))).toEqual(
      hold(toMicro(500_000)),
    );
  });

  test('the threshold binds at and above, matching MandateAccount', () => {
    expect(evaluateDocument(document, new SpendLog(), request({ amountMicros: toMicro(499_999) }))).toEqual(allow());
    expect(evaluateDocument(document, new SpendLog(), request({ amountMicros: toMicro(500_000) }))).toEqual(
      hold(toMicro(500_000)),
    );
  });

  test('a call exactly at the ceiling is allowed and the next micro is not', () => {
    const log = new SpendLog();
    log.record(
      { requestId: 'prior', subject: SUBJECT, action: 'gpu.lease', amountMicros: toMicro(1_900_000), at: '2026-06-01T00:00:00Z' },
      allow(),
    );

    expect(evaluateDocument(document, log, request({ amountMicros: toMicro(100_000) }))).toEqual(allow());
    expect(evaluateDocument(document, log, request({ amountMicros: toMicro(100_001) }))).toEqual(
      refuse(RefuseReason.OverCumulativeCeiling),
    );
  });

  test('rejects a malformed request rather than deciding it', () => {
    expect(() => evaluateDocument(document, new SpendLog(), request({ requestId: '' }))).toThrow(RequestError);
    expect(() => evaluateDocument(document, new SpendLog(), request({ at: 'yesterday' }))).toThrow();
  });
});

describe('rolling windows', () => {
  const document = parseDocument({
    ...BASE,
    daily_limit_micros: 300_000,
    daily_window_seconds: 86_400,
    monthly_limit_micros: 1_000_000,
    monthly_window_seconds: 30 * 86_400,
    window_anchor: '2026-01-01T00:00:00Z',
  });

  function spend(log: SpendLog, id: string, amount: number, at: string): void {
    log.record({ requestId: id, subject: SUBJECT, action: 'gpu.lease', amountMicros: toMicro(amount), at }, allow());
  }

  test('the daily bucket runs out before the monthly one', () => {
    const log = new SpendLog();
    spend(log, 'a', 250_000, '2026-06-01T01:00:00Z');

    expect(evaluateDocument(document, log, request({ amountMicros: toMicro(50_000), at: '2026-06-01T02:00:00Z' }))).toEqual(
      allow(),
    );
    expect(evaluateDocument(document, log, request({ amountMicros: toMicro(50_001), at: '2026-06-01T02:00:00Z' }))).toEqual(
      refuse(RefuseReason.DailyCapExceeded),
    );
  });

  test('the daily bucket refills on the next period', () => {
    const log = new SpendLog();
    spend(log, 'a', 300_000, '2026-06-01T01:00:00Z');

    expect(evaluateDocument(document, log, request({ amountMicros: toMicro(1), at: '2026-06-01T23:00:00Z' }))).toEqual(
      refuse(RefuseReason.DailyCapExceeded),
    );
    expect(evaluateDocument(document, log, request({ amountMicros: toMicro(100_000), at: '2026-06-02T01:00:00Z' }))).toEqual(
      allow(),
    );
  });

  test('the monthly bucket still binds after the daily one has refilled', () => {
    const log = new SpendLog();
    for (let day = 1; day <= 3; day++) {
      spend(log, `d${day}`, 250_000, `2026-01-0${day}T01:00:00Z`);
    }

    // Day five starts with a full daily bucket, so only the monthly one is left to bind.
    expect(evaluateDocument(document, log, request({ amountMicros: toMicro(250_000), at: '2026-01-05T01:00:00Z' }))).toEqual(
      allow(),
    );
    expect(evaluateDocument(document, log, request({ amountMicros: toMicro(250_001), at: '2026-01-05T01:00:00Z' }))).toEqual(
      refuse(RefuseReason.MonthlyCapExceeded),
    );
  });

  test('waiting out a window does not buy a fresh one on the agent\'s schedule', () => {
    const anchor = Date.parse('2026-01-01T00:00:00Z');
    const day = 86_400_000;

    // A spend six hours into a period still leaves the period ending at the same wall clock.
    expect(windowStartMs(anchor, 86_400, anchor + 6 * 3_600_000)).toBe(anchor);
    expect(windowStartMs(anchor, 86_400, anchor + day)).toBe(anchor + day);
    expect(windowStartMs(anchor, 86_400, anchor + 2 * day + 1)).toBe(anchor + 2 * day);
  });

  test('a request before the anchor sits in the first period', () => {
    const anchor = Date.parse('2026-01-01T00:00:00Z');
    expect(windowStartMs(anchor, 86_400, anchor - 1_000)).toBe(anchor);
  });
});

describe('merchant gate', () => {
  test('an allowlist refuses an address it does not name', () => {
    const document = parseDocument({ ...BASE, merchant_gate: { kind: 'allowlist', merchants: [MERCHANT] } });
    expect(evaluateDocument(document, new SpendLog(), request({ merchant: MERCHANT }))).toEqual(allow());
    expect(evaluateDocument(document, new SpendLog(), request({ merchant: OTHER_MERCHANT }))).toEqual(
      refuse(RefuseReason.MerchantNotAllowed),
    );
  });

  test('a proof carried into an allowlist gate is refused, not ignored', () => {
    const document = parseDocument({ ...BASE, merchant_gate: { kind: 'allowlist', merchants: [MERCHANT] } });
    expect(
      evaluateDocument(document, new SpendLog(), request({ merchant: MERCHANT, merchantProof: [`0x${'11'.repeat(32)}`] })),
    ).toEqual(refuse(RefuseReason.StaleMerchantProof));
  });

  test('a Merkle gate with no proof is undecidable, which is a refusal', () => {
    const document = parseDocument({ ...BASE, merchant_gate: { kind: 'merkleRoot', root: merchantLeaf(MERCHANT) } });
    expect(evaluateDocument(document, new SpendLog(), request({ merchant: MERCHANT }))).toEqual(
      refuse(RefuseReason.MerchantGateUndecidable),
    );
  });

  test('a single-leaf root verifies with an empty proof and refuses a stranger', () => {
    const document = parseDocument({ ...BASE, merchant_gate: { kind: 'merkleRoot', root: merchantLeaf(MERCHANT) } });
    expect(evaluateDocument(document, new SpendLog(), request({ merchant: MERCHANT, merchantProof: [] }))).toEqual(allow());
    expect(evaluateDocument(document, new SpendLog(), request({ merchant: OTHER_MERCHANT, merchantProof: [] }))).toEqual(
      refuse(RefuseReason.BadMerkleProof),
    );
  });

  test('a gate with no merchant on the request refuses', () => {
    const document = parseDocument({ ...BASE, merchant_gate: { kind: 'allowlist', merchants: [MERCHANT] } });
    expect(evaluateDocument(document, new SpendLog(), request())).toEqual(refuse(RefuseReason.ZeroAddress));
  });
});

describe('capability list', () => {
  const document = parseDocument({ ...BASE, capabilities: [CAPABILITY] });

  test('admits a listed capability', () => {
    expect(evaluateDocument(document, new SpendLog(), request({ capabilityId: CAPABILITY }))).toEqual(allow());
  });

  test('refuses an unlisted one and a missing one', () => {
    expect(evaluateDocument(document, new SpendLog(), request({ capabilityId: `0x${'cd'.repeat(32)}` }))).toEqual(
      refuse(RefuseReason.CapabilityNotAllowed),
    );
    expect(evaluateDocument(document, new SpendLog(), request())).toEqual(refuse(RefuseReason.CapabilityNotAllowed));
  });

  test('a document that declares no list defers the term to the account', () => {
    expect(evaluateDocument(parseDocument(BASE), new SpendLog(), request())).toEqual(allow());
  });
});
