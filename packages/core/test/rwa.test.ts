import { describe, expect, it } from 'vitest';

import { DEPLOYMENTS } from '../src/deployments.js';
import {
  COLLATERAL_LANE,
  NO_DEBT_HEALTH,
  RWA_CLASS_BIT,
  collateralDeployment,
  healthRatio,
  rawToUsdgMicros,
  rwaDeployment,
  usdgMicrosToRaw,
} from '../src/rwa.js';

describe('rwa lane', () => {
  it('reads the lane from the record that answers for 4663', () => {
    const rwa = rwaDeployment(4663);
    expect(rwa).toBeDefined();
    expect(rwa?.assets.map((a) => a.symbol)).toEqual(['SGOV', 'SPY', 'NVDA', 'AAPL']);
    expect(rwa?.assets.find((a) => a.symbol === 'SGOV')?.address).toBe('0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5');
    expect(rwa?.adapters['SGOV']).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(DEPLOYMENTS['rhc-mainnet'].rwa).toBeUndefined();
  });

  it('values raw × feed with no multiplier', () => {
    // 1 SGOV at 101.17856966 is 101.178569 USDG.
    expect(rawToUsdgMicros(10n ** 18n, 10_117_856_966n)).toBe(101_178_569n);
    expect(usdgMicrosToRaw(101_178_569n, 10_117_856_966n)).toBeLessThanOrEqual(10n ** 18n);
    expect(RWA_CLASS_BIT).toBe(4);
  });
});

describe('collateral lane', () => {
  it('reads the live pool and vault from the v2 record', () => {
    const c = collateralDeployment(4663);
    expect(c?.CreditPool).toBe('0xC217af334e6eaC06b774B5059b16257695937B0a');
    expect(c?.CollateralVault).toBe('0x4AB6d4859D56452736f8b70749880CaFfC5c62C4');
    expect(c?.fromBlock).toBeGreaterThan(0);
    expect(collateralDeployment(1)).toBeUndefined();
  });

  it('reports no health when nothing is owed', () => {
    expect(healthRatio(NO_DEBT_HEALTH)).toBeNull();
    expect(healthRatio(1_992_200_389_980_500_974n)).toBe(1.9922);
    expect(COLLATERAL_LANE).toBe(1);
  });
});
