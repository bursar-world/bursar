import { micro } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { roundedUnits, tokenAmountText, usd } from '@/money';

const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

describe('usd', () => {
  it('rounds to the nearest cent instead of cutting the digits', () => {
    expect(usd(micro(79_952n))).toBe('$0.08');
    expect(usd(micro(49_999n))).toBe('$0.05');
    expect(usd(micro(9_900n))).toBe('$0.01');
    expect(usd(micro(4_999n))).toBe('$0.00');
    expect(usd(micro(5_000n))).toBe('$0.01');
    expect(usd(micro(1_234_567_890n))).toBe('$1,234.57');
  });

  it('keeps a spent and a left figure that add up to the whole', () => {
    const whole = 2_000_000n;
    const spent = 295_450n;
    expect([usd(micro(spent)), usd(micro(whole - spent))]).toEqual(['$0.30', '$1.70']);
  });
});

describe('tokenAmountText', () => {
  it('reads a stock token in its own unit, never as dollars', () => {
    expect(tokenAmountText(64_961_527_959_563n, SPY)).toBe('0.000065 SPY');
    expect(tokenAmountText(64_961_527_959_563n, SPY)).not.toContain('$');
  });

  it('reads USDG in dollars', () => {
    expect(tokenAmountText(10_000n, USDG)).toBe('$0.01');
  });

  it('names an unknown token rather than guessing its unit', () => {
    expect(tokenAmountText(5n, '0x0000000000000000000000000000000000000abc')).toContain('units of');
  });

  it('rounds half up at the last shown place', () => {
    expect(roundedUnits(1_555_555_555n, 18, 3)).toBe('0.00000000156');
  });
});
