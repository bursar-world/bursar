import { RpcPool, createRhcClient, redactUrl } from '@bursar/core';
import type { RhcPublicClient, RpcPoolEvent } from '@bursar/core';
import { RHC, rpcProviders } from './rhc';

/**
 * One pooled client per tab.
 *
 * A public endpoint meters arrivals per second, not calls in flight, and the meter is shared by
 * everything coming from the same source. Every read in this app goes through this client so the
 * pacer sees all of it; a second bare `http()` transport anywhere would work perfectly on its own
 * and start costing this one its calls the moment both are busy.
 *
 * The pool also carries the failover. Each provider keeps its own breaker and a refused call moves
 * quietly down the list. The connectivity panel reads the same snapshot, so a degraded endpoint
 * stays visible even once the failover has covered for it.
 */
let cached: RhcPublicClient | undefined;
let pool: RpcPool | undefined;

const listeners = new Set<(event: RpcPoolEvent) => void>();

export function rhcClient(): RhcPublicClient {
  if (!cached) create();
  return cached as RhcPublicClient;
}

export function rhcPool(): RpcPool {
  if (!pool) create();
  return pool as RpcPool;
}

/** Subscribe to pool events so a surface can show a failover the moment it happens. */
export function onPoolEvent(listener: (event: RpcPoolEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function create(): void {
  const rhc = createRhcClient({
    chain: RHC,
    providers: rpcProviders(),
    // A browser's fetch has to be called on the window. The pool holds it as a field and calls it
    // as a method, which a browser rejects as an illegal invocation. Binding it here fixes that.
    fetchFn: globalThis.fetch.bind(globalThis),
    onEvent: (event) => {
      for (const listener of listeners) listener(event);
    },
  });
  cached = rhc.client;
  pool = rhc.pool;
}

export type ProviderHealth = {
  readonly name: string;
  /** Query string stripped, because an endpoint key belongs in nobody's screenshot. */
  readonly url: string;
  readonly reachable: boolean;
  readonly blockNumber: bigint | null;
  readonly chainId: number | null;
  readonly latencyMs: number | null;
  readonly problem: string | null;
  /** Breaker state and counters the pool has accumulated for this endpoint. */
  readonly breaker: 'closed' | 'open' | 'half-open' | 'unknown';
  readonly throttled: number;
  readonly failures: number;
};

/**
 * Asks each endpoint directly, bypassing the pool.
 *
 * Going through the pool would answer "the chain is reachable", which is true and useless: it is
 * exactly what a silent failover looks like from the outside. Redundancy that has already been
 * spent is the thing an operator needs to see before the second endpoint goes too.
 */
export async function probeProviders(timeoutMs = 6_000): Promise<readonly ProviderHealth[]> {
  const counters = new Map(rhcPool().status().map((entry) => [entry.name, entry]));

  return Promise.all(
    rpcProviders().map(async (provider): Promise<ProviderHealth> => {
      const started = performance.now();
      const seen = counters.get(provider.name);
      const base: Pick<ProviderHealth, 'name' | 'url' | 'breaker' | 'throttled' | 'failures'> = {
        name: provider.name,
        url: redactUrl(provider.url),
        breaker: seen?.state ?? 'unknown',
        throttled: seen?.throttled ?? 0,
        failures: seen?.failures ?? 0,
      };

      try {
        const [block, chainId] = await Promise.all([
          rpcCall(provider.url, 'eth_blockNumber', timeoutMs),
          rpcCall(provider.url, 'eth_chainId', timeoutMs),
        ]);

        return {
          ...base,
          reachable: true,
          blockNumber: BigInt(block as string),
          chainId: Number(BigInt(chainId as string)),
          latencyMs: Math.round(performance.now() - started),
          problem: null,
        };
      } catch (error) {
        return {
          ...base,
          reachable: false,
          blockNumber: null,
          chainId: null,
          latencyMs: null,
          problem: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

async function rpcCall(url: string, method: string, timeoutMs: number): Promise<unknown> {
  const abort = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal: abort,
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'RPC error');
  if (body.result === undefined) throw new Error('Empty response');
  return body.result;
}
