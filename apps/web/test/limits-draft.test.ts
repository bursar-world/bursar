import { describe, expect, it } from 'vitest';

import { TOTAL_BUDGET_MIN_SECONDS, micro } from '@bursar/core';

import { EMPTY_DRAFT, NEVER_REFILLS, draftFromLimits, isTotalDraft, problemFor, readDraft } from '@/app/(app)/console/limits-form';
import { DAY_SECONDS, MONTH_SECONDS } from '@/chain/limits';
import type { LimitsDraft } from '@/app/(app)/console/limits-form';

/**
 * What the create-mandate form will let a treasurer send, and what it tells them when it will not.
 *
 * Two things went wrong here and they are the same mistake twice: the form worked out its warnings
 * from one set of conditions and whether to enable Create from another. A per-payment cap of 50
 * against a daily cap of 10 printed "The daily limit has to be at least the per-payment limit." and
 * left Create pressable over a mandate the contract refuses. And every amount that did not parse
 * came back as the neutral instruction to fill the field in, in the slot where a readable amount
 * shows "Reads as $10.00", so 0, -5, abc and 1.2345678 were four dead buttons with one blank look.
 *
 * `limits` is the submit state: present means Create is pressable. Asserting on it and on the
 * problems together is the only way these two can be held to the same conditions.
 */
function draft(over: Partial<LimitsDraft> = {}): LimitsDraft {
  return { ...EMPTY_DRAFT, perCall: '10', daily: '100', monthly: '1000', approvalAmount: '50', ...over };
}

describe('a ladder the contract would refuse', () => {
  it('disables Create on the case it warns about', () => {
    const reading = readDraft(draft({ perCall: '50', daily: '10' }));

    expect(problemFor(reading.problems, 'dailyCap')).toBe('The period cap has to be at least the per-payment limit.');
    expect(reading.limits).toBeUndefined();
  });

  it('disables it on the longer window too, which is the same rule one step up', () => {
    const reading = readDraft(draft({ perCall: '10', daily: '100', monthly: '50' }));

    expect(problemFor(reading.problems, 'monthlyCap')).toBe('The total budget has to be at least the period cap.');
    expect(reading.limits).toBeUndefined();
  });

  it('disables it on an expiry that has already passed', () => {
    const reading = readDraft(draft({ validUntil: '2020-01-01' }));

    expect(problemFor(reading.problems, 'validUntil')).toContain('That date has passed');
    expect(reading.limits).toBeUndefined();
  });

  it('enables it on a ladder that climbs, and says nothing', () => {
    const reading = readDraft(draft());

    expect(reading.problems).toEqual([]);
    expect(reading.limits).toMatchObject({ perCallCap: 10_000_000n, dailyCap: 100_000_000n, monthlyCap: 1_000_000_000n });
  });
});

describe('an amount that is not one says which mistake it is', () => {
  const cases: readonly { readonly typed: string; readonly says: string }[] = [
    { typed: '0', says: 'Enter a positive amount.' },
    { typed: '-5', says: 'Enter a positive amount.' },
    { typed: 'abc', says: 'Use digits, and a comma or a dot for the decimal point.' },
    { typed: '1.2345678', says: 'At most 6 decimal places.' },
  ];

  it.each(cases)('reads "$typed" as $says', ({ typed, says }) => {
    const reading = readDraft(draft({ perCall: typed }));

    expect(problemFor(reading.problems, 'perCallCap')).toBe(says);
    expect(reading.limits).toBeUndefined();
  });

  it('never answers a mistake with the instruction for an empty field', () => {
    for (const { typed } of cases) {
      expect(problemFor(readDraft(draft({ perCall: typed })).problems, 'perCallCap')).not.toBe(
        'Set the most this agent may spend on one payment.',
      );
    }
  });

  it('keeps the instruction for a field nobody has filled in yet, which is not a mistake', () => {
    expect(problemFor(readDraft(draft({ perCall: '' })).problems, 'perCallCap')).toBe(
      'Set the most this agent may spend on one payment.',
    );
  });

  it('takes the decimal comma most of the world writes', () => {
    expect(readDraft(draft({ perCall: '2,50' })).limits?.perCallCap).toBe(2_500_000n);
  });

  it('says the same things about the approval threshold', () => {
    expect(problemFor(readDraft(draft({ approvalAmount: '0' })).problems, 'approvalThreshold')).toBe(
      'Enter a positive amount.',
    );
    expect(problemFor(readDraft(draft({ approvalAmount: 'abc' })).problems, 'approvalThreshold')).toContain('Use digits');
  });
});

describe('the total budget is the second window, set never to roll', () => {
  it('writes the total as a window of at least one hundred years', () => {
    const reading = readDraft({ ...EMPTY_DRAFT, perCall: '0.50', daily: '0.50', monthly: '1.00', shortWindow: DAY_SECONDS, approvalAmount: '1' });
    expect(reading.problems).toEqual([]);
    expect(reading.limits?.dailyWindow).toBe(DAY_SECONDS);
    expect(reading.limits?.dailyCap).toBe(500_000n);
    expect(reading.limits?.monthlyCap).toBe(1_000_000n);
    expect(reading.limits?.monthlyWindow).toBe(TOTAL_BUDGET_MIN_SECONDS);
  });

  it('reads a deployed total back as a total, and a rolling second cap as rolling', () => {
    const limits = {
      perCallCap: micro(1n),
      dailyCap: micro(2n),
      monthlyCap: micro(3n),
      dailyWindow: BigInt(DAY_SECONDS),
      approvalThreshold: micro(1n),
      validFrom: 0n,
      validUntil: 0n,
    };
    expect(draftFromLimits({ ...limits, monthlyWindow: BigInt(TOTAL_BUDGET_MIN_SECONDS) }).longWindow).toBe(NEVER_REFILLS);
    expect(isTotalDraft(draftFromLimits({ ...limits, monthlyWindow: BigInt(TOTAL_BUDGET_MIN_SECONDS) }))).toBe(true);
    expect(draftFromLimits({ ...limits, monthlyWindow: BigInt(MONTH_SECONDS) }).longWindow).toBe(MONTH_SECONDS);
  });

  it('keeps a rolling second cap rolling when one is chosen', () => {
    const reading = readDraft({ ...EMPTY_DRAFT, perCall: '1', daily: '2', monthly: '3', longWindow: MONTH_SECONDS, approvalAmount: '1' });
    expect(reading.limits?.monthlyWindow).toBe(MONTH_SECONDS);
  });
});
