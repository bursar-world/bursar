import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BursarError } from '@bursar/core';
import type { Database, Queryable } from './sql.js';
import { many, one } from './sql.js';

/**
 * Versioned SQL files, applied in name order, each one inside its own transaction.
 *
 * Postgres runs DDL transactionally, so a file that fails half way leaves nothing behind and the
 * next run starts from the same place. The checksum is recorded because an applied migration that
 * has since been edited is the failure mode that costs a day: the schema no longer matches the
 * file everyone is reading, and nothing says so.
 */

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export class MigrationError extends BursarError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = 'MigrationError';
  }
}

export type Migration = {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
};

export type MigrationResult = {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
};

export type MigrationPlan = {
  /** On disk and not yet in this database, in the order they would be applied. */
  readonly pending: readonly string[];
  readonly applied: readonly string[];
};

/** Ships next to the compiled output, so the SQL travels with the package. */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function loadMigrations(dir: string = defaultMigrationsDir()): Promise<Migration[]> {
  const entries = await readdir(dir);
  const names = entries.filter((name) => MIGRATION_FILE.test(name)).sort();

  if (names.length === 0) {
    throw new MigrationError('migrations_missing', `no migration files found in ${dir}`, { dir });
  }

  const seen = new Set<string>();
  const migrations: Migration[] = [];
  for (const name of names) {
    const version = MIGRATION_FILE.exec(name)?.[1] ?? '';
    if (seen.has(version)) {
      throw new MigrationError('migrations_duplicate_version', `two migrations claim version ${version}`, {
        version,
        name,
      });
    }
    seen.add(version);
    const sql = await readFile(join(dir, name), 'utf8');
    migrations.push({ name, sql, checksum: checksum(sql) });
  }
  return migrations;
}

type AppliedRow = { name: string; checksum: string };

async function ensureJournal(db: Queryable): Promise<void> {
  // A database filled before the brand rename carries the journal under its old name. Adopt it,
  // because creating a second one next to it would read as an empty history and replay every
  // migration that has already been applied.
  await db.query(`
    DO $$
    BEGIN
      IF to_regclass('mandate_migrations') IS NOT NULL AND to_regclass('bursar_migrations') IS NULL THEN
        ALTER TABLE mandate_migrations RENAME TO bursar_migrations;
      END IF;
    END
    $$
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS bursar_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Arbitrary and constant. Any instance of this service migrating the same database takes this lock
 * first, so the number only has to be one nobody else in the database has picked. Changing it
 * after a deployment exists would let an old and a new binary migrate the same database at once,
 * so it is fixed from here.
 */
const MIGRATION_LOCK = 4_663_000_001;

export async function migrate(db: Database, dir?: string): Promise<MigrationResult> {
  const migrations = await loadMigrations(dir);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    // The read and the write are one transaction behind one lock. Two instances booting together
    // would otherwise both read "not applied", both insert the same version, and the loser would
    // die on the primary key. The lock is transaction scoped, so a process that falls over
    // mid-migration releases it by disconnecting.
    const first = await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK]);
      await ensureJournal(client);

      const existing = await one<AppliedRow>(
        client,
        'SELECT name, checksum FROM bursar_migrations WHERE name = $1',
        [migration.name],
      );

      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new MigrationError(
            'migration_checksum_mismatch',
            `${migration.name} was applied from a different file; write a new migration instead of editing an applied one`,
            { name: migration.name, applied: existing.checksum, onDisk: migration.checksum },
          );
        }
        return false;
      }

      await client.query(migration.sql);
      await client.query('INSERT INTO bursar_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      return true;
    });

    (first ? applied : skipped).push(migration.name);
  }

  return { applied, skipped };
}

/**
 * What the database says it has, for a health endpoint or an operator asking why a column is
 * missing. Reads only: a database with no journal table answers with nothing, because a probe
 * that creates a table is a probe that changed the thing it measured.
 *
 * The journal under its pre-rename name counts. A readiness probe that ignored it would report a
 * fully migrated database as seven versions behind and refuse traffic until something wrote to it.
 */
export async function appliedMigrations(db: Queryable): Promise<readonly string[]> {
  const journal = await one<{ current: boolean; previous: boolean }>(
    db,
    `SELECT to_regclass('bursar_migrations') IS NOT NULL AS current,
            to_regclass('mandate_migrations') IS NOT NULL AS previous`,
  );

  if (journal?.current) {
    const rows = await many<{ name: string }>(db, 'SELECT name FROM bursar_migrations ORDER BY name');
    return rows.map((row) => row.name);
  }
  if (journal?.previous) {
    const rows = await many<{ name: string }>(db, 'SELECT name FROM mandate_migrations ORDER BY name');
    return rows.map((row) => row.name);
  }
  return [];
}

/**
 * What applying migrations would do, without doing any of it.
 *
 * The same reading three things need: `migrate --dry-run`, a start that was told not to migrate,
 * and the readiness probe. A schema a version behind the binary is a service that will fail on the
 * first request that touches the missing column. It should say so before it takes traffic.
 */
export async function migrationPlan(db: Database, dir?: string): Promise<MigrationPlan> {
  const migrations = await loadMigrations(dir);
  const applied = new Set(await appliedMigrations(db));
  return {
    pending: migrations.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name),
    applied: [...applied].sort(),
  };
}
