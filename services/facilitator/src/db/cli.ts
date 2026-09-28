#!/usr/bin/env node
import { loadEnv, envVar } from '@bursar/core';
import { migrate, migrationPlan } from './migrate.js';
import { createPostgres, describeDatabase } from './postgres.js';

/**
 * Applies pending migrations and exits. Separate from the service so a deploy can gate on it, and
 * so an operator who would rather not have a starting process write to their database has a place
 * to run it by hand.
 *
 *   bursar-facilitator-migrate             apply what is pending
 *   bursar-facilitator-migrate --dry-run   name what is pending, change nothing
 */
const USAGE = 'usage: bursar-facilitator-migrate [--dry-run]';

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const unknown = args.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) throw new Error(`${unknown.join(', ')} is not an option. ${USAGE}`);

  const { DATABASE_URL } = loadEnv({
    DATABASE_URL: envVar.url({ protocols: ['postgres:', 'postgresql:'] }),
  });

  const db = createPostgres({ url: DATABASE_URL });
  const where = describeDatabase(DATABASE_URL);
  try {
    if (dryRun) {
      const { pending, applied } = await migrationPlan(db);
      process.stdout.write(
        pending.length > 0
          ? `${where} would apply ${pending.length}: ${pending.join(', ')}\n`
          : `${where} is up to date, ${applied.length} already in place\n`,
      );
      return;
    }

    const { applied, skipped } = await migrate(db);
    process.stdout.write(
      applied.length > 0
        ? `${where} applied ${applied.length}: ${applied.join(', ')}\n`
        : `${where} had nothing to apply, ${skipped.length} already in place\n`,
    );
  } finally {
    await db.close();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
