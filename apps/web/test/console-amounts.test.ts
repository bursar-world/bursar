import { micro } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { readUsdgAmount } from '@/app/(app)/console/lib/amount';

/**
 * Every amount a treasurer types, and the reason it will not be sent.
 *
 * Two rules are held here at once, and they are the same rule from two sides. A value comes back
 * exactly when there is no problem, so a form cannot work out its warning from one condition and
 * whether its button is pressable from another: that mismatch is what left a deposit above the
 * wallet's own balance pressable, with the field saying so underneath.
 *
 * And every refusal names itself. "0", "-5", "abc" and "1.2345678" are four different mistakes,
 * and all four used to arrive at the same dead button with nothing in the slot where a readable
 * amount shows what it reads as.
 */
describe('an amount that cannot be sent says which mistake it is', () => {
  const cases: readonly { readonly typed: string; readonly says: string }[] = [
    { typed: '0', says: 'Enter a positive amount.' },
    { typed: '0,00', says: 'Enter a positive amount.' },
    { typed: '-5', says: 'Enter a positive amount.' },
    { typed: 'abc', says: 'Use digits, and a comma or a dot for the decimal point.' },
    { typed: '12 USDG', says: 'Use digits, and a comma or a dot for the decimal point.' },
    { typed: '1.2345678', says: 'At most 6 decimal places.' },
    { typed: '1.2.3', says: 'Group the digits in threes, or use no separators.' },
    { typed: '12,34,567', says: 'Group the digits in threes, or use no separators.' },
  ];

  it.each(cases)('reads "$typed" as $says', ({ typed, says }) => {
    const reading = readUsdgAmount(typed, { whenEmpty: 'Enter an amount.' });

    expect(reading.problem).toBe(says);
    expect(reading.value).toBeUndefined();
  });

  it('never answers a mistake with the instruction written for an empty field', () => {
    for (const { typed } of cases) {
      expect(readUsdgAmount(typed, { whenEmpty: 'Enter an amount.' }).problem).not.toBe('Enter an amount.');
    }
  });
});

describe('a field nobody has filled in', () => {
  it('gets the instruction where one is set, and it is not a mistake yet', () => {
    expect(readUsdgAmount('  ', { whenEmpty: 'Set how much to move in.' })).toEqual({
      value: undefined,
      problem: 'Set how much to move in.',
    });
  });

  it('says nothing at all where an empty field is a legitimate answer', () => {
    expect(readUsdgAmount('')).toEqual({ value: undefined, problem: undefined });
  });
});

describe('the decimal separator a person uses', () => {
  it('takes the comma most of the world writes', () => {
    expect(readUsdgAmount('2,50').value).toBe(2_500_000n);
  });

  it('reads it the same as the dot, and never as a thousand', () => {
    expect(readUsdgAmount('1,5').value).toBe(readUsdgAmount('1.5').value);
    expect(readUsdgAmount('1,5').value).not.toBe(readUsdgAmount('15').value);
  });

  it('resolves both separators together by taking the last one as the point', () => {
    expect(readUsdgAmount('1.234,56').value).toBe(readUsdgAmount('1,234.56').value);
    expect(readUsdgAmount('1.234,56').value).toBe(1_234_560_000n);
  });

  it('refuses a grouping no locale writes rather than guessing an amount from it', () => {
    expect(readUsdgAmount('1.2.3').value).toBeUndefined();
    expect(readUsdgAmount('1.234.567,89').value).toBe(1_234_567_890_000n);
  });
});

describe('a ceiling the amount has to land under', () => {
  const ceiling = { most: micro(3_000_000n), over: 'Your wallet holds $3.00.' };

  it('refuses the amount over it and quotes what is there', () => {
    const reading = readUsdgAmount('4', { ceiling });

    expect(reading.problem).toBe('Your wallet holds $3.00.');
    expect(reading.value).toBeUndefined();
  });

  it('takes the amount exactly on it', () => {
    expect(readUsdgAmount('3', { ceiling }).value).toBe(3_000_000n);
  });

  it('leaves the amount alone where no ceiling could be read', () => {
    expect(readUsdgAmount('4').value).toBe(4_000_000n);
  });
});

describe('the invariant every form depends on', () => {
  const typed = ['', '0', '-1', 'abc', '1.2345678', '1', '2,5', '9999999999'];

  it.each(typed)('gives a value for "%s" exactly when it gives no problem', (text) => {
    const reading = readUsdgAmount(text, {
      whenEmpty: 'Enter an amount.',
      ceiling: { most: micro(1_000_000_000n), over: 'Over the ceiling.' },
    });

    expect(reading.value === undefined).toBe(reading.problem !== undefined);
  });
});
