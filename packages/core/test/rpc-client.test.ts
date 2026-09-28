import { describe, expect, it } from 'vitest';
import { RHC_MAINNET, TestnetHasNoSettlementAsset } from '../src/chain.js';
import { EnvError } from '../src/env.js';
import { BursarError } from '../src/errors.js';
import { createRhcClient, rhcRpcProviders } from '../src/rpc/client.js';
import {
  DRPC_RATE,
  RHC_MAINNET_DEFAULT_FALLBACK_RPC,
  RHC_PUBLIC_RPC_RATE,
  defaultFallbackRpc,
  rateLimitFor,
} from '../src/rpc/limits.js';

const PRIMARY = 'https://rpc.mainnet.chain.robinhood.com';
const DRPC = 'https://robinhood.drpc.org';

describe('rhcRpcProviders', () => {
  it('supplies the keyless second provider when a deployment sets only the primary', () => {
    const providers = rhcRpcProviders({ RHC_RPC_PRIMARY: PRIMARY });

    expect(providers.map((p) => p.name)).toEqual(['primary', 'fallback']);
    expect(providers[1]?.url).toBe(RHC_MAINNET_DEFAULT_FALLBACK_RPC);
    expect(RHC_MAINNET_DEFAULT_FALLBACK_RPC).toBe(DRPC);
  });

  /**
   * 4663 is the only network that settles, so an unset RHC_NETWORK has to mean mainnet or every
   * service comes up pointed at a chain with no settlement asset.
   */
  it('defaults to mainnet with no RHC_NETWORK set', () => {
    expect(rhcRpcProviders({ RHC_RPC_PRIMARY: PRIMARY })[1]?.url).toBe(RHC_MAINNET_DEFAULT_FALLBACK_RPC);
    expect(rhcRpcProviders({ RHC_NETWORK: '', RHC_RPC_PRIMARY: PRIMARY })[1]?.url).toBe(
      RHC_MAINNET_DEFAULT_FALLBACK_RPC,
    );
  });

  it('refuses to build a provider list for testnet at all', () => {
    expect(() => rhcRpcProviders({ RHC_NETWORK: 'testnet', RHC_RPC_PRIMARY: PRIMARY })).toThrow(
      TestnetHasNoSettlementAsset,
    );
    expect(() => rhcRpcProviders({ RHC_RPC_PRIMARY: PRIMARY }, 'testnet')).toThrow(/USDG is not deployed/);
    expect(() => defaultFallbackRpc('testnet')).toThrow(TestnetHasNoSettlementAsset);
  });

  it('leaves the pace to the host, which is where the measurement lives', () => {
    const providers = rhcRpcProviders({ RHC_RPC_PRIMARY: PRIMARY, RHC_RPC_FALLBACK: DRPC });

    expect(providers.map((p) => p.maxRatePerSecond)).toEqual([undefined, undefined]);
    expect(rateLimitFor('https://rpc.mainnet.chain.robinhood.com')).toEqual(RHC_PUBLIC_RPC_RATE);
    expect(rateLimitFor(DRPC)).toEqual(DRPC_RATE);
    expect(rateLimitFor('http://127.0.0.1:8545')).toBeUndefined();
  });

  it('holds the rates measured on 4663 on 2026-09-22', () => {
    // The primary answered 60 a second clean and started refusing at 70; dRPC never refused at
    // all, up to 200. Both defaults sit under what was demonstrated, with room for a second
    // process on the same source address.
    expect(RHC_PUBLIC_RPC_RATE).toEqual({ ratePerSecond: 40, burst: 30 });
    expect(DRPC_RATE).toEqual({ ratePerSecond: 100, burst: 60 });
  });

  it('takes a configured pace, and a concurrency cap, from the environment', () => {
    const providers = rhcRpcProviders({
      RHC_RPC_PRIMARY: PRIMARY,
      RHC_RPC_FALLBACK: DRPC,
      RHC_RPC_PRIMARY_MAX_RPS: '8',
      RHC_RPC_FALLBACK_MAX_RPS: '64',
      RHC_RPC_PRIMARY_MAX_CONCURRENCY: '4',
    });

    expect(providers.map((p) => p.maxRatePerSecond)).toEqual([8, 64]);
    expect(providers.map((p) => p.maxConcurrent)).toEqual([4, undefined]);
  });

  it('refuses two names for one host, whatever the path or the key', () => {
    const error = capture(() =>
      rhcRpcProviders({
        RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com/v1/key-a',
        RHC_RPC_FALLBACK: 'https://rpc.mainnet.chain.robinhood.com/v1/key-b',
      }),
    );

    expect(error).toBeInstanceOf(BursarError);
    expect((error as BursarError).code).toBe('rpc_single_provider');
    expect((error as BursarError).message).toContain('rpc.mainnet.chain.robinhood.com');
    expect((error as BursarError).message).toContain('RHC_RPC_PRIMARY');
  });

  it('names the fallback it defaulted, and never offers the colliding host as the fix', () => {
    const error = capture(() => rhcRpcProviders({ RHC_RPC_PRIMARY: `${DRPC}/key` }));

    expect((error as BursarError).code).toBe('rpc_single_provider');
    const message = (error as BursarError).message;
    expect(message).toContain('RHC_RPC_FALLBACK is unset');
    expect(message).toContain(`set RHC_RPC_FALLBACK to a second, independent provider, such as ${PRIMARY}`);
    expect(message).not.toContain(`such as ${DRPC}`);
  });

  it('offers no alternative when every keyless endpoint is already in the list', () => {
    const error = capture(() =>
      rhcRpcProviders({
        RHC_RPC_PRIMARY: PRIMARY,
        RHC_RPC_FALLBACK: `${PRIMARY}/v2`,
        RHC_RPC_TERTIARY: DRPC,
      }),
    );

    const message = (error as BursarError).message;
    expect(message).toContain('set RHC_RPC_FALLBACK to a second, independent provider.');
    expect(message).not.toContain('such as');
  });

  it('refuses a tertiary that duplicates a host already in the list', () => {
    const error = capture(() =>
      rhcRpcProviders({
        RHC_RPC_PRIMARY: PRIMARY,
        RHC_RPC_FALLBACK: DRPC,
        RHC_RPC_TERTIARY: 'https://robinhood.drpc.org/other',
      }),
    );

    expect((error as BursarError).code).toBe('rpc_single_provider');
  });

  it('still demands a primary', () => {
    expect(() => rhcRpcProviders({})).toThrow(EnvError);
  });
});

describe('createRhcClient', () => {
  it('refuses to run on one host under two provider names', () => {
    const error = capture(() =>
      createRhcClient({
        chain: RHC_MAINNET,
        providers: [
          { name: 'primary', url: PRIMARY },
          { name: 'fallback', url: `${PRIMARY}/v2` },
        ],
      }),
    );

    expect((error as BursarError).code).toBe('rpc_no_redundancy');
    expect((error as BursarError).message).toContain('RHC_RPC_FALLBACK');
  });

  it('accepts a single endpoint only when the call site says it is a local node or a fork', () => {
    const { pool } = createRhcClient({
      chain: RHC_MAINNET,
      providers: [{ name: 'fork', url: 'http://127.0.0.1:8545' }],
      requireRedundancy: false,
    });

    expect(pool.providers).toHaveLength(1);
    // A fork is nobody's metered endpoint, so it runs unpaced until it says otherwise.
    expect(pool.status()[0]?.ratePerSecond).toBeNull();
  });

  it('binds the pool to the chain it was built for, so a stray endpoint cannot answer', async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xb626' }))) as unknown as typeof fetch;

    const { pool } = createRhcClient({
      chain: RHC_MAINNET,
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: DRPC },
      ],
      fetchFn: fn,
    });

    // 0xb626 is 46630: the testnet endpoint answering under a mainnet name.
    const error = await pool.request('eth_blockNumber').catch((e: unknown) => e);
    expect((error as BursarError).code).toBe('rpc_wrong_chain');
    expect((error as BursarError).message).toContain('4663');
  });

  it('applies the measured Robinhood pace to a provider list that did not set one', () => {
    const { pool } = createRhcClient({
      chain: RHC_MAINNET,
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: DRPC },
      ],
    });

    expect(pool.status().map((s) => s.ratePerSecond)).toEqual([
      RHC_PUBLIC_RPC_RATE.ratePerSecond,
      DRPC_RATE.ratePerSecond,
    ]);
  });
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}
