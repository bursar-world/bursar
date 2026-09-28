/**
 * The database surface the ledger and the trust store are written against.
 *
 * Narrow. Every query in this service is hand-written SQL with positional parameters,
 * so nothing here needs a query builder, a connection pool type, or anything else that would tie
 * the ledger to one driver. It also makes the whole ledger testable against a recorder without a
 * running server, which matters because the FIFO and idempotency behaviour is the part worth
 * testing hardest.
 */

/** Every value this service binds. Money crosses as a decimal string, never as a JS number. */
export type SqlParam =
  | string
  | number
  | boolean
  | Date
  | null
  | readonly string[]
  | readonly number[];

export type QueryResult<Row> = {
  readonly rows: Row[];
  readonly rowCount: number;
};

export type Queryable = {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly SqlParam[],
  ): Promise<QueryResult<Row>>;
};

export type Database = Queryable & {
  /**
   * Runs `fn` inside BEGIN/COMMIT, rolling back on any throw.
   *
   * Every mutation the ledger performs spans several statements that must not be observed apart:
   * a balance moves, a row changes status, and a trust event is queued. The callback gets one
   * client, which is what keeps `FOR UPDATE` locks held for the duration.
   */
  transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** Reads a single row, or null when the statement matched nothing. */
export async function one<Row extends object>(
  db: Queryable,
  text: string,
  params?: readonly SqlParam[],
): Promise<Row | null> {
  const result = await db.query<Row>(text, params);
  return result.rows[0] ?? null;
}

export async function many<Row extends object>(
  db: Queryable,
  text: string,
  params?: readonly SqlParam[],
): Promise<Row[]> {
  const result = await db.query<Row>(text, params);
  return result.rows;
}
