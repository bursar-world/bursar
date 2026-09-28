import { describe, expect, it } from 'vitest';

import {
  RefuseReason,
  capabilityFromAction,
  capabilityId,
  evaluateDocument,
  micro,
  parseRule,
  spendHistory,
} from '../src/index.js';
import type { MandateDocument } from '../src/index.js';

const AT = '2026-10-01T12:00:00.000Z';
const PAYEE = '0x00000000000000000000000000000000000000aa' as const;

const DOC: MandateDocument = {
  subject: 'draft',
  account: null,
  chainId: null,
  version: null,
  validFrom: null,
  expiresAt: '2027-01-01T00:00:00.000Z',
  rules: [parseRule('service:*', 'allow')],
  ceilingMicros: micro(1_000_000n),
  perCallCapMicros: micro(400_000n),
  approvalThresholdMicros: null,
  daily: { limitMicros: micro(500_000n), seconds: 86_400 },
  monthly: null,
  windowAnchor: AT,
  merchantGate: { kind: 'allowlist', merchants: [PAYEE] },
  capabilities: [capabilityId('service:gpu.render:1')],
};

const request = (amount: bigint) => ({
  requestId: 'r',
  subject: 'draft',
  action: 'service:gpu.render:1',
  amountMicros: micro(amount),
  at: AT,
  merchant: PAYEE,
  capabilityId: capabilityId('service:gpu.render:1'),
});

describe('evaluateDocument, from core', () => {
  it('allows a spend inside every rule against a plain history', () => {
    expect(evaluateDocument(DOC, spendHistory([]), request(100_000n))).toEqual({ decision: 'allow' });
  });

  it('counts only history inside the period against the period cap', () => {
    const history = spendHistory([
      { amountMicros: micro(300_000n), atMs: Date.parse(AT) },
      { amountMicros: micro(400_000n), atMs: 0 },
    ]);
    expect(evaluateDocument(DOC, history, request(300_000n))).toEqual({
      decision: 'refuse',
      reason: RefuseReason.DailyCapExceeded,
    });
    expect(evaluateDocument(DOC, history, request(200_000n))).toEqual({ decision: 'allow' });
  });

  it('holds the total across periods', () => {
    const history = spendHistory([{ amountMicros: micro(900_000n), atMs: 0 }]);
    expect(evaluateDocument(DOC, history, request(200_000n))).toEqual({
      decision: 'refuse',
      reason: RefuseReason.OverCumulativeCeiling,
    });
  });

  it('reads a class-namespaced action as its capability', () => {
    expect(capabilityFromAction('service:gpu.render:1')).toBe(capabilityId('service:gpu.render:1'));
    expect(capabilityFromAction('gpu.render:1')).toBe(capabilityId('gpu.render:1'));
    expect(capabilityFromAction('not a label')).toBeNull();
  });
});
