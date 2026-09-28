import { TestnetHasNoSettlementAsset } from '../chain.js';
import type { RhcNetwork } from '../chain.js';

export type RpcRateLimit = {
  readonly ratePerSecond: number;
  readonly burst: number;
};

/**
 * Measured against `rpc.mainnet.chain.robinhood.com` on 2026-09-22: arrivals paced at a fixed
 * rate for six seconds, counting 429s.
 *
 * Paced, per second, `eth_blockNumber`:
 *
 *   10, 15, 20, 25, 30, 40, 50, 60   clean, 0 of 300 to 360 rate limited, p50 ~165 ms
 *   70                               56 of 420 rate limited
 *   75                               19 of 375
 *   100                              84 of 500
 *   150                              399 of 750
 *   200                              1000 of 1000
 *
 * Fired all at once: 20, 40, 60 and 80 answered clean; 100 answered clean from a rested meter and
 * were refused outright straight after the 200/s run, so the endpoint carries the penalty forward
 * for a while.
 *
 * So the ceiling sits between 60 and 70 a second. Forty is two thirds of the highest clean rate,
 * which leaves room for a second process on the same source address: that is the case that broke
 * an earlier live run. The burst is well inside the eighty that answered at once.
 *
 * This is a starting point. A 429 halves whatever rate is in force and the bucket climbs back on
 * its own.
 */
export const RHC_PUBLIC_RPC_RATE: RpcRateLimit = { ratePerSecond: 40, burst: 30 };

/**
 * Keyless, answers `0x1237`, and serves 4663 at the same height as Robinhood's own endpoint.
 * Measured 2026-09-22.
 */
export const RHC_MAINNET_DEFAULT_FALLBACK_RPC = 'https://robinhood.drpc.org';

/**
 * The second provider a deployment gets when it sets only RHC_RPC_PRIMARY, so the two-provider
 * rule still holds without a key.
 *
 * Testnet gets no default because it gets no deployment. Asking for one is asking for a second
 * opinion on a network where nothing can settle, so it is refused here rather than answered with
 * a URL that would let the configuration look complete.
 */
export function defaultFallbackRpc(network: RhcNetwork = 'mainnet'): string {
  if (network === 'testnet') throw new TestnetHasNoSettlementAsset('The RPC configuration');
  return RHC_MAINNET_DEFAULT_FALLBACK_RPC;
}

/**
 * dRPC took every rate this probe could generate without one 429: 60, 80, 100, 150 and 200 a
 * second over six seconds each, and 120 fired at once. At 250 a second the failures were local
 * sockets giving out, not the endpoint refusing. Measured 2026-09-22.
 *
 * The default is half of the highest clean rate on purpose. Six seconds of `eth_blockNumber`
 * measures an arrival meter; it does not measure a monthly compute budget on a keyless endpoint
 * shared with everyone else pointing at Robinhood Chain, and this is the provider that has to be
 * there on the day the primary is not.
 */
export const DRPC_RATE: RpcRateLimit = { ratePerSecond: 100, burst: 60 };

/**
 * Where an unmetered endpoint is paced once it answers its first 429. Nothing is known about its
 * ceiling at that point except that it sits below the rate that drew the 429, so this is cautious;
 * the bucket recovers from here.
 */
export const DISCOVERED_RATE: RpcRateLimit = { ratePerSecond: 10, burst: 10 };

/**
 * The pace to hold in front of an endpoint nobody configured. Robinhood operates the
 * `chain.robinhood.com` endpoints and dRPC operates `drpc.org`; any other host, including a local
 * fork, is left unpaced until it says otherwise with a 429.
 */
export function rateLimitFor(url: string): RpcRateLimit | undefined {
  const host = hostOf(url);
  if (host === 'robinhood.com' || host.endsWith('.robinhood.com')) return RHC_PUBLIC_RPC_RATE;
  if (host === 'drpc.org' || host.endsWith('.drpc.org')) return DRPC_RATE;
  return undefined;
}

/** Falls back to the raw string so a malformed URL still compares equal to itself. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
