import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { readDraft } from '@/app/(app)/providers/[payee]/evidence-form';
import { readRulingBody, ruleLabel } from '@/app/(app)/resolvers/ruling';
import { RulingNoteView } from '@/app/(app)/resolvers/ruling-note';

const PUBLISHED = {
  status: 'published',
  policyVersion: 'v1',
  rule: 'P5',
  score: 90,
  reasons: ['The payee signed the delivery, the output matches its commitment, and it is well-formed, non-empty JSON.'],
  operatorParty: false,
  evidence: [
    { kind: 'delivery', counted: true },
    { kind: 'delivery', counted: false },
    { kind: 'payer-statement', statement: 'The summary was wrong.' },
  ],
  note: null,
};

describe('reading a published ruling', () => {
  it('reads the rule, the score, the reasons and what counted', () => {
    expect(readRulingBody(200, PUBLISHED)).toEqual({
      kind: 'published',
      policyVersion: 'v1',
      rule: 'P5',
      score: 90,
      reasons: PUBLISHED.reasons,
      evidence: 2,
      counted: 1,
      statements: ['The summary was wrong.'],
      operatorParty: false,
      note: null,
    });
  });

  it('keeps sealed, unknown and unreadable apart', () => {
    expect(readRulingBody(200, { status: 'sealed', revealsFrom: '2026-09-28T18:00:00.000Z' })).toEqual({
      kind: 'sealed',
      revealsFrom: new Date('2026-09-28T18:00:00.000Z'),
    });
    expect(readRulingBody(404, { error: 'unknown' })).toEqual({ kind: 'none' });
    expect(readRulingBody(503, { error: 'unconfigured' })).toEqual({ kind: 'unavailable' });
    expect(readRulingBody(200, 'nonsense')).toEqual({ kind: 'unavailable' });
  });

  it('names every rule in words', () => {
    for (const rule of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']) expect(ruleLabel(rule)).not.toBe(rule);
    expect(ruleLabel(null)).toMatch(/chain/);
  });
});

describe('the ruling note', () => {
  it('shows the published reasons with a link to the policy', () => {
    const html = renderToStaticMarkup(<RulingNoteView reading={readRulingBody(200, PUBLISHED)} />);
    expect(html).toContain('Delivered as committed');
    expect(html).toContain('scored 90 out of 100');
    expect(html).toContain('1 of 2 delivery statements');
    expect(html).toContain('The summary was wrong.');
    expect(html).toContain('href="/docs/ruling-policy"');
  });

  it('shows no score while it is sealed', () => {
    const html = renderToStaticMarkup(<RulingNoteView reading={{ kind: 'sealed', revealsFrom: null }} />);
    expect(html).toContain('sealed');
    expect(html).not.toMatch(/scored \d/);
  });

  it('says the reveal is open rather than counting down to a moment already past', () => {
    const html = renderToStaticMarkup(<RulingNoteView reading={{ kind: 'sealed', revealsFrom: new Date(Date.now() - 33_000) }} />);
    expect(html).toContain('The reveal is open');
    expect(html).not.toContain('ago');
  });

  it('says an unreadable service leaves the on-chain outcome alone', () => {
    expect(renderToStaticMarkup(<RulingNoteView reading={{ kind: 'unavailable' }} />)).toContain('unaffected');
  });

  it('says when Bursar was a party', () => {
    const html = renderToStaticMarkup(<RulingNoteView reading={readRulingBody(200, { ...PUBLISHED, operatorParty: true })} />);
    expect(html).toContain('Bursar is a party to this dispute');
  });
});

describe('the evidence form draft', () => {
  it('commits to the canonical output and inlines it when no address is given', () => {
    const draft = readDraft('{"b": 1, "a": 2}', '');
    expect(draft.evidence?.outputURI).toBe(`data:application/json;base64,${Buffer.from('{"a":2,"b":1}').toString('base64')}`);
    expect(draft.evidence?.outputCommit).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('refuses output that is not JSON, or is empty', () => {
    expect(readDraft('not json', '').outputProblem).toMatch(/not JSON/);
    expect(readDraft('{}', '').outputProblem).toMatch(/empty/);
    expect(readDraft('[]', '').outputProblem).toMatch(/empty/);
  });

  it('takes only an https address', () => {
    expect(readDraft('{"a":1}', 'http://outputs.example.com/1.json').uriProblem).toMatch(/https/);
    expect(readDraft('{"a":1}', 'https://outputs.example.com/1.json').evidence?.outputURI).toBe('https://outputs.example.com/1.json');
  });
});
