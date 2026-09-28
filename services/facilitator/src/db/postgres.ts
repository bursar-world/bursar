import pg from 'pg';
import type { Database, Queryable, QueryResult, SqlParam } from './sql.js';

const { Pool, types } = pg;

/**
 * Postgres OID 1700, NUMERIC. The driver parses it into a JS number by default, which silently
 * destroys any amount above 2^53 micro-USD and rounds several below it. Every money column in this
 * ledger is NUMERIC, so the parser is replaced process-wide before a pool is ever opened.
 */
const NUMERIC_OID = 1700;
/** INT8. Counts and offsets are read as text for the same reason and narrowed at the edge. */
const INT8_OID = 20;

let parsersInstalled = false;

function installParsers(): void {
  if (parsersInstalled) return;
  types.setTypeParser(NUMERIC_OID, (value: string) => value);
  types.setTypeParser(INT8_OID, (value: string) => value);
  parsersInstalled = true;
}

/**
 * A connection string with the password taken out, for a log line or an operator-facing field.
 *
 * `redactUrl` in the core is for RPC endpoints and reports `URL.origin`, which every browser and
 * every runtime answers as the literal string `null` for a scheme it does not special-case, and
 * `postgres:` is one of those. An operator being told their database is at `null` learns nothing.
 */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'an unreadable connection string';
  }
}

export type PostgresOptions = {
  readonly url: string;
  /** Ten connections is comfortably above the concurrency one facilitator process generates. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /**
   * How long one statement may run before the server cancels it.
   *
   * `applyRepayment` takes `FOR UPDATE` on every open debt an agent has, so one transaction that
   * stops making progress holds locks the next repayment queues behind. With ten connections in
   * the pool, a handful of those and the service stops answering at all. A cancelled statement is
   * a failed request; an uncancelled one is a failed service.
   */
  readonly statementTimeoutMs?: number;
  /** A transaction left open by a client that went away, holding its locks. */
  readonly idleInTransactionTimeoutMs?: number;
  readonly onError?: (error: Error) => void;
};

/**
 * TLS is decided by the connection string, not by an ambient environment guess.
 *
 * A managed Postgres publishes `sslmode=require` in the URL it hands out. Turning TLS on because
 * some unrelated variable is set is how a local development database starts failing to connect
 * for reasons nobody can see in the URL.
 */
function sslFor(url: string): { rejectUnauthorized: boolean } | undefined {
  const mode = /[?&]sslmode=([^&]+)/i.exec(url)?.[1]?.toLowerCase();
  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return undefined;
  // `verify-full` would need a CA bundle the deployment supplies. Until one is configured, the
  // transport is encrypted and the certificate is not pinned.
  return { rejectUnauthorized: mode === 'verify-ca' || mode === 'verify-full' };
}

export function createPostgres(options: PostgresOptions): Database {
  installParsers();

  const pool = new Pool({
    connectionString: options.url,
    ssl: sslFor(options.url),
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 60_000,
  });

  // An idle client dropped by the server reaches the pool as an unhandled error event, which ends
  // the process if nothing listens for it.
  pool.on('error', (error) => options.onError?.(error));

  type DriverResult = { rows: unknown[]; rowCount: number | null };

  async function run<Row extends object>(
    executor: { query: (text: string, params?: unknown[]) => Promise<DriverResult | DriverResult[]> },
    text: string,
    params?: readonly SqlParam[],
  ): Promise<QueryResult<Row>> {
    const answer = await executor.query(text, params ? [...params] : undefined);
    // A statement with several commands in it, which the migrations have, comes back as one result
    // per command. The last one is the one a caller could have asked about.
    const result = Array.isArray(answer) ? answer.at(-1) : answer;
    if (!result) return { rows: [], rowCount: 0 };
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
  }

  return {
    query(text, params) {
      return run(pool, text, params);
    },

    async transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      // Set when the connection can no longer be trusted, and handed to `release` so the pool
      // destroys it. Returned as healthy, it would give the next caller a socket that is dead or,
      // worse, still inside the aborted transaction.
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const scoped: Queryable = { query: (text, params) => run(client, text, params) };
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // A rollback that itself fails means the connection is already gone. Reporting that
        // instead of the original failure hides the reason the transaction aborted.
        await client.query('ROLLBACK').catch((rollback: unknown) => {
          broken = rollback instanceof Error ? rollback : new Error(String(rollback));
        });
        throw error;
      } finally {
        client.release(broken);
      }
    },

    async close() {
      await pool.end();
    },
  };
}
