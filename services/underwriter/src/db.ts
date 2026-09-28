import pg from 'pg';

/*
 * The Postgres surface this service needs, which is smaller than the facilitator's.
 *
 * Nothing here stores an amount in a NUMERIC column. Money reaches the database only inside a
 * journal entry body, as the decimal string `encodeEntry` produces, because the entry hash is
 * taken over that exact text and a column that reformatted it would move the root.
 *
 * `session` hands back a client pinned to one connection. The journal claim is a session-scoped
 * advisory lock, and a lock taken on a pooled connection would be released the moment the pool
 * reused it somewhere else.
 */

export type SqlParam = string | number | boolean | null;

export type Sql = {
  query<Row extends object>(text: string, params?: readonly SqlParam[]): Promise<readonly Row[]>;
};

/**
 * A client pinned to one connection. `release` takes the error that ended the session so pg
 * destroys the connection instead of returning it: a connection that still holds an advisory lock
 * must never be handed to the next caller.
 */
export type Session = Sql & { release(error?: Error): void };

export type Postgres = Sql & {
  /**
   * How many connections this pool will ever open. A caller that pins one per account has to know
   * the number, because pinning the last one leaves nothing for the query it was about to run.
   */
  readonly maxConnections: number;
  /**
   * `onError` hears the connection fail while it is checked out. pg reports that as an `error`
   * event on the client, and with nobody listening the event ends the process.
   */
  session(onError?: (error: Error) => void): Promise<Session>;
  close(): Promise<void>;
};

/**
 * A connection string with the password taken out, for a log line or an operator-facing field.
 *
 * `redactUrl` in the core reports `URL.origin`, which is the literal string `null` for any scheme
 * a runtime does not special-case, and `postgres:` is one of those. An operator being told their
 * journal is at `null` learns nothing.
 */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'an unreadable connection string';
  }
}

function sslFor(url: string): { rejectUnauthorized: boolean } | undefined {
  const mode = /[?&]sslmode=([^&]+)/i.exec(url)?.[1]?.toLowerCase();
  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return undefined;
  return { rejectUnauthorized: mode === 'verify-ca' || mode === 'verify-full' };
}

/**
 * Every statement this service sends is a single-row read or a single-row insert against a small
 * table. One that has not answered in ten seconds is not going to, and without a server-side
 * ceiling it holds one of five connections until the network notices, which is how a decision path
 * ends up waiting on a socket nobody is going to close.
 */
const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Connections the pool may open.
 *
 * One of these is pinned for the life of the process for every account this underwriter speaks
 * for, because the journal claim is a session-scoped advisory lock and a lock on a pooled
 * connection is released the moment the pool reuses it elsewhere. Everything else shares what is
 * left, so the pool has to be larger than the number of mandates, not equal to it: at equal size
 * the last mandate claims the last connection and the read it takes next waits five seconds for a
 * connection nobody is going to return, against a healthy database.
 *
 * Twenty is room for a deployment far larger than one process should be carrying, and
 * `UNDERWRITER_DATABASE_MAX_CONNECTIONS` moves it for the deployment that disagrees.
 */
export const DEFAULT_MAX_CONNECTIONS = 20;

export type PostgresOptions = {
  readonly maxConnections?: number;
  readonly onError?: (error: Error) => void;
};

export function createPostgres(url: string, options: PostgresOptions = {}): Postgres {
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const pool = new pg.Pool({
    connectionString: url,
    ssl: sslFor(url),
    max: maxConnections,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: STATEMENT_TIMEOUT_MS,
  });

  // An idle client dropped by the server arrives as an unhandled error event, which ends the
  // process if nothing listens for it.
  pool.on('error', (error) => options.onError?.(error));

  return {
    maxConnections,

    async query<Row extends object>(text: string, params?: readonly SqlParam[]): Promise<readonly Row[]> {
      const result = await pool.query(text, params ? [...params] : undefined);
      return result.rows as Row[];
    },

    async session(onError?: (error: Error) => void): Promise<Session> {
      const client = await pool.connect();
      const listener = (error: Error): void => onError?.(error);
      client.on('error', listener);
      return {
        async query<Row extends object>(text: string, params?: readonly SqlParam[]): Promise<readonly Row[]> {
          const result = await client.query(text, params ? [...params] : undefined);
          return result.rows as Row[];
        },
        release(error?: Error) {
          client.off('error', listener);
          client.release(error);
        },
      };
    },

    async close() {
      await pool.end();
    },
  };
}
