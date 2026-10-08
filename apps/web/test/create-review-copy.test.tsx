import { micro } from '@bursar/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { describeLimits } from '@/app/(app)/console/lib/format';
import { EMPTY_DRAFT, readDraft } from '@/app/(app)/console/limits-form';
import { DAY_SECONDS } from '@/chain/limits';
import { AmountInput } from '@/components/amount-input';

/**
 * The create form as a person filming it reads it: the review says back the caps that were typed,
 * an amount typed the way the console writes it keeps the field's explanation, and a field nobody
 * has touched yet is not shown as a mistake.
 */
describe('the review reads the caps back', () => {
  it('reads a total budget the way the form sets it', () => {
    const reading = readDraft(
      { ...EMPTY_DRAFT, perCall: '0.02', daily: '0.05', monthly: '0.10', approvalAmount: '0.02' },
      Date.now(),
      { contractSet: 'v4', classMask: 1 },
    );
    expect(reading.problems).toEqual([]);
    expect(describeLimits(reading.limits!)).toBe('$0.02 per payment, $0.05 per day, $0.10 in total');
  });

  it('names a second rolling cap by its window', () => {
    const limits = {
      perCallCap: micro(1_000_000n),
      dailyCap: micro(5_000_000n),
      monthlyCap: micro(50_000_000n),
      dailyWindow: 8 * 3_600,
      monthlyWindow: 30 * DAY_SECONDS,
      approvalThreshold: micro(1_000_000n),
    };
    expect(describeLimits(limits)).toBe('$1.00 per payment, $5.00 per 8 hours, $50.00 per month');
  });
});

describe('an amount field', () => {
  const render = (value: string, problem?: string) =>
    renderToStaticMarkup(
      <AmountInput label="Most per payment" asset="USDG" value={value} onChange={() => undefined} hint="Larger payments are refused." problem={problem} />,
    );

  it('keeps its hint when the amount is typed as the console writes it', () => {
    const html = render('0.02');
    expect(html).toContain('Larger payments are refused.');
    expect(html).not.toContain('Reads as');
  });

  it('keeps its hint for a plain decimal the console would write differently', () => {
    const html = render('0.1');
    expect(html).toContain('Larger payments are refused.');
    expect(html).not.toContain('Reads as');
  });

  it('echoes an amount typed with a separator', () => {
    expect(render('1,5')).toContain('Reads as $1.50');
  });

  it('opens an empty field without its problem', () => {
    const html = render('', 'Set the most this agent may spend on one payment.');
    expect(html).not.toContain('Set the most this agent may spend');
    expect(html).toContain('Larger payments are refused.');
  });
});
