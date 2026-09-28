import { describe, expect, it } from 'vitest';
import {
  MICRO_SCALE,
  MoneyError,
  ZERO_MICRO,
  addMicro,
  assertNonNegative,
  clampMicro,
  compareMicro,
  formatMicro,
  micro,
  mulBps,
  parseMicro,
  subMicro,
  toMicro,
} from '../src/money.js';

describe('parseMicro', () => {
  it('scales a decimal string to six-decimal atomic units', () => {
    expect(parseMicro('0')).toBe(0n);
    expect(parseMicro('1')).toBe(1_000_000n);
    expect(parseMicro('12.5')).toBe(12_500_000n);
    expect(parseMicro('0.000001')).toBe(1n);
    expect(parseMicro('-3.25')).toBe(-3_250_000n);
    expect(parseMicro('  42.000000  ')).toBe(42_000_000n);
  });

  it('carries an amount larger than a double can hold', () => {
    expect(parseMicro('9007199254740993.123456')).toBe(9_007_199_254_740_993_123_456n);
  });

  it('refuses anything that is not a plain decimal with at most six places', () => {
    for (const input of ['', '.5', '1.', '1.0000001', '1e6', '1_000', '1,000', 'abc', '0x1', '+1', ' ']) {
      expect(() => parseMicro(input), input).toThrow(MoneyError);
    }
  });
});

describe('toMicro', () => {
  it('accepts the wire forms atomic units arrive in', () => {
    expect(toMicro(1_500_000n)).toBe(1_500_000n);
    expect(toMicro('1500000')).toBe(1_500_000n);
    expect(toMicro('-1500000')).toBe(-1_500_000n);
    expect(toMicro(1_500_000)).toBe(1_500_000n);
  });

  it('refuses a float rather than rounding it', () => {
    expect(() => toMicro(1.5)).toThrow(MoneyError);
    expect(() => toMicro(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
    expect(() => toMicro('1.5')).toThrow(MoneyError);
  });
});

describe('formatMicro', () => {
  it('shows cents by default and full precision when it is there', () => {
    expect(formatMicro(micro(12_500_000n))).toBe('12.50');
    expect(formatMicro(micro(4_424n))).toBe('0.004424');
    expect(formatMicro(ZERO_MICRO)).toBe('0.00');
    expect(formatMicro(micro(-3_250_000n))).toBe('-3.25');
  });

  it('takes a symbol, grouping and tighter bounds', () => {
    expect(formatMicro(micro(1_234_567_890n), { symbol: true, grouped: true })).toBe('$1,234.56789');
    expect(formatMicro(micro(1_999_999n), { maxDecimals: 2 })).toBe('1.99');
    expect(formatMicro(micro(1_000_000n), { minDecimals: 0 })).toBe('1');
  });

  it('round-trips through parseMicro when nothing is truncated', () => {
    for (const value of [0n, 1n, 999_999n, 12_500_000n, -3_250_000n]) {
      expect(parseMicro(formatMicro(micro(value)))).toBe(value);
    }
  });

  it('refuses decimal bounds it cannot honour', () => {
    expect(() => formatMicro(ZERO_MICRO, { maxDecimals: 7 })).toThrow(MoneyError);
    expect(() => formatMicro(ZERO_MICRO, { minDecimals: 4, maxDecimals: 2 })).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts without leaving bigint', () => {
    expect(addMicro(micro(1n), micro(2n), micro(3n))).toBe(6n);
    expect(addMicro()).toBe(0n);
    expect(subMicro(micro(5n), micro(8n))).toBe(-3n);
  });

  it('truncates basis points toward zero, matching the contracts', () => {
    expect(mulBps(micro(1_000_000n), 100)).toBe(10_000n);
    expect(mulBps(micro(9_999n), 1)).toBe(0n);
    expect(mulBps(micro(-1_000_001n), 100)).toBe(-10_000n);
    expect(mulBps(micro(1_000_000n), 10_000)).toBe(1_000_000n);
  });

  it('refuses a fractional or negative rate', () => {
    expect(() => mulBps(micro(1n), 1.5)).toThrow(MoneyError);
    expect(() => mulBps(micro(1n), -1)).toThrow(MoneyError);
  });

  it('clamps and compares', () => {
    expect(clampMicro(micro(50n), micro(0n), micro(10n))).toBe(10n);
    expect(clampMicro(micro(-5n), micro(0n), micro(10n))).toBe(0n);
    expect(() => clampMicro(micro(1n), micro(10n), micro(0n))).toThrow(MoneyError);
    expect(compareMicro(micro(1n), micro(2n))).toBe(-1);
    expect(compareMicro(micro(2n), micro(2n))).toBe(0);
    expect(compareMicro(micro(3n), micro(2n))).toBe(1);
  });

  it('guards a negative where one would be a silent debit', () => {
    expect(assertNonNegative(micro(0n), 'deposit')).toBe(0n);
    expect(() => assertNonNegative(micro(-1n), 'deposit')).toThrow(/deposit must not be negative/);
  });
});

it('keeps one unit system: the scale is six decimals', () => {
  expect(MICRO_SCALE).toBe(1_000_000n);
  expect(parseMicro('1')).toBe(MICRO_SCALE);
});
