import { describe, expect, it } from 'vitest';

import { POLICY_VERSION, V3_IN_FORCE_FROM, policyVersionAt, rule } from '../src/policy.js';
import type { DeliveryCheck, InputCheck, PolicyEvidence, RuleId } from '../src/policy.js';

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

/** Every way the committed input can fail to be read. None of them is a score. */
const UNREAD: readonly Exclude<InputCheck, { kind: 'verified' }>[] = [
  { kind: 'missing' },
  { kind: 'unfetchable', detail: 'HTTP 404' },
  { kind: 'mismatch', detail: 'it hashes to 0xbeef' },
];

/** One row per rule, and per way a rule can be reached. The expected score is the published one. */
const FIXTURES: readonly { name: string; evidence: PolicyEvidence; rule: RuleId; score: number | null }[] = [
  { name: 'P0: lock not held in dispute', evidence: with_({ heldInDispute: false }), rule: 'P0', score: null },
  { name: 'P0 wins over an override', evidence: with_({ heldInDispute: false, override: { score: 90, reason: 'x' } }), rule: 'P0', score: null },

  { name: 'P2: nothing delivered', evidence: BASE, rule: 'P2', score: 0 },
  { name: 'P2: nothing delivered on a lock with no input', evidence: with_({ input: { kind: 'missing' } }), rule: 'P2', score: 0 },

  { name: 'P3: not signed by the payee', evidence: delivered({ signedByPayee: false }), rule: 'P3', score: 0 },
  { name: 'P3: other input commitment', evidence: delivered({ inputMatches: false }), rule: 'P3', score: 0 },
  { name: 'P3: output mismatch', evidence: delivered({ output: { kind: 'mismatch', detail: 'x' } }), rule: 'P3', score: 0 },
  { name: 'P3: output unfetchable', evidence: delivered({ output: { kind: 'unfetchable', detail: 'x' } }), rule: 'P3', score: 0 },
  { name: 'P3: output not public', evidence: delivered({ output: { kind: 'not-public', detail: 'x' } }), rule: 'P3', score: 0 },
  { name: 'P3: validator fails', evidence: delivered({ validator: 'fail' }), rule: 'P3', score: 0 },
  { name: 'P3: empty output, no validator', evidence: delivered({ output: { kind: 'verified', wellFormed: false } }), rule: 'P3', score: 0 },
  {
    name: 'P3: bad output on a lock with no input is still the output that decides',
    evidence: with_({ input: { kind: 'missing' }, deliveries: [{ ...DELIVERED, output: { kind: 'mismatch', detail: 'x' } }] }),
    rule: 'P3',
    score: 0,
  },

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
  ...UNREAD.map((input) => ({
    name: `P5: a valid delivery on a lock whose input is ${input.kind} is delivered all the same`,
    evidence: with_({ input, deliveries: [DELIVERED] }),
    rule: 'P5' as const,
    score: 90,
  })),

  { name: 'P6: override replaces P2', evidence: with_({ override: { score: 72, reason: 'late but usable' } }), rule: 'P6', score: 72 },
  { name: 'P6: override replaces P5', evidence: with_({ deliveries: [DELIVERED], override: { score: 0, reason: 'fraud' } }), rule: 'P6', score: 0 },
  {
    name: 'C-b: override refused when the operator is a party',
    evidence: with_({ override: { score: 90, reason: 'x' }, operatorParty: true }),
    rule: 'P2',
    score: 0,
  },
];

describe('ruling policy v3', () => {
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
    expect(() => rule(BASE, 'v1')).toThrow(/v1/);
    expect(() => rule(BASE, 'v4')).toThrow(/v4/);
  });
});

describe('the version a dispute is ruled under', () => {
  it('is the one in force when the dispute opened', () => {
    expect(POLICY_VERSION).toBe('v3');
    expect(new Date(Number(V3_IN_FORCE_FROM) * 1_000).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(policyVersionAt(V3_IN_FORCE_FROM - 1n)).toBe('v2');
    expect(policyVersionAt(V3_IN_FORCE_FROM)).toBe('v3');
  });

  it.each(UNREAD)('still scores an unread input 0 for a dispute that opened under Version 2 ($kind)', (input) => {
    const ruling = rule(with_({ input, deliveries: [DELIVERED] }), 'v2');
    expect(ruling).toMatchObject({ policyVersion: 'v2', ruleId: 'P1', score: 0 });
    expect(ruling.reasons.at(-1)).toBe('No verifiable job existed, so nothing was owed.');
  });

  it('rules everything else the same under both', () => {
    for (const fixture of FIXTURES.filter((entry) => entry.evidence.input.kind === 'verified')) {
      const { policyVersion: _v2, ...before } = rule(fixture.evidence, 'v2');
      const { policyVersion: _v3, ...after } = rule(fixture.evidence, 'v3');
      expect(before).toEqual(after);
    }
  });
});

describe('a lock whose input cannot be read', () => {
  it('is not refunded for the omission when the payee delivered', () => {
    const ruling = rule(with_({ input: { kind: 'missing' }, deliveries: [DELIVERED] }));
    expect(ruling.score).not.toBe(0);
    expect(ruling.ruleId).not.toBe('P1');
  });

  it.each(UNREAD)('is ruled on the delivery evidence alone, with the gap on the record ($kind)', (input) => {
    const served = rule(with_({ input, deliveries: [DELIVERED] }));
    expect(served).toMatchObject({ ruleId: 'P5', score: 90 });
    expect(served.reasons[0]).toMatch(/rests on the delivery evidence alone/);

    const unserved = rule(with_({ input }));
    expect(unserved).toMatchObject({ ruleId: 'P2', score: 0 });
    expect(unserved.reasons[0]).toMatch(/rests on the delivery evidence alone/);

    const botched = rule(with_({ input, deliveries: [{ ...DELIVERED, signedByPayee: false }] }));
    expect(botched).toMatchObject({ ruleId: 'P3', score: 0 });
  });

  it('never emits P1, whatever else is in the evidence', () => {
    const deliveries = [[], [DELIVERED], [{ ...DELIVERED, output: { kind: 'mismatch' as const, detail: 'x' } }], [{ ...DELIVERED, validator: 'partial' as const }]];
    for (const input of UNREAD) {
      for (const batch of deliveries) {
        expect(rule(with_({ input, deliveries: batch })).ruleId).not.toBe('P1');
      }
    }
  });

  it('names the detail of an input that could be fetched and did not match', () => {
    const ruling = rule(with_({ input: { kind: 'mismatch', detail: 'it hashes to 0xbeef' } }));
    expect(ruling.reasons[0]).toContain('it hashes to 0xbeef');
  });
});
