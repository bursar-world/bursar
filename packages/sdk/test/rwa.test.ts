import { describe, expect, it } from 'vitest';
import { rwaDeployment, stockSpendRouterAbi } from '@bursar/core';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics } from 'viem';

import { connect } from '../src/connection.js';
import { BursarError } from '@bursar/core';
import { mandateAccount } from '../src/mandate.js';
import { RwaClient, UnknownAssetError, rwa } from '../src/rwa.js';
import type { MandateAccountClient } from '../src/mandate.js';
import { fakeConnection } from './helpers/fake-connection.js';

const EXAMPLE = '0x420BeB507F72173E7d78e0f956968f64fb508356';
const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const NFLX = '0x1111111111111111111111111111111111111111';
const live = process.env['BURSAR_LIVE_RHC'] === '1';

const LANE = rwaDeployment(4663)!;
const RAW = 640_554_959_594_479n;
const PRICE_E8 = 78_005_783_409n;
const FLOOR = 494_672n;

function offline(): MandateAccountClient {
  return { address: EXAMPLE, connection: connect({ chainId: 4663 }) } as unknown as MandateAccountClient;
}

type Read = { address: string; functionName: string; args?: readonly unknown[] };

/** The example mandate with every chain read answered from a table, and the reads it made. */
function withReads(reads: Record<string, (read: Read) => unknown>): { client: MandateAccountClient; made: Read[] } {
  const base = connect({ chainId: 4663 });
  const made: Read[] = [];
  const publicClient = {
    readContract: async (read: Read) => {
      made.push(read);
      const fn = reads[read.functionName];
      if (fn === undefined) throw new Error(`unexpected read ${read.functionName}`);
      return fn(read);
    },
  };
  return { made, client: { address: EXAMPLE, connection: { ...base, publicClient } } as unknown as MandateAccountClient };
}

/** A registry that lists the record's SPY and an NFLX the record never heard of. */
function registryWithNflx() {
  return withReads({
    assets: () => [SPY, NFLX],
    get: ({ args }) => ({
      feed: '0x4A1166a659A55625345e9515b32adECea5547C38',
      tradeStaleness: 93_600,
      valuationStaleness: 93_600,
      bandBps: 100,
      haircutBps: 0,
      collateralHaircutBps: 0,
      decimals: 18,
      eligible: true,
      isStock: true,
      isTreasury: false,
      perTradeCap: 25_000_000n,
      perMandateCap: 0n,
      totalCap: 0n,
      pool: { currency0: args?.[0], currency1: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' },
    }),
    symbol: ({ address }) => (address.toLowerCase() === NFLX.toLowerCase() ? 'NFLX' : 'SPY'),
    valuationPrice: () => [38_295_000_000n, 1_790_000_000n, true],
    maxSlippageBps: () => 100,
    assetAllowed: ({ args }) => args?.[1] === NFLX,
  });
}

/** A node where the example mandate has SPY released for sale, and the router's receipt for selling it. */
function selling(sellable: bigint) {
  const sold = {
    address: LANE.StockSpendRouter,
    topics: encodeEventTopics({ abi: stockSpendRouterAbi, eventName: 'StockSold', args: { mandate: EXAMPLE, asset: SPY } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [RAW, 499_374n, PRICE_E8]),
  };
  const fake = fakeConnection({
    read: (call) => {
      switch (call.functionName) {
        case 'sellable':
          return sellable;
        case 'exitPrice':
          return PRICE_E8;
        case 'minUsdgFor':
          return FLOOR;
        default:
          return undefined;
      }
    },
    logs: [sold as never],
  });
  const mandate = { address: EXAMPLE, connection: fake.connection } as unknown as MandateAccountClient;
  return { fake, client: rwa(mandate, LANE) };
}

describe('selling a stock back to usdg', () => {
  it('sells what the principal released, at the floor the router quotes, and reads the proceeds back', async () => {
    const { fake, client } = selling(RAW);

    const receipt = await client.sell('SPY');

    expect(receipt).toMatchObject({ asset: SPY, amountIn: RAW, usdgOut: 499_374n, priceE8: PRICE_E8 });
    expect(fake.reads.map((read) => read.functionName)).toEqual(['sellable', 'exitPrice', 'minUsdgFor']);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.to).toBe(LANE.StockSpendRouter);
    expect(decodeFunctionData({ abi: stockSpendRouterAbi, data: fake.sent[0]!.data })).toEqual({
      functionName: 'sell',
      args: [EXAMPLE, SPY, RAW, FLOOR, PRICE_E8],
    });
  });

  it('sells part of the custody when told how much', async () => {
    const { fake, client } = selling(RAW);
    await client.sell('spy', RAW / 2n);
    expect(fake.reads.map((read) => read.functionName)).toEqual(['exitPrice', 'minUsdgFor']);
    expect(decodeFunctionData({ abi: stockSpendRouterAbi, data: fake.sent[0]!.data }).args?.[2]).toBe(RAW / 2n);
  });

  it('sends nothing when the principal has released nothing', async () => {
    const { fake, client } = selling(0n);
    await expect(client.sell('SPY')).rejects.toMatchObject({ code: 'rwa_nothing_released' });
    await expect(client.recall('SPY')).rejects.toBeInstanceOf(BursarError);
    expect(fake.sent).toHaveLength(0);
  });

  it('sets the sale policy on the router, allow before deny', async () => {
    const { fake, client } = selling(RAW);
    await client.setSalePolicy({ allow: ['SPY'], deny: ['NVDA'] });
    expect(decodeFunctionData({ abi: stockSpendRouterAbi, data: fake.sent[0]!.data })).toEqual({
      functionName: 'setSalePolicy',
      args: [EXAMPLE, [SPY, '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'], [true, false]],
    });
  });
});

describe('rwa client', () => {
  it('resolves assets and adapters from the deployment record', () => {
    const client = new RwaClient(offline());
    expect(client.resolve('sgov')).toBe('0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5');
    expect(client.resolve('SPY')).toBe('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C');
    expect(client.adapter('SGOV')).toBe(rwaDeployment(4663)?.adapters['SGOV']);
    expect(() => client.resolve('NFLX')).toThrow(UnknownAssetError);
  });

  it('names a stock the registry lists and the record does not, by its own ticker', async () => {
    const { client, made } = registryWithNflx();
    const lane = rwa(client);

    const nflx = await lane.asset('nflx');
    const price = await lane.price('NFLX');
    const policy = await lane.policy();

    expect(nflx).toMatchObject({ symbol: 'NFLX', address: NFLX, kind: 'stock', eligible: true });
    expect(price.priceE8).toBe(38_295_000_000n);
    expect(policy.allowed).toEqual([NFLX]);
    // The registry and the token are read once for the whole client, not once per call.
    expect(made.filter((read) => read.functionName === 'assets')).toHaveLength(1);
    expect(made.filter((read) => read.functionName === 'symbol' && read.address === NFLX)).toHaveLength(2);
    expect(() => lane.resolve('NFLX')).toThrow(UnknownAssetError);
  });

  it('names what the registry lists when a ticker is on neither list', async () => {
    const { client } = registryWithNflx();

    await expect(rwa(client).price('IBM')).rejects.toThrow('IBM is not an asset this deployment lists. It lists SPY, NFLX.');
  });

  it.skipIf(!live)('reads the example mandate on 4663', async () => {
    const client = rwa(await mandateAccount(EXAMPLE, { chainId: 4663 }));
    const assets = await client.assets();
    expect(assets.map((a) => a.symbol).sort()).toEqual(['AAPL', 'NVDA', 'SGOV', 'SPY']);
    const holdings = await client.holdings();
    expect(holdings.find((h) => h.asset.symbol === 'SPY')?.raw).toBeGreaterThan(0n);
    const parked = await client.parked();
    expect(parked.find((p) => p.symbol === 'SGOV')?.raw).toBeGreaterThan(0n);
    const policy = await client.policy();
    expect(policy.allowed).toContain('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C');
  });
});
