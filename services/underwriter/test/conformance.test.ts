import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toMicro } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import type { Decision, RefuseReason } from '../src/decision.js';
import { parseDocument } from '../src/document.js';
import { SpendLog } from '../src/log.js';
import { authorizeAgainstDocument, type SpendRequest } from '../src/policy.js';

type VectorDecision =
  | { decision: 'allow' }
  | { decision: 'hold'; threshold_micros: number }
  | { decision: 'refuse'; reason: string };

type VectorStep =
  | {
      type: 'request';
      request: { request_id: string; subject: string; action: string; amount_micros: number; at: string };
      expect: VectorDecision;
      expect_idempotent: boolean;
      note?: string;
    }
  | { type: 'settle'; settles: string; resolution: 'approve' | 'deny'; at: string; expect: VectorDecision; note?: string };

type Vector = {
  description: string;
  mandate: unknown;
  steps: VectorStep[];
  expected_entries: number;
  expected_committed_micros: number;
  expected_root: string;
};

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(readFileSync(join(here, 'vectors', 'decisions.json'), 'utf8')) as Vector;

// The vector writes amounts as JSON numbers; this port carries them as bigint. Widening the
// expectation is the only adaptation made to the vector, and the file itself is byte-identical
// to the one the reference implementation is pinned by.
function asDecision(expected: VectorDecision): Decision {
  if (expected.decision === 'hold') return { decision: 'hold', threshold_micros: toMicro(expected.threshold_micros) };
  if (expected.decision === 'refuse') return { decision: 'refuse', reason: expected.reason as RefuseReason };
  return { decision: 'allow' };
}

function asRequest(raw: { request_id: string; subject: string; action: string; amount_micros: number; at: string }): SpendRequest {
  return {
    requestId: raw.request_id,
    subject: raw.subject,
    action: raw.action,
    amountMicros: toMicro(raw.amount_micros),
    at: raw.at,
  };
}

describe('conformance vector', () => {
  test('reproduces every decision, the committed total and the anchored root', () => {
    const document = parseDocument(vector.mandate, 'conformance mandate');
    const log = new SpendLog();

    vector.steps.forEach((step, index) => {
      if (step.type === 'request') {
        const before = log.length;
        const { decision, idempotent } = authorizeAgainstDocument(log, document, asRequest(step.request));
        const appended = log.length > before;

        expect(decision, `step ${index} decision`).toEqual(asDecision(step.expect));
        expect(idempotent, `step ${index} idempotent flag`).toBe(step.expect_idempotent);
        expect(!appended, `step ${index} append behaviour`).toBe(step.expect_idempotent);
        return;
      }

      const { decision } = log.settle(step.settles, step.resolution, step.at);
      expect(decision, `step ${index} settlement`).toEqual(asDecision(step.expect));
    });

    expect(log.length, 'entry count').toBe(vector.expected_entries);
    expect(log.committedMicros(), 'committed micros').toBe(toMicro(vector.expected_committed_micros));
    expect(log.verify()).toEqual({ valid: true, root: vector.expected_root });
    expect(log.root(), 'final root').toBe(vector.expected_root);
  });

  test('a decision body with chain context still hashes over the pinned prefix', () => {
    const document = parseDocument(vector.mandate);
    const plain = new SpendLog();
    const enriched = new SpendLog();

    const request = asRequest((vector.steps[0] as Extract<VectorStep, { type: 'request' }>).request);

    authorizeAgainstDocument(plain, document, request);
    enriched.record(
      {
        requestId: request.requestId,
        subject: request.subject,
        action: request.action,
        amountMicros: request.amountMicros,
        at: request.at,
        account: '0x00000000000000000000000000000000000000aA',
        accountVersion: 7n,
      },
      { decision: 'allow' },
    );

    // Same prefix, different suffix: the chain-bound entry must not collide with the plain one.
    expect(enriched.root()).not.toBe(plain.root());
    expect(enriched.verify()).toMatchObject({ valid: true });
  });
});
