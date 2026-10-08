import { afterEach, describe, expect, it, vi } from 'vitest';

import { chainNow, formatRelative, isPast, noteChainTime } from '@/lib/time';

/**
 * Windows on chain open and close by block time. A browser whose clock is off, or a chain whose
 * clock has been moved, would otherwise show a countdown that disagrees with the button under it.
 */
const BROWSER = new Date('2026-10-09T00:00:00.000Z');
const seconds = (date: Date) => BigInt(Math.floor(date.getTime() / 1000));

describe('the chain clock behind countdowns', () => {
  afterEach(() => {
    noteChainTime(seconds(new Date()));
    vi.useRealTimers();
  });

  it('counts a window on the chain when the chain runs ahead of the browser', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BROWSER);
    const chain = new Date(BROWSER.getTime() + 7 * 86_400_000);
    noteChainTime(seconds(chain), BROWSER.getTime());

    expect(chainNow().toISOString()).toBe(chain.toISOString());
    expect(formatRelative(new Date(chain.getTime() + 3_600_000))).toBe('in 1h');
    expect(isPast(new Date(chain.getTime() - 1_000))).toBe(true);
  });

  it('leaves a gap under a minute alone, so a block still on its way does not move every countdown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BROWSER);
    noteChainTime(seconds(new Date(BROWSER.getTime() - 20_000)), BROWSER.getTime());

    expect(chainNow().toISOString()).toBe(BROWSER.toISOString());
  });

  it('still answers from an explicit now', () => {
    noteChainTime(seconds(new Date(Date.now() + 86_400_000)));

    expect(formatRelative(new Date('2026-10-09T02:00:00.000Z'), new Date('2026-10-09T00:00:00.000Z'))).toBe('in 2h');
  });
});
