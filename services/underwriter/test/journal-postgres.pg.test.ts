import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';

import { createPostgres } from '../src/db.js';
import type { Postgres } from '../src/db.js';
import type { Address } from '../src/document.js';
import { createPostgresJournalStore } from '../src/journal-postgres.js';
import type { JournalStore } from '../src/journal-store.js';

/**
 * The journal in Postgres, which is the arrangement that lets more than one host run underwriters.
 *
 * Two claims are tested, because the two failures are different. The advisory lock keeps a second
 * process out while the first is alive. The primary key on `(account, seq)` is what stops a second
 * writer that got past the lock from reserving the same ceiling twice, and it is the one that has
 * to hold when the lock does not.
 *
 * Point `BURSAR_TEST_DATABASE_URL` at a scratch server. This creates its own database inside it.
 */

const TEST_DATABASE_URL = process.env['BURSAR_TEST_DATABASE_URL'] ?? '';
const DATABASE = 'bursar_underwriter_journal_test';
const ACCOUNT = '0xe8fd2904175811Db41636c6085eBFE6661E196d5' as Address;

describe.skipIf(!TEST_DATABASE_URL)('a spend journal in Postgres', () => {
  let db: Postgres;
  const stores: JournalStore[] = [];

  beforeAll(async () => {
    const admin = createPostgres(TEST_DATABASE_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    await admin.close();

    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${DATABASE}`;
    db = createPostgres(url.toString());
  }, 60_000);

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    // The marker goes with the log. Truncating one and not the other leaves the next test
    // opening a journal that reads shorter than its marker, which is a different fault.
    await db.query('TRUNCATE underwriter_spend_log, underwriter_journal_head').catch(() => undefined);
  });

  afterAll(async () => {
    await db?.close();
    const admin = createPostgres(TEST_DATABASE_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.close();
  });

  function store(): JournalStore {
    const created = createPostgresJournalStore(db, 'postgres');
    stores.push(created);
    return created;
  }

  it('lets one session hold an account and refuses the next', async () => {
    const first = store();
    const held = await first.open(ACCOUNT);

    await expect(store().open(ACCOUNT)).rejects.toMatchObject({ code: 'underwriter_journal_held' });

    await held.release();
    await expect(store().open(ACCOUNT)).resolves.toMatchObject({ account: ACCOUNT });
  }, 30_000);

  it('replays what it committed, so a restart resumes the same reservation', async () => {
    const first = store();
    const handle = await first.open(ACCOUNT);
    const { entry } = handle.log.buildDecision(
      {
        requestId: 'pg-1',
        subject: 'agent-1',
        action: 'doc.summarize',
        amountMicros: toMicro(2_000_000),
        at: new Date().toISOString(),
      },
      { decision: 'allow' },
    );
    await handle.sink.append(entry);
    handle.log.push(entry);
    await handle.release();

    const reopened = await store().open(ACCOUNT);
    expect(reopened.log.length).toBe(1);
    expect(reopened.log.committedMicros()).toBe(toMicro(2_000_000));
    expect(reopened.log.verify()).toMatchObject({ valid: true, root: entry.entry_hash });
  }, 30_000);

  it('drops the claim when the stored log will not verify, rather than holding it and the connection', async () => {
    const warmed = await store().open(ACCOUNT);
    await warmed.release();

    await db.query(
      `INSERT INTO underwriter_spend_log (account, seq, prev_hash, entry_hash, body)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        ACCOUNT.toLowerCase(),
        '0'.repeat(64),
        'a hash that does not recompute',
        JSON.stringify({
          kind: 'decision',
          request_id: 'pg-broken',
          subject: 'agent-1',
          action: 'doc.summarize',
          amount_micros: '1000000',
          decision: { decision: 'allow' },
          at: '2026-01-01T00:00:00.000Z',
        }),
      ],
    );

    // One more than the pool holds. Each failure that kept its connection would take a slot with
    // it, and the sixth attempt would wait for a connection instead of reporting the broken log.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(store().open(ACCOUNT)).rejects.toMatchObject({ code: 'log_broken' });
    }

    // Nothing wrote a marker here: the broken entry went in behind `append`, so clearing the rows
    // leaves an account with no journal and no marker, which is a fresh account.
    await db.query('DELETE FROM underwriter_spend_log WHERE account = $1', [ACCOUNT.toLowerCase()]);
    await expect(store().open(ACCOUNT)).resolves.toMatchObject({ account: ACCOUNT });
  }, 30_000);

  it('refuses a journal cleared out from under its marker, and opens once the marker goes too', async () => {
    const handle = await store().open(ACCOUNT);
    const entry = handle.log.buildDecision(
      {
        requestId: 'pg-marker-1',
        subject: 'agent-1',
        action: 'doc.summarize',
        amountMicros: toMicro(1_000_000),
        at: new Date().toISOString(),
      },
      { decision: 'allow' },
    ).entry;
    await handle.sink.append(entry);
    handle.log.push(entry);
    await handle.release();

    // A volume that failed to mount looks like this: the rows are gone and the marker
    // remembers what was spent against them.
    await db.query('DELETE FROM underwriter_spend_log WHERE account = $1', [ACCOUNT.toLowerCase()]);
    await expect(store().open(ACCOUNT)).rejects.toMatchObject({ code: 'log_broken' });

    // Clearing a journal on purpose means clearing its marker in the same breath.
    await db.query('DELETE FROM underwriter_journal_head WHERE account = $1', [ACCOUNT.toLowerCase()]);
    await expect(store().open(ACCOUNT)).resolves.toMatchObject({ account: ACCOUNT });
  }, 30_000);

  it('refuses a second writer at the same sequence rather than reserving the ceiling twice', async () => {
    const handle = await store().open(ACCOUNT);
    const decision = (requestId: string) =>
      handle.log.buildDecision(
        {
          requestId,
          subject: 'agent-1',
          action: 'doc.summarize',
          amountMicros: toMicro(2_000_000),
          at: new Date().toISOString(),
        },
        { decision: 'allow' },
      ).entry;

    const first = decision('pg-race-a');
    await handle.sink.append(first);

    // The same sequence again: what a second underwriter appending against its own replay of the
    // journal would send. The insert loses, so the decision never comes back and nothing is
    // reserved against the ceiling for it.
    await expect(handle.sink.append(decision('pg-race-b'))).rejects.toMatchObject({ code: 'log_out_of_order' });

    const rows = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM underwriter_spend_log');
    expect(rows[0]?.count).toBe('1');
  }, 30_000);

  /**
   * A pinned connection the server ends, which is what a failover, an idle reaper and an operator
   * cleaning up sessions all do. pg reports it as an `error` event on the client; unheard, that
   * event ends the process, and heard, it has to end this handle's right to append, because the
   * advisory lock went with the connection.
   */
  it('survives the server ending the connection that holds the claim, and stops appending', async () => {
    const handle = await store().open(ACCOUNT);

    const [holder] = await db.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted LIMIT 1",
    );
    expect(holder).toBeDefined();
    await db.query('SELECT pg_terminate_backend($1)', [holder?.pid ?? 0]);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const entry = handle.log.buildDecision(
      {
        requestId: 'pg-dropped-1',
        subject: 'agent-1',
        action: 'doc.summarize',
        amountMicros: toMicro(1_000_000),
        at: new Date().toISOString(),
      },
      { decision: 'allow' },
    ).entry;
    await expect(handle.sink.append(entry)).rejects.toMatchObject({ code: 'underwriter_journal_held' });

    // The claim is free for a replacement, which is why the lock is session-scoped.
    await expect(store().open(ACCOUNT)).resolves.toMatchObject({ account: ACCOUNT });
    await handle.release().catch(() => undefined);
  }, 30_000);
});
