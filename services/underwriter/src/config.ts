import {
  TestnetHasNoSettlementAsset,
  caip2,
  envVar,
  loadEnv,
  optional,
  rhcChain,
  rhcRpcProviders,
  withDefault,
} from '@bursar/core';
import type { Caip2, EnvSource, EnvValues, RhcChain, RpcProvider } from '@bursar/core';

import { DEFAULT_MAX_CONNECTIONS } from './db.js';
import { UnderwriterConfigError } from './errors.js';

/*
 * Configuration for the underwriter process, checked before anything listens or reads a mandate.
 *
 * Two choices have to be named. `MANDATE_DOCUMENT_SOURCE` says where mandate documents come from,
 * and `chain` is a mode with a name instead of what you get when a document store happens to be
 * empty. `UNDERWRITER_DATABASE_URL` says where the spend journal lives, which
 * is the same thing as saying how many of these processes may speak for one MandateAccount: a
 * file journal is claimed by one process on one host, a Postgres journal by one session anywhere.
 */

/**
 * Where the terms a spend is measured against come from.
 *
 * `chain` derives the document from the live MandateAccount, so the account is both the authority
 * and the description. That is the default because the contract is the source of truth.
 *
 * `file` and `postgres` read a document a principal wrote. The account still decides every limit
 * it holds; the document adds the ones it does not, chiefly the action rules and the lifetime
 * ceiling, and any disagreement between the two is reported as a divergence.
 */
export const DOCUMENT_SOURCES = ['chain', 'file', 'postgres'] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export type UnderwriterConfig = {
  readonly host: string;
  readonly port: number;
  readonly authToken: string | null;
  readonly chain: RhcChain;
  readonly network: Caip2;
  readonly rpcProviders: readonly RpcProvider[];
  /** One Postgres for both the spend journal and, when it is the source, the documents. */
  readonly databaseUrl: string | null;
  /** Has to exceed the number of mandates: each one pins a connection for its journal claim. */
  readonly databaseMaxConnections: number;
  readonly documents: DocumentsConfig;
  readonly journal: JournalConfig;
  /** Re-check the document store no more often than this when a subject is not yet known. */
  readonly reloadIntervalMs: number;
  /** Simulate the whole `spend` call before issuing an allow. One extra `eth_call` per decision. */
  readonly simulate: boolean;
  readonly deadlineDriftSeconds: bigint;
  /** How long a held call may wait for a principal before approving it is refused instead. */
  readonly holdExpirySeconds: number;
};

export type DocumentsConfig =
  | { readonly source: 'chain'; readonly subject: string; readonly account: `0x${string}` }
  | { readonly source: 'file'; readonly path: string }
  | { readonly source: 'postgres' };

export type JournalConfig = { readonly kind: 'file'; readonly directory: string } | { readonly kind: 'postgres' };

const schema = {
  UNDERWRITER_HOST: withDefault(envVar.string({ minLength: 1 }), '127.0.0.1'),
  /** 8403, one above the facilitator, so the pair can run on one host without an argument. */
  UNDERWRITER_PORT: withDefault(envVar.int({ min: 1, max: 65_535 }), 8403),
  /** Required unless the listener is on loopback, where the operating system is the boundary. */
  UNDERWRITER_AUTH_TOKEN: optional(envVar.string({ minLength: 32, secret: true })),

  /**
   * Mainnet is the default and the only value that resolves. Testnet is refused below, because a
   * decision is an authorisation to move USDG and chain 46630 has none to move.
   */
  RHC_NETWORK: withDefault(envVar.oneOf(['testnet', 'mainnet'] as const), 'mainnet'),

  MANDATE_DOCUMENT_SOURCE: withDefault(envVar.oneOf(DOCUMENT_SOURCES), 'chain'),
  /** The MandateAccount this process speaks for. Required in `chain` mode, ignored otherwise. */
  MANDATE_ACCOUNT: optional(envVar.address()),
  /** The agent id the facilitator will ask about, and the document's subject. */
  MANDATE_SUBJECT: optional(envVar.string({ minLength: 1 })),
  MANDATE_DOCUMENT_PATH: optional(envVar.string({ minLength: 1 })),

  /** Postgres for the spend journal, and for documents when the source is `postgres`. */
  UNDERWRITER_DATABASE_URL: optional(envVar.url({ protocols: ['postgres:', 'postgresql:'] })),
  /**
   * Connections the pool may open. One is pinned per mandate for its journal claim and the rest
   * are shared, so this has to stay above the number of mandates this process speaks for.
   */
  UNDERWRITER_DATABASE_MAX_CONNECTIONS: withDefault(envVar.int({ min: 2, max: 200 }), DEFAULT_MAX_CONNECTIONS),
  UNDERWRITER_JOURNAL_DIR: withDefault(envVar.string({ minLength: 1 }), './.mandate/journal'),

  UNDERWRITER_RELOAD_SECONDS: withDefault(envVar.seconds({ min: 1, max: 3_600 }), 30),
  UNDERWRITER_SIMULATE: withDefault(envVar.boolean(), true),
  UNDERWRITER_DEADLINE_DRIFT_SECONDS: withDefault(envVar.int({ min: 0, max: 3_600 }), 30),
  /**
   * How long a held call may wait for its principal. Past this an approval is refused rather than
   * paid, because the account it was quoted against has had a day to be paused, re-limited or
   * revoked and nothing re-reads it on the caller's behalf.
   */
  UNDERWRITER_HOLD_EXPIRY_SECONDS: withDefault(envVar.seconds({ min: 60, max: 30 * 86_400 }), 86_400),
} as const;

/** Loopback is a boundary the operating system enforces. Anything else needs a token. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadUnderwriterConfig(source: EnvSource = process.env): UnderwriterConfig {
  const env = loadEnv(schema, source);

  if (!LOOPBACK.has(env.UNDERWRITER_HOST) && !env.UNDERWRITER_AUTH_TOKEN) {
    throw new UnderwriterConfigError(
      'underwriter_token_required',
      `UNDERWRITER_HOST is ${env.UNDERWRITER_HOST}, so this process is reachable off this machine and every route needs UNDERWRITER_AUTH_TOKEN`,
      { host: env.UNDERWRITER_HOST },
    );
  }

  // `rhcChain` refuses testnet on its own. Raising it from here first is what puts the variable an
  // operator set into the message, instead of leaving them to work out which setting
  // chose the network.
  if (env.RHC_NETWORK === 'testnet') throw new TestnetHasNoSettlementAsset('RHC_NETWORK');
  const chain = rhcChain(env.RHC_NETWORK, source);

  return {
    host: env.UNDERWRITER_HOST,
    port: env.UNDERWRITER_PORT,
    authToken: env.UNDERWRITER_AUTH_TOKEN ?? null,
    chain,
    network: caip2(chain.chainId),
    rpcProviders: rhcRpcProviders(source),
    databaseUrl: env.UNDERWRITER_DATABASE_URL ?? null,
    databaseMaxConnections: env.UNDERWRITER_DATABASE_MAX_CONNECTIONS,
    documents: documentsFrom(env),
    journal: journalFrom(env),
    reloadIntervalMs: env.UNDERWRITER_RELOAD_SECONDS * 1_000,
    simulate: env.UNDERWRITER_SIMULATE,
    deadlineDriftSeconds: BigInt(env.UNDERWRITER_DEADLINE_DRIFT_SECONDS),
    holdExpirySeconds: env.UNDERWRITER_HOLD_EXPIRY_SECONDS,
  };
}

type Env = EnvValues<typeof schema>;

function documentsFrom(env: Env): DocumentsConfig {
  switch (env.MANDATE_DOCUMENT_SOURCE) {
    case 'chain': {
      if (!env.MANDATE_ACCOUNT || !env.MANDATE_SUBJECT) {
        throw new UnderwriterConfigError(
          'mandate_account_required',
          'MANDATE_DOCUMENT_SOURCE=chain reads the terms off one MandateAccount, so set MANDATE_ACCOUNT to its address and MANDATE_SUBJECT to the agent id the facilitator will ask about',
        );
      }
      return { source: 'chain', subject: env.MANDATE_SUBJECT, account: env.MANDATE_ACCOUNT };
    }
    case 'file': {
      if (!env.MANDATE_DOCUMENT_PATH) {
        throw new UnderwriterConfigError(
          'mandate_document_path_required',
          'MANDATE_DOCUMENT_SOURCE=file needs MANDATE_DOCUMENT_PATH, a JSON file holding one mandate document or an array of them',
        );
      }
      return { source: 'file', path: env.MANDATE_DOCUMENT_PATH };
    }
    case 'postgres': {
      if (!env.UNDERWRITER_DATABASE_URL) {
        throw new UnderwriterConfigError(
          'underwriter_database_url_required',
          'MANDATE_DOCUMENT_SOURCE=postgres reads documents from bursar_documents, so set UNDERWRITER_DATABASE_URL',
        );
      }
      return { source: 'postgres' };
    }
  }
}

/**
 * Postgres wins when it is configured. It is the only one of the two that can keep a second
 * process off an account's journal from another host, and a deployment that went to the trouble
 * of pointing at a database did not mean for the reservation to stay on one machine's disk.
 */
function journalFrom(env: Env): JournalConfig {
  if (env.UNDERWRITER_DATABASE_URL) return { kind: 'postgres' };
  return { kind: 'file', directory: env.UNDERWRITER_JOURNAL_DIR };
}

/** A redacted view for the health route and the startup line. Carries no secret. */
export function describeUnderwriterConfig(config: UnderwriterConfig): Readonly<Record<string, unknown>> {
  return {
    chain: config.chain.name,
    network: config.network,
    chainId: config.chain.chainId,
    documentSource: config.documents.source,
    ...(config.documents.source === 'chain'
      ? { subject: config.documents.subject, mandateAccount: config.documents.account }
      : {}),
    ...(config.documents.source === 'file' ? { documentPath: config.documents.path } : {}),
    journal: config.journal.kind,
    simulate: config.simulate,
    deadlineDriftSeconds: Number(config.deadlineDriftSeconds),
    authRequired: config.authToken !== null,
  };
}
