import { rwaDeployment } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { minUsdgAt, routerIsCurrent, usdFloor } from '@/app/(app)/console/lib/rwa';

const SPY_E8 = 78_005_783_409n;
const RAW = 640_554_959_594_479n;

describe('what a sale promises', () => {
  it('works the floor out the way the router does: value at the feed, less the slippage limit', () => {
    const atFeed = (RAW * SPY_E8) / 10n ** 20n;
    expect(atFeed).toBe(499_669n);
    expect(minUsdgAt(RAW, SPY_E8, 18, 0, 100)).toBe(494_672n);
    expect(minUsdgAt(RAW, SPY_E8, 18, 20, 100)).toBe(498_669n);
    // A wider limit than the stock's own is capped at it.
    expect(minUsdgAt(RAW, SPY_E8, 18, 300, 100)).toBe(494_672n);
    expect(minUsdgAt(RAW, 0n, 18, 0, 100)).toBe(0n);
  });

  it('shows the floor to the cent and never rounds it up', () => {
    expect(usdFloor(494_671n)).toBe('$0.49');
    expect(usdFloor(499_999n)).toBe('$0.49');
    expect(usdFloor(500_000n)).toBe('$0.50');
    expect(usdFloor(1_234_567_890n)).toBe('$1,234.56');
    expect(usdFloor(0n)).toBe('$0.00');
  });

  it('knows whether a mandate points at the lane’s router', () => {
    const lane = rwaDeployment(4663)!;
    expect(routerIsCurrent(lane.StockSpendRouter.toLowerCase() as `0x${string}`, lane)).toBe(true);
    expect(routerIsCurrent('0x4061b1346bedE97DcA8D7295977B703046fA9905', lane)).toBe(false);
    expect(routerIsCurrent(undefined, lane)).toBe(false);
  });
});
