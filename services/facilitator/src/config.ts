import {
  TestnetHasNoSettlementAsset,
  ZERO_MICRO,
  activeBrand,
  assertFundingIsolation,
  caip2,
  envVar,
  loadEnv,
  optional,
  parseEth,
  rhcChain,
  rhcRpcProviders,
  withDefault,
} from '@bursar/core';
import type {
  BrandConfig,
  Caip2,
  EnvSource,
  FundingAddresses,
  Micro,
  RhcChain,
  RpcProvider,
  Wei,
} from '@bursar/core';
import { privateKeyToAccount } from 'viem/accounts';
import { FacilitatorConfigError } from './errors.js';
import { LANE_MODES } from './lanes/types.js';

/**
 * Configuration, collected and checked before anything listens.
 *
 * Three rules are enforced here. The network has to be one that can settle, which on Robinhood
 * Chain means mainnet: USDG has no contract on testnet. Every funding role gets its own address,
 * which used to be about gas and working capital sharing one balance and is now about keys, nonces
 * and rotation, all of which `assertFundingIsolation` explains where it refuses. And the relayer
 * key must be the gas float's key, because a relayer that can sign for the settlement or
 * collateral address is custody by another name.
 */

/**
 * How this deployment gets a spend decision.
 *
 * `remote` calls an underwriter over HTTP, `in-process` runs one inside this process against the
 * same environment its own binary reads, and `none` is a facilitator that only settles and takes
 * its decisions from whoever posts them to `/authorizations`. `unconfigured` is not a mode: it is
 * what `loadConfig` reports when the environment names none of them, and `main` will not start
 * on it.
 */
export const UNDERWRITER_MODES = ['remote', 'in-process', 'none'] as const;
export type UnderwriterMode = (typeof UNDERWRITER_MODES)[number];

/**
 * How long a hold may be opened for, in seconds.
 *
 * The floor is the settle claim's margin plus room for the call itself. A settle claims its hold
 * only while the hold still has one receipt wait (60 seconds) to run, so a hold opened for less than
 * that could never be settled, and one opened for barely more leaves the paid call no time to run.
 */
export const RESERVATION_TTL_SECONDS = { min: 90, max: 3_600 } as const;

/**
 * What a starting process is allowed to do to the schema.
 *
 * `on-start` applies what is pending before the port is bound, which is what a deployment that
 * owns its database wants. `verify` applies nothing and fails startup while anything is
 * pending, which is what a shared database wants: the schema changes when an operator says so,
 * and a binary that is ahead of it says which migrations are missing instead of writing them.
 * `off` neither applies nor checks, for a schema managed somewhere else entirely.
 */
export const MIGRATE_MODES = ['on-start', 'verify', 'off'] as const;
export type MigrateMode = (typeof MIGRATE_MODES)[number];

export type UnderwriterWiring =
  | { readonly mode: 'remote'; readonly url: string; readonly token: string | null }
  | { readonly mode: 'in-process' }
  | { readonly mode: 'none' }
  | { readonly mode: 'unconfigured' };

/** The variables that say an underwriter is meant to run inside this process. */
const IN_PROCESS_SIGNALS = ['MANDATE_DOCUMENT_SOURCE', 'MANDATE_ACCOUNT', 'MANDATE_DOCUMENT_PATH'] as const;

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export const UNDERWRITER_UNCONFIGURED =
  'This facilitator has no source of spend decisions. Set BURSAR_UNDERWRITER_URL to reach an underwriter over HTTP, or set MANDATE_DOCUMENT_SOURCE (chain, file or postgres) with the variables that mode needs to run one in this process, or set FACILITATOR_UNDERWRITER=none for a deployment that only settles decisions posted to /authorizations.';

const schema = {
  FACILITATOR_HOST: withDefault(envVar.string({ minLength: 1 }), '127.0.0.1'),
  FACILITATOR_PORT: withDefault(envVar.int({ min: 1, max: 65_535 }), 8402),
  /** Required unless the listener is on loopback, where the operating system is the boundary. */
  FACILITATOR_AUTH_TOKEN: optional(envVar.string({ minLength: 32, secret: true })),

  DATABASE_URL: envVar.url({ protocols: ['postgres:', 'postgresql:'] }),
  /** Whether a starting process may write to that schema. See `MIGRATE_MODES`. */
  FACILITATOR_MIGRATE: withDefault(envVar.oneOf(MIGRATE_MODES), 'on-start'),

  /** Mainnet is the only network that can settle. Testnet is refused below, with the reason. */
  RHC_NETWORK: withDefault(envVar.oneOf(['testnet', 'mainnet'] as const), 'mainnet'),

  /**
   * Server-side key for the hosted Blockscout index, which is a paid tier and answers 402 without
   * one. Core's `createIndexClient` reads the same variable and tells a 402 apart from an outage.
   *
   * Optional here, because nothing this service settles or decides reads history: the chain head,
   * the gas float and every contract read go over JSON-RPC. Declaring it anyway puts it in one
   * env surface with the rest, and `GET /config` reports whether this deployment has one.
   */
  BLOCKSCOUT_API_KEY: optional(envVar.string({ minLength: 8, secret: true })),

  FACILITATOR_GAS_FLOAT: envVar.address(),
  FACILITATOR_SETTLEMENT: envVar.address(),
  FACILITATOR_COLLATERAL: envVar.address(),
  FACILITATOR_TREASURY: envVar.address(),
  /**
   * The relayer's own key, and the only key this service holds.
   *
   * Declared secret, which is what keeps a load failure from printing it: `loadEnv` echoes the
   * value it could not parse back in the refusal for every variable that is not. Pasting the key
   * without its `0x` is exactly such a failure, and it used to put the whole key on stderr.
   *
   * One process per key. Transaction nonces are allocated in memory by the process that signs, so
   * two processes holding this key hand out the same nonces and replace each other's settlements.
   */
  FACILITATOR_RELAYER_KEY: envVar.string({ pattern: HEX32, secret: true }),
  /**
   * The relayer's ETH reserve, written the way ETH is written: `0.004`, not a count of wei.
   *
   * Gas and settlement are different assets here, so this is not micro-USD and carries its unit in
   * its name. Below it the relayer runs out mid-batch, which is worth alerting on before it
   * happens rather than after.
   */
  FACILITATOR_GAS_FLOAT_MINIMUM_ETH: envVar.string({ pattern: /^\d+(\.\d{1,18})?$/ }),

  FACILITATOR_FEE_BPS: envVar.bps(),
  FACILITATOR_FEE_FLOOR_MICRO: envVar.micro(),

  /**
   * Settlement ceilings, both of which have to leave room for at least one call.
   *
   * Zero is not "no cap": the budget refuses at the limit, so a zero on either one refuses every
   * payment this process is asked to settle while health, readiness and every probe stay green.
   * An operator who means no practical cap writes a large number.
   */
  FACILITATOR_DAILY_SETTLEMENTS: withDefault(envVar.int({ min: 1 }), 2_000),
  FACILITATOR_PER_PAYER_HOURLY: withDefault(envVar.int({ min: 1 }), 60),
  FACILITATOR_REQUIRE_BINDING: withDefault(envVar.boolean(), true),
  FACILITATOR_RESERVATION_TTL_SECONDS: withDefault(envVar.seconds(RESERVATION_TTL_SECONDS), 120),

  /**
   * Where spend decisions come from. Left unset it is derived, and a deployment that configured
   * neither an underwriter nor an explicit `none` fails at startup, not at the first request:
   * `/underwrite` answering 501 on a live deployment is a configuration mistake wearing a
   * protocol response.
   */
  FACILITATOR_UNDERWRITER: optional(envVar.oneOf(UNDERWRITER_MODES)),
  BURSAR_UNDERWRITER_URL: optional(envVar.url({ protocols: ['http:', 'https:'] })),
  BURSAR_UNDERWRITER_TOKEN: optional(envVar.string({ minLength: 16, secret: true })),

  TRUST_TOPIC: withDefault(envVar.string({ minLength: 1 }), 'mandate.trust.v1'),
  TRUST_SINK_URL: optional(envVar.url({ protocols: ['http:', 'https:'] })),
  TRUST_SINK_TOKEN: optional(envVar.string({ minLength: 16, secret: true })),
  TRUST_BATCH_SIZE: withDefault(envVar.int({ min: 1, max: 200 }), 50),
  TRUST_POLL_SECONDS: withDefault(envVar.seconds({ min: 1, max: 300 }), 2),
  TRUST_MAX_ATTEMPTS: withDefault(envVar.int({ min: 1, max: 64 }), 12),
  TRUST_LEASE_SECONDS: withDefault(envVar.seconds({ min: 5, max: 3_600 }), 60),
} as const;

export type FacilitatorConfig = {
  readonly host: string;
  readonly port: number;
  readonly authToken: string | null;
  readonly databaseUrl: string;
  readonly migrate: MigrateMode;
  readonly chain: RhcChain;
  readonly network: Caip2;
  /** USDG on this network. Read off the chain once, so nothing else has to know the token. */
  readonly settlementAsset: `0x${string}`;
  readonly brand: BrandConfig;
  readonly rpcProviders: readonly RpcProvider[];
  /** Absent unless this deployment was given a key for the chain index. */
  readonly indexKey: string | null;
  readonly funding: FundingAddresses & { readonly treasury: `0x${string}` };
  readonly relayerKey: `0x${string}`;
  readonly gasFloatMinimumWei: Wei;
  readonly feeBps: number;
  readonly feeFloorMicro: Micro;
  readonly dailySettlements: number;
  readonly perPayerHourly: number;
  readonly requireBinding: boolean;
  readonly reservationTtlMs: number;
  readonly underwriter: UnderwriterWiring;
  readonly trust: {
    readonly topic: string;
    readonly sinkUrl: string | null;
    readonly sinkToken: string | null;
    readonly batchSize: number;
    readonly pollIntervalMs: number;
    readonly maxAttempts: number;
    readonly leaseMs: number;
  };
};

/**
 * A thousand ETH, which is where a gas-float reserve stops being a reserve and starts being a
 * value written in the wrong unit. The smallest reserve anyone writes in wei, 0.001 ETH, is
 * 1e15, so the ceiling separates the two without coming near a figure an operator could mean.
 */
const GAS_FLOAT_MINIMUM_CEILING_WEI = 1_000n * 10n ** 18n;

/** Loopback is a boundary the operating system enforces. Anything else needs a token. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(source: EnvSource = process.env): FacilitatorConfig {
  const env = loadEnv(schema, source);

  // `rhcChain` refuses testnet on its own. Raising it from here first is what puts the variable an
  // operator actually set into the message, instead of leaving them to work out which of several
  // settings chose the network.
  if (env.RHC_NETWORK === 'testnet') throw new TestnetHasNoSettlementAsset('RHC_NETWORK');
  const chain = rhcChain(env.RHC_NETWORK, source);

  if (!LOOPBACK.has(env.FACILITATOR_HOST) && !env.FACILITATOR_AUTH_TOKEN) {
    throw new FacilitatorConfigError(
      'facilitator_token_required',
      `FACILITATOR_HOST is ${env.FACILITATOR_HOST}, so the service is reachable off this machine and every route needs FACILITATOR_AUTH_TOKEN`,
      { host: env.FACILITATOR_HOST },
    );
  }

  const funding = assertFundingIsolation({
    gasFloat: env.FACILITATOR_GAS_FLOAT,
    settlement: env.FACILITATOR_SETTLEMENT,
    collateral: env.FACILITATOR_COLLATERAL,
    treasury: env.FACILITATOR_TREASURY,
  });

  const relayerKey = env.FACILITATOR_RELAYER_KEY as `0x${string}`;
  const relayer = accountAddress(relayerKey);
  if (relayer.toLowerCase() !== funding.gasFloat.toLowerCase()) {
    throw new FacilitatorConfigError(
      'relayer_is_not_gas_float',
      `FACILITATOR_RELAYER_KEY signs for ${relayer}, which is not the gas float ${funding.gasFloat}`,
      { relayer, gasFloat: funding.gasFloat },
    );
  }

  if (env.FACILITATOR_FEE_BPS >= 10_000) {
    throw new FacilitatorConfigError(
      'fee_takes_the_whole_payment',
      'FACILITATOR_FEE_BPS is 10000, which is the entire payment. The ledger refuses a settlement the merchant nets nothing from, so every call would be broadcast and then refused.',
      { feeBps: env.FACILITATOR_FEE_BPS },
    );
  }

  if (env.FACILITATOR_FEE_FLOOR_MICRO <= ZERO_MICRO) {
    throw new FacilitatorConfigError(
      'fee_floor_invalid',
      'FACILITATOR_FEE_FLOOR_MICRO must be positive. It is the smallest fee in micro-USD this deployment will broadcast a direct settlement for; the ETH the broadcast costs comes out of the gas float and is never recovered from the payment.',
      { feeFloorMicro: env.FACILITATOR_FEE_FLOOR_MICRO.toString() },
    );
  }

  // Written as ETH, so a figure written as wei still parses: `4000000000000000` is a valid
  // decimal string and becomes 4e33 wei. Nothing downstream can tell that apart from an operator
  // who meant it, so the relayer sits at degraded forever and no message ever says why. No
  // relayer paying sub-cent gas has a floor in the thousands of ETH, which makes the ceiling a
  // safe place to catch the unit.
  const gasFloatMinimumWei = parseEth(env.FACILITATOR_GAS_FLOAT_MINIMUM_ETH);

  if (gasFloatMinimumWei > GAS_FLOAT_MINIMUM_CEILING_WEI) {
    throw new FacilitatorConfigError(
      'gas_float_minimum_implausible',
      `FACILITATOR_GAS_FLOAT_MINIMUM_ETH is ${env.FACILITATOR_GAS_FLOAT_MINIMUM_ETH}, which is ` +
        `more ETH than any relayer holds. It is read as ETH, not as wei: a reserve of 0.004 ETH ` +
        `is written "0.004". Set it in ETH, or the health check reports degraded from startup and ` +
        `never recovers.`,
      { value: env.FACILITATOR_GAS_FLOAT_MINIMUM_ETH, wei: gasFloatMinimumWei.toString() },
    );
  }

  if (env.TRUST_SINK_TOKEN && !env.TRUST_SINK_URL) {
    throw new FacilitatorConfigError(
      'trust_sink_token_without_url',
      'TRUST_SINK_TOKEN is set but TRUST_SINK_URL is not, so the token would never be sent anywhere',
    );
  }

  return {
    host: env.FACILITATOR_HOST,
    port: env.FACILITATOR_PORT,
    authToken: env.FACILITATOR_AUTH_TOKEN ?? null,
    databaseUrl: env.DATABASE_URL,
    migrate: env.FACILITATOR_MIGRATE,
    chain,
    network: caip2(chain.chainId),
    settlementAsset: chain.usdg,
    brand: activeBrand(source),
    rpcProviders: rhcRpcProviders(source),
    indexKey: env.BLOCKSCOUT_API_KEY ?? null,
    funding: { ...funding, treasury: env.FACILITATOR_TREASURY },
    relayerKey,
    gasFloatMinimumWei,
    feeBps: env.FACILITATOR_FEE_BPS,
    feeFloorMicro: env.FACILITATOR_FEE_FLOOR_MICRO,
    dailySettlements: env.FACILITATOR_DAILY_SETTLEMENTS,
    perPayerHourly: env.FACILITATOR_PER_PAYER_HOURLY,
    requireBinding: env.FACILITATOR_REQUIRE_BINDING,
    reservationTtlMs: env.FACILITATOR_RESERVATION_TTL_SECONDS * 1_000,
    underwriter: underwriterWiring(env, source),
    trust: {
      topic: env.TRUST_TOPIC,
      sinkUrl: env.TRUST_SINK_URL ?? null,
      sinkToken: env.TRUST_SINK_TOKEN ?? null,
      batchSize: env.TRUST_BATCH_SIZE,
      pollIntervalMs: env.TRUST_POLL_SECONDS * 1_000,
      maxAttempts: env.TRUST_MAX_ATTEMPTS,
      leaseMs: env.TRUST_LEASE_SECONDS * 1_000,
    },
  };
}

/**
 * Resolves the underwriter from the environment, without deciding whether the answer is
 * acceptable. An explicit `FACILITATOR_UNDERWRITER` is honoured and checked for the variables its
 * mode needs; otherwise the mode is read off what is set, which keeps the common deployments to
 * one variable each.
 */
function underwriterWiring(
  env: {
    readonly FACILITATOR_UNDERWRITER: UnderwriterMode | undefined;
    readonly BURSAR_UNDERWRITER_URL: string | undefined;
    readonly BURSAR_UNDERWRITER_TOKEN: string | undefined;
  },
  source: EnvSource,
): UnderwriterWiring {
  const url = env.BURSAR_UNDERWRITER_URL ?? null;
  const token = env.BURSAR_UNDERWRITER_TOKEN ?? null;
  const runsHere = IN_PROCESS_SIGNALS.some((name) => (source[name] ?? '').trim() !== '');

  switch (env.FACILITATOR_UNDERWRITER) {
    case 'remote':
      if (url === null) {
        throw new FacilitatorConfigError(
          'underwriter_url_required',
          'FACILITATOR_UNDERWRITER=remote needs BURSAR_UNDERWRITER_URL',
        );
      }
      return { mode: 'remote', url, token };

    case 'in-process':
      return { mode: 'in-process' };

    case 'none':
      return { mode: 'none' };

    default:
      if (url !== null) return { mode: 'remote', url, token };
      if (runsHere) return { mode: 'in-process' };
      return { mode: 'unconfigured' };
  }
}

/**
 * The address a key signs for.
 *
 * The key itself never leaves this function, and nothing in this service logs it, echoes it in an
 * error, or writes it to the database.
 */
function accountAddress(key: `0x${string}`): `0x${string}` {
  try {
    return privateKeyToAccount(key).address;
  } catch {
    throw new FacilitatorConfigError(
      'relayer_key_invalid',
      'FACILITATOR_RELAYER_KEY is not a valid secp256k1 private key',
    );
  }
}

/** A redacted view, for a health endpoint or a startup line. Carries no secret. */
export function describeConfig(config: FacilitatorConfig): Readonly<Record<string, unknown>> {
  return {
    chain: config.chain.name,
    network: config.network,
    chainId: config.chain.chainId,
    settlementAsset: config.settlementAsset,
    // Whether this deployment could read the chain index at all, never the key itself. A 402 from
    // the index and an index that is down are different problems with different owners.
    index: config.indexKey === null ? 'unkeyed' : 'keyed',
    // The lanes this service accepts, not the ones the brand describes. Advertising a lane that
    // every route then refuses is what `/config` did until the two names were reconciled in 0006.
    lanes: LANE_MODES,
    feeBps: config.feeBps,
    feeFloorMicro: config.feeFloorMicro.toString(),
    gasFloat: config.funding.gasFloat,
    requireBinding: config.requireBinding,
    underwriter: config.underwriter.mode,
    trustTopic: config.trust.topic,
    trustSinkConfigured: config.trust.sinkUrl !== null,
  };
}
