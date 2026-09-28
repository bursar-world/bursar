import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { APPROVE_EVERYTHING, APPROVE_NOTHING, approvalModeOf, describeApproval } from '@/app/(app)/console/lib/format';
import { EMPTY_DRAFT, draftFromLimits, problemFor, readDraft } from '@/app/(app)/console/limits-form';
import type { LimitsDraft } from '@/app/(app)/console/limits-form';
import { checkLimits } from '@/chain/limits';

/**
 * The one field on the create form that is inverted, and what stops it bricking an agent.
 *
 * The threshold binds at and above, so zero means the owner signs every payment personally and
 * the way to ask for none is the largest value the field holds. `_setLimits` refuses zero
 * outright, because a mandate deployed with the field left at its default would refuse its
 * agent's first call and read to its owner like an outage.
 *
 * Nothing in the console may reach that value: not an empty field, not a mode, not a round trip
 * through a mandate that already exists. The struct field is a uint128, so the off value has to
 * fit in one.
 */
function draft(over: Partial<LimitsDraft> = {}): LimitsDraft {
  return { ...EMPTY_DRAFT, perCall: '10', daily: '100', monthly: '1000', approvalAmount: '5', ...over };
}

const UINT128_MAX = 2n ** 128n - 1n;

describe('the two ends of the field', () => {
  it('asks for consent on everything with the smallest value the contract accepts', () => {
    expect(APPROVE_EVERYTHING).toBe(1n);
    expect(readDraft(draft({ approvalMode: 'every' })).limits?.approvalThreshold).toBe(1n);
  });

  it('asks for consent on nothing with the largest, never with zero', () => {
    expect(APPROVE_NOTHING).toBe(UINT128_MAX);
    expect(readDraft(draft({ approvalMode: 'never' })).limits?.approvalThreshold).toBe(UINT128_MAX);
  });

  it('keeps the off value inside the uint128 the struct declares', () => {
    expect(APPROVE_NOTHING <= UINT128_MAX).toBe(true);
  });
});

describe('a threshold field left empty', () => {
  it('produces no limit set at all, so nothing can be deployed on it', () => {
    const reading = readDraft(draft({ approvalMode: 'above', approvalAmount: '' }));

    expect(reading.limits).toBeUndefined();
  });

  it('says what to do about it rather than leaving a dead button', () => {
    const reading = readDraft(draft({ approvalMode: 'above', approvalAmount: '' }));

    expect(problemFor(reading.problems, 'approvalThreshold')).toBe(
      'Set the amount from which you want to approve payments yourself.',
    );
  });

  it('is the state a form opens in, so the default is refusal and never zero', () => {
    const opened = readDraft(EMPTY_DRAFT);

    expect(opened.limits).toBeUndefined();
    expect(problemFor(opened.problems, 'approvalThreshold')).toBeDefined();
  });
});

describe('zero, which is the value that would brick the agent', () => {
  it('is refused as a typed amount', () => {
    expect(problemFor(readDraft(draft({ approvalAmount: '0' })).problems, 'approvalThreshold')).toBe(
      'Enter a positive amount.',
    );
  });

  it('is refused by the check the form runs before a wallet opens', () => {
    const problems = checkLimits({
      perCallCap: micro(10_000_000n),
      dailyCap: micro(100_000_000n),
      monthlyCap: micro(1_000_000_000n),
      dailyWindow: 86_400,
      monthlyWindow: 2_592_000,
      approvalThreshold: micro(0n),
    });

    expect(problems.map((problem) => problem.field)).toContain('approvalThreshold');
  });

  it('cannot be reached through any mode the form offers', () => {
    for (const approvalMode of ['every', 'never', 'above'] as const) {
      const threshold = readDraft(draft({ approvalMode })).limits?.approvalThreshold;
      expect(threshold === undefined || threshold > 0n).toBe(true);
    }
  });
});

describe('reading a threshold back off a mandate that exists', () => {
  const limits = (threshold: Micro, perCall = micro(10_000_000n)) => ({
    perCallCap: perCall,
    dailyCap: micro(100_000_000n),
    monthlyCap: micro(1_000_000_000n),
    dailyWindow: 86_400n,
    monthlyWindow: 2_592_000n,
    approvalThreshold: threshold,
    validFrom: 0n,
    validUntil: 0n,
  });

  it('reads one micro-dollar as consent on every payment', () => {
    expect(approvalModeOf(micro(1n), micro(10_000_000n))).toBe('every');
    expect(describeApproval(micro(1n), micro(10_000_000n))).toBe('You approve every payment');
  });

  it('reads anything over the per-payment cap as consent on nothing, and says so plainly', () => {
    expect(approvalModeOf(APPROVE_NOTHING, micro(10_000_000n))).toBe('never');
    expect(describeApproval(APPROVE_NOTHING, micro(10_000_000n))).toBe('No payment needs your approval');
  });

  it('quotes the figure where one was set', () => {
    expect(describeApproval(micro(5_000_000n), micro(10_000_000n))).toBe('You approve payments of $5.00 and above');
  });

  it('survives a round trip through the form without changing what it means', () => {
    for (const threshold of [micro(1n), micro(5_000_000n), APPROVE_NOTHING]) {
      const back = readDraft(draftFromLimits(limits(threshold)));

      expect(back.limits).toBeDefined();
      expect(approvalModeOf(back.limits!.approvalThreshold, back.limits!.perCallCap)).toBe(
        approvalModeOf(threshold, micro(10_000_000n)),
      );
    }
  });
});

/**
 * The window a mandate is good for, which the contract checks against the start date alone. A
 * date already gone is accepted on chain and produces an account that refuses its agent's first
 * call, so the form is the only thing between a treasurer and that mandate.
 */
describe('the validity window', () => {
  it('refuses a date that has already passed, and says why', () => {
    const reading = readDraft(draft({ validUntil: '2020-01-01' }));

    expect(reading.limits).toBeUndefined();
    expect(problemFor(reading.problems, 'validUntil')).toBe(
      'That date has passed, so the mandate would refuse every payment.',
    );
  });

  it('refuses an expiry that lands before the mandate opens', () => {
    const opensNextYear = Math.floor(new Date('2027-01-01T00:00:00Z').getTime() / 1000);
    const problems = checkLimits({
      perCallCap: micro(10_000_000n),
      dailyCap: micro(100_000_000n),
      monthlyCap: micro(1_000_000_000n),
      dailyWindow: 86_400,
      monthlyWindow: 2_592_000,
      approvalThreshold: micro(5_000_000n),
      validFrom: opensNextYear,
      validUntil: opensNextYear - 86_400,
    });

    expect(problems.map((problem) => problem.problem)).toContain('The mandate would expire before it opens.');
  });

  it('takes an empty date as no expiry, which is a mandate with no end', () => {
    expect(readDraft(draft({ validUntil: '' })).limits?.validUntil).toBe(0);
  });
});
