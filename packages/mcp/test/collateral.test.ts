import { NO_DEBT_HEALTH, RHC_MAINNET, rwaDeployment } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { createCollateralGateway } from '../src/collateral.js';
import type { CollateralGateway } from '../src/collateral.js';
import { refusalForName } from '../src/reasons.js';
import { callTool, toolsFor } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';

const MANDATE = '0x4686C3566E1C50b4cC14c37A1088b7892d7D7407';
const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';

type Read = { functionName: string; args?: readonly unknown[] };

function fakeClient(reads: Record<string, (args?: readonly unknown[]) => unknown>): RhcPublicClient {
  return {
    readContract: async ({ functionName, args }: Read) => {
      const fn = reads[functionName];
      if (fn === undefined) throw new Error(`unexpected read ${functionName}`);
      return fn(args);
    },
    getBlock: async () => ({ timestamp: 1_790_686_194n }),
    request: async () => {
      throw new Error('no network in this test');
    },
  } as unknown as RhcPublicClient;
}

const LIVE_READS = {
  account: () => [49_808n, 39_846n, 20_001n, 11_875n, 1_992_200_389_980_500_974n],
  positions: () => [
    {
      asset: SPY,
      tier: 2,
      raw: 64_961_527_959_563n,
      priceE8: 76_674_004_349n,
      updatedAt: 1_790_606_666n,
      fresh: true,
      haircutBps: 2000,
      value: 49_808n,
      adjusted: 39_846n,
    },
  ],
  isLine: () => true,
  lane: () => 1,
  tiers: () => [
    { name: 'Treasury fund', sessionHaircutBps: 500, afterHoursHaircutBps: 1000, sessionStaleness: 93_600, valuationStaleness: 360_000 },
    { name: 'Index fund', sessionHaircutBps: 2000, afterHoursHaircutBps: 3500, sessionStaleness: 93_600, valuationStaleness: 360_000 },
  ],
  inSession: () => true,
};

function gateway(reads: Record<string, (args?: readonly unknown[]) => unknown>, key: `0x${string}` | null = null) {
  const g = createCollateralGateway({
    client: fakeClient(reads),
    chain: RHC_MAINNET,
    account: MANDATE,
    key,
    rwa: rwaDeployment(4663) ?? null,
    settlementAsset: RHC_MAINNET.usdg,
  });
  if (g === null) throw new Error('no collateral lane on 4663');
  return g;
}

function context(collateral: CollateralGateway): ToolContext {
  return {
    gateway: null,
    resolver: null,
    provider: null,
    collateral,
    secrets: [],
    canSign: { mandate: false, resolver: false, provider: false },
  };
}

describe('collateral tools', () => {
  it('reads collateral, debt, headroom, health and tiers', async () => {
    const view = await gateway(LIVE_READS).read();
    expect(view.lane).toBe('collateral');
    expect(view.debt.micro).toBe('20001');
    expect(view.headroom.micro).toBe('11875');
    expect(view.health).toBe(1.9922);
    expect(view.positions[0]?.symbol).toBe('SPY');
    expect(view.positions[0]?.haircutBps).toBe(2000);
    expect(view.tiers.map((t) => t.name)).toEqual(['Treasury fund', 'Index fund']);
  });

  it('reports no health when nothing is owed', async () => {
    const view = await gateway({
      ...LIVE_READS,
      account: () => [49_808n, 39_846n, 0n, 31_876n, NO_DEBT_HEALTH],
    }).read();
    expect(view.health).toBeNull();
    expect(view.next).toMatch(/Nothing is owed/);
  });

  it('offers only the read without a local key, and says why a write is refused', async () => {
    const ctx = context(gateway(LIVE_READS));
    const names = toolsFor(ctx).map((t) => t.name);
    expect(names).toContain('mandate_collateral');
    expect(names).not.toContain('mandate_collateral_repay');

    const read = await callTool(ctx, 'mandate_collateral', {});
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.text).health).toBe(1.9922);

    const repay = await callTool(ctx, 'mandate_collateral_repay', { amount: '20001' });
    expect(repay.isError).toBe(true);
    expect(JSON.parse(repay.text).error).toBe('relay_unconfigured');
  });

  it('refuses to post collateral for a prefund mandate', async () => {
    const key = `0x${'11'.repeat(32)}` as const;
    const ctx = context(gateway({ ...LIVE_READS, lane: () => 0 }, key));
    expect(toolsFor(ctx).map((t) => t.name)).toContain('mandate_collateral_deposit');
    const result = await callTool(ctx, 'mandate_collateral_deposit', { asset: 'SPY', raw: '1000' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.text);
    expect(body.error).toBe('mandate_refused');
    expect(body.detail.revert).toBe('NotCollateralLane');
  });

  it('refuses a repayment with nothing owed', async () => {
    const key = `0x${'11'.repeat(32)}` as const;
    const ctx = context(gateway({ ...LIVE_READS, account: () => [0n, 0n, 0n, 0n, NO_DEBT_HEALTH] }, key));
    const body = JSON.parse((await callTool(ctx, 'mandate_collateral_repay', {})).text);
    expect(body.detail.revert).toBe('NoDebt');
  });

  it('names the vault and pool refusals', () => {
    for (const name of [
      'HealthTooLow',
      'NotCollateralLane',
      'NoLine',
      'NotCollateral',
      'MandateCapExceeded',
      'TotalCapExceeded',
      'InsufficientCash',
      'StalePrice',
      'NotEligible',
    ]) {
      expect(refusalForName(name)?.message, name).toBeTruthy();
    }
  });
});
