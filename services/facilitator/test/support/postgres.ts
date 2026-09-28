import { createPostgres } from '../../src/db/postgres.js';
import { migrate } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/sql.js';

/**
 * A real Postgres for the tests that are about SQL.
 *
 * Every statement in the ledger is hand written, and a double that returns canned rows proves
 * nothing about `FOR UPDATE`, a guard in a WHERE clause, or a CHECK constraint. Those are the parts
 * that decide whether money is conserved, so they are tested against a server or not at all.
 *
 * Point `BURSAR_TEST_DATABASE_URL` at a scratch database. The suite creates its own database
 * inside that server and drops it afterwards, so it never touches the one in the URL.
 */

export const TEST_DATABASE_URL = process.env.BURSAR_TEST_DATABASE_URL ?? '';

export type Scratch = {
  readonly db: Database;
  reset(): Promise<void>;
  drop(): Promise<void>;
};

const TABLES = [
  'bursar_trust_dead_letter',
  'bursar_trust_outbox',
  'bursar_trust_events',
  'bursar_billable_events',
  'bursar_health_snapshots',
  'bursar_risk_actions',
  'bursar_repayments',
  'bursar_debt_collateral_locks',
  'bursar_debts',
  'bursar_collateral_events',
  'bursar_collateral_positions',
  'bursar_payment_guard',
  'bursar_fee_ledger',
  'bursar_reservations',
  'bursar_authorizations',
  'bursar_funding_events',
  'bursar_lane_balances',
  'bursar_settlements',
  'bursar_pool_reserves',
  'bursar_pools',
  'bursar_accounts',
];

export async function scratchDatabase(name: string): Promise<Scratch> {
  const admin = createPostgres({ url: TEST_DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.close();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = createPostgres({ url: url.toString() });
  await migrate(db);

  return {
    db,
    async reset() {
      await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
      // 0008 seeds the settlement asset, and TRUNCATE takes it with everything else.
      await db.query(
        `INSERT INTO bursar_collateral_assets (asset_id, symbol, chain, haircut_bps, volatility_buffer_bps, status)
         VALUES ('usdg-rhc', 'USDG', 'robinhood-chain', 0, 0, 'active')
         ON CONFLICT (asset_id) DO NOTHING`,
      );
    },
    async drop() {
      await db.close();
      const cleanup = createPostgres({ url: TEST_DATABASE_URL });
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.close();
    },
  };
}
