import { describe, expect, it } from 'vitest';

import { createPostgres } from '../src/db.js';

/**
 * The pool the journal and the document store share. Point `BURSAR_TEST_DATABASE_URL` at a
 * scratch server; nothing here writes.
 */

const TEST_DATABASE_URL = process.env['BURSAR_TEST_DATABASE_URL'] ?? '';

describe.skipIf(!TEST_DATABASE_URL)('the underwriter pool', () => {
  it('bounds how long a statement may hold one of its five connections', async () => {
    const db = createPostgres(TEST_DATABASE_URL);

    try {
      const [statement] = await db.query<{ setting: string }>(
        "SELECT current_setting('statement_timeout') AS setting",
      );
      const [idle] = await db.query<{ setting: string }>(
        "SELECT current_setting('idle_in_transaction_session_timeout') AS setting",
      );

      expect(statement?.setting).not.toBe('0');
      expect(idle?.setting).not.toBe('0');
    } finally {
      await db.close();
    }
  }, 30_000);
});
