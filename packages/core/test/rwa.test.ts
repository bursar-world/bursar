import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEPLOYMENTS } from '../src/deployments.js';
import { RAW_DEPLOYMENTS } from '../src/generated/deployments.js';
import {
  COLLATERAL_LANE,
  DRAW_HALTS,
  NO_DEBT_HEALTH,
  RWA_CLASS_BIT,
  collateralDeployment,
  drawHaltOf,
  healthRatio,
  rawToUsdgMicros,
  usdgMicrosToRaw,
} from '../src/rwa.js';

describe('rwa lane', () => {
  it('records the v2 lane, which v1 never had', () => {
    const rwa = DEPLOYMENTS['rhc-mainnet-v2'].rwa;
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
  it('records the v2 pool and vault', () => {
    const c = DEPLOYMENTS['rhc-mainnet-v2'].rwa?.collateral;
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

/**
 * A vault answers a draw halt as a number, and the ABI carries no names for it. The list here is
 * held to the enum in the guard's source, so a member added or moved there fails this before a
 * reader is told the wrong condition.
 */
describe('why a draw counts nothing for a position', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../contracts/src/rwa/PriceGuard.sol', import.meta.url)),
    'utf8',
  );

  it('names the conditions in the order the price guard declares them', () => {
    const declared = /enum DrawHalt \{([^}]*)\}/u.exec(source)?.[1]?.split(',').map((name) => name.trim()) ?? [];

    // A member the guard declares and this list does not name would read as a wrong reason.
    expect(declared).toEqual([...DRAW_HALTS]);
  });

  it('reads the number a vault answers, and nothing for one it does not know', () => {
    expect(drawHaltOf(0)).toBe('None');
    expect(drawHaltOf(4)).toBe('NoObservation');
    expect(drawHaltOf(8)).toBe('SpotOffBand');
    expect(drawHaltOf(9)).toBe('Unreadable');
    expect(drawHaltOf(10)).toBe('PendingOffBand');
    expect(drawHaltOf(11)).toBeUndefined();
  });
});

/**
 * A lane is read through the generated ABIs, which describe the current build. Once a newer set
 * answers for the chain, the lanes an earlier set deployed are a different build, so a record that
 * has not recorded its own lanes yet has none rather than borrowing the old ones.
 */
describe('which set a lane comes from', () => {
  afterEach(() => {
    vi.doUnmock('../src/generated/deployments.js');
    vi.resetModules();
  });

  const v2 = RAW_DEPLOYMENTS['rhc-mainnet-v2'] as Record<string, unknown>;
  const v3Core = (): Record<string, unknown> => {
    const { rwa: _rwa, privacy: _privacy, ...core } = v2;
    return {
      ...core,
      network: 'rhc-mainnet-v3',
      supersedes: 'rhc-mainnet-v2',
      contracts: {
        AdminTimelock: `0x${'31'.repeat(20)}`,
        Reputation: `0x${'32'.repeat(20)}`,
        Escrow: `0x${'33'.repeat(20)}`,
        OracleRegistry: `0x${'34'.repeat(20)}`,
        AgentRegistry: `0x${'35'.repeat(20)}`,
        MandateAccountFactory: `0x${'36'.repeat(20)}`,
      },
    };
  };

  async function lanesWith(records: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock('../src/generated/deployments.js', () => ({ RAW_DEPLOYMENTS: records }));
    const [rwa, privacy] = await Promise.all([import('../src/rwa.js'), import('../src/privacy.js')]);
    return {
      rwa: rwa.rwaDeployment(4663),
      collateral: rwa.collateralDeployment(4663),
      privacy: privacy.privacyDeployment(4663),
    };
  }

  it('reads the lanes of the set that answers for the chain', async () => {
    const lanes = await lanesWith({ 'rhc-mainnet-v2': v2, 'rhc-mainnet': RAW_DEPLOYMENTS['rhc-mainnet'] });

    expect(lanes.rwa?.AssetRegistry).toBe(DEPLOYMENTS['rhc-mainnet-v2'].rwa?.AssetRegistry);
    expect(lanes.privacy?.SolvencyLog).toBe(DEPLOYMENTS['rhc-mainnet-v2'].privacy?.SolvencyLog);
  });

  it('does not borrow the v2 lanes for a v3 record that has none yet', async () => {
    const lanes = await lanesWith({ 'rhc-mainnet-v3': v3Core(), 'rhc-mainnet-v2': v2 });

    expect(lanes.rwa).toBeUndefined();
    expect(lanes.collateral).toBeUndefined();
    expect(lanes.privacy).toBeUndefined();
  });

  it('reads the v3 lanes once the v3 record carries them', async () => {
    const withLanes = { ...v3Core(), rwa: v2['rwa'], privacy: v2['privacy'] };
    const lanes = await lanesWith({ 'rhc-mainnet-v3': withLanes, 'rhc-mainnet-v2': v2 });

    expect(lanes.rwa).toBeDefined();
    expect(lanes.privacy).toBeDefined();
  });

  // The v3 lanes have no observations, no seizure and no depositor window. A v4 record that has
  // not deployed its own must read as having none, or a v4 reader would call a v3 vault for them.
  const v3 = RAW_DEPLOYMENTS['rhc-mainnet-v3'] as Record<string, unknown>;
  const v4Core = (): Record<string, unknown> => {
    const { rwa: _rwa, privacy: _privacy, ...core } = v3;
    return {
      ...core,
      network: 'rhc-mainnet-v4',
      supersedes: 'rhc-mainnet-v3',
      contracts: {
        AdminTimelock: `0x${'41'.repeat(20)}`,
        Reputation: `0x${'42'.repeat(20)}`,
        Escrow: `0x${'43'.repeat(20)}`,
        OracleRegistry: `0x${'44'.repeat(20)}`,
        AgentRegistry: `0x${'45'.repeat(20)}`,
        MandateAccountFactory: `0x${'46'.repeat(20)}`,
      },
    };
  };

  it('does not borrow the v3 lanes for a v4 record that has none yet', async () => {
    const lanes = await lanesWith({ 'rhc-mainnet-v4': v4Core(), 'rhc-mainnet-v3': v3 });

    expect(lanes.rwa).toBeUndefined();
    expect(lanes.collateral).toBeUndefined();
    expect(lanes.privacy).toBeUndefined();
  });

  it('reads the v4 lanes once the v4 record carries them', async () => {
    const withLanes = { ...v4Core(), rwa: v3['rwa'], privacy: v3['privacy'] };
    const lanes = await lanesWith({ 'rhc-mainnet-v4': withLanes, 'rhc-mainnet-v3': v3 });

    expect(lanes.collateral).toBeDefined();
    expect(lanes.privacy?.shielded).toBeDefined();
  });
});
