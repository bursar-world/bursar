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
const live = process.env['BURSAR_LIVE_RHC'] === '1';

const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const LANE = rwaDeployment(4663)!;
const RAW = 640_554_959_594_479n;
const PRICE_E8 = 78_005_783_409n;
const FLOOR = 494_672n;

function offline(): MandateAccountClient {
  return { address: EXAMPLE, connection: connect({ chainId: 4663 }) } as unknown as MandateAccountClient;
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
    expect(() => client.resolve('TSLA')).toThrow(UnknownAssetError);
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
