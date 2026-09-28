import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../src/errors.js';
import { brsr, parseBrsr, toBrsr } from '../src/brsr.js';
import { formatUsdg, micro, toMicro, usdg } from '../src/money.js';

describe('usdg', () => {
  it('reads a price the way a price is written', () => {
    expect(usdg('2.50')).toBe(2_500_000n);
    expect(usdg('0.000001')).toBe(1n);
    expect(usdg('1000')).toBe(1_000_000_000n);
  });

  it('refuses precision the settlement asset cannot hold', () => {
    expect(() => usdg('0.0000001')).toThrow(/at most 6 decimal places/);
  });

  it('refuses the spellings that hide a unit mistake', () => {
    expect(() => usdg('1e6')).toThrow();
    expect(() => usdg('1,000')).toThrow();
    expect(() => usdg('.5')).toThrow();
  });

  it('refuses a negative price, which every other layer already refuses', () => {
    expect(() => usdg('-1')).toThrow(InvalidArgumentError);
    expect(() => usdg('-0.000001')).toThrow(/is negative/u);
    expect(() => usdg('-1000000')).toThrow(InvalidArgumentError);
  });

  it('names the field a negative price came in on', () => {
    try {
      usdg('-1');
      expect.unreachable('usdg accepted a negative price');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as InvalidArgumentError).field).toBe('amount');
    }
  });

  it('refuses a number and asks for the string, because a float loses cents', () => {
    const asNumber = usdg as unknown as (amount: number) => bigint;

    expect(() => asNumber(2.5)).toThrow(InvalidArgumentError);
    expect(() => asNumber(2.5)).toThrow(/decimal string such as '2\.50'.*given a number \(2\.5\)/u);
    expect(() => asNumber(0.1 + 0.2)).toThrow(/write the amount as a string/u);
  });

  it('still takes zero, which is a ceiling rather than a payment', () => {
    expect(usdg('0')).toBe(0n);
  });
});

describe('toMicro', () => {
  it('takes atomic units off a wire without converting them', () => {
    expect(toMicro('2500000')).toBe(2_500_000n);
    expect(toMicro(2_500_000)).toBe(2_500_000n);
    expect(toMicro(2_500_000n)).toBe(2_500_000n);
  });
});

describe('formatUsdg', () => {
  it('writes an amount for a human without letting it back into arithmetic', () => {
    expect(formatUsdg(micro(2_500_000n))).toBe('2.50 USDG');
    expect(formatUsdg(micro(1_234_567_890n))).toBe('1,234.56789 USDG');
    expect(formatUsdg(micro(0n))).toBe('0.00 USDG');
  });
});

describe('BRSR helpers', () => {
  it('refuse a number rather than brand or trim it', () => {
    const loose = (fn: unknown) => fn as (value: number) => bigint;

    expect(() => loose(brsr)(1e18)).toThrow(/brsr\(\) takes a bigint/u);
    expect(() => loose(toBrsr)(1e18)).toThrow(/toBrsr\(\) takes a bigint or a digit string/u);
    expect(() => loose(parseBrsr)(25_000)).toThrow(/parseBrsr\(\) takes a decimal string/u);
    expect(() => loose(parseBrsr)(25_000)).toThrow(InvalidArgumentError);
  });
});
