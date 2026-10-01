import { RHC_MAINNET, collateralDeployment, priceGuardAbi, viemChain } from '@bursar/core';
import { describe, expect, it } from 'vitest';
import { BaseError, createPublicClient, custom, encodeErrorResult } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';

import { createKeeperChain, observeDecision, revertName, runKeeper } from '../src/collateral/keeper.js';
import type { KeeperChain, Observation, ObservationRule, Position, Spread } from '../src/collateral/keeper.js';
import { createOnchainCollateralReader, fromAccountTuple } from '../src/lanes/onchain-collateral.js';

const HEALTHY: Address = '0x1000000000000000000000000000000000000001';
const SICK: Address = '0x2000000000000000000000000000000000000002';
const SPY: Address = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const AAPL: Address = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const NO_DEBT = (1n << 256n) - 1n;
const TX: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000abc';
const NOW = 1_800_000_000n;
const RULE: ObservationRule = { minAge: 300n, maxAge: 3_600n };
const NONE = { at: 0n, poolE8: 0n, feedE8: 0n };
/** A pool and a feed in line, read now and recorded in a waiting reading old enough to promote. */
const SETTLED: Observation = {
  aged: { at: NOW - 900n, poolE8: 77_000_000_000n, feedE8: 77_100_000_000n },
  pending: { at: NOW - 400n, poolE8: 77_000_000_000n, feedE8: 77_100_000_000n },
  poolE8: 77_000_000_000n,
  feedE8: 77_100_000_000n,
  halt: 'None',
};

class FakeChain implements KeeperChain {
  sent: string[] = [];
  liquidateRevert: Error | null = null;
  observeRevert: Error | null = null;
  /** Null is a guard from before v4, which takes no readings. */
  rule: ObservationRule | null = null;
  observations: Record<string, Observation> = { [SPY]: SETTLED, [AAPL]: SETTLED };
  lineList: Address[] = [HEALTHY, SICK];
  /** What the vault would sell. Zero is the write-off of a line with nothing left to sell. */
  sold = 5n;
  spreadState: Spread = { reservesMicro: 0n, poolIsCreditManager: false };
  sickPositions: Position[] = [
    { asset: AAPL, raw: 10n, valueMicro: 1_000n, fresh: true, haircutBps: 3000 },
    { asset: SPY, raw: 10n, valueMicro: 3_000n, fresh: true, haircutBps: 2000 },
  ];

  async lines() {
    return this.lineList;
  }
  async account(mandate: Address) {
    return mandate === SICK
      ? fromAccountTuple(mandate, [4_000n, 2_900n, 3_000n, 0n, 966_666_666_666_666_666n])
      : fromAccountTuple(mandate, [49_808n, 39_846n, 0n, 31_876n, NO_DEBT]);
  }
  async positions(mandate: Address) {
    return mandate === SICK ? this.sickPositions : [];
  }
  async inSession() {
    return false;
  }
  async spread() {
    return this.spreadState;
  }
  async simulateLiquidate() {
    if (this.liquidateRevert) throw this.liquidateRevert;
    return this.sold;
  }
  async liquidate(mandate: Address, asset: Address) {
    this.sent.push(`liquidate ${mandate} ${asset}`);
    return TX;
  }
  async simulateSweep() {}
  async sweep() {
    this.sent.push('sweep');
    return TX;
  }
  async now() {
    return NOW;
  }
  async assets() {
    return Object.keys(this.observations) as Address[];
  }
  async observationRule() {
    return this.rule;
  }
  async observation(asset: Address) {
    return this.observations[asset] as Observation;
  }
  async simulateObserve() {
    if (this.observeRevert) throw this.observeRevert;
  }
  async observe(asset: Address) {
    this.sent.push(`observe ${asset}`);
    return TX;
  }
}

const run = (chain: FakeChain, execute = false) =>
  runKeeper({ chain, fromBlock: 0n, execute, sweepMinMicro: 100n, now: () => new Date('2026-09-29T00:00:00Z') });

describe('collateral keeper', () => {
  it('snapshots every line and marks after hours', async () => {
    const report = await run(new FakeChain());
    expect(report.lines).toHaveLength(2);
    expect(report.lines[0]).toEqual({
      mandate: HEALTHY,
      valueMicro: '49808',
      adjustedMicro: '39846',
      debtMicro: '0',
      headroomMicro: '31876',
      health: null,
      afterHours: true,
    });
    expect(report.lines[1]?.health).toBe(0.966666);
  });

  it('dry run names the liquidation of the largest fresh position and sends nothing', async () => {
    const chain = new FakeChain();
    const report = await run(chain);
    expect(report.actions).toEqual([{ kind: 'liquidate', mandate: SICK, asset: SPY, outcome: 'would-send' }]);
    expect(chain.sent).toEqual([]);
  });

  it('sends when told to execute', async () => {
    const chain = new FakeChain();
    const report = await run(chain, true);
    expect(report.actions[0]).toMatchObject({ outcome: 'sent', tx: TX });
    expect(chain.sent).toEqual([`liquidate ${SICK} ${SPY}`]);
  });

  it('defers on a price the guard refuses, and says what it is waiting for', async () => {
    const chain = new FakeChain();
    chain.liquidateRevert = new BaseError('execution reverted: StalePrice(address,uint256,uint256)');
    const report = await run(chain, true);
    expect(report.actions[0]).toMatchObject({
      kind: 'liquidate',
      outcome: 'deferred',
      reason: 'StalePrice',
      detail: 'the feed is older than the asset allows a trade on',
    });
    expect(chain.sent).toEqual([]);
  });

  it('reports any other refusal as a failure', async () => {
    const chain = new FakeChain();
    chain.liquidateRevert = new BaseError('execution reverted: NothingToSell()');
    const report = await run(chain, true);
    expect(report.actions[0]).toMatchObject({ kind: 'liquidate', outcome: 'failed' });
  });

  // With nothing fresh the vault is still asked, because a line holding only dust or a dropped
  // asset is written off by the same call. Anything else comes back with the guard's reason.
  it('asks about the largest position when none is fresh and defers on the guard', async () => {
    const chain = new FakeChain();
    chain.sickPositions = chain.sickPositions.map((p) => ({ ...p, fresh: false }));
    chain.liquidateRevert = new BaseError('execution reverted: OraclePaused(address)');
    const report = await run(chain, true);
    expect(report.actions[0]).toMatchObject({ outcome: 'deferred', asset: SPY, reason: 'OraclePaused' });
  });

  it('defers a line with no collateral posted at all', async () => {
    const chain = new FakeChain();
    chain.sickPositions = [];
    const report = await run(chain, true);
    expect(report.actions[0]).toMatchObject({ outcome: 'deferred', asset: null, reason: 'no collateral posted' });
  });

  it('reports a call that would sell nothing as the write-off it is', async () => {
    const chain = new FakeChain();
    chain.sold = 0n;
    expect((await run(chain)).actions[0]).toEqual({ kind: 'write-off', mandate: SICK, asset: SPY, outcome: 'would-send' });

    const report = await run(chain, true);
    expect(report.actions[0]).toMatchObject({ kind: 'write-off', outcome: 'sent', tx: TX });
    expect(chain.sent).toEqual([`liquidate ${SICK} ${SPY}`]);
  });

  it('waits to sweep until Staking names the pool, then sweeps', async () => {
    const chain = new FakeChain();
    chain.sickPositions = [];
    chain.spreadState = { reservesMicro: 500n, poolIsCreditManager: false };
    let report = await run(chain, true);
    expect(report.actions.at(-1)).toMatchObject({ kind: 'sweep', outcome: 'waiting' });

    chain.spreadState = { reservesMicro: 500n, poolIsCreditManager: true };
    report = await run(chain, true);
    expect(report.actions.at(-1)).toMatchObject({ kind: 'sweep', outcome: 'sent', amountMicro: '500' });

    chain.spreadState = { reservesMicro: 50n, poolIsCreditManager: true };
    report = await run(chain, true);
    expect(report.actions.some((a) => a.kind === 'sweep')).toBe(false);
  });
});

/**
 * From v4 a draw counts a position only against a reading of its pool the guard took earlier, so
 * the keeper keeps the readings current. Every decision below is the one a pass makes from the
 * guard's two samples, the clock, and what the vault says a draw fails on.
 */
describe('deciding whether to observe an asset', () => {
  it('takes a first reading when the guard holds none', () => {
    expect(observeDecision({ ...SETTLED, aged: NONE, pending: NONE }, RULE, NOW)).toEqual({ action: 'observe', reason: 'first-reading' });
  });

  it('waits while the waiting reading is younger than the guard’s minimum, whatever else is true', () => {
    const young = { ...SETTLED, aged: NONE, pending: { ...SETTLED.pending, at: NOW - 100n }, halt: 'NoObservation' as const };

    expect(observeDecision(young, RULE, NOW)).toEqual({ action: 'wait', until: NOW + 200n });
  });

  it('promotes once the waiting reading is old enough and none is in force', () => {
    expect(observeDecision({ ...SETTLED, aged: NONE, halt: 'NoObservation' }, RULE, NOW)).toEqual({ action: 'observe', reason: 'promote' });
  });

  it('promotes before the reading in force runs out, with two waits of margin', () => {
    const expiring = { ...SETTLED, aged: { ...SETTLED.aged, at: NOW - 3_001n } };
    const fresh = { ...SETTLED, aged: { ...SETTLED.aged, at: NOW - 3_000n } };

    expect(observeDecision(expiring, RULE, NOW)).toEqual({ action: 'observe', reason: 'promote' });
    expect(observeDecision(fresh, RULE, NOW)).toEqual({ action: 'skip' });
  });

  it.each(['ObservationOffBand', 'FeedJump', 'ObservationExpired'] as const)('observes when a draw is halted on %s, which the next reading may clear', (halt) => {
    expect(observeDecision({ ...SETTLED, halt }, RULE, NOW)).toEqual({ action: 'observe', reason: 'halted' });
  });

  it.each(['NoPrice', 'Paused', 'FeedStale', 'SpotOffBand'] as const)('leaves a draw halted on %s to the market, and skips an unchanged reading', (halt) => {
    expect(observeDecision({ ...SETTLED, halt }, RULE, NOW)).toEqual({ action: 'skip' });
  });

  it('observes when the pool or the feed has moved since the waiting reading', () => {
    expect(observeDecision({ ...SETTLED, poolE8: 77_500_000_000n }, RULE, NOW)).toEqual({ action: 'observe', reason: 'moved' });
    expect(observeDecision({ ...SETTLED, feedE8: 0n }, RULE, NOW)).toEqual({ action: 'observe', reason: 'moved' });
  });

  it('compares a mid past the field as the guard would record it, clipped', () => {
    const edge = (1n << 104n) - 1n;
    const pinned = { ...SETTLED, pending: { ...SETTLED.pending, poolE8: edge }, poolE8: edge + 5n };

    expect(observeDecision(pinned, RULE, NOW)).toEqual({ action: 'skip' });
  });
});

describe('keeping the guard’s readings', () => {
  /** A v4 guard over one healthy line, so every action in the report is a reading. */
  function v4(chain = new FakeChain()): FakeChain {
    chain.rule = RULE;
    chain.lineList = [HEALTHY];
    return chain;
  }

  it('reports no readings and nothing to keep on a lane from before v4', async () => {
    const chain = new FakeChain();
    chain.lineList = [HEALTHY];

    const report = await run(chain, true);

    expect(report.observations).toBeNull();
    expect(report.health.observed).toBe(true);
    expect(report.health.summary).toContain('takes no readings');
    expect(report.actions.some((a) => a.kind === 'observe')).toBe(false);
  });

  it('dry run names the reading it would take and sends nothing', async () => {
    const chain = v4();
    chain.observations = { [SPY]: { ...SETTLED, aged: NONE, pending: NONE, halt: 'NoObservation' } };

    const report = await run(chain);

    expect(report.actions).toEqual([{ kind: 'observe', asset: SPY, outcome: 'would-send', reason: 'first-reading' }]);
    expect(chain.sent).toEqual([]);
  });

  it('sends the readings that would change what a draw sees, and skips the rest', async () => {
    const chain = v4();
    chain.observations = {
      [SPY]: { ...SETTLED, poolE8: 78_000_000_000n },
      [AAPL]: SETTLED,
    };

    const report = await run(chain, true);

    expect(report.actions).toEqual([
      { kind: 'observe', asset: SPY, outcome: 'sent', reason: 'moved', tx: TX },
      { kind: 'observe', asset: AAPL, outcome: 'skipped', reason: 'unchanged', detail: expect.stringContaining('sit where the waiting reading left them') },
    ]);
    expect(chain.sent).toEqual([`observe ${SPY}`]);
  });

  it('reports a reading too young to replace, and says when it can', async () => {
    const chain = v4();
    chain.observations = { [SPY]: { ...SETTLED, pending: { ...SETTLED.pending, at: NOW - 120n } } };

    const report = await run(chain, true);

    expect(report.actions[0]).toMatchObject({ kind: 'observe', asset: SPY, outcome: 'waiting', reason: 'too-soon' });
    expect((report.actions[0] as { detail: string }).detail).toContain(new Date(Number(NOW + 180n) * 1000).toISOString());
    expect(chain.sent).toEqual([]);
  });

  it('tolerates the guard refusing a reading as too soon, which another sender explains', async () => {
    const chain = v4();
    chain.observations = { [SPY]: { ...SETTLED, poolE8: 78_000_000_000n } };
    chain.observeRevert = new BaseError('execution reverted: ObservationTooSoon(address,uint256,uint256)');

    const report = await run(chain, true);

    expect(report.actions[0]).toMatchObject({ kind: 'observe', outcome: 'waiting', reason: 'too-soon' });
    expect(chain.sent).toEqual([]);
  });

  it('reports any other refusal of a reading as a failure, and goes on to the next asset', async () => {
    const chain = v4();
    chain.observations = { [SPY]: { ...SETTLED, poolE8: 78_000_000_000n }, [AAPL]: { ...SETTLED, feedE8: 0n } };
    chain.observeRevert = new BaseError('execution reverted: NotRegistered(address)');

    const report = await run(chain, true);

    expect(report.actions.map((a) => a.outcome)).toEqual(['failed', 'failed']);
    expect(chain.sent).toEqual([]);
  });

  it('snapshots each asset’s standing and the age of both readings', async () => {
    const chain = v4();
    chain.observations = { [SPY]: SETTLED, [AAPL]: { ...SETTLED, aged: NONE, pending: NONE, halt: 'NoObservation' } };

    const report = await run(chain);

    expect(report.observations).toEqual([
      { asset: SPY, halt: 'None', agedAgeSeconds: 900, pendingAgeSeconds: 400 },
      { asset: AAPL, halt: 'NoObservation', agedAgeSeconds: null, pendingAgeSeconds: null },
    ]);
  });

  it('fails health for want of a reading in force, and not for a halt that is the market’s', async () => {
    const chain = v4();
    chain.observations = { [SPY]: { ...SETTLED, halt: 'SpotOffBand' }, [AAPL]: SETTLED };
    let report = await run(chain, true);
    expect(report.health).toEqual({
      observed: true,
      halted: [{ asset: SPY, halt: 'SpotOffBand' }],
      summary: 'Readings are in force for every asset; draws against 1 of 2 are halted on the feed, the issuer or the pool.',
    });

    chain.observations = { [SPY]: { ...SETTLED, aged: NONE, halt: 'NoObservation' }, [AAPL]: SETTLED };
    report = await run(chain, true);
    expect(report.health.observed).toBe(false);
    expect(report.health.summary).toBe(
      "Draws against 1 of 2 assets are halted for want of a reading in force; 1 reading sent this pass, in force after the guard's minimum age.",
    );

    chain.observations = { [SPY]: SETTLED, [AAPL]: SETTLED };
    report = await run(chain, true);
    expect(report.health).toEqual({ observed: true, halted: [], summary: 'Readings are in force for every asset and draws count all 2.' });
  });

  it('takes the readings before it looks at the lines', async () => {
    const chain = v4();
    chain.lineList = [SICK];
    chain.observations = { [SPY]: { ...SETTLED, aged: NONE, halt: 'NoObservation' } };

    const report = await run(chain, true);

    expect(report.actions.map((a) => a.kind)).toEqual(['observe', 'liquidate']);
    expect(chain.sent).toEqual([`observe ${SPY}`, `liquidate ${SICK} ${SPY}`]);
  });
});

describe('on-chain collateral reader', () => {
  it('reads the recorded vault and maps its account tuple', async () => {
    const calls: unknown[] = [];
    const reader = createOnchainCollateralReader(
      {
        async readContract(args) {
          calls.push(args.address);
          return [49_808n, 39_846n, 20_001n, 11_875n, 1_992_200_389_980_500_974n] as const;
        },
      },
      4663,
    );
    const position = await reader!.read('0x4686C3566E1C50b4cC14c37A1088b7892d7D7407');
    expect(calls).toEqual([collateralDeployment(4663)?.CollateralVault]);
    expect(position.healthFactor).toBe(1.9922);
    expect(position.headroomMicro).toBe(11_875n);
  });

  it('is absent on a chain with no lane', () => {
    expect(createOnchainCollateralReader({ readContract: async () => [0n, 0n, 0n, 0n, 0n] as const }, 1)).toBeNull();
  });
});

/**
 * A guard refusal reaches the vault's caller as the guard's own error, which the vault's ABI does
 * not declare. Read against the vault's ABI alone it is a bare selector, and a sale waiting on a
 * price would be reported as a failure.
 */
describe('reading a liquidation the guard refuses', () => {
  function refusingNode(data: Hex): PublicClient {
    return createPublicClient({
      chain: viemChain(RHC_MAINNET),
      transport: custom(
        {
          request: async ({ method }: { method: string }) => {
            if (method === 'eth_chainId') return `0x${RHC_MAINNET.chainId.toString(16)}`;
            if (method === 'eth_call') throw { code: 3, message: 'execution reverted', data };
            throw new Error(`this node does not answer ${method}`);
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
  }

  const lane = collateralDeployment(RHC_MAINNET.chainId);

  it.skipIf(lane === undefined)('names a band refusal after the sale, which is a deferral', async () => {
    const data = encodeErrorResult({ abi: priceGuardAbi, errorName: 'PoolPriceDeviation', args: [SPY, 101_500_000_00n, 100_000_000_00n] });
    const chain = createKeeperChain({ publicClient: refusingNode(data), lane: lane! });

    const error = await chain.simulateLiquidate(SICK, SPY).catch((failure: unknown) => failure);
    expect(revertName(error)).toBe('PoolPriceDeviation');
  });

  it.skipIf(lane === undefined)('names a reading the guard refuses as too soon, which is a wait', async () => {
    const data = encodeErrorResult({ abi: priceGuardAbi, errorName: 'ObservationTooSoon', args: [SPY, 120n, 300n] });
    const node = createPublicClient({
      chain: viemChain(RHC_MAINNET),
      transport: custom(
        {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_chainId') return `0x${RHC_MAINNET.chainId.toString(16)}`;
            // The vault answers its guard; the guard refuses the reading.
            const to = String((params?.[0] as { to?: string } | undefined)?.to ?? '').toLowerCase();
            if (method === 'eth_call' && to === lane!.CollateralVault.toLowerCase()) return `0x${'0'.repeat(24)}${'99'.repeat(20)}`;
            if (method === 'eth_call') throw { code: 3, message: 'execution reverted', data };
            throw new Error(`this node does not answer ${method}`);
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
    const chain = createKeeperChain({ publicClient: node, lane: lane! });

    const error = await chain.simulateObserve(SPY).catch((failure: unknown) => failure);
    expect(revertName(error)).toBe('ObservationTooSoon');
  });

  /** A v3 guard has no observation bounds, and an unknown selector on it answers nothing. */
  it.skipIf(lane === undefined)('reads a guard that takes no readings as having no rule', async () => {
    const node = createPublicClient({
      chain: viemChain(RHC_MAINNET),
      transport: custom(
        {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_chainId') return `0x${RHC_MAINNET.chainId.toString(16)}`;
            const to = String((params?.[0] as { to?: string } | undefined)?.to ?? '').toLowerCase();
            if (method === 'eth_call' && to === lane!.CollateralVault.toLowerCase()) return `0x${'0'.repeat(24)}${'99'.repeat(20)}`;
            if (method === 'eth_call') return '0x';
            throw new Error(`this node does not answer ${method}`);
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
    const chain = createKeeperChain({ publicClient: node, lane: lane! });

    expect(await chain.observationRule()).toBeNull();
  });
});
