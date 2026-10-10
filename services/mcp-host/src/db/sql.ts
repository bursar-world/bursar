/**
 * The database surface the store is written against: hand-written SQL with positional
 * parameters, one transaction helper, and nothing that ties it to one driver. A test runs the
 * store against an in-memory double of the same shape.
 */

export type SqlParam = string | number | boolean | Date | Uint8Array | null;

export type QueryResult<Row> = {
  readonly rows: Row[];
  readonly rowCount: number;
};

export type Queryable = {
  query<Row extends object = Record<string, unknown>>(text: string, params?: readonly SqlParam[]): Promise<QueryResult<Row>>;
};

export type Database = Queryable & {
  transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export async function one<Row extends object>(db: Queryable, text: string, params?: readonly SqlParam[]): Promise<Row | null> {
  const result = await db.query<Row>(text, params);
  return result.rows[0] ?? null;
}

export async function many<Row extends object>(db: Queryable, text: string, params?: readonly SqlParam[]): Promise<Row[]> {
  const result = await db.query<Row>(text, params);
  return result.rows;
}
