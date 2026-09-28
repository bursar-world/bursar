import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import {
  MAX_COLUMN_MICRO,
  NumericColumnError,
  countToNumber,
  microToNumeric,
  numericToMicro,
  optionalNumericToMicro,
} from '../src/db/numeric.js';

describe('money columns', () => {
  it('binds an amount as plain atomic units', () => {
    expect(microToNumeric(toMicro(1_500_000))).toBe('1500000');
    expect(microToNumeric(toMicro(0))).toBe('0');
    expect(microToNumeric(toMicro(-42))).toBe('-42');
  });

  it('reads back the declared scale Postgres renders', () => {
    expect(numericToMicro('1500000.000000', 'amount_micro')).toBe(1_500_000n);
    expect(numericToMicro('0.000000', 'amount_micro')).toBe(0n);
    expect(numericToMicro('-42.000000', 'amount_micro')).toBe(-42n);
  });

  it('round trips every value the column can hold', () => {
    for (const value of [0n, 1n, 1_900n, 999_999_999n, MAX_COLUMN_MICRO]) {
      const amount = toMicro(value);
      expect(numericToMicro(`${microToNumeric(amount)}.000000`, 'c')).toBe(amount);
    }
  });

  it('survives amounts a double would round', () => {
    const large = toMicro('90071992547409');
    expect(numericToMicro(`${microToNumeric(large)}.000000`, 'c')).toBe(90_071_992_547_409n);
  });

  it('refuses a fraction of one micro-USD rather than truncating it', () => {
    expect(() => numericToMicro('1.500001', 'amount_micro')).toThrow(NumericColumnError);
    expect(() => numericToMicro('0.000001', 'amount_micro')).toThrow(/fraction of one micro-USD/);
  });

  it('names the column it refused', () => {
    expect(() => numericToMicro('nope', 'outstanding_micro')).toThrow(/outstanding_micro/);
  });

  it('refuses to bind more than a NUMERIC(20,6) can hold', () => {
    expect(() => microToNumeric(toMicro(MAX_COLUMN_MICRO + 1n))).toThrow(NumericColumnError);
    expect(() => microToNumeric(toMicro(-MAX_COLUMN_MICRO - 1n))).toThrow(NumericColumnError);
  });

  it('treats a missing value as zero and an optional one as absent', () => {
    expect(numericToMicro(null, 'c')).toBe(0n);
    expect(numericToMicro(undefined, 'c')).toBe(0n);
    expect(optionalNumericToMicro(null, 'c')).toBeNull();
    expect(optionalNumericToMicro('7.000000', 'c')).toBe(7n);
  });

  it('reads counts that Postgres renders as text', () => {
    expect(countToNumber('12')).toBe(12);
    expect(countToNumber(12)).toBe(12);
    expect(countToNumber(null)).toBe(0);
    expect(countToNumber('not a number')).toBe(0);
  });
});
