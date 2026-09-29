import { NO_DEBT_HEALTH } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { creditWired, formatHealth, formatRatio, liquidatable, symbolOf } from '@/chain/collateral';
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
    expect(collateralRefusal('execution reverted')).toBeUndefined();
  });
});
