import { RHC_MAINNET, collateralDeployment, priceGuardAbi, viemChain } from '@bursar/core';
import { describe, expect, it } from 'vitest';
import { BaseError, createPublicClient, custom, encodeErrorResult } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';

import { createKeeperChain, revertName, runKeeper } from '../src/collateral/keeper.js';
import type { KeeperChain, Position, Spread } from '../src/collateral/keeper.js';
import { createOnchainCollateralReader, fromAccountTuple } from '../src/lanes/onchain-collateral.js';

const HEALTHY: Address = '0x1000000000000000000000000000000000000001';
const SICK: Address = '0x2000000000000000000000000000000000000002';
const SPY: Address = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const AAPL: Address = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const NO_DEBT = (1n << 256n) - 1n;
const TX: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000abc';

class FakeChain implements KeeperChain {
  sent: string[] = [];
  liquidateRevert: Error | null = null;
  /** What the vault would sell. Zero is the write-off of a line with nothing left to sell. */
  sold = 5n;
  spreadState: Spread = { reservesMicro: 0n, poolIsCreditManager: false };
  sickPositions: Position[] = [
    { asset: AAPL, raw: 10n, valueMicro: 1_000n, fresh: true, haircutBps: 3000 },
    { asset: SPY, raw: 10n, valueMicro: 3_000n, fresh: true, haircutBps: 2000 },
  ];

  async lines() {
    return [HEALTHY, SICK];
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
    expect(calls).toEqual(['0x4AB6d4859D56452736f8b70749880CaFfC5c62C4']);
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
});
