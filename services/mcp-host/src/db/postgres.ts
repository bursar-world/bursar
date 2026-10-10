import pg from 'pg';
import type { Database, Queryable, QueryResult, SqlParam } from './sql.js';

const { Pool, types } = pg;

/** INT8 arrives as text, so a count never passes through a double on its way to a caller. */
const INT8_OID = 20;

let parsersInstalled = false;

function installParsers(): void {
  if (parsersInstalled) return;
  types.setTypeParser(INT8_OID, (value: string) => value);
  parsersInstalled = true;
}

/** The connection string with its credentials taken out, for a log line. */
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
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly onError?: (error: Error) => void;
};

/** TLS follows `sslmode` in the URL and nothing ambient. */
function sslFor(url: string): { rejectUnauthorized: boolean } | undefined {
  const mode = /[?&]sslmode=([^&]+)/i.exec(url)?.[1]?.toLowerCase();
  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return undefined;
  return { rejectUnauthorized: mode === 'verify-ca' || mode === 'verify-full' };
}

export function createPostgres(options: PostgresOptions): Database {
  installParsers();

  const pool = new Pool({
    connectionString: options.url,
    ssl: sslFor(options.url),
    max: options.maxConnections ?? 6,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });

  // An idle client the server drops surfaces as an unhandled error event, which ends the process
  // when nothing listens for it.
  pool.on('error', (error) => options.onError?.(error));

  type DriverResult = { rows: unknown[]; rowCount: number | null };

  async function run<Row extends object>(
    executor: { query: (text: string, params?: unknown[]) => Promise<DriverResult | DriverResult[]> },
    text: string,
    params?: readonly SqlParam[],
  ): Promise<QueryResult<Row>> {
    const answer = await executor.query(text, params ? [...params] : undefined);
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
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params) => run(client, text, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
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
