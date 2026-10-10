#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createRhcClient, isBursarError } from '@bursar/core';
import type { EnvSource } from '@bursar/core';
import { redactSecrets } from '@bursar/mcp';

import { loadConfig } from './config.js';
import type { HostConfig } from './config.js';
import { createConnectionService } from './connections.js';
import type { ConnectionService } from './connections.js';
import { createContextFactory } from './contexts.js';
import { migrate, migrationPlan } from './db/migrate.js';
import { createPostgres, describeDatabase } from './db/postgres.js';
import type { Database } from './db/sql.js';
import { HostConfigError } from './config.js';
import { createHttpServer, listen } from './http.js';
import type { RunningServer } from './http.js';
import { createChainReads } from './proof.js';
import { createPostgresStore } from './store.js';

/**
 * The process: configuration first, then the database and its schema, then the listener. A
 * key-encryption key that cannot be read, or a schema that is behind, stops it before a port is
 * bound.
 */

export type Composed = {
  readonly config: HostConfig;
  readonly service: ConnectionService;
  readonly db: Database;
  start(): Promise<RunningServer>;
  stop(): Promise<void>;
};

export async function compose(source: EnvSource = process.env): Promise<Composed> {
  const config = loadConfig(source);
  const secrets = [config.kek, ...config.providers.map((provider) => provider.url), ...(config.indexKey ? [config.indexKey] : [])];
  const log = (line: string): void => {
    process.stderr.write(`${new Date().toISOString()} ${redactSecrets(line, secrets)}\n`);
  };

  const db = createPostgres({ url: config.databaseUrl, onError: (error) => log(`postgres pool error: ${error.message}`) });
  let running: RunningServer | null = null;

  try {
    await reachDatabase(config, db);
    await prepareSchema(config, db, log);

    const { client } = createRhcClient({ chain: config.chain, providers: config.providers });
    const service = createConnectionService({
      store: createPostgresStore(db),
      contexts: createContextFactory(source, log),
      reads: createChainReads(client),
      chainId: config.chain.chainId,
      kek: config.kek,
      publicUrl: config.publicUrl,
      proofWindowSeconds: config.proofWindowSeconds,
      connectionsPerHour: config.connectionsPerHour,
    });

    const server = createHttpServer({
      service,
      chainId: config.chain.chainId,
      publicUrl: config.publicUrl,
      tokenRpm: config.tokenRpm,
      log,
      health: async () => ({ status: 'ok', chainId: config.chain.chainId, endpoint: `${config.publicUrl}/mcp` }),
      ready: async () => {
        try {
          await db.query('SELECT 1');
          const { pending } = await migrationPlan(db);
          return { ready: pending.length === 0, checks: { database: 'reachable', pendingMigrations: pending } };
        } catch (error) {
          return { ready: false, checks: { database: error instanceof Error ? error.message : String(error) } };
        }
      },
    });

    return {
      config,
      service,
      db,
      async start() {
        running = await listen(server, config.host, config.port);
        log(`listening on ${config.host}:${running.port}; connectors use ${config.publicUrl}/mcp`);
        return running;
      },
      async stop() {
        await running?.close();
        running = null;
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function reachDatabase(config: HostConfig, db: Database): Promise<void> {
  try {
    await db.query('SELECT 1');
  } catch (error) {
    const where = describeDatabase(config.databaseUrl);
    const cause = error instanceof Error && error.message !== '' ? error.message : String(error);
    throw new HostConfigError('database_unreachable', `Could not connect to the database DATABASE_URL names, ${where}: ${cause}.`, { database: where });
  }
}

async function prepareSchema(config: HostConfig, db: Database, log: (line: string) => void): Promise<void> {
  const where = describeDatabase(config.databaseUrl);
  if (config.migrate === 'off') {
    log(`MCP_HOST_MIGRATE=off, so the schema at ${where} is neither applied nor checked`);
    return;
  }
  const { pending } = await migrationPlan(db);
  if (config.migrate === 'verify') {
    if (pending.length > 0) {
      throw new HostConfigError('schema_behind', `MCP_HOST_MIGRATE=verify and ${where} is missing ${pending.join(', ')}. Apply them with bursar-mcp-host-migrate.`, { pending });
    }
    log(`schema at ${where} is current`);
    return;
  }
  if (pending.length === 0) {
    log(`schema at ${where} is current`);
    return;
  }
  log(`applying ${pending.length} migration(s) to ${where}: ${pending.join(', ')}`);
  const { applied } = await migrate(db);
  log(`applied ${applied.join(', ')}`);
}

async function run(): Promise<void> {
  let composed: Composed | null = null;
  let draining = false;
  const shutdown = (signal: string): void => {
    if (draining) return;
    draining = true;
    process.stderr.write(`${new Date().toISOString()} ${signal} received, draining\n`);
    const deadline = setTimeout(() => process.exit(1), 30_000);
    deadline.unref();
    void (composed?.stop() ?? Promise.resolve()).then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  composed = await compose();
  await composed.start();
}

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
    const line = isBursarError(error) ? `startup refused [${error.code}] ${error.message}` : `startup failed: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`${new Date().toISOString()} ${line}\n`);
    process.exit(1);
  });
}
