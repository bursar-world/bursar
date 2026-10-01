import { DRAW_HALTS, NO_DEBT_HEALTH } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { creditWired, drawHaltLine, formatHealth, formatRatio, haltedPositions, liquidatable, symbolOf } from '@/chain/collateral';
import type { CollateralPosition } from '@/chain/collateral';
import { collateralRefusal } from '@/app/(app)/console/lib/collateral';

const VAULT = '0x4AB6d4859D56452736f8b70749880CaFfC5c62C4';
const lane = { CreditPool: '0xC217af334e6eaC06b774B5059b16257695937B0a', CollateralVault: VAULT, Staking: VAULT, fromBlock: 1 } as const;

describe('the collateral readings', () => {
  it('shows no health when nothing is owed', () => {
    expect(formatHealth(NO_DEBT_HEALTH)).toBe('No debt');
    expect(formatHealth(undefined)).toBe('Unread');
    expect(formatHealth(1_992_200_389_980_500_974n)).toBe('1.99');
  });

  it('flags a position below 1.00 and nothing else', () => {
    expect(liquidatable(999_999_999_999_999_999n)).toBe(true);
    expect(liquidatable(10n ** 18n)).toBe(false);
    expect(liquidatable(NO_DEBT_HEALTH)).toBe(false);
    expect(liquidatable(undefined)).toBe(false);
  });

  it('writes the lane terms as ratios', () => {
    expect(formatRatio(1_250_000_000_000_000_000n)).toBe('1.25');
    expect(formatRatio(1_050_000_000_000_000_000n)).toBe('1.05');
  });

  it('knows when the mandate borrows through the vault', () => {
    expect(creditWired({ lane, creditSource: VAULT.toLowerCase() as `0x${string}` })).toBe(true);
    expect(creditWired({ lane, creditSource: undefined })).toBe(false);
  });

  it('names registered assets by symbol', () => {
    expect(symbolOf('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C')).toBe('SPY');
    expect(symbolOf('0x0000000000000000000000000000000000000001')).toMatch(/^0x0000…/);
  });

  it('says why a borrow was refused', () => {
    expect(collateralRefusal('reverted with NotCollateralLane(0x11, 0)')).toMatch(/prefunded/);
    expect(collateralRefusal('reverted with HealthTooLow(1, 2)')).toMatch(/borrowing floor/);
    expect(collateralRefusal('reverted with HealthTooLow(1, 2)')).toMatch(/price check holds a recent reading/);
    expect(collateralRefusal('reverted with NothingSeized(0x11)')).toMatch(/nothing to claim/);
    expect(collateralRefusal('reverted with ObservationTooSoon(0x11, 1, 2)')).toMatch(/too recently/);
    expect(collateralRefusal('execution reverted')).toBeUndefined();
  });
});

/**
 * From v4 a position can be fresh and still count for nothing toward a draw. The line a reader sees
 * names the condition in plain words and what moves it, with no contract names in it, and uses the
 * guard's bounds when they were read.
 */
describe('why a position counts for nothing toward borrowing', () => {
  const bounds = { minAge: 300n, maxAge: 3_600n, maxFeedJumpBps: 1_500n };

  it('has a sentence for every condition but the one where it counts', () => {
    for (const halt of DRAW_HALTS) {
      const line = drawHaltLine(halt, bounds);
      if (halt === 'None') {
        expect(line).toBeUndefined();
        continue;
      }
      expect(line, halt).toMatch(/\.$/);
      expect(line, halt).not.toMatch(/observation|keeper|v4|undefined/i);
    }
  });

  it('says a price that cannot be read counts for nothing, in the console’s words', () => {
    expect(drawHaltLine('Unreadable', bounds)).toBe('The price of this asset cannot be read right now. It counts again once its price feed and its pool answer.');
  });

  it('shows a condition it does not name as not counting, never as counting', () => {
    expect(drawHaltLine('unknown')).toContain('treat the position as not counting');
  });

  it('quotes the guard’s bounds when it has them, and stays true without them', () => {
    expect(drawHaltLine('NoObservation', bounds)).toBe('The price check holds no reading of its pool old enough to count. A reading counts 5m after it is taken.');
    expect(drawHaltLine('ObservationExpired', bounds)).toContain('more than 1h old');
    expect(drawHaltLine('FeedJump', bounds)).toContain('moved more than 15% since');
    expect(drawHaltLine('FeedJump')).toContain('further since the price check’s last reading of its pool than a draw allows');
    expect(drawHaltLine('NoObservation')).toContain('A reading counts once it has aged.');
    expect(drawHaltLine('SpotOffBand', bounds)).toBe('Its pool is out of line with its price right now.');
  });

  it('lists the posted positions held out, and not the empty ones or the ones that count', () => {
    const position = (symbol: string, raw: bigint, halt: CollateralPosition['halt']): CollateralPosition => ({
      asset: `0x${'1'.repeat(40)}`,
      symbol,
      tier: 2,
      raw,
      priceE8: 0n,
      updatedAt: undefined,
      fresh: true,
      haircutBps: 2000,
      afterHours: false,
      value: 0n,
      adjusted: 0n,
      walletHeld: undefined,
      allowance: undefined,
      halt,
    });

    const halted = haltedPositions({
      positions: [position('SPY', 10n, 'NoObservation'), position('AAPL', 0n, 'NoObservation'), position('SGOV', 5n, 'None'), position('NVDA', 1n, undefined)],
      observation: bounds,
    });

    expect(halted).toEqual([{ symbol: 'SPY', line: drawHaltLine('NoObservation', bounds) }]);
  });
});
