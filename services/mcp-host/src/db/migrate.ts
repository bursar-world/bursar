import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BursarError } from '@bursar/core';
import type { Database, Queryable } from './sql.js';
import { many, one } from './sql.js';

/**
 * Versioned SQL files applied in name order, each inside its own transaction, with a checksum
 * recorded so an applied file that was edited afterwards is refused instead of silently diverging.
 */

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Arbitrary and fixed: every instance migrating the same database takes this lock first. */
const MIGRATION_LOCK = 4_663_000_002;

export class MigrationError extends BursarError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = 'MigrationError';
  }
}

export type Migration = { readonly name: string; readonly sql: string; readonly checksum: string };
export type MigrationResult = { readonly applied: readonly string[]; readonly skipped: readonly string[] };
export type MigrationPlan = { readonly pending: readonly string[]; readonly applied: readonly string[] };

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function loadMigrations(dir: string = defaultMigrationsDir()): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => MIGRATION_FILE.test(name)).sort();
  if (names.length === 0) throw new MigrationError('migrations_missing', `no migration files found in ${dir}`, { dir });

  const migrations: Migration[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), 'utf8');
    migrations.push({ name, sql, checksum: checksum(sql) });
  }
  return migrations;
}

async function ensureJournal(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS bursar_mcp_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function migrate(db: Database, dir?: string): Promise<MigrationResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of await loadMigrations(dir)) {
    const first = await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK]);
      await ensureJournal(client);

      const existing = await one<{ name: string; checksum: string }>(
        client,
        'SELECT name, checksum FROM bursar_mcp_migrations WHERE name = $1',
        [migration.name],
      );
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new MigrationError(
            'migration_checksum_mismatch',
            `${migration.name} was applied from a different file; write a new migration instead of editing an applied one`,
            { name: migration.name },
          );
        }
        return false;
      }

      await client.query(migration.sql);
      await client.query('INSERT INTO bursar_mcp_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
      return true;
    });
    (first ? applied : skipped).push(migration.name);
  }

  return { applied, skipped };
}

/** Reads only: a probe that creates the journal has changed the thing it measured. */
export async function appliedMigrations(db: Queryable): Promise<readonly string[]> {
  const journal = await one<{ present: boolean }>(db, `SELECT to_regclass('bursar_mcp_migrations') IS NOT NULL AS present`);
  if (!journal?.present) return [];
  const rows = await many<{ name: string }>(db, 'SELECT name FROM bursar_mcp_migrations ORDER BY name');
  return rows.map((row) => row.name);
}

export async function migrationPlan(db: Database, dir?: string): Promise<MigrationPlan> {
  const migrations = await loadMigrations(dir);
  const applied = new Set(await appliedMigrations(db));
  return {
    pending: migrations.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name),
    applied: [...applied].sort(),
  };
}
