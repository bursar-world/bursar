import { createHash } from 'node:crypto';

import type { Postgres, Session } from './db.js';
import type { Address } from './document.js';
import { JournalHeldError, LogError, UnderwriterConfigError } from './errors.js';
import type { DecisionSink } from './journal.js';
import { type LogEntry, SpendLog, decodeEntry, encodeEntry } from './log.js';
import { claimOwner, type JournalHandle, type JournalStore } from './journal-store.js';

/*
 * A spend journal in Postgres, claimed with a session advisory lock.
 *
 * This is the one arrangement in which several hosts can be pointed at the same MandateAccount
 * safely. The lock is held on a connection of its own for the life of the process; if the process
 * dies, the server drops the connection and the lock with it, so a replacement starts without
 * anyone clearing state by hand.
 *
 * `(account, seq)` is the primary key, and that is the part that makes the reservation
 * authoritative. An append is the commit point of a decision: a second writer appending at a
 * sequence that already exists fails the insert, the decision is not returned, and no amount is
 * reserved twice.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS underwriter_spend_log (
  account     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  prev_hash   TEXT NOT NULL,
  entry_hash  TEXT NOT NULL,
  body        JSONB NOT NULL,
  written_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account, seq)
)`;

/**
 * How far the journal had got, kept in a row of its own.
 *
 * An empty result from the log table is what a first run looks like and also what a dropped table,
 * a truncated one and a half-finished restore look like. Replaying any of those as an empty log
 * hands back every micro of the lifetime ceiling already spent. The marker is what separates them:
 * a log that does not reach the sequence and hash recorded here is refused to open.
 *
 * It is the same claim the file journal keeps beside its file, and it has the same limit. A
 * database swapped wholesale for another loses the marker with the entries, and nothing stored
 * inside a journal can catch a journal being replaced. What it does catch is this one losing rows.
 */
const HEAD_SCHEMA = `
CREATE TABLE IF NOT EXISTS underwriter_journal_head (
  account     TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  entry_hash  TEXT NOT NULL,
  written_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

type Row = { seq: number; prev_hash: string; entry_hash: string; body: unknown };
type HeadRow = { seq: number; entry_hash: string };

export function createPostgresJournalStore(db: Postgres, describe: string): JournalStore {
  const sessions: Session[] = [];

  return {
    kind: 'postgres',
    describe,

    async open(account: Address): Promise<JournalHandle> {
      await db.query(SCHEMA);
      await db.query(HEAD_SCHEMA);

      const key = account.toLowerCase();
      const me = claimOwner();

      // Each claim pins a connection for the life of the process, and every read and append needs
      // one from what is left. Pinning the last one would leave this store waiting out
      // `connectionTimeoutMillis` on a database with nothing wrong with it, so the ceiling is named
      // here with the variable that moves it.
      if (sessions.length + 2 > db.maxConnections) {
        throw new UnderwriterConfigError(
          'underwriter_database_pool_exhausted',
          `this underwriter holds ${sessions.length} journal claims and the pool opens at most ${db.maxConnections} connections. Each claim pins one for the life of the process and the rest are shared by every read, so raise UNDERWRITER_DATABASE_MAX_CONNECTIONS above the number of mandates this process speaks for.`,
          { claims: sessions.length, maxConnections: db.maxConnections, account },
        );
      }

      // Filled in once the claim is taken. A pinned connection that dies takes the advisory lock
      // with it, so from that moment another process may hold this journal and nothing here may
      // append to it.
      const state: SinkState = { refusal: null };
      const session = await db.session((error) => {
        state.refusal ??= new JournalHeldError(
          `the connection holding the spend journal claim for ${account} failed (${error.message}), and the claim went with it; restart the underwriter before it decides for this account again`,
          { account },
        );
      });

      let claimed = false;
      try {
        const [lock] = await session.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS locked',
          advisoryKey(key),
        );
        if (!lock?.locked) {
          throw new JournalHeldError(
            `another underwriter session holds the spend journal for ${account}; the lifetime ceiling is reserved in that journal, so only one may speak for this account`,
            { account },
          );
        }
        claimed = true;

        const rows = await db.query<Row>(
          'SELECT seq, prev_hash, entry_hash, body FROM underwriter_spend_log WHERE account = $1 ORDER BY seq',
          [key],
        );

        const log = SpendLog.fromEntries(rows.map((row) => decodeEntry(row)));
        const verified = log.verify();
        if ('broken' in verified) {
          throw new LogError('log_broken', `the stored spend log for ${account} is broken at entry ${verified.index}`, {
            account,
            index: verified.index,
          });
        }

        const [head] = await db.query<HeadRow>(
          'SELECT seq, entry_hash FROM underwriter_journal_head WHERE account = $1',
          [key],
        );
        if (head !== undefined) {
          const reached = log.entries[head.seq];
          if (log.length !== head.seq + 1 || reached === undefined || reached.entry_hash !== head.entry_hash) {
            throw new LogError(
              'log_broken',
              `the stored spend log for ${account} replays ${log.length} entries and the marker recorded ${head.seq + 1}. A journal shorter than its marker has lost decisions that were already acted on; the lifetime ceiling is reserved in it, so an empty one would hand back everything already spent.`,
              { account, replayed: log.length, expectedEntries: head.seq + 1 },
            );
          }
        } else if (log.length > 0) {
          // A journal written before the marker existed. It gets one now, from what it replayed,
          // so the next start is protected even though this one could not be.
          const last = log.entries[log.length - 1];
          if (last !== undefined) await recordHead(db, key, last.seq, last.entry_hash);
        }

        sessions.push(session);

        return {
          account,
          log,
          sink: appendTo(db, key, state),
          holder: me.label,
          async release() {
            const index = sessions.indexOf(session);
            if (index === -1) return;
            sessions.splice(index, 1);
            await unlock(session, key);
          },
        };
      } catch (error) {
        // Anything after the claim leaves a locked connection in hand. Returning it to the pool
        // would hand the next caller a session that still holds this account's journal, and five
        // such failures exhaust the pool.
        if (claimed) await unlock(session, key).catch(() => undefined);
        else session.release();
        throw error;
      }
    },

    async close() {
      // The pool belongs to the service. Only the pinned sessions are this store's to give back.
      for (const session of sessions.splice(0)) session.release();
    },
  };
}

/**
 * Drops the claim and gives the connection back. An unlock that does not answer leaves the lock
 * held for as long as the connection lives, so the connection is destroyed. The server drops a
 * session lock with the session, which turns a failed unlock into a released journal instead of
 * an account nobody can underwrite until a restart.
 */
async function unlock(session: Session, account: string): Promise<void> {
  try {
    await session.query('SELECT pg_advisory_unlock($1, $2)', advisoryKey(account));
    session.release();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    session.release(error);
    throw error;
  }
}

async function recordHead(db: Postgres, account: string, seq: number, entryHash: string): Promise<void> {
  await db.query(
    `INSERT INTO underwriter_journal_head (account, seq, entry_hash) VALUES ($1, $2, $3)
     ON CONFLICT (account) DO UPDATE SET seq = EXCLUDED.seq, entry_hash = EXCLUDED.entry_hash, written_at = now()`,
    [account, seq, entryHash],
  );
}

type SinkState = { refusal: Error | null };

function appendTo(db: Postgres, account: string, state: SinkState): DecisionSink {
  return {
    async append(entry: LogEntry): Promise<void> {
      if (state.refusal !== null) throw state.refusal;

      const encoded = encodeEntry(entry);
      try {
        // The entry and the marker move together. One statement is one transaction, so there is
        // no window in which a decision is stored under a marker that does not know about it, and
        // none in which the marker runs ahead of the entry it names.
        await db.query(
          `WITH appended AS (
             INSERT INTO underwriter_spend_log (account, seq, prev_hash, entry_hash, body)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             RETURNING account, seq, entry_hash
           )
           INSERT INTO underwriter_journal_head (account, seq, entry_hash)
           SELECT account, seq, entry_hash FROM appended
           ON CONFLICT (account) DO UPDATE SET seq = EXCLUDED.seq, entry_hash = EXCLUDED.entry_hash, written_at = now()`,
          [account, encoded.seq, encoded.prev_hash, encoded.entry_hash, JSON.stringify(encoded.body)],
        );
      } catch (cause) {
        // A statement can commit and still fail on its way back: a timeout, a dropped socket after
        // the server wrote the row. Reporting that as unrecorded leaves the log in memory a
        // sequence behind the table, and the next decision collides with a row it cannot see.
        if (await stored(db, account, entry)) return;

        state.refusal = new LogError(
          'log_broken',
          `an append to the spend log for ${account} at entry ${entry.seq} failed and the row could not be confirmed either way; restart the underwriter so it replays what the table holds`,
          { account, seq: entry.seq },
        );

        if ((cause as { code?: string }).code === '23505') {
          throw new LogError(
            'log_out_of_order',
            `entry ${entry.seq} already exists in the spend log for ${account}, so another writer is appending to it`,
            { account, seq: entry.seq },
          );
        }
        throw cause;
      }
    },
  };
}

/** Whether the row at this entry's sequence is this entry. A read that fails establishes nothing. */
async function stored(db: Postgres, account: string, entry: LogEntry): Promise<boolean> {
  try {
    const [row] = await db.query<{ entry_hash: string }>(
      'SELECT entry_hash FROM underwriter_spend_log WHERE account = $1 AND seq = $2',
      [account, entry.seq],
    );
    return row?.entry_hash === entry.entry_hash;
  } catch {
    return false;
  }
}

/**
 * Postgres advisory locks are keyed by two 32-bit integers, so the account address is hashed into
 * a pair. The first word is fixed so these locks cannot collide with another application's.
 */
function advisoryKey(account: string): readonly [number, number] {
  const digest = createHash('sha256').update(`mandate.underwriter.journal:${account}`).digest();
  return [LOCK_NAMESPACE, digest.readInt32BE(0)];
}

/**
 * "BRSR" as four bytes. Changing it later would stop a new build from seeing a lock an older build
 * still holds on the same account, so a change has to wait until no older build is running.
 */
const LOCK_NAMESPACE = 0x42525352;
