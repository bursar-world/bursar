#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isBursarError } from '@bursar/core';
import type { EnvSource } from '@bursar/core';
import {
  createUnderwriterClient,
  createUnderwriterProbe,
  createUnderwriterService,
  loadUnderwriterConfig,
} from '@bursar/underwriter';
import type { UnderwriterService } from '@bursar/underwriter';

import { UNDERWRITER_UNCONFIGURED, loadConfig } from './config.js';
import type { FacilitatorConfig } from './config.js';
import { migrate, migrationPlan } from './db/migrate.js';
import { createPostgres, describeDatabase } from './db/postgres.js';
import type { Database } from './db/sql.js';
import { FacilitatorConfigError } from './errors.js';
import { loadScheme } from './scheme-module.js';
import type { Check } from './http/routes.js';
import { createFacilitatorService } from './service.js';
import type { FacilitatorService } from './service.js';
import type { UnderwriterLookup } from './underwriting/underwriter.js';
import { SETTLE_WORST_CASE_MS } from './x402/facilitator.js';

/**
 * The process.
 *
 * Configuration is read and checked first, before anything binds a port: a listener that came up
 * on the wrong address has already been reachable by the time a later line of config fails. The
 * schema is settled next, under whichever of the three `FACILITATOR_MIGRATE` modes the deployment
 * chose, so a deploy that cannot reach its schema fails at start instead of on a settlement.
 *
 * The underwriter is wired here, and a deployment that names none will not start. `/underwrite`
 * answering 501 is a correct response for a facilitator that only settles; it is a wrong one for a
 * facilitator that was meant to decide and was started without being told how, and the difference
 * belongs at startup where an operator sees it, not at a request an agent is waiting on.
 */

const log = (line: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
};

export type Composed = {
  readonly config: FacilitatorConfig;
  readonly service: FacilitatorService;
  /** Present only when this process runs the underwriter itself. Stopped with the service. */
  readonly underwriter: UnderwriterService | null;
  readonly db: Database;
  stop(): Promise<void>;
};

/**
 * Everything the binary builds, in the order it builds it.
 *
 * Exported so a test can start exactly what ships. `main` differs from a test
 * only in the environment it reads and in installing signal handlers.
 */
export async function compose(source: EnvSource = process.env): Promise<Composed> {
  const config = loadConfig(source);

  // Checked before a connection is opened or a port is bound. A deployment missing its source of
  // decisions is missing the thing it was started to do, and there is nothing to warm up first.
  if (config.underwriter.mode === 'unconfigured') {
    throw new FacilitatorConfigError('underwriter_unconfigured', UNDERWRITER_UNCONFIGURED);
  }

  const db = createPostgres({
    url: config.databaseUrl,
    onError: (error) => log(`postgres pool error: ${error.message}`),
  });

  try {
    await reachDatabase(config, db);
    await prepareSchema(config, db);

    // The scheme runs the same binding policy this service does. Left to its own default it
    // refuses every payment as unbound, because the request digest reaches it only through here.
    const scheme = await loadScheme({
      configure: {
        chain: config.chain,
        providers: config.rpcProviders,
        relayerKey: config.relayerKey,
        assets: [config.settlementAsset],
        requireBinding: config.requireBinding,
      },
    });

    const { lookup, underwriter, ready } = await wireUnderwriter(config, source);

    const service = createFacilitatorService({
      config,
      scheme,
      db,
      ...(lookup ? { underwriterFor: lookup } : {}),
      underwriterReady: ready,
      log,
    });

    return {
      config,
      service,
      underwriter,
      db,
      async stop() {
        await service.stop();
        if (underwriter) await underwriter.stop();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

/**
 * One round trip before anything else touches the database.
 *
 * Without it, a wrong password or a server that is not running surfaced as the driver's own error
 * from inside the migration planner, a stack trace that never named the variable to fix. Every
 * failure here is about reaching the server, whatever the migrate mode, so the refusal names
 * DATABASE_URL and carries the driver's reason. The host is printed and the credentials are not.
 */
async function reachDatabase(config: FacilitatorConfig, db: Database): Promise<void> {
  try {
    await db.query('SELECT 1');
  } catch (error) {
    const where = describeDatabase(config.databaseUrl);
    const cause = driverReason(error);
    throw new FacilitatorConfigError(
      'database_unreachable',
      `Could not connect to the database DATABASE_URL names, ${where}: ${cause}. Check the host, ` +
        'port, user, password and database name in DATABASE_URL, and that the server is running.',
      { database: where, cause },
    );
  }
}

/**
 * The driver's own words for a failed connection. A refused connection to a name that resolves to
 * both IPv4 and IPv6 arrives as an AggregateError with an empty message, which printed as nothing.
 */
function driverReason(error: unknown): string {
  if (error instanceof AggregateError && error.message === '') {
    const first: unknown = error.errors[0];
    if (first instanceof Error && first.message !== '') return first.message;
  }
  if (error instanceof Error) {
    if (error.message !== '') return error.message;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return String(error);
}

/**
 * Brings the schema to what this build writes against, or says why it will not.
 *
 * The line is written before anything is applied. A process pointed at a shared database used to
 * migrate it and mention it afterwards, which is the wrong order for the one operator who needed
 * a chance to stop it.
 */
async function prepareSchema(config: FacilitatorConfig, db: Database): Promise<void> {
  const where = describeDatabase(config.databaseUrl);

  if (config.migrate === 'off') {
    log(`FACILITATOR_MIGRATE=off, so the schema at ${where} is neither applied nor checked`);
    return;
  }

  if (config.migrate === 'verify') {
    const { pending } = await migrationPlan(db);
    if (pending.length > 0) {
      throw new FacilitatorConfigError(
        'schema_behind',
        `FACILITATOR_MIGRATE=verify and ${where} is missing ${pending.length} migration(s): ${pending.join(', ')}. Apply them with bursar-facilitator-migrate, or set FACILITATOR_MIGRATE=on-start to have this process apply them.`,
        { database: where, pending },
      );
    }
    log(`schema at ${where} is current`);
    return;
  }

  const { pending } = await migrationPlan(db);
  if (pending.length === 0) {
    log(`schema at ${where} is current`);
    return;
  }

  log(`applying ${pending.length} migration(s) to ${where}: ${pending.join(', ')}`);
  const { applied } = await migrate(db);
  log(`applied ${applied.join(', ')}`);
}

async function wireUnderwriter(
  config: FacilitatorConfig,
  source: EnvSource,
): Promise<{
  lookup: UnderwriterLookup | null;
  underwriter: UnderwriterService | null;
  ready: () => Promise<Check>;
}> {
  switch (config.underwriter.mode) {
    case 'remote': {
      const { url, token } = config.underwriter;
      const where = underwriterHost(url);
      log(`spend decisions from the underwriter at ${where}`);
      const probe = createUnderwriterProbe({ baseUrl: url, token: token ?? undefined });
      return {
        lookup: createUnderwriterClient({ baseUrl: url, token: token ?? undefined }),
        underwriter: null,
        ready: async () => ({ mode: 'remote', underwriter: where, ...(await probe()) }),
      };
    }

    case 'in-process': {
      // The same configuration the underwriter's own binary reads, so moving it into its own
      // process later is a change of address and nothing else. `bind` claims each account's spend
      // journal without opening a second listener on this host.
      const underwriter = createUnderwriterService({ config: loadUnderwriterConfig(source), log });
      await underwriter.bind();
      const bound = underwriter.registry.mandates();
      log(
        `spend decisions taken in this process for ${bound.map((mandate) => `${mandate.subject} (${mandate.account})`).join(', ') || 'no mandate yet'}`,
      );
      return {
        lookup: underwriter.lookup,
        underwriter,
        ready: async () => {
          const readiness = await underwriter.ready();
          return { mode: 'in-process', ready: readiness.ready, ...readiness.checks };
        },
      };
    }

    case 'none':
      log('this facilitator settles only; /underwrite answers 501 and decisions arrive at /authorizations');
      return {
        lookup: null,
        underwriter: null,
        ready: async () => ({ ready: true, mode: 'none', decides: false }),
      };

    case 'unconfigured':
      throw new FacilitatorConfigError('underwriter_unconfigured', UNDERWRITER_UNCONFIGURED);
  }
}

/**
 * Enough for the listener to drain what it is holding, and no longer.
 *
 * What it may be holding is a settle waiting on its receipt, so the deadline sits ten seconds above
 * the longest one can run: 160 seconds with the scheme's figures today. Exiting under a settle that
 * has broadcast leaves a landed transfer for reconciliation to find instead of recording it now.
 * Past the deadline the process has stopped making progress on something it will not finish. A
 * supervisor needs a stop grace period at least this long (Kubernetes defaults to 30 seconds),
 * or it kills the process first.
 */
export const SHUTDOWN_DEADLINE_MS = SETTLE_WORST_CASE_MS + 10_000;

/**
 * The URL an underwriter is reached at, as much of it as is safe to print.
 *
 * `envVar.url` declares a URL secret because one routinely carries a key in its userinfo, its path
 * or its query. The host is the part an operator needs to see in a log line or a readiness answer,
 * and the only part with nothing in it to leak.
 */
function underwriterHost(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'a URL this process could not parse';
  }
}

async function run(): Promise<void> {
  // Installed before anything long-running starts. Migrations can take a while, and a SIGTERM
  // arriving during them found no handler and killed the process where the default action does.
  let composed: Composed | null = null;
  let draining = false;

  const shutdown = (signal: string): void => {
    if (draining) return;
    draining = true;
    log(`${signal} received, draining`);

    const deadline = setTimeout(() => {
      log(`shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms, exiting anyway`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();

    void (composed?.stop() ?? Promise.resolve())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  composed = await compose();
  await composed.service.start();
}

/** Only the binary starts a server. An import gets `compose` and nothing else happens. */
function startedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  run().catch((error: unknown) => {
    if (isBursarError(error)) {
      log(`startup refused [${error.code}] ${error.message}`);
    } else {
      log(`startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    process.exit(1);
  });
}
