import { createPublicClient, custom } from 'viem';
import type { Chain, PublicClient, Transport } from 'viem';
import type { RhcChain, RhcNetwork } from '../chain.js';
import { RHC_MAINNET, TestnetHasNoSettlementAsset, viemChain } from '../chain.js';
import { BursarError } from '../errors.js';
import { loadEnv, envVar, optional } from '../env.js';
import type { EnvSource } from '../env.js';
import { RpcPool } from './pool.js';
import type { RpcPoolEvent, RpcProvider, RpcRetryOptions } from './pool.js';
import type { BreakerOptions } from './breaker.js';
import { defaultFallbackRpc, hostOf } from './limits.js';

export type RhcClientOptions = {
  readonly chain: RhcChain;
  /** Ordered. Index 0 is the endpoint this deployment pays for and expects to serve every call. */
  readonly providers?: readonly RpcProvider[];
  /** Supply an existing pool to share breaker state across clients in the same process. */
  readonly pool?: RpcPool;
  readonly timeoutMs?: number;
  readonly breaker?: BreakerOptions;
  readonly retry?: RpcRetryOptions;
  readonly onEvent?: (event: RpcPoolEvent) => void;
  readonly fetchFn?: typeof fetch;
  /**
   * Two providers from day one. Set false only for a local node or a fork, and set it at the
   * call site where a reader will see it.
   */
  readonly requireRedundancy?: boolean;
};

/** Chain is bound, so `client.chain` is always present. */
export type RhcPublicClient = PublicClient<Transport, Chain>;

export type RhcClient = {
  readonly client: RhcPublicClient;
  readonly pool: RpcPool;
  readonly chain: RhcChain;
};

/**
 * A viem public client whose transport is the ordered pool rather than a single URL.
 *
 * viem's own retry is switched off: retrying the same dead endpoint three times before the pool
 * gets to try the next one turns a failover into a ten-second stall. The pool retries instead, and
 * it moves to a different provider while it does.
 */
export function createRhcClient(options: RhcClientOptions): RhcClient {
  const providers = options.providers ?? [{ name: 'chain-default', url: options.chain.rpcUrl }];

  if (options.requireRedundancy ?? true) {
    const hosts = new Set(providers.map((p) => hostOf(p.url)));
    if (!options.pool && hosts.size < 2) {
      throw new BursarError(
        'rpc_no_redundancy',
        'Robinhood Chain clients run on two independent RPC providers. Configure RHC_RPC_PRIMARY ' +
          'and RHC_RPC_FALLBACK at different hosts, or pass requireRedundancy: false for a local ' +
          'node or a fork.',
        { providers: providers.map((p) => p.name), hosts: [...hosts] },
      );
    }
  }

  const pool =
    options.pool ??
    new RpcPool({
      providers,
      chainId: options.chain.chainId,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.breaker === undefined ? {} : { breaker: options.breaker }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });

  const client: RhcPublicClient = createPublicClient({
    chain: viemChain(options.chain),
    transport: custom(
      {
        request: ({ method, params }) => pool.request(method, (params ?? []) as readonly unknown[]),
      },
      { retryCount: 0 },
    ),
  });

  return { client, pool, chain: options.chain };
}

const RPC_ENV = {
  RHC_RPC_PRIMARY: envVar.url(),
  RHC_RPC_FALLBACK: optional(envVar.url()),
  RHC_RPC_TERTIARY: optional(envVar.url()),
  RHC_RPC_PRIMARY_MAX_RPS: optional(envVar.int({ min: 1, max: 10_000 })),
  RHC_RPC_FALLBACK_MAX_RPS: optional(envVar.int({ min: 1, max: 10_000 })),
  RHC_RPC_TERTIARY_MAX_RPS: optional(envVar.int({ min: 1, max: 10_000 })),
  RHC_RPC_PRIMARY_MAX_CONCURRENCY: optional(envVar.int({ min: 1, max: 4096 })),
  RHC_RPC_FALLBACK_MAX_CONCURRENCY: optional(envVar.int({ min: 1, max: 4096 })),
  RHC_RPC_TERTIARY_MAX_CONCURRENCY: optional(envVar.int({ min: 1, max: 4096 })),
} as const;

/**
 * Mainnet unless the operator typed "testnet". 4663 is fully specified and 46630 has no
 * settlement asset, so the safe default and the working default are the same one.
 */
function networkOf(source: EnvSource): RhcNetwork {
  return source['RHC_NETWORK']?.trim() === 'testnet' ? 'testnet' : 'mainnet';
}

/**
 * The shared naming every BURSAR service reads its endpoints from. Primary is the endpoint this
 * deployment chose, fallback is an independent provider and defaults to a keyless one, and
 * tertiary is for the rare deployment that wants a third.
 *
 * Two endpoints at the same host are rejected. Primary and fallback at one host is single-provider
 * operation under a second name: one rate limit and one outage.
 */
export function rhcRpcProviders(
  source: EnvSource = process.env,
  network: RhcNetwork = networkOf(source),
): readonly RpcProvider[] {
  if (network === 'testnet') throw new TestnetHasNoSettlementAsset('RHC_NETWORK');

  const config = loadEnv(RPC_ENV, source);
  const fallback = config.RHC_RPC_FALLBACK ?? defaultFallbackRpc(network);
  const providers: RpcProvider[] = [
    withLimits({ name: 'primary', url: config.RHC_RPC_PRIMARY }, {
      rps: config.RHC_RPC_PRIMARY_MAX_RPS,
      concurrency: config.RHC_RPC_PRIMARY_MAX_CONCURRENCY,
    }),
    withLimits({ name: 'fallback', url: fallback }, {
      rps: config.RHC_RPC_FALLBACK_MAX_RPS,
      concurrency: config.RHC_RPC_FALLBACK_MAX_CONCURRENCY,
    }),
  ];
  if (config.RHC_RPC_TERTIARY) {
    providers.push(
      withLimits({ name: 'tertiary', url: config.RHC_RPC_TERTIARY }, {
        rps: config.RHC_RPC_TERTIARY_MAX_RPS,
        concurrency: config.RHC_RPC_TERTIARY_MAX_CONCURRENCY,
      }),
    );
  }

  const hosts = new Set(providers.map((provider) => hostOf(provider.url)));
  const seen = new Map<string, string>();
  for (const provider of providers) {
    const host = hostOf(provider.url);
    const first = seen.get(host);
    if (first !== undefined) {
      const variable = `RHC_RPC_${provider.name.toUpperCase()}`;
      // An unset fallback is the default provider, so an operator whose primary already is that
      // provider never typed the value that collided. Say where it came from, and never offer a
      // host that is already in the list as the fix.
      const defaulted = provider.name === 'fallback' && config.RHC_RPC_FALLBACK === undefined;
      const alternative = [defaultFallbackRpc(network), RHC_MAINNET.rpcUrl].find(
        (url) => !hosts.has(hostOf(url)),
      );
      throw new BursarError(
        'rpc_single_provider',
        `RHC_RPC_${first.toUpperCase()} and ${variable} both point at ${host}` +
          (defaulted ? ` (${variable} is unset, and ${host} is its default)` : '') +
          `. Two names for one endpoint is one endpoint: set ${variable} to a second, independent ` +
          `provider` +
          (alternative === undefined ? '.' : `, such as ${alternative}, which needs no key.`),
        { host, providers: [first, provider.name], variable },
      );
    }
    seen.set(host, provider.name);
  }

  return providers;
}

/**
 * Only what the operator set. A host with a known pace gets it from the pool, so an endpoint that
 * moves to a new provider does not carry a stale figure copied in here.
 */
function withLimits(
  provider: RpcProvider,
  limits: { rps: number | undefined; concurrency: number | undefined },
): RpcProvider {
  return {
    ...provider,
    ...(limits.rps === undefined ? {} : { maxRatePerSecond: limits.rps }),
    ...(limits.concurrency === undefined ? {} : { maxConcurrent: limits.concurrency }),
  };
}
