import { describe, expect, it } from 'vitest';
import { createPostgres } from '../src/db/postgres.js';
import { TEST_DATABASE_URL } from './support/postgres.js';

/**
 * The pool's two brakes.
 *
 * `applyRepayment` locks every open debt an agent has for the length of its transaction. Without a
 * server-side limit, one transaction that stops making progress holds those locks for ever and the
 * ten connections behind it queue until the service answers nothing at all.
 */

describe.skipIf(!TEST_DATABASE_URL)('the connection pool', () => {
  it('cancels a statement that outruns its limit instead of holding the connection', async () => {
    const db = createPostgres({ url: TEST_DATABASE_URL, statementTimeoutMs: 150 });
    try {
      await expect(db.query('SELECT pg_sleep(5)')).rejects.toMatchObject({ code: '57014' });
      // A cancelled statement leaves its connection usable, so the next query on it succeeds.
      const answer = await db.query<{ ok: number }>('SELECT 1 AS ok');
      expect(answer.rows[0]?.ok).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('bounds a transaction left open by a client that went away', async () => {
    const db = createPostgres({ url: TEST_DATABASE_URL });
    try {
      const settings = await db.query<{ statement: string; idle: string }>(
        'SELECT current_setting($1) AS statement, current_setting($2) AS idle',
        ['statement_timeout', 'idle_in_transaction_session_timeout'],
      );
      expect(settings.rows[0]?.statement).not.toBe('0');
      expect(settings.rows[0]?.idle).not.toBe('0');
    } finally {
      await db.close();
    }
  }, 30_000);
});
