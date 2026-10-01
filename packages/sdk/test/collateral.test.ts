import { describe, expect, it } from 'vitest';
import { NO_DEBT_HEALTH, collateralDeployment, deployment } from '@bursar/core';

import { connect } from '../src/connection.js';
import { CollateralClient, CollateralSetError, NoDebtError, NotCollateralLaneError, collateral } from '../src/collateral.js';
import { CallRefusedError } from '../src/errors.js';
import { mandateAccount } from '../src/mandate.js';
import { UnknownAssetError } from '../src/rwa.js';
import type { MandateAccountClient } from '../src/mandate.js';

const MANDATE = '0x4686C3566E1C50b4cC14c37A1088b7892d7D7407';
const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const SGOV = '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5';
const live = process.env['BURSAR_LIVE_RHC'] === '1';

type Read = { functionName: string; args?: readonly unknown[] };

/**
 * A mandate on the recorded chain with every read answered from a table. The record that answers
 * for the chain today runs v3, so its vault has no draw rule and seizes nothing; `onV4` reads the
 * same lane through an escrow no record names, which is the current build.
 */
// A client on the set named: the fourth set's lane answers the live record, the third set's lane
// answers with the third record's escrow, which the client reads as that set.
function withReads(reads: Record<string, (args?: readonly unknown[]) => unknown>, set: 'v3' | 'v4' = 'v3'): MandateAccountClient {
  const base = connect({ chainId: 4663 });
  const publicClient = {
    readContract: async ({ functionName, args }: Read) => {
      const fn = reads[functionName];
      if (fn === undefined) throw new Error(`unexpected read ${functionName}`);
      return fn(args);
    },
    getBlock: async () => ({ timestamp: 1_790_686_194n }),
  };
  const addresses = set === 'v4' ? base.addresses : { ...base.addresses, escrow: deployment('rhc-mainnet-v3').contracts.Escrow };
  return {
    address: MANDATE,
    connection: { ...base, addresses, publicClient },
  } as unknown as MandateAccountClient;
}

describe('collateral client', () => {
  it('reads the lane from the deployment record and resolves symbols', () => {
    const client = new CollateralClient(withReads({}));
    expect(client.lane).toEqual(collateralDeployment(4663));
    expect(client.resolve('spy')).toBe(SPY);
    expect(() => client.resolve('TSLA')).toThrow(UnknownAssetError);
  });

  it('reports collateral, debt, headroom and health', async () => {
    const client = collateral(
      withReads({
        account: () => [49_808n, 39_846n, 20_001n, 11_875n, 1_992_200_389_980_500_974n],
        positions: () => [
          { asset: SGOV, tier: 1, raw: 0n, priceE8: 0n, updatedAt: 0n, fresh: true, haircutBps: 500, value: 0n, adjusted: 0n },
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
      }),
    );
    const p = await client.position();
    expect(p.debt).toBe(20_001n);
    expect(p.headroom).toBe(11_875n);
    expect(p.health).toBe(1.9922);
    expect(p.positions).toHaveLength(1);
    expect(p.positions[0]?.symbol).toBe('SPY');
    expect(p.positions[0]?.haircutBps).toBe(2000);
  });

  it('reports no health when nothing is owed', async () => {
    const client = collateral(
      withReads({
        account: () => [49_808n, 39_846n, 0n, 31_876n, NO_DEBT_HEALTH],
        positions: () => [],
        isLine: () => true,
        lane: () => 1,
      }),
    );
    expect((await client.position()).health).toBeNull();
  });

  it('publishes tiers and the haircut that applies now', async () => {
    const client = collateral(
      withReads({
        tiers: () => [
          { name: 'Treasury fund', sessionHaircutBps: 500, afterHoursHaircutBps: 1000, sessionStaleness: 93_600, valuationStaleness: 360_000 },
          { name: 'Index fund', sessionHaircutBps: 2000, afterHoursHaircutBps: 3500, sessionStaleness: 93_600, valuationStaleness: 360_000 },
        ],
        collateralAssets: () => [SGOV, SPY],
        inSession: () => true,
        tierOf: (args) => (args?.[0] === SGOV ? 1 : 2),
        haircutOf: (args) => (args?.[0] === SGOV ? [500, false] : [2000, false]),
      }),
    );
    const t = await client.tiers();
    expect(t.inSession).toBe(true);
    expect(t.tiers.map((x) => x.tier)).toEqual([1, 2]);
    expect(t.assets.map((a) => [a.symbol, a.tier, a.haircutBps])).toEqual([
      ['SGOV', 1, 500],
      ['SPY', 2, 2000],
    ]);
  });

  it('refuses to open a line or post collateral for a prefund mandate', async () => {
    const client = collateral(withReads({ lane: () => 0 }));
    await expect(client.openLine()).rejects.toBeInstanceOf(NotCollateralLaneError);
    await expect(client.deposit('SPY', 1n)).rejects.toBeInstanceOf(NotCollateralLaneError);
    await expect(client.setCreditLane()).rejects.toThrow(/lane 0/);
  });

  it('refuses a repayment with nothing owed', async () => {
    const client = collateral(withReads({ debtOf: () => 0n }));
    await expect(client.repay()).rejects.toBeInstanceOf(NoDebtError);
  });

  it('says per asset whether a draw counts it, and why not when it does not', async () => {
    const client = collateral(
      withReads(
        {
          collateralAssets: () => [SGOV, SPY],
          drawHalt: (args) => (args?.[0] === SPY ? 4 : 0),
          guard: () => '0x9999999999999999999999999999999999999999',
          MIN_OBSERVATION_AGE: () => 300n,
          MAX_OBSERVATION_AGE: () => 3_600n,
          MAX_FEED_JUMP_BPS: () => 1_500n,
        },
        'v4',
      ),
    );
    const standing = await client.drawStanding();

    expect(standing.map((s) => [s.symbol, s.halt])).toEqual([
      ['SGOV', 'None'],
      ['SPY', 'NoObservation'],
    ]);
    expect(standing[0]?.refusal).toBeNull();
    expect(standing[1]?.refusal?.message).toContain('SPY counts for nothing toward a draw yet');
    expect(standing[1]?.refusal?.message).toContain('at least 5m earlier');
    expect(await client.observationBounds()).toEqual({ minAge: 300n, maxAge: 3_600n, maxFeedJumpBps: 1_500n });
  });

  it('refuses to name a draw condition this build does not know, rather than reading it as counting', async () => {
    const client = collateral(
      withReads(
        {
          collateralAssets: () => [SPY],
          drawHalt: () => 42,
          guard: () => '0x9999999999999999999999999999999999999999',
          MIN_OBSERVATION_AGE: () => 300n,
          MAX_OBSERVATION_AGE: () => 3_600n,
          MAX_FEED_JUMP_BPS: () => 1_500n,
        },
        'v4',
      ),
    );

    await expect(client.drawStanding()).rejects.toThrow(/draw condition 42/);
  });

  it('lists the collateral write-offs have seized, per asset, leaving out the empty ones', async () => {
    const client = collateral(
      withReads({ collateralAssets: () => [SGOV, SPY], seized: (args) => (args?.[0] === SPY ? 7n : 0n) }, 'v4'),
    );

    expect(await client.seized()).toEqual([{ symbol: 'SPY', asset: SPY, raw: 7n }]);
  });

  it('refuses to claim seized collateral in an asset where none waits, before anything is sent', async () => {
    const client = collateral(withReads({ seized: () => 0n }, 'v4'));

    const failure = await client.claimSeized('SPY').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect((failure as CallRefusedError).errorName).toBe('NothingSeized');
    expect((failure as Error).message).toContain('holds no seized SPY');
  });

  it('answers no standing and nothing seized on a lane from before v4, and refuses a claim on it', async () => {
    const client = collateral(withReads({}));

    expect(await client.drawStanding()).toEqual([]);
    expect(await client.seized()).toEqual([]);
    expect(await client.observationBounds()).toBeUndefined();
    await expect(client.claimSeized('SPY')).rejects.toBeInstanceOf(CollateralSetError);
  });

  it.skipIf(!live)('reads the live collateral-lane mandate on 4663', async () => {
    const m = await mandateAccount(MANDATE, { chainId: 4663 });
    const p = await m.collateral().position();
    expect(p.lane).toBe(1);
    expect(p.lineOpen).toBe(true);
    expect(p.positions.find((x) => x.symbol === 'SPY')?.raw).toBeGreaterThan(0n);
    const t = await m.collateral().tiers();
    expect(t.tiers).toHaveLength(3);
  });
});
