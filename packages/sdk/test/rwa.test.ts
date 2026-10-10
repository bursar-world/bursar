import { describe, expect, it } from 'vitest';
import { rwaDeployment } from '@bursar/core';

import { connect } from '../src/connection.js';
import { mandateAccount } from '../src/mandate.js';
import { RwaClient, UnknownAssetError, rwa } from '../src/rwa.js';
import type { MandateAccountClient } from '../src/mandate.js';

const EXAMPLE = '0x420BeB507F72173E7d78e0f956968f64fb508356';
const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const TSLA = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';
const live = process.env['BURSAR_LIVE_RHC'] === '1';

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

/** A registry that lists the record's SPY and a TSLA the record never heard of. */
function registryWithTsla() {
  return withReads({
    assets: () => [SPY, TSLA],
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
    symbol: ({ address }) => (address.toLowerCase() === TSLA.toLowerCase() ? 'TSLA' : 'SPY'),
    valuationPrice: () => [38_295_000_000n, 1_790_000_000n, true],
    maxSlippageBps: () => 100,
    assetAllowed: ({ args }) => args?.[1] === TSLA,
  });
}

describe('rwa client', () => {
  it('resolves assets and adapters from the deployment record', () => {
    const client = new RwaClient(offline());
    expect(client.resolve('sgov')).toBe('0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5');
    expect(client.resolve('SPY')).toBe('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C');
    expect(client.adapter('SGOV')).toBe(rwaDeployment(4663)?.adapters['SGOV']);
    expect(() => client.resolve('TSLA')).toThrow(UnknownAssetError);
  });

  it('names a stock the registry lists and the record does not, by its own ticker', async () => {
    const { client, made } = registryWithTsla();
    const lane = rwa(client);

    const tsla = await lane.asset('tsla');
    const price = await lane.price('TSLA');
    const policy = await lane.policy();

    expect(tsla).toMatchObject({ symbol: 'TSLA', address: TSLA, kind: 'stock', eligible: true });
    expect(price.priceE8).toBe(38_295_000_000n);
    expect(policy.allowed).toEqual([TSLA]);
    // The registry and the token are read once for the whole client, not once per call.
    expect(made.filter((read) => read.functionName === 'assets')).toHaveLength(1);
    expect(made.filter((read) => read.functionName === 'symbol' && read.address === TSLA)).toHaveLength(2);
    expect(() => lane.resolve('TSLA')).toThrow(UnknownAssetError);
  });

  it('names what the registry lists when a ticker is on neither list', async () => {
    const { client } = registryWithTsla();

    await expect(rwa(client).price('AMZN')).rejects.toThrow('AMZN is not an asset this deployment lists. It lists SPY, TSLA.');
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
