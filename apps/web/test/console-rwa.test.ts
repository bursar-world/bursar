import { describe, expect, it } from 'vitest';

import { allowsRwa, feedPrice, holdingValue, minOutAt, refusalInText, tokenAmount } from '@/app/(app)/console/lib/rwa';

describe('the stock and parking readings', () => {
  it('values a holding at raw times the feed price', () => {
    expect(holdingValue(395374858707165n, 10_117_000_000n)).toBe(40000n);
  });

  it('holds the slippage limit to the asset band', () => {
    const atFeed = (50_000n * 10n ** 20n) / 76_970_000_000n;
    expect(minOutAt(50_000n, 76_970_000_000n, 18, 0, 100)).toBe((atFeed * 9_900n) / 10_000n);
    expect(minOutAt(50_000n, 76_970_000_000n, 18, 500, 100)).toBe((atFeed * 9_900n) / 10_000n);
    expect(minOutAt(50_000n, 76_970_000_000n, 18, 50, 100)).toBe((atFeed * 9_950n) / 10_000n);
  });

  it('reads the class bit', () => {
    expect(allowsRwa(7)).toBe(true);
    expect(allowsRwa(3)).toBe(false);
    expect(allowsRwa(undefined)).toBe(false);
  });

  it('names a refusal in plain language', () => {
    expect(refusalInText('reverted with StalePrice(0x11, 100000, 93600)')).toMatch(/too old/);
    expect(refusalInText('execution reverted')).toBeUndefined();
  });

  it('formats small token amounts and feed prices', () => {
    expect(tokenAmount(64961527959563n)).toBe('0.00006496');
    expect(tokenAmount(1n)).toBe('<0.00000001');
    expect(feedPrice(76_970_000_000n)).toBe('$769.70');
  });
});
