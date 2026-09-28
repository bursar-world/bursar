import { describe, expect, it } from 'vitest';

import { newDraft } from '@/workspace/model';
import type { MandateDraft } from '@/workspace/model';
import { EMPTY_SPEND, checkDraftSpend } from '@/workspace/rule-check';
import type { PlannedSpend } from '@/workspace/rule-check';

const PAYEE = '0x2222222222222222222222222222222222222222';
const NOW = Date.parse('2026-10-01T09:00:00Z');

/** Period cap 0.50 per day, total 1.00, per payment 0.40, approval from 0.35, expiring end of 2026. */
function draft(over: Partial<MandateDraft> = {}): MandateDraft {
  const base = newDraft(new Date(NOW));
  return {
    ...base,
    agent: '0x1111111111111111111111111111111111111111',
    limits: { ...base.limits, perCall: '0.40', daily: '0.50', monthly: '1.00', approvalMode: 'above', approvalAmount: '0.35', validUntil: '2026-12-31' },
    classes: { service: true, hire: false, rwa: false },
    capabilities: [{ spendClass: 'service', label: 'gpu.render:1' }],
    payees: [PAYEE],
    ...over,
  };
}

function spend(over: Partial<PlannedSpend> = {}): PlannedSpend {
  return { ...EMPTY_SPEND, capability: 'gpu.render:1', payee: PAYEE, amount: '0.10', date: '2026-10-02', ...over };
}

describe('pre-activation rule check', () => {
  it('allows a spend inside every rule', () => {
    expect(checkDraftSpend(draft(), spend(), NOW)).toMatchObject({ outcome: 'allowed' });
  });

  it('names the per-payment limit', () => {
    expect(checkDraftSpend(draft(), spend({ amount: '0.45' }), NOW)).toMatchObject({ outcome: 'refused', rule: 'Per-payment limit' });
  });

  it('names the period cap', () => {
    expect(checkDraftSpend(draft(), spend({ amount: '0.20', spentThisPeriod: '0.40', spentInTotal: '0.40' }), NOW)).toMatchObject({
      outcome: 'refused',
      rule: 'Period cap',
    });
  });

  it('names the total budget once earlier periods have used it', () => {
    const result = checkDraftSpend(draft(), spend({ amount: '0.20', spentThisPeriod: '0', spentInTotal: '0.90' }), NOW);
    expect(result).toMatchObject({ outcome: 'refused', rule: 'Total budget' });
    if (result.outcome === 'refused') expect(result.message).toContain('$0.10 of the $1.00 total budget is left');
  });

  it('names the spend class for a hire the draft does not allow', () => {
    expect(checkDraftSpend(draft(), spend({ spendClass: 'hire' }), NOW)).toMatchObject({ outcome: 'refused', rule: 'Spend class' });
  });

  it('names the spend class for eligible stocks the draft does not allow', () => {
    const result = checkDraftSpend(draft(), spend({ spendClass: 'rwa' }), NOW);
    expect(result).toMatchObject({ outcome: 'refused', rule: 'Spend class' });
    if (result.outcome === 'refused') expect(result.message).toContain('Eligible stocks are not allowed');
  });

  it('names the capability when the class is allowed but the capability is not listed', () => {
    expect(checkDraftSpend(draft(), spend({ capability: 'doc.summarize:1' }), NOW)).toMatchObject({ outcome: 'refused', rule: 'Capability' });
  });

  it('names the counterparty', () => {
    expect(
      checkDraftSpend(draft(), spend({ payee: '0x3333333333333333333333333333333333333333' }), NOW),
    ).toMatchObject({ outcome: 'refused', rule: 'Counterparty' });
  });

  it('names the expiry', () => {
    expect(checkDraftSpend(draft(), spend({ date: '2027-01-02' }), NOW)).toMatchObject({ outcome: 'refused', rule: 'Expiry' });
  });

  it('says a spend at the approval amount waits for a signature', () => {
    expect(checkDraftSpend(draft(), spend({ amount: '0.35' }), NOW)).toMatchObject({ outcome: 'approval', rule: 'Approval' });
  });

  it('reports what is missing instead of guessing', () => {
    const result = checkDraftSpend(draft({ limits: { ...draft().limits, monthly: '' } }), spend({ amount: '', payee: 'nope' }), NOW);
    expect(result.outcome).toBe('incomplete');
    if (result.outcome === 'incomplete') {
      expect(result.problems.some((p) => p.includes('total budget'))).toBe(true);
      expect(result.problems.some((p) => p.includes('0x address'))).toBe(true);
    }
  });
});
