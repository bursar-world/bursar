import { describe, expect, it } from 'vitest';

import { POLICY_VERSION, rule } from '../src/policy.js';
import type { DeliveryCheck, PolicyEvidence, RuleId } from '../src/policy.js';

const DELIVERED: DeliveryCheck = {
  hash: `0x${'e1'.repeat(32)}`,
  signedByPayee: true,
  inputMatches: true,
  output: { kind: 'verified', wellFormed: true },
  validator: 'none',
};

const BASE: PolicyEvidence = {
  heldInDispute: true,
  input: { kind: 'verified' },
  deliveries: [],
  override: null,
  operatorParty: false,
};

const with_ = (patch: Partial<PolicyEvidence>): PolicyEvidence => ({ ...BASE, ...patch });
const delivered = (patch: Partial<DeliveryCheck>): PolicyEvidence => with_({ deliveries: [{ ...DELIVERED, ...patch }] });

/** One row per rule, and per way a rule can be reached. The expected score is the published one. */
const FIXTURES: readonly { name: string; evidence: PolicyEvidence; rule: RuleId; score: number | null }[] = [
  { name: 'P0: lock not held in dispute', evidence: with_({ heldInDispute: false }), rule: 'P0', score: null },
  { name: 'P0 wins over an override', evidence: with_({ heldInDispute: false, override: { score: 90, reason: 'x' } }), rule: 'P0', score: null },

  { name: 'P1: no input URI', evidence: with_({ input: { kind: 'missing' } }), rule: 'P1', score: 0 },
  { name: 'P1: input unfetchable', evidence: with_({ input: { kind: 'unfetchable', detail: 'HTTP 404' } }), rule: 'P1', score: 0 },
  { name: 'P1: input hashes elsewhere', evidence: with_({ input: { kind: 'mismatch', detail: 'x' } }), rule: 'P1', score: 0 },
  { name: 'P1 wins over valid delivery', evidence: with_({ input: { kind: 'missing' }, deliveries: [DELIVERED] }), rule: 'P1', score: 0 },

  { name: 'P2: nothing delivered', evidence: BASE, rule: 'P2', score: 0 },

  { name: 'P3: not signed by the payee', evidence: delivered({ signedByPayee: false }), rule: 'P3', score: 0 },
  { name: 'P3: other input commitment', evidence: delivered({ inputMatches: false }), rule: 'P3', score: 0 },
  { name: 'P3: output mismatch', evidence: delivered({ output: { kind: 'mismatch', detail: 'x' } }), rule: 'P3', score: 0 },
  { name: 'P3: output unfetchable', evidence: delivered({ output: { kind: 'unfetchable', detail: 'x' } }), rule: 'P3', score: 0 },
  { name: 'P3: output not public', evidence: delivered({ output: { kind: 'not-public', detail: 'x' } }), rule: 'P3', score: 0 },
  { name: 'P3: validator fails', evidence: delivered({ validator: 'fail' }), rule: 'P3', score: 0 },
  { name: 'P3: empty output, no validator', evidence: delivered({ output: { kind: 'verified', wellFormed: false } }), rule: 'P3', score: 0 },

  { name: 'P4: validator reports partial', evidence: delivered({ validator: 'partial' }), rule: 'P4', score: 60 },
  { name: 'P4 even when empty, since a validator decided', evidence: delivered({ validator: 'partial', output: { kind: 'verified', wellFormed: false } }), rule: 'P4', score: 60 },

  { name: 'P5: no validator, well-formed output', evidence: delivered({}), rule: 'P5', score: 90 },
  { name: 'P5: validator passes', evidence: delivered({ validator: 'pass' }), rule: 'P5', score: 90 },
  {
    name: 'P5: one valid delivery among invalid ones',
    evidence: with_({ deliveries: [{ ...DELIVERED, signedByPayee: false }, DELIVERED] }),
    rule: 'P5',
    score: 90,
  },
  {
    name: 'P5 beats P4 when both are present',
    evidence: with_({ deliveries: [{ ...DELIVERED, validator: 'partial' }, { ...DELIVERED, validator: 'pass' }] }),
    rule: 'P5',
    score: 90,
  },

  { name: 'P6: override replaces P2', evidence: with_({ override: { score: 72, reason: 'late but usable' } }), rule: 'P6', score: 72 },
  { name: 'P6: override replaces P5', evidence: with_({ deliveries: [DELIVERED], override: { score: 0, reason: 'fraud' } }), rule: 'P6', score: 0 },
  {
    name: 'C-b: override refused when the operator is a party',
    evidence: with_({ override: { score: 90, reason: 'x' }, operatorParty: true }),
    rule: 'P2',
    score: 0,
  },
];

describe('ruling policy v1', () => {
  it.each(FIXTURES)('$name', ({ evidence, rule: expected, score }) => {
    const ruling = rule(evidence);
    expect(ruling.ruleId).toBe(expected);
    expect(ruling.score).toBe(score);
    expect(ruling.policyVersion).toBe(POLICY_VERSION);
    expect(ruling.reasons.length).toBeGreaterThan(0);
  });

  it('only ever emits the middle of a refund band', () => {
    const scores = new Set(FIXTURES.map((fixture) => rule(fixture.evidence).score));
    for (const score of scores) expect([null, 0, 60, 72, 90]).toContain(score);
  });

  it('says in the reasons that an operator-party override was refused', () => {
    const ruling = rule(with_({ override: { score: 90, reason: 'x' }, operatorParty: true }));
    expect(ruling.reasons.join(' ')).toMatch(/refused/);
  });

  it('refuses a policy version it does not implement', () => {
    expect(() => rule(BASE, 'v2')).toThrow(/v2/);
  });
});
