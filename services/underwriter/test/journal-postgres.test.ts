import { toMicro } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import type { Postgres, Session, SqlParam } from '../src/db.js';
import { allow } from '../src/decision.js';
import type { Address } from '../src/document.js';
import { createPostgresJournalStore } from '../src/journal-postgres.js';
import type { JournalHandle } from '../src/journal-store.js';

/**
 * Releasing a Postgres claim, against a server that stops answering halfway through it.
 *
 * The unlock is the only thing standing between a released journal and an account no replacement
 * process can claim. A failed unlock has to destroy the connection: the server drops a session
 * lock with the session, and pg discards a client released with an error.
 */

const ACCOUNT = '0xe8fd2904175811Db41636c6085eBFE6661E196d5' as Address;

type Recorded = { released: (Error | undefined)[] };

function postgres(failUnlock: boolean): { db: Postgres; recorded: Recorded } {
  const recorded: Recorded = { released: [] };

  const answer = async <Row extends object>(text: string): Promise<readonly Row[]> => {
    if (text.includes('pg_try_advisory_lock')) return [{ locked: true } as unknown as Row];
    if (text.includes('pg_advisory_unlock')) {
      if (failUnlock) throw new Error('connection reset by peer');
      return [];
    }
    return [];
  };

  const session: Session = {
    query: answer,
    release: (error?: Error) => recorded.released.push(error),
  };

  const db: Postgres = {
    maxConnections: 20,
    query: <Row extends object>(text: string, _params?: readonly SqlParam[]): Promise<readonly Row[]> =>
      answer<Row>(text),
    session: async () => session,
    close: async () => undefined,
  };

  return { db, recorded };
}

describe('releasing a Postgres spend journal', () => {
  it('gives the connection back once the lock is dropped', async () => {
    const { db, recorded } = postgres(false);
    const handle = await createPostgresJournalStore(db, 'fake').open(ACCOUNT);

    await handle.release();

    expect(recorded.released).toEqual([undefined]);
  });

  it('destroys the connection when the unlock does not answer, and says so', async () => {
    const { db, recorded } = postgres(true);
    const handle = await createPostgresJournalStore(db, 'fake').open(ACCOUNT);

    await expect(handle.release()).rejects.toThrow(/connection reset/);
    expect(recorded.released[0]).toBeInstanceOf(Error);
  });
});

/**
 * A table that took the row and a connection that failed on the way back look the same to the
 * insert: it throws. Only reading the row settles which one happened. A committed entry reported as
 * lost leaves the log in memory a sequence behind the table; an entry that did not land and is
 * appended past anyway leaves a gap.
 */
describe('an append the database did not confirm', () => {
  type Table = { rows: Map<number, string>; insert: 'ok' | 'commit-then-fail' | 'fail'; readable: boolean };

  function journal(table: Table): { db: Postgres; dropConnection: (error: Error) => void } {
    let onError: ((error: Error) => void) | undefined;

    const answer = async <Row extends object>(text: string, params?: readonly SqlParam[]): Promise<readonly Row[]> => {
      if (text.includes('pg_try_advisory_lock')) return [{ locked: true } as unknown as Row];
      if (text.includes('INSERT INTO underwriter_spend_log')) {
        if (table.insert === 'fail') throw new Error('statement timeout');
        table.rows.set(Number(params?.[1]), String(params?.[3]));
        if (table.insert === 'commit-then-fail') throw new Error('connection reset by peer');
        return [];
      }
      if (text.includes('SELECT entry_hash FROM underwriter_spend_log')) {
        if (!table.readable) throw new Error('the server is gone');
        const hash = table.rows.get(Number(params?.[1]));
        return (hash === undefined ? [] : [{ entry_hash: hash }]) as unknown as Row[];
      }
      return [];
    };

    const db: Postgres = {
      maxConnections: 20,
      query: answer,
      session: async (listener) => {
        onError = listener;
        return { query: answer, release: () => undefined };
      },
      close: async () => undefined,
    };

    return { db, dropConnection: (error) => onError?.(error) };
  }

  const entryFor = (log: JournalHandle['log'], id: string) =>
    log.buildDecision(
      { requestId: id, subject: 'wallet:0x1', action: 'gpu.lease', amountMicros: toMicro(1), at: '2026-01-01T00:00:00Z' },
      allow(),
    ).entry;

  it('takes an entry the table holds as written', async () => {
    const table: Table = { rows: new Map(), insert: 'commit-then-fail', readable: true };
    const handle = await createPostgresJournalStore(journal(table).db, 'fake').open(ACCOUNT);

    await expect(handle.sink.append(entryFor(handle.log, 'a'))).resolves.toBeUndefined();
  });

  it('refuses every append after one it cannot confirm', async () => {
    const table: Table = { rows: new Map(), insert: 'fail', readable: true };
    const handle = await createPostgresJournalStore(journal(table).db, 'fake').open(ACCOUNT);

    await expect(handle.sink.append(entryFor(handle.log, 'a'))).rejects.toThrow(/statement timeout/);

    table.insert = 'ok';
    await expect(handle.sink.append(entryFor(handle.log, 'a'))).rejects.toMatchObject({ code: 'log_broken' });
    expect(table.rows.size).toBe(0);
  });

  it('does not take a read that failed as confirmation', async () => {
    const table: Table = { rows: new Map(), insert: 'commit-then-fail', readable: false };
    const handle = await createPostgresJournalStore(journal(table).db, 'fake').open(ACCOUNT);

    await expect(handle.sink.append(entryFor(handle.log, 'a'))).rejects.toThrow(/connection reset/);
    await expect(handle.sink.append(entryFor(handle.log, 'a'))).rejects.toMatchObject({ code: 'log_broken' });
  });

  /**
   * The claim is an advisory lock on the pinned connection, so a connection that dies takes the
   * claim with it and another process may already hold the journal.
   */
  it('refuses to append once the connection holding the claim has failed', async () => {
    const table: Table = { rows: new Map(), insert: 'ok', readable: true };
    const { db, dropConnection } = journal(table);
    const handle = await createPostgresJournalStore(db, 'fake').open(ACCOUNT);

    dropConnection(new Error('terminating connection due to administrator command'));

    await expect(handle.sink.append(entryFor(handle.log, 'a'))).rejects.toMatchObject({
      code: 'underwriter_journal_held',
    });
    expect(table.rows.size).toBe(0);
  });
});
