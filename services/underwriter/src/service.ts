import { createRhcClient } from '@bursar/core';
import type { Micro, RhcClient } from '@bursar/core';

import { createMandateChain } from './chain.js';
import type { MandateChain } from './chain.js';
import { describeUnderwriterConfig } from './config.js';
import type { UnderwriterConfig } from './config.js';
import { createPostgres, describeDatabase } from './db.js';
import type { Postgres } from './db.js';
import type { EventSink } from './events.js';
import { createFileJournalStore } from './journal-file.js';
import { createPostgresJournalStore } from './journal-postgres.js';
import type { JournalStore } from './journal-store.js';
import { createMandateRegistry } from './registry.js';
import type { MandateRegistry } from './registry.js';
import { createFileDocumentStore } from './store/file.js';
import { createPostgresDocumentStore } from './store/postgres.js';
import type { DocumentStore, MandateBinding } from './store/types.js';
import { createRouter } from './http/routes.js';
import type { Router } from './http/routes.js';
import { createHttpServer, listen } from './http/server.js';
import type { RunningServer } from './http/server.js';

/*
 * The underwriter as a process: a document store, a spend journal claimed per account, a chain to
 * read, and an HTTP surface over the decision.
 *
 * Everything it cannot build from configuration alone is injectable, which is how a test drives
 * the exact composition the binary runs. Nothing is injected in production.
 */

export type UnderwriterServiceOptions = {
  readonly config: UnderwriterConfig;
  readonly store?: DocumentStore;
  readonly journals?: JournalStore;
  readonly chain?: MandateChain;
  readonly rhc?: RhcClient;
  readonly onEvent?: EventSink;
  readonly log?: (line: string) => void;
};

/**
 * What the facilitator asks for, declared here instead of imported from it.
 *
 * The two are separate processes in any deployment that has outgrown one host, so neither package
 * may depend on the other. Both read the same MandateAccount and nothing about a decision needs
 * them to share memory, so a structural agreement on these three types is the whole contract.
 */
export type SpendDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'hold'; readonly threshold_micros: Micro }
  | { readonly decision: 'refuse'; readonly reason: string };

export type SpendQuoteView = {
  readonly decision: SpendDecision;
  readonly bucket: string | null;
  readonly documentHash: string;
  readonly accountVersion: bigint | null;
  readonly headroom: {
    readonly perCall: Micro;
    readonly daily: Micro;
    readonly monthly: Micro;
    readonly balance: Micro;
  } | null;
};

export type UnderwriterPort = {
  readonly account: string;
  authorize(request: {
    readonly requestId: string;
    readonly subject: string;
    readonly action: string;
    readonly amountMicros: Micro;
    readonly at: string;
    readonly merchant?: `0x${string}`;
    readonly capabilityId?: `0x${string}`;
    /** Required by an account behind a Merkle merchant gate, which refuses without it. */
    readonly merchantProof?: readonly `0x${string}`[];
  }): Promise<{
    readonly decision: SpendDecision;
    readonly quote: SpendQuoteView | null;
    readonly idempotent: boolean;
  }>;
};

export type UnderwriterLookup = (agentId: string) => Promise<UnderwriterPort | null>;

export type Readiness = { readonly ready: boolean; readonly checks: Readonly<Record<string, unknown>> };

export type UnderwriterService = {
  readonly config: UnderwriterConfig;
  readonly registry: MandateRegistry;
  readonly router: Router;
  /** The in-process lookup the facilitator composes against when it runs the underwriter itself. */
  readonly lookup: UnderwriterLookup;
  ready(): Promise<Readiness>;
  /**
   * Binds every mandate and claims its journal, without listening.
   *
   * This is what the facilitator calls when it runs the underwriter inside its own process: the
   * claim still has to happen, because it is what keeps a second underwriter off the same
   * lifetime ceiling, but a second listener on that host would be a port nobody asked for.
   */
  bind(): Promise<void>;
  start(): Promise<RunningServer>;
  stop(): Promise<void>;
};

export function createUnderwriterService(options: UnderwriterServiceOptions): UnderwriterService {
  const { config } = options;
  const log = options.log ?? (() => undefined);

  // One pool serves the journal and, when it is the document source, the documents. Two pools
  // against the same server would double the connection count for nothing.
  const postgres =
    config.databaseUrl === null
      ? null
      : createPostgres(config.databaseUrl, {
          maxConnections: config.databaseMaxConnections,
          onError: (error) => log(`postgres pool error: ${error.message}`),
        });

  const store = options.store ?? openStore(config, postgres);
  const journals = options.journals ?? openJournals(config, postgres, log);

  const rhc =
    options.rhc ??
    (options.chain
      ? null
      : createRhcClient({
          chain: config.chain,
          providers: config.rpcProviders,
          onEvent: (event) =>
            log('provider' in event ? `rpc ${event.type} provider=${event.provider}` : `rpc ${event.type}`),
        }));

  const mandateChain = options.chain ?? createMandateChain(required(rhc, 'a Robinhood Chain client').client);

  const registry = createMandateRegistry({
    store,
    journals,
    chain: mandateChain,
    chainId: config.chain.chainId,
    simulate: config.simulate,
    deadlineDriftSeconds: config.deadlineDriftSeconds,
    reloadIntervalMs: config.reloadIntervalMs,
    holdExpirySeconds: config.holdExpirySeconds,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  /**
   * Ready means a decision can be taken now: a mandate is bound, its journal is claimed, the chain
   * answered, and every account this process speaks for answered as a MandateAccount.
   *
   * The last one is the difference between a probe and a formality. `MANDATE_ACCOUNT` is an
   * address an operator pastes, and an address with nothing at it looks like a working
   * configuration from every other angle: the mandate binds, the journal is claimed, the block
   * number comes back, and every decision then refuses with `underwriter_chain_unavailable`. A
   * probe that reports ready in that state is worse than no probe, because it takes traffic.
   */
  const ready = async (): Promise<Readiness> => {
    const mandates = registry.mandates();

    let blockTimestamp: string | null = null;
    let chainError: string | null = null;
    try {
      blockTimestamp = (await mandateChain.blockTimestamp()).toString(10);
    } catch (error) {
      chainError = error instanceof Error ? error.message : String(error);
    }

    const accounts = await Promise.all(
      mandates.map(async (mandate) => {
        try {
          const state = await mandateChain.readAccount(mandate.account);
          return {
            subject: mandate.subject,
            account: mandate.account,
            answers: true,
            version: state.version.toString(10),
            paused: state.paused,
            revoked: state.revoked,
          };
        } catch (error) {
          return {
            subject: mandate.subject,
            account: mandate.account,
            answers: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    // The chain is named on both answers. An operator reading a 503 has to be able to tell an
    // endpoint pointed at the wrong network from one that is down, and the chain and its id are
    // the first thing that separates them.
    const where = { name: config.chain.name, chainId: config.chain.chainId };

    return {
      ready: mandates.length > 0 && chainError === null && accounts.every((entry) => entry.answers),
      checks: {
        chainId: config.chain.chainId,
        network: config.network,
        documentSource: store.source,
        documents: store.describe,
        journal: journals.kind,
        mandates,
        accounts,
        chain:
          chainError === null
            ? { ...where, reachable: true, blockTimestamp }
            : { ...where, reachable: false, error: chainError },
        ...(rhc ? { rpc: rhc.pool.status() } : {}),
      },
    };
  };

  /**
   * Reads the chain before the port is bound, and refuses to listen if it cannot.
   *
   * Binding first makes every configuration fault look like a working service. `MANDATE_ACCOUNT`
   * is an address an operator pastes and an `RHC_RPC_PRIMARY` pointed at another network answers
   * every question except the ones that matter: the mandate binds, the journal is claimed, the
   * port opens, the startup line prints, and each decision afterwards refuses with
   * `underwriter_chain_unavailable`. Every one of those refusals is a payment that did not happen.
   *
   * So the same reads `/readyz` reports are taken once here, and a process that cannot take a
   * decision exits naming what it could not read instead of taking traffic. The sidecar has done
   * this from the start: it reads the escrow's terms and the settlement asset's decimals before
   * its loop runs.
   */
  const preflight = async (): Promise<void> => {
    const readiness = await ready();
    if (readiness.ready) {
      await assetScale();
      return;
    }

    const chain = readiness.checks['chain'] as { reachable?: boolean; error?: string } | undefined;
    if (chain?.reachable === false) {
      throw new Error(
        `The underwriter could not read ${config.chain.name} (chain ${config.chain.chainId}) at startup: ${chain.error ?? 'no answer'}. Check RHC_RPC_PRIMARY and RHC_RPC_FALLBACK point at that chain.`,
      );
    }

    const accounts = (readiness.checks['accounts'] ?? []) as ReadonlyArray<{
      subject: string;
      account: string;
      answers: boolean;
      detail?: string;
    }>;
    const silent = accounts.filter((entry) => !entry.answers);
    if (silent.length > 0) {
      throw new Error(
        `The underwriter could not read a MandateAccount at startup on ${config.chain.name} (chain ${config.chain.chainId}): ${silent
          .map((entry) => `${entry.account} for ${entry.subject} (${entry.detail ?? 'no answer'})`)
          .join('; ')}. An address with no MandateAccount at it, and an endpoint on another network, both look like this.`,
      );
    }

    throw new Error(
      `The underwriter has no mandate to decide against: the ${store.source} document source produced none. Nothing it could answer would be a decision.`,
    );
  };

  /**
   * Every amount this service compares is six-decimal micro-USD, and the account's caps are written
   * in the settlement asset's own units. An asset with another scale makes every cap, balance and
   * headroom off by orders of magnitude without a single read failing, so it is checked against the
   * token before the first decision rather than taken from the deployment record.
   */
  const assetScale = async (): Promise<void> => {
    const readDecimals = mandateChain.readAssetDecimals;
    for (const mandate of registry.mandates()) {
      const { settlementAsset } = await mandateChain.readAccount(mandate.account);
      const decimals = readDecimals === undefined ? null : await readDecimals.call(mandateChain, settlementAsset);
      if (decimals !== 6) {
        throw new Error(
          decimals === null
            ? `The underwriter cannot read decimals() on ${settlementAsset}, the settlement asset of ${mandate.account}, so it cannot confirm the six-decimal scale every amount here assumes.`
            : `${mandate.account} settles in ${settlementAsset}, a ${decimals}-decimal asset. Every amount this underwriter compares is six-decimal micro-USD.`,
        );
      }
    }
  };

  const router = createRouter({ registry, describe: () => describeUnderwriterConfig(config), ready });

  let running: RunningServer | null = null;

  return {
    config,
    registry,
    router,
    ready,

    async lookup(agentId: string) {
      const mandate = await registry.find(agentId);
      if (mandate === null) return null;

      return {
        account: mandate.account,
        async authorize(request) {
          const result = await registry.authorize(agentId, { ...request, subject: agentId });
          if (result === null) return { decision: UNBOUND, quote: null, idempotent: false };
          return { decision: result.decision, quote: result.quote, idempotent: result.idempotent };
        },
      };
    },

    async bind() {
      await registry.start();
    },

    async start() {
      if (running) return running;
      await registry.start();
      await preflight();

      const server = createHttpServer({
        router,
        host: config.host,
        authToken: config.authToken,
        onError: (error) => log(`request failed: ${error instanceof Error ? error.message : String(error)}`),
      });
      running = await listen(server, config.host, config.port);

      for (const mandate of registry.mandates()) {
        log(
          `underwriting ${mandate.subject} against ${mandate.account}: journal holds ${mandate.journalEntries} entries, claimed by ${mandate.journalHolder}`,
        );
      }
      log(`underwriter listening on ${config.host}:${running.port} for ${config.network}, documents from ${store.source}`);
      return running;
    },

    async stop() {
      if (running) await running.close();
      running = null;
      await registry.close();
      if (postgres) await postgres.close();
    },
  };
}

/**
 * A mandate that was bound a moment ago and is not bound now. Only reachable if the document store
 * dropped it mid-request, and a refusal is the only safe reading of that.
 */
const UNBOUND: SpendDecision = { decision: 'refuse', reason: 'outside_mandate' };

function openStore(config: UnderwriterConfig, postgres: Postgres | null): DocumentStore {
  switch (config.documents.source) {
    case 'chain':
      return chainOnlyStore(config.documents.subject, config.documents.account);
    case 'file':
      return createFileDocumentStore(config.documents.path);
    case 'postgres':
      return createPostgresDocumentStore(required(postgres, 'a Postgres pool'), describeUrl(config));
  }
}

function openJournals(config: UnderwriterConfig, postgres: Postgres | null, log: (line: string) => void): JournalStore {
  return config.journal.kind === 'postgres'
    ? createPostgresJournalStore(required(postgres, 'a Postgres pool'), describeUrl(config))
    : createFileJournalStore(config.journal.directory, {
        onClaimLost: (account, holder) =>
          log(
            `the spend journal for ${account} is now claimed by ${holder}; this process has stopped renewing it and must be restarted before it underwrites that account again`,
          ),
      });
}

/**
 * The `chain` document source: one binding with no document, so the registry derives the terms
 * off the account.
 */
function chainOnlyStore(subject: string, account: `0x${string}`): DocumentStore {
  const bindings: readonly MandateBinding[] = [{ subject, account, document: null }];
  return {
    source: 'chain',
    describe: `${account}, terms read from the account`,
    load: async () => bindings,
    close: async () => undefined,
  };
}

function describeUrl(config: UnderwriterConfig): string {
  return config.databaseUrl === null ? 'postgres' : describeDatabase(config.databaseUrl);
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`the underwriter needs ${what} and none was built`);
  return value;
}
