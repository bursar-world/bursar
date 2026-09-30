import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MigrationError,
  appliedMigrations,
  checksum,
  defaultMigrationsDir,
  loadMigrations,
  migrate,
  migrationPlan,
} from '../src/db/migrate.js';
import { createPostgres } from '../src/db/postgres.js';
import type { Database } from '../src/db/sql.js';
import { RecordingDatabase } from './support/doubles.js';
import { TEST_DATABASE_URL } from './support/postgres.js';

async function scratch(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bursar-migrations-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, 'utf8');
  }
  return dir;
}

describe('migration files', () => {
  it('loads the shipped set in version order', async () => {
    const migrations = await loadMigrations(defaultMigrationsDir());
    expect(migrations.map((m) => m.name)).toEqual([
      '0001_settlement_ledger.sql',
      '0002_lane_ledger.sql',
      '0003_collateral_lane.sql',
      '0004_trust_events.sql',
      '0005_collateral_locks.sql',
      '0006_direct_lane.sql',
      '0007_bursar_table_prefix.sql',
      '0008_usdg_collateral_asset.sql',
      '0009_settle_claims.sql',
      '0010_repayment_pool.sql',
      '0011_settlement_rebate.sql',
    ]);
  });

  it('holds every money column at six decimals', async () => {
    const migrations = await loadMigrations(defaultMigrationsDir());
    const sql = migrations.map((m) => m.sql).join('\n');
    const columns = sql.match(/_micro\s+NUMERIC\(\d+,\s*\d+\)/g) ?? [];
    expect(columns.length).toBeGreaterThan(20);
    for (const column of columns) expect(column).toMatch(/NUMERIC\(20, 6\)/);
  });

  it('confines debt to the collateral lane in the schema itself', async () => {
    const migrations = await loadMigrations(defaultMigrationsDir());
    const sql = migrations.map((m) => m.sql).join('\n');
    expect(sql).toContain("CONSTRAINT chk_debts_collateral_lane_only CHECK (lane = 'collateral')");
  });

  it('leaves every table under the bursar_ prefix once all migrations have run', async () => {
    const migrations = await loadMigrations(defaultMigrationsDir());
    const sql = migrations.map((m) => m.sql).join('\n').toLowerCase();

    // Replay creates and renames in order to reach the schema a fresh database ends up with.
    const tables = new Set<string>();
    const statements = /create table (?:if not exists )?([a-z0-9_]+)|alter table (?:if exists )?([a-z0-9_]+)\s+rename to ([a-z0-9_]+)/g;
    for (const match of sql.matchAll(statements)) {
      if (match[1] !== undefined) {
        tables.add(match[1]);
      } else if (match[2] !== undefined && match[3] !== undefined) {
        tables.delete(match[2]);
        tables.add(match[3]);
      }
    }

    expect(tables.size).toBeGreaterThan(10);
    for (const table of tables) expect(table).toMatch(/^bursar_/);

    // Nothing else is created: no functions, types, views or sequences a table prefix would miss.
    expect(sql).not.toMatch(/create (?:or replace )?(?:function|type|view|sequence|trigger|schema)\b/);
  });

  it('ignores anything that is not a numbered migration', async () => {
    const dir = await scratch({
      '0001_first.sql': 'SELECT 1;',
      'README.md': 'not a migration',
      'scratch.sql': 'SELECT 2;',
    });
    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => m.name)).toEqual(['0001_first.sql']);
  });

  it('refuses two migrations claiming the same version', async () => {
    const dir = await scratch({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' });
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('refuses an empty directory rather than reporting a clean schema', async () => {
    const dir = await scratch({ 'README.md': 'nothing here' });
    await expect(loadMigrations(dir)).rejects.toThrow(/no migration files/);
  });
});

describe('applying migrations', () => {
  it('applies everything pending and records a checksum', async () => {
    const dir = await scratch({ '0001_first.sql': 'SELECT 1;' });
    const db = new RecordingDatabase();

    const result = await migrate(db, dir);
    expect(result.applied).toEqual(['0001_first.sql']);
    expect(db.saw(/CREATE TABLE IF NOT EXISTS bursar_migrations/)).toBe(true);
    expect(db.saw(/INSERT INTO bursar_migrations/)).toBe(true);
  });

  it('skips a migration that is already recorded', async () => {
    const sql = 'SELECT 1;';
    const dir = await scratch({ '0001_first.sql': sql });
    const db = new RecordingDatabase().answer(/FROM bursar_migrations WHERE name/, [
      { name: '0001_first.sql', checksum: checksum(sql) },
    ]);

    const result = await migrate(db, dir);
    expect(result).toEqual({ applied: [], skipped: ['0001_first.sql'] });
  });

  it('refuses to run when an applied migration has since been edited', async () => {
    const dir = await scratch({ '0001_first.sql': 'SELECT 2;' });
    const db = new RecordingDatabase().answer(/FROM bursar_migrations WHERE name/, [
      { name: '0001_first.sql', checksum: checksum('SELECT 1;') },
    ]);

    await expect(migrate(db, dir)).rejects.toThrow(/write a new migration/);
  });

  it('holds a lock before it reads what has already been applied', async () => {
    const dir = await scratch({ '0001_first.sql': 'SELECT 1;' });
    const db = new RecordingDatabase();

    await migrate(db, dir);

    const lock = db.queries.findIndex((query) => /pg_advisory_xact_lock/.test(query.text));
    const read = db.queries.findIndex((query) => /FROM bursar_migrations WHERE name/.test(query.text));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(read);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('two instances migrating at once', () => {
  const name = 'bursar_migrate_race_test';

  async function admin(): Promise<Database> {
    return createPostgres({ url: TEST_DATABASE_URL });
  }

  beforeEach(async () => {
    const db = await admin();
    await db.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await db.query(`CREATE DATABASE ${name}`);
    await db.close();
  });

  afterAll(async () => {
    const db = await admin();
    await db.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await db.close();
  });

  it('says what it would apply without applying any of it', async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const db = createPostgres({ url: url.toString() });

    try {
      const shipped = (await loadMigrations(defaultMigrationsDir())).map((m) => m.name);

      const before = await migrationPlan(db, defaultMigrationsDir());
      expect(before.pending).toEqual(shipped);
      expect(before.applied).toEqual([]);

      // Nothing was written, not even the journal table a probe would be tempted to create.
      const tables = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
      );
      expect(tables.rows[0]?.count).toBe('0');

      await migrate(db, defaultMigrationsDir());
      const after = await migrationPlan(db, defaultMigrationsDir());
      expect(after.pending).toEqual([]);
      expect(after.applied).toEqual(shipped);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('opens the collateral lane on the asset this chain actually has', async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const db = createPostgres({ url: url.toString() });

    try {
      await migrate(db, defaultMigrationsDir());
      const { rows } = await db.query<{ asset_id: string; symbol: string; chain: string; status: string }>(
        'SELECT asset_id, symbol, chain, status FROM bursar_collateral_assets ORDER BY asset_id',
      );

      // USDG is the settlement asset and the only collateral the lane opens with. The USDC row
      // from the earlier deployment is kept, because positions and events reference it, and
      // deactivated, because USDC has no contract on this chain and nothing could post it.
      expect(rows).toEqual([
        { asset_id: 'usdc-arc', symbol: 'USDC', chain: 'arc', status: 'inactive' },
        { asset_id: 'usdg-rhc', symbol: 'USDG', chain: 'robinhood-chain', status: 'active' },
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('applies every migration exactly once and neither instance fails', async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const first = createPostgres({ url: url.toString() });
    const second = createPostgres({ url: url.toString() });

    try {
      const [a, b] = await Promise.all([
        migrate(first, defaultMigrationsDir()),
        migrate(second, defaultMigrationsDir()),
      ]);

      const shipped = (await loadMigrations(defaultMigrationsDir())).map((m) => m.name);
      expect([...a.applied, ...b.applied].sort()).toEqual(shipped);
      expect(await appliedMigrations(first)).toEqual(shipped);
    } finally {
      await first.close();
      await second.close();
    }
  }, 60_000);
});
