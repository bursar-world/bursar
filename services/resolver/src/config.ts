import { readFileSync } from 'node:fs';

import {
  EnvError,
  contractSetOf,
  deploymentsForChain,
  envVar,
  isBursarError,
  loadEnv,
  optional,
  parseDeployment,
  rhcChain,
  rhcRpcProviders,
  withDefault,
} from '@bursar/core';
import type { ContractSet, EnvProblem, EnvSource, EnvValues, RhcChain, RpcProvider } from '@bursar/core';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

import type { KeySource } from './keys.js';
import { passwordFromFile, passwordFromKeychain } from './keys.js';

/** One escrow and the registry it rules through. v2 and v1 are served side by side. */
export type Served = {
  readonly name: string;
  readonly escrow: Address;
  readonly registry: Address;
  /**
   * Which contract build the pair runs. It decides what a dispute that misses quorum does to the
   * lock: v1 refunds the payer, v2 reopens the lock and returns the bond.
   */
  readonly contractSet: ContractSet;
};

export type ResolverConfig = {
  readonly chain: RhcChain;
  readonly providers: readonly RpcProvider[];
  /**
   * Where transactions go, primary first. Reads fail over across the pool; a write is sent to one
   * of these and never re-sent through the pool, because the pool has no write allowlist and a
   * provider that never saw the first broadcast reports a stale nonce and invites a second
   * signature.
   */
  readonly writeUrls: readonly string[];
  readonly served: readonly Served[];
  readonly http: { readonly host: string; readonly port: number };
  readonly journal: { readonly kind: 'file'; readonly path: string } | { readonly kind: 'postgres'; readonly url: string };
  readonly alertWebhook: string | undefined;
  /** Null disables `POST /override` outright. */
  readonly operatorToken: string | null;
  /** Every address the operator controls as payer or payee. Overrides are refused on their disputes. */
  readonly operatorAddresses: readonly Address[] | null;
  readonly pollMs: number;
  readonly blockRange: bigint;
  readonly startBlock: bigint | undefined;
  readonly confirmTimeoutMs: number;
  readonly fetchTimeoutMs: number;
  /** Wei of ETH per key. Gas and settlement are different assets, so this is not an amount of USDG. */
  readonly minGasWei: bigint;
  readonly heartbeatMs: number;
};

/**
 * Keys are returned beside the configuration, never inside it, so a configuration that is logged
 * or serialised cannot carry them. They are not even opened here: `loadKeys` does that, once.
 */
export type LoadedConfig = {
  readonly config: ResolverConfig;
  readonly keys: KeySource;
};

const DEFAULT_KEY_ORDER = 'resolver-1,resolver-2,resolver-3';

const SCHEMA = {
  RHC_NETWORK: withDefault(envVar.oneOf(['testnet', 'mainnet']), 'mainnet'),

  /**
   * Deployment records to serve, as paths. Unset serves every live record bundled for the chain,
   * newest first, so the v1 escrow keeps its resolvers while its last locks and disputes settle.
   */
  RESOLVER_DEPLOYMENTS: optional(envVar.list()),

  RESOLVER_KEYSTORE_DIR: optional(envVar.string()),
  RESOLVER_PASSWORD_FILE: optional(envVar.string()),
  RESOLVER_PASSWORD_KEYCHAIN: optional(envVar.string({ pattern: /^[^/]+\/[^/]+$/ })),
  /** Raw keys for a host that holds its secrets in the environment. Paired with the order below. */
  RESOLVER_KEYS: optional(envVar.string({ pattern: /^0x[0-9a-fA-F]{64}(,0x[0-9a-fA-F]{64})*$/, secret: true })),
  RESOLVER_KEYS_ORDER: withDefault(envVar.list(), DEFAULT_KEY_ORDER.split(',')),

  BURSAR_ALERT_WEBHOOK: optional(envVar.url({ protocols: ['https:'] })),

  /** Loopback unless told otherwise. A host that routes to this port sets 0.0.0.0 on purpose. */
  RESOLVER_HTTP_HOST: withDefault(envVar.string(), '127.0.0.1'),
  RESOLVER_HTTP_PORT: withDefault(envVar.int({ min: 1, max: 65_535 }), 10_000),

  RESOLVER_DATABASE_URL: optional(envVar.url({ protocols: ['postgres:', 'postgresql:'] })),
  RESOLVER_JOURNAL_PATH: withDefault(envVar.string(), './resolver-journal.json'),

  RESOLVER_OPERATOR_TOKEN: optional(envVar.string({ minLength: 32, secret: true })),
  RESOLVER_OPERATOR_ADDRESSES: optional(envVar.list()),

  RESOLVER_POLL_MS: withDefault(envVar.int({ min: 1_000, max: 600_000 }), 30_000),
  RESOLVER_BLOCK_RANGE: withDefault(envVar.int({ min: 1, max: 100_000 }), 5_000),
  RESOLVER_START_BLOCK: optional(envVar.bigint({ min: 0n })),
  RESOLVER_CONFIRM_TIMEOUT_MS: withDefault(envVar.int({ min: 1_000, max: 600_000 }), 60_000),
  RESOLVER_FETCH_TIMEOUT_MS: withDefault(envVar.int({ min: 100, max: 60_000 }), 10_000),

  /**
   * 0.0001 ETH. A commit or a reveal costs about four millionths of that at today's price, so a
   * key under this has tens of votes left rather than none, which is the time to refill it.
   */
  RESOLVER_MIN_GAS_WEI: withDefault(envVar.bigint({ min: 0n }), 100_000_000_000_000n),
  RESOLVER_HEARTBEAT_MS: withDefault(envVar.int({ min: 60_000, max: 7 * 86_400_000 }), 86_400_000),
} as const;

/** Every problem in one pass, the service's own variables and the shared chain ones together. */
export function loadConfig(source: EnvSource = process.env): LoadedConfig {
  const problems: EnvProblem[] = [];

  const env = capture(() => loadEnv(SCHEMA, source), problems);
  const providers = capture(() => rhcRpcProviders(source), problems);
  const chain = capture(() => rhcChain(env?.RHC_NETWORK ?? 'mainnet', source), problems);

  const keys = env === undefined ? undefined : keySource(env, problems);
  const served = env === undefined || chain === undefined ? undefined : servedFrom(env.RESOLVER_DEPLOYMENTS, chain, problems);
  const operatorAddresses = env === undefined ? undefined : addresses(env.RESOLVER_OPERATOR_ADDRESSES, problems);

  if (
    env === undefined ||
    providers === undefined ||
    chain === undefined ||
    keys === undefined ||
    served === undefined ||
    operatorAddresses === undefined ||
    problems.length > 0
  ) {
    throw new EnvError(problems);
  }

  return {
    keys,
    config: {
      chain,
      providers,
      writeUrls: providers.map((provider) => provider.url),
      served,
      http: { host: env.RESOLVER_HTTP_HOST, port: env.RESOLVER_HTTP_PORT },
      journal:
        env.RESOLVER_DATABASE_URL === undefined
          ? { kind: 'file', path: env.RESOLVER_JOURNAL_PATH }
          : { kind: 'postgres', url: env.RESOLVER_DATABASE_URL },
      alertWebhook: env.BURSAR_ALERT_WEBHOOK,
      operatorToken: env.RESOLVER_OPERATOR_TOKEN ?? null,
      operatorAddresses,
      pollMs: env.RESOLVER_POLL_MS,
      blockRange: BigInt(env.RESOLVER_BLOCK_RANGE),
      startBlock: env.RESOLVER_START_BLOCK,
      confirmTimeoutMs: env.RESOLVER_CONFIRM_TIMEOUT_MS,
      fetchTimeoutMs: env.RESOLVER_FETCH_TIMEOUT_MS,
      minGasWei: env.RESOLVER_MIN_GAS_WEI,
      heartbeatMs: env.RESOLVER_HEARTBEAT_MS,
    },
  };
}

type Env = EnvValues<typeof SCHEMA>;

/**
 * Exactly one place the keys come from. Both set is refused rather than resolved by precedence,
 * because an operator who set both believes one of them is in use and cannot see which.
 */
function keySource(env: Env, problems: EnvProblem[]): KeySource | undefined {
  const names = env.RESOLVER_KEYS_ORDER;

  if (env.RESOLVER_KEYS !== undefined && env.RESOLVER_KEYSTORE_DIR !== undefined) {
    problems.push({
      name: 'RESOLVER_KEYS',
      reason: 'is set together with RESOLVER_KEYSTORE_DIR',
      expected: 'one source of resolver keys, not two',
    });
    return undefined;
  }

  if (env.RESOLVER_KEYS !== undefined) {
    return { kind: 'raw', names, keys: env.RESOLVER_KEYS.split(',') as Hex[] };
  }

  if (env.RESOLVER_KEYSTORE_DIR === undefined) {
    problems.push({
      name: 'RESOLVER_KEYSTORE_DIR',
      reason: 'is not set, and neither is RESOLVER_KEYS',
      expected: 'a directory of encrypted keystores named by RESOLVER_KEYS_ORDER, or RESOLVER_KEYS',
    });
    return undefined;
  }

  if ((env.RESOLVER_PASSWORD_FILE === undefined) === (env.RESOLVER_PASSWORD_KEYCHAIN === undefined)) {
    problems.push({
      name: 'RESOLVER_PASSWORD_FILE',
      reason: 'has to be set, or RESOLVER_PASSWORD_KEYCHAIN instead, and not both',
      expected: 'the keystore password as a file path or a Keychain service/account',
    });
    return undefined;
  }

  return {
    kind: 'keystore',
    dir: env.RESOLVER_KEYSTORE_DIR,
    names,
    password:
      env.RESOLVER_PASSWORD_FILE !== undefined
        ? passwordFromFile(env.RESOLVER_PASSWORD_FILE)
        : passwordFromKeychain(env.RESOLVER_PASSWORD_KEYCHAIN ?? ''),
  };
}

function servedFrom(paths: readonly string[] | undefined, chain: RhcChain, problems: EnvProblem[]): Served[] | undefined {
  try {
    const records =
      paths === undefined
        ? [...deploymentsForChain(chain.chainId)]
        : paths.map((path) => parseDeployment(JSON.parse(readFileSync(path, 'utf8')) as unknown, path));

    if (records.length === 0) {
      problems.push({
        name: 'RESOLVER_DEPLOYMENTS',
        reason: `is not set, and no live deployment is bundled for chain ${chain.chainId}`,
        expected: 'paths to deployment records such as contracts/deployments/rhc-mainnet-v2.json',
      });
      return undefined;
    }

    const wrong = records.find((record) => record.chainId !== chain.chainId);
    if (wrong !== undefined) {
      problems.push({
        name: 'RESOLVER_DEPLOYMENTS',
        reason: `names ${wrong.network} on chain ${wrong.chainId} while this service runs on ${chain.chainId}`,
        expected: 'deployment records for the configured chain',
      });
      return undefined;
    }

    return records.map((record) => ({
      name: record.network,
      escrow: getAddress(record.contracts.Escrow),
      registry: getAddress(record.contracts.OracleRegistry),
      contractSet: contractSetOf(record),
    }));
  } catch (error) {
    if (!isBursarError(error) && !(error instanceof SyntaxError) && !isFsError(error)) throw error;
    problems.push({
      name: 'RESOLVER_DEPLOYMENTS',
      reason: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
      expected: 'paths to deployment records such as contracts/deployments/rhc-mainnet.json',
    });
    return undefined;
  }
}

function addresses(list: readonly string[] | undefined, problems: EnvProblem[]): Address[] | null | undefined {
  if (list === undefined) return null;

  const parsed: Address[] = [];
  for (const entry of list) {
    try {
      parsed.push(getAddress(entry));
    } catch {
      problems.push({
        name: 'RESOLVER_OPERATOR_ADDRESSES',
        reason: `holds ${entry}, which is not an address`,
        expected: 'comma-separated 20-byte hex addresses',
      });
      return undefined;
    }
  }
  return parsed;
}

function isFsError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** Folds a resolver's own complaint into the shared report, the way the sidecar does. */
function capture<T>(resolve: () => T, problems: EnvProblem[]): T | undefined {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof EnvError) {
      problems.push(...error.problems);
      return undefined;
    }

    if (isBursarError(error) && error.code.startsWith('rhc_')) {
      const variable = error.details['variable'];
      if (typeof variable === 'string') {
        problems.push({ name: variable, reason: 'is not usable', expected: 'a Robinhood Chain mainnet chain parameter' });
        return undefined;
      }
    }

    throw error;
  }
}
