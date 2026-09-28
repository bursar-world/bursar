import { checkGasFloat, createRhcClient } from '@bursar/core';
import type { RhcClient } from '@bursar/core';
import type { FacilitatorConfig } from './config.js';
import { describeConfig } from './config.js';
import { appliedMigrations, migrationPlan } from './db/migrate.js';
import { createPostgres, describeDatabase } from './db/postgres.js';
import type { Database } from './db/sql.js';
import { LaneLedger } from './lanes/ledger.js';
import { TrustRelay } from './trust/relay.js';
import { TrustStore } from './trust/store.js';
import { createHttpSink } from './trust/http-sink.js';
import type { TrustEventSink } from './trust/types.js';
import { canonicalNetwork } from '@bursar/x402';
import { SettlementBudget } from './x402/budget.js';
import type { PaymentScheme } from './x402/contract.js';
import { Facilitator, SETTLE_WORST_CASE_MS } from './x402/facilitator.js';
import { chainAuthorizations, reconcile } from './x402/reconcile.js';
import type { AuthorizationChain } from './x402/reconcile.js';
import type { UnderwriterLookup } from './underwriting/underwriter.js';
import { createRouter } from './http/routes.js';
import type { Check, Readiness, Router } from './http/routes.js';
import { createHttpServer, listen } from './http/server.js';
import type { RunningServer } from './http/server.js';

/**
 * Everything assembled and wired, with the two things this service cannot build itself passed in.
 *
 * The payment scheme is injected because the verifier lives in its own package, and the trust sink
 * is injected because where events go is a deployment decision. Both default to something usable:
 * the sink falls back to a recorder when no URL is configured, which keeps the outbox filling and
 * lets an operator see exactly what would have been delivered.
 */

export type ServiceOptions = {
  readonly config: FacilitatorConfig;
  readonly scheme: PaymentScheme;
  readonly db?: Database;
  readonly sink?: TrustEventSink;
  readonly rhc?: RhcClient;
  /** How reconciliation reads authorisations. Defaults to the settlement asset through `rhc`. */
  readonly authorizations?: AuthorizationChain;
  /**
   * Whether the configured source of spend decisions can take one right now.
   *
   * Supplied by `main`, which is the only place that knows whether this deployment reaches an
   * underwriter over HTTP or runs one in this process. Absent, readiness reports that the source
   * is configured and unprobed.
   */
  readonly underwriterReady?: () => Promise<Check>;
  /**
   * Where a spend decision comes from, when this deployment takes its own.
   *
   * Leave it out and `/underwrite` answers 501 while `/authorizations` keeps accepting decisions
   * made elsewhere. Neither path grants anything the mandate account would refuse: the contract
   * is the authority and both of these only mirror what it already permits.
   */
  readonly underwriterFor?: UnderwriterLookup;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
};

export type FacilitatorService = {
  readonly config: FacilitatorConfig;
  readonly db: Database;
  readonly trust: TrustStore;
  readonly ledger: LaneLedger;
  readonly facilitator: Facilitator;
  readonly relay: TrustRelay;
  readonly router: Router;
  readonly rhc: RhcClient;
  health(): Promise<Readonly<Record<string, unknown>>>;
  ready(): Promise<Readiness>;
  start(): Promise<RunningServer>;
  stop(): Promise<void>;
};

/**
 * How long a quarantined trust event is kept before it is swept.
 *
 * Long enough that an operator who finds a delivery broken has a month to redrive it, short enough
 * that the table does not grow for the life of the deployment.
 */
const DEAD_LETTER_RETENTION_MS = 30 * 86_400_000;

/**
 * How old a settle claim with no settlement has to be before reconciliation asks the chain about it.
 *
 * Twice the longest a settle can run. Younger than that, the claim may belong to a settle still
 * waiting on its receipt, and deleting it as unused would let the same authorisation be broadcast
 * a second time.
 */
const RECONCILE_AFTER_MS = 2 * SETTLE_WORST_CASE_MS;

/**
 * Holds events that have nowhere to go.
 *
 * Not a discard. The outbox keeps them, the relay keeps claiming and failing them, and they
 * quarantine on schedule with an error that names the missing configuration. An operator who then
 * sets a sink URL redrives the quarantine and nothing is lost.
 */
function unconfiguredSink(): TrustEventSink {
  return {
    name: 'unconfigured',
    deliver: async () => ({
      delivered: [],
      statusCode: null,
      error: 'TRUST_SINK_URL is not set, so trust events are recorded but not delivered',
      permanent: false,
    }),
  };
}

export function createFacilitatorService(options: ServiceOptions): FacilitatorService {
  const { config } = options;
  const log = options.log ?? (() => undefined);

  const db =
    options.db ??
    createPostgres({
      url: config.databaseUrl,
      onError: (error) => log(`postgres pool error: ${error.message}`),
    });

  const rhc =
    options.rhc ??
    createRhcClient({
      chain: config.chain,
      providers: config.rpcProviders,
      onEvent: (event) =>
        log('provider' in event ? `rpc ${event.type} provider=${event.provider}` : `rpc ${event.type}`),
    });

  const trust = new TrustStore({
    topic: config.trust.topic,
    leaseMs: config.trust.leaseMs,
    maxAttempts: config.trust.maxAttempts,
    now: options.now,
  });

  const ledger = new LaneLedger({
    db,
    trust,
    currency: config.brand.settlementAsset.symbol,
    now: options.now,
  });

  const facilitator = new Facilitator({
    scheme: options.scheme,
    budget: new SettlementBudget({
      dailySettlements: config.dailySettlements,
      perPayerPerHour: config.perPayerHourly,
    }),
    ledger,
    treasury: config.funding.treasury,
    feeBps: config.feeBps,
    feeFloorMicro: config.feeFloorMicro,
    requireBinding: config.requireBinding,
    log,
  });

  const sink =
    options.sink ??
    (config.trust.sinkUrl
      ? createHttpSink({ url: config.trust.sinkUrl, token: config.trust.sinkToken ?? undefined })
      : unconfiguredSink());

  const relay = new TrustRelay({
    db,
    store: trust,
    sink,
    batchSize: config.trust.batchSize,
    pollIntervalMs: config.trust.pollIntervalMs,
    onEvent: (event) => {
      if (event.type === 'error') log(`trust relay error: ${event.error}`);
      else if (event.type === 'batch' && event.quarantined > 0) {
        log(`trust relay quarantined ${event.quarantined} of ${event.claimed}`);
      }
    },
  });

  /**
   * Health is three separate questions, reported separately.
   *
   * A relayer that cannot pay for gas, a chain this service cannot read, and a trust queue that is
   * not draining are different failures with different fixes, and collapsing them into one word
   * would leave an operator guessing which one they have.
   */
  const health = async (): Promise<Readonly<Record<string, unknown>>> => {
    const [gas, counts, migrations] = await Promise.allSettled([
      checkGasFloat(rhc.client, config.funding, config.gasFloatMinimumWei),
      trust.counts(db),
      appliedMigrations(db),
    ]);

    // Wei, named as wei. The float is ETH and the ledger is micro-USD USDG, and a number that
    // could be read as either is how a reserve ends up set twelve decimal places from where an
    // operator meant it. The summary carries the same figure in ETH for an alert.
    const gasFloat =
      gas.status === 'fulfilled'
        ? {
            address: gas.value.address,
            healthy: gas.value.healthy,
            balanceWei: gas.value.balance.toString(),
            minimumWei: gas.value.minimum.toString(),
            summary: gas.value.summary,
          }
        : { healthy: false, summary: unread('the gas float balance', gas.reason, log) };

    return {
      status: gas.status === 'fulfilled' && gas.value.healthy && counts.status === 'fulfilled' ? 'ok' : 'degraded',
      chain: config.chain.name,
      chainId: config.chain.chainId,
      network: config.network,
      gasFloat,
      rpc: rhc.pool.status(),
      trustOutbox: counts.status === 'fulfilled' ? counts.value : { error: reason(counts.reason) },
      migrations: migrations.status === 'fulfilled' ? migrations.value : { error: reason(migrations.reason) },
    };
  };

  /**
   * Whether this process can serve a request now, over the three things it cannot do without.
   *
   * Separate from health, and answered separately. Health is a judgement about how well this
   * deployment is running and stays 200 while it is degraded; readiness is whether to send it
   * traffic at all, and an orchestrator acts on it. The gas float is reported here and does not
   * decide it: a dry relayer cannot settle, but it can still verify payments, take decisions and
   * serve every ledger route, and pulling the process out of rotation would take those down too.
   */
  const ready = async (): Promise<Readiness> => {
    const [database, underwriter, chain] = await Promise.all([
      databaseCheck(db, config),
      options.underwriterReady?.() ?? Promise.resolve(unprobedUnderwriter(config, options.underwriterFor)),
      chainCheck(rhc, config, log),
    ]);

    return {
      ready: database.ready && underwriter.ready && chain.ready,
      checks: { chainId: config.chain.chainId, network: config.network, database, underwriter, chain },
    };
  };

  const router = createRouter({
    db,
    facilitator,
    ledger,
    trust,
    reservationTtlMs: config.reservationTtlMs,
    treasury: config.funding.treasury,
    describe: () => describeConfig(config),
    ...(options.underwriterFor ? { underwriterFor: options.underwriterFor } : {}),
    health,
    ready,
  });

  /**
   * Holds and quarantined events both need someone to come back for them.
   *
   * A client that opens a reservation and dies leaves prefunded balance locked until something
   * expires it, a settle cut off mid-broadcast leaves its claim with no settlement until something
   * reconciles it, and a quarantined trust event stays in the dead letter table for the life of the
   * deployment unless something sweeps it. All three run here, on one timer, at a cadence a good
   * deal shorter than the shortest hold so a stale one is not held much past its window.
   */
  const maintenanceIntervalMs = Math.max(1_000, Math.min(config.reservationTtlMs / 2, 60_000));

  const authorizations = options.authorizations ?? chainAuthorizations(rhc.client, config.settlementAsset);

  const maintain = async (): Promise<void> => {
    const expired = await ledger.expireReservations();
    if (expired > 0) log(`expired ${expired} reservations`);

    const reconciled = await reconcile({
      ledger,
      chain: authorizations,
      network: canonicalNetwork(config.network),
      asset: config.settlementAsset,
      treasury: config.funding.treasury,
      fee: (amountMicro) => facilitator.fee(amountMicro),
      olderThanMs: RECONCILE_AFTER_MS,
      log,
    });
    if (reconciled.checked > 0) {
      log(
        `reconciled ${reconciled.checked} settle claims: ${reconciled.recorded} recorded, ${reconciled.released} released, ${reconciled.unresolved} unresolved`,
      );
    }

    await db.transaction((client) => trust.sweep(client, DEAD_LETTER_RETENTION_MS));
  };

  let running: RunningServer | null = null;
  let maintenance: NodeJS.Timeout | null = null;
  let maintaining: Promise<void> | null = null;

  // One pass at a time. A pass slower than the interval would otherwise stack under the next, and
  // `stop` has exactly one pass to wait for before it closes the pool that pass is using.
  const runMaintenance = (): void => {
    if (maintaining) return;
    maintaining = maintain()
      .catch((error: unknown) => log(`maintenance failed: ${reason(error)}`))
      .finally(() => {
        maintaining = null;
      });
  };

  return {
    config,
    db,
    trust,
    ledger,
    facilitator,
    relay,
    router,
    rhc,
    health,
    ready,

    async start() {
      if (running) return running;
      const server = createHttpServer({
        router,
        host: config.host,
        port: config.port,
        authToken: config.authToken,
        onError: (error) => log(`request failed: ${error instanceof Error ? error.message : String(error)}`),
      });
      running = await listen(server, config.host, config.port);
      relay.start();
      maintenance = setInterval(runMaintenance, maintenanceIntervalMs);
      // Housekeeping is not a reason for the process to stay alive.
      maintenance.unref();
      log(`facilitator listening on ${config.host}:${running.port} for ${config.network}`);
      return running;
    },

    async stop() {
      if (maintenance) clearInterval(maintenance);
      maintenance = null;
      await maintaining;
      await relay.stop();
      if (running) await running.close();
      running = null;
      if (!options.db) await db.close();
    },
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The ledger, and whether it holds the schema this build writes against.
 *
 * A database that answers but is a migration behind is not ready. Every route here is hand-written
 * SQL naming columns by hand, so a missing one is a 500 on the first request that touches it, and
 * that request is somebody's payment.
 */
async function databaseCheck(db: Database, config: FacilitatorConfig): Promise<Check> {
  const where = describeDatabase(config.databaseUrl);
  try {
    const plan = await migrationPlan(db);
    return {
      ready: plan.pending.length === 0,
      database: where,
      applied: plan.applied.length,
      ...(plan.pending.length === 0
        ? {}
        : {
            pending: plan.pending,
            detail:
              config.migrate === 'on-start'
                ? 'the schema is behind this build. Restart this process, or run bursar-facilitator-migrate.'
                : `FACILITATOR_MIGRATE is ${config.migrate}, so this process applies nothing. Run bursar-facilitator-migrate.`,
          }),
    };
  } catch (error) {
    return { ready: false, database: where, detail: reason(error) };
  }
}

/** The chain, named, and the ETH float that pays for writing to it. */
async function chainCheck(rhc: RhcClient, config: FacilitatorConfig, log: (line: string) => void): Promise<Check> {
  const [block, gas] = await Promise.allSettled([
    rhc.client.getBlockNumber(),
    checkGasFloat(rhc.client, config.funding, config.gasFloatMinimumWei),
  ]);

  // The chain is named on both answers. An operator looking at an unreachable probe has to be able
  // to tell a wrong endpoint from an outage, and the first thing to check is which chain it is on.
  const where = { name: config.chain.name, chainId: config.chain.chainId, network: config.network };

  if (block.status === 'rejected') {
    return {
      ready: false,
      ...where,
      reachable: false,
      detail: unread('the chain head', block.reason, log),
      rpc: rhc.pool.status(),
    };
  }

  return {
    ready: true,
    ...where,
    reachable: true,
    blockNumber: block.value.toString(10),
    rpc: rhc.pool.status(),
    gasFloat:
      gas.status === 'fulfilled'
        ? {
            healthy: gas.value.healthy,
            balanceWei: gas.value.balance.toString(),
            minimumWei: gas.value.minimum.toString(),
          }
        : { healthy: false, detail: unread('the gas float balance', gas.reason, log) },
  };
}

/**
 * What a failed read says, and where the reason it failed goes.
 *
 * The transport library's own message carries its version, a documentation link and the shape of
 * the call it was making. That is for whoever is debugging this service, so it goes to the log. An
 * operator reading a probe gets the condition and where to look.
 */
function unread(what: string, error: unknown, log: (line: string) => void): string {
  log(`could not read ${what}: ${reason(error)}`);
  return `could not read ${what} from the chain. Each provider's state is in rpc, and the endpoints are RHC_RPC_PRIMARY and RHC_RPC_FALLBACK.`;
}

/**
 * What readiness can say about a decision source it was given no way to probe.
 *
 * Only reachable in a test that composes the service by hand. `main` always supplies a probe, and
 * a deployment that decides nothing is ready by definition: it has nothing to be unready about.
 */
function unprobedUnderwriter(config: FacilitatorConfig, lookup: UnderwriterLookup | undefined): Check {
  if (config.underwriter.mode === 'none' || lookup === undefined) {
    return { ready: true, mode: 'none', decides: false };
  }
  return { ready: true, mode: config.underwriter.mode, probed: false };
}
