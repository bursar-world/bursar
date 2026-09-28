import { createHash } from 'node:crypto';
import { microToAtomicString } from '@bursar/core';
import type { Queryable } from '../db/sql.js';
import { many, one } from '../db/sql.js';
import { countToNumber } from '../db/numeric.js';
import type {
  DeadLetter,
  JournalEntry,
  OutboxCounts,
  OutboxMessage,
  RedriveStats,
  ReplayStats,
  SweepStats,
  TrustEventInput,
  TrustEventPayload,
  TrustEventType,
} from './types.js';

/**
 * The durable half of the trust layer: an append-only journal plus a delivery outbox.
 *
 * `queue` runs on the caller's transaction, never on its own connection. That is what an outbox
 * buys: the event and the ledger change it describes commit together or not at all, so
 * there is no window in which a settlement exists and its event does not, and none in which an
 * event was published for a settlement that rolled back.
 *
 * Delivery is at-least-once. A consumer sees the same `eventId` again after a lease expires mid
 * flight, and it is expected to be idempotent on that field.
 */

export type TrustStoreOptions = {
  /** Routing label carried on every message. One topic keeps ordering per subject meaningful. */
  readonly topic: string;
  /** How long a claimed message stays invisible to other workers. */
  readonly leaseMs?: number;
  /** Attempts before a message is quarantined. */
  readonly maxAttempts?: number;
  readonly now?: () => Date;
};

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const MAX_BATCH = 200;
/** Postgres `text` has no practical limit, but an unbounded error string is a log flood. */
const MAX_ERROR_CHARS = 2_000;

/**
 * The event id is derived from the idempotency key.
 *
 * A consumer deduplicates on the event id. If a retried ledger call produced a fresh random id for
 * the same outcome, the unique key would stop the second row but any consumer that had already
 * seen the first would have no way to connect them.
 */
export function trustEventId(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
}

function buildPayload(input: TrustEventInput, eventId: string): TrustEventPayload {
  return {
    eventId,
    eventType: input.eventType,
    subject: input.subject,
    occurredAt: input.occurredAt.toISOString(),
    lane: input.lane,
    poolId: input.poolId,
    network: input.network ?? null,
    amountMicro:
      input.amountMicro === null || input.amountMicro === undefined
        ? null
        : microToAtomicString(input.amountMicro),
    currency: input.currency ?? null,
    txHash: input.txHash ?? null,
    referenceId: input.referenceId ?? null,
    settlementId: input.settlementId ?? null,
    reservationId: input.reservationId ?? null,
    debtId: input.debtId ?? null,
    payerWallet: input.payerWallet ?? null,
    repayWallet: input.repayWallet ?? null,
    merchantWallet: input.merchantWallet ?? null,
    collateralAccount: input.collateralAccount ?? null,
    assetId: input.assetId ?? null,
    metadata: input.metadata ?? {},
  };
}

type OutboxRow = {
  id: string;
  event_id: string;
  offset_id: string;
  topic: string;
  event_key: string;
  payload: TrustEventPayload;
  attempt_count: number;
};

type DeadLetterRow = {
  event_id: string;
  offset_id: string;
  topic: string;
  event_key: string;
  payload: TrustEventPayload;
  attempt_count: number;
  last_status_code: number | null;
  last_error: string;
  first_seen_at: Date;
  dead_lettered_at: Date;
};

type JournalRow = {
  offset_id: string;
  event_id: string;
  subject: string;
  event_type: TrustEventType;
  occurred_at: Date;
  payload: TrustEventPayload;
};

function toMessage(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    eventId: row.event_id,
    offset: BigInt(row.offset_id),
    topic: row.topic,
    eventKey: row.event_key,
    payload: row.payload,
    attemptCount: row.attempt_count,
  };
}

function truncate(error: string | null): string {
  return (error ?? 'unknown').slice(0, MAX_ERROR_CHARS);
}

export class TrustStore {
  readonly topic: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(options: TrustStoreOptions) {
    this.topic = options.topic;
    this.leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Appends an event and queues it for delivery, on the caller's open transaction.
   *
   * Both inserts are `ON CONFLICT DO NOTHING`, so a ledger operation that is retried after a
   * partial failure records the outcome once. The journal row is written first because the outbox
   * carries its offset, which is what makes replay from an offset possible.
   */
  async queue(client: Queryable, input: TrustEventInput): Promise<string> {
    const eventId = trustEventId(input.idempotencyKey);
    const payload = buildPayload(input, eventId);
    const encoded = JSON.stringify(payload);

    const inserted = await one<{ offset_id: string }>(
      client,
      `INSERT INTO bursar_trust_events (event_id, idempotency_key, subject, event_type, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING offset_id`,
      [eventId, input.idempotencyKey, input.subject, input.eventType, input.occurredAt, encoded],
    );

    // A conflict means this outcome is already recorded. Reading the offset back keeps the outbox
    // insert below correct for the case where the journal committed and the outbox did not.
    const offset =
      inserted?.offset_id ??
      (
        await one<{ offset_id: string }>(
          client,
          'SELECT offset_id FROM bursar_trust_events WHERE idempotency_key = $1',
          [input.idempotencyKey],
        )
      )?.offset_id;

    if (offset === undefined) {
      throw new Error(`trust event ${input.idempotencyKey} vanished between insert and read`);
    }

    await client.query(
      `INSERT INTO bursar_trust_outbox (event_id, offset_id, topic, event_key, payload, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, offset, this.topic, input.subject, encoded, this.now()],
    );

    return eventId;
  }

  /**
   * Takes up to `limit` messages that are due, hiding them from other workers for the lease.
   *
   * `FOR UPDATE SKIP LOCKED` is what lets several relay processes run without coordination: each
   * one takes rows nobody else holds rather than blocking on them. A lease that expires before the
   * worker reports back returns the message to the queue, which is where at-least-once comes from.
   */
  async claim(client: Queryable, limit: number): Promise<readonly OutboxMessage[]> {
    const size = Math.max(1, Math.min(limit, MAX_BATCH));
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);

    const rows = await many<OutboxRow>(
      client,
      `WITH due AS (
         SELECT id
         FROM bursar_trust_outbox
         WHERE status <> 'published'
           AND next_attempt_at <= $1
           AND (leased_until IS NULL OR leased_until <= $1)
         ORDER BY next_attempt_at ASC, id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE bursar_trust_outbox outbox
       SET status = 'processing',
           attempt_count = outbox.attempt_count + 1,
           leased_until = $3,
           last_attempt_at = $1,
           updated_at = $1
       FROM due
       WHERE outbox.id = due.id
       RETURNING outbox.id::text, outbox.event_id, outbox.offset_id, outbox.topic,
                 outbox.event_key, outbox.payload, outbox.attempt_count`,
      [now, size, leaseUntil],
    );

    return rows.map(toMessage);
  }

  async markPublished(
    client: Queryable,
    eventIds: readonly string[],
    statusCode: number | null,
  ): Promise<number> {
    if (eventIds.length === 0) return 0;
    const now = this.now();
    const result = await client.query(
      `UPDATE bursar_trust_outbox
       SET status = 'published',
           published_at = $2,
           leased_until = NULL,
           last_status_code = $3,
           last_error = NULL,
           updated_at = $2
       WHERE event_id = ANY($1::text[])
         AND status <> 'published'`,
      [[...eventIds], now, statusCode],
    );
    return result.rowCount;
  }

  /**
   * Hands a message back with a longer wait, or quarantines it once the budget is spent.
   *
   * Returns true when the message was quarantined, so the caller can count poison separately from
   * ordinary retries.
   */
  async recordFailure(
    client: Queryable,
    message: OutboxMessage,
    failure: { readonly statusCode: number | null; readonly error: string | null; readonly permanent: boolean },
  ): Promise<boolean> {
    const exhausted = message.attemptCount >= this.maxAttempts;
    if (failure.permanent || exhausted) {
      await this.quarantine(client, message, failure.statusCode, truncate(failure.error));
      return true;
    }

    const now = this.now();
    await client.query(
      `UPDATE bursar_trust_outbox
       SET status = 'pending',
           leased_until = NULL,
           next_attempt_at = $2,
           last_status_code = $3,
           last_error = $4,
           updated_at = $5
       WHERE id = $1::bigint`,
      // `attemptCount` already counts the attempt that just failed. The first retry therefore
      // waits one base delay, not two.
      [
        message.id,
        new Date(now.getTime() + backoffMs(message.attemptCount - 1)),
        failure.statusCode,
        truncate(failure.error),
        now,
      ],
    );
    return false;
  }

  /**
   * Moves a message out of the queue and into the quarantine, preserving everything needed to
   * replay it later. The journal row is untouched: the event happened whether or not anyone
   * managed to deliver it.
   */
  async quarantine(
    client: Queryable,
    message: OutboxMessage,
    statusCode: number | null,
    error: string,
  ): Promise<void> {
    await client.query(
      `WITH moved AS (
         DELETE FROM bursar_trust_outbox
         WHERE id = $1::bigint
         RETURNING event_id, offset_id, topic, event_key, payload, attempt_count, created_at
       )
       INSERT INTO bursar_trust_dead_letter (
         event_id, offset_id, topic, event_key, payload,
         attempt_count, last_status_code, last_error, first_seen_at, dead_lettered_at
       )
       SELECT moved.event_id, moved.offset_id, moved.topic, moved.event_key, moved.payload,
              moved.attempt_count, $2, $3, moved.created_at, $4
       FROM moved
       ON CONFLICT (event_id) DO UPDATE
       SET attempt_count = GREATEST(bursar_trust_dead_letter.attempt_count, EXCLUDED.attempt_count),
           last_status_code = EXCLUDED.last_status_code,
           last_error = EXCLUDED.last_error,
           dead_lettered_at = EXCLUDED.dead_lettered_at`,
      [message.id, statusCode, truncate(error), this.now()],
    );
  }

  /** Returns quarantined messages to the queue, oldest first. */
  async redrive(
    client: Queryable,
    options: { readonly limit?: number; readonly eventId?: string } = {},
  ): Promise<RedriveStats> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 10_000));
    const now = this.now();

    const rows = await many<{ event_id: string; inserted: boolean }>(
      client,
      `WITH candidates AS (
         SELECT event_id, offset_id, topic, event_key, payload
         FROM bursar_trust_dead_letter
         WHERE ($2::text IS NULL OR event_id = $2)
         ORDER BY dead_lettered_at ASC, id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ),
       requeued AS (
         INSERT INTO bursar_trust_outbox (
           event_id, offset_id, topic, event_key, payload,
           status, attempt_count, next_attempt_at, created_at, updated_at
         )
         SELECT c.event_id, c.offset_id, c.topic, c.event_key, c.payload,
                'pending', 0, $3, $3, $3
         FROM candidates c
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id
       ),
       removed AS (
         DELETE FROM bursar_trust_dead_letter d
         USING requeued r
         WHERE d.event_id = r.event_id
         RETURNING d.event_id
       )
       SELECT c.event_id, (r.event_id IS NOT NULL) AS inserted
       FROM candidates c
       LEFT JOIN removed r ON r.event_id = c.event_id`,
      [limit, options.eventId ?? null, now],
    );

    const redriven = rows.filter((row) => row.inserted).length;
    return { selected: rows.length, redriven, skipped: rows.length - redriven };
  }

  /**
   * Deletes quarantined messages, and delivered ones, older than the retention window.
   *
   * A published outbox row has done its job: the journal keeps the event, and `replay` re-queues
   * from the journal. Kept for ever, the outbox grows by one row per ledger movement for the life of
   * the deployment and every claim scans past them.
   */
  async sweep(
    client: Queryable,
    retentionMs: number,
    options: { readonly limit?: number; readonly dryRun?: boolean } = {},
  ): Promise<SweepStats> {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 10_000));
    const cutoff = new Date(this.now().getTime() - Math.max(0, retentionMs));

    if (options.dryRun) {
      const rows = await many<{ event_id: string }>(
        client,
        `SELECT event_id FROM bursar_trust_dead_letter
         WHERE dead_lettered_at < $1
         ORDER BY dead_lettered_at ASC, id ASC
         LIMIT $2`,
        [cutoff, limit],
      );
      const published = await one<{ count: string }>(
        client,
        `SELECT COUNT(*)::text AS count FROM (
           SELECT 1 FROM bursar_trust_outbox
           WHERE status = 'published' AND published_at < $1
           LIMIT $2
         ) due`,
        [cutoff, limit],
      );
      return { selected: rows.length, deleted: 0, published: countToNumber(published?.count), pruned: 0 };
    }

    const rows = await many<{ event_id: string }>(
      client,
      `WITH candidates AS (
         SELECT id
         FROM bursar_trust_dead_letter
         WHERE dead_lettered_at < $1
         ORDER BY dead_lettered_at ASC, id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM bursar_trust_dead_letter d
       USING candidates c
       WHERE d.id = c.id
       RETURNING d.event_id`,
      [cutoff, limit],
    );

    const pruned = await many<{ id: string }>(
      client,
      `DELETE FROM bursar_trust_outbox o
       USING (
         SELECT id FROM bursar_trust_outbox
         WHERE status = 'published' AND published_at < $1
         ORDER BY published_at ASC, id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       ) due
       WHERE o.id = due.id
       RETURNING o.id::text AS id`,
      [cutoff, limit],
    );

    return { selected: rows.length, deleted: rows.length, published: pruned.length, pruned: pruned.length };
  }

  /**
   * Re-queues journal entries from an offset onwards.
   *
   * Useful after a consumer loses its own state, or after a bug on the consuming side. Entries
   * already in the outbox are left alone, so a replay cannot undo the progress of a delivery that
   * is in flight.
   */
  async replay(
    client: Queryable,
    options: { readonly fromOffset?: bigint; readonly limit?: number; readonly subject?: string } = {},
  ): Promise<ReplayStats> {
    const from = options.fromOffset ?? 0n;
    const limit = Math.max(1, Math.min(options.limit ?? 500, 10_000));
    const now = this.now();

    const rows = await many<{ offset_id: string; enqueued: boolean }>(
      client,
      `WITH candidates AS (
         SELECT offset_id, event_id, subject, payload
         FROM bursar_trust_events
         WHERE offset_id >= $1::bigint
           AND ($3::text IS NULL OR subject = $3)
         ORDER BY offset_id ASC
         LIMIT $2
       ),
       queued AS (
         INSERT INTO bursar_trust_outbox (
           event_id, offset_id, topic, event_key, payload,
           status, attempt_count, next_attempt_at, created_at, updated_at
         )
         SELECT c.event_id, c.offset_id, $4, c.subject, c.payload, 'pending', 0, $5, $5, $5
         FROM candidates c
         ON CONFLICT (event_id) DO NOTHING
         RETURNING offset_id
       )
       SELECT c.offset_id, (q.offset_id IS NOT NULL) AS enqueued
       FROM candidates c
       LEFT JOIN queued q ON q.offset_id = c.offset_id
       ORDER BY c.offset_id ASC`,
      [from.toString(), limit, options.subject ?? null, this.topic, now],
    );

    const last = rows.at(-1);
    return {
      scanned: rows.length,
      enqueued: rows.filter((row) => row.enqueued).length,
      nextOffset: last ? BigInt(last.offset_id) + 1n : from,
    };
  }

  async counts(client: Queryable): Promise<OutboxCounts> {
    const row = await one<{
      pending: string;
      processing: string;
      published: string;
      dead_lettered: string;
      oldest_pending_at: Date | null;
      latest_published_at: Date | null;
    }>(
      client,
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'processing')::text AS processing,
         COUNT(*) FILTER (WHERE status = 'published')::text AS published,
         (SELECT COUNT(*)::text FROM bursar_trust_dead_letter) AS dead_lettered,
         MIN(next_attempt_at) FILTER (WHERE status <> 'published') AS oldest_pending_at,
         MAX(published_at) AS latest_published_at
       FROM bursar_trust_outbox`,
    );

    return {
      pending: countToNumber(row?.pending),
      processing: countToNumber(row?.processing),
      published: countToNumber(row?.published),
      deadLettered: countToNumber(row?.dead_lettered),
      oldestPendingAt: row?.oldest_pending_at ?? null,
      latestPublishedAt: row?.latest_published_at ?? null,
    };
  }

  async listDeadLetters(client: Queryable, limit = 20): Promise<readonly DeadLetter[]> {
    const size = Math.max(1, Math.min(limit, 200));
    const rows = await many<DeadLetterRow>(
      client,
      `SELECT event_id, offset_id, topic, event_key, payload, attempt_count,
              last_status_code, last_error, first_seen_at, dead_lettered_at
       FROM bursar_trust_dead_letter
       ORDER BY dead_lettered_at DESC, id DESC
       LIMIT $1`,
      [size],
    );

    return rows.map((row) => ({
      eventId: row.event_id,
      offset: BigInt(row.offset_id),
      topic: row.topic,
      eventKey: row.event_key,
      payload: row.payload,
      attemptCount: row.attempt_count,
      lastStatusCode: row.last_status_code,
      lastError: row.last_error,
      firstSeenAt: row.first_seen_at,
      deadLetteredAt: row.dead_lettered_at,
    }));
  }

  async readJournal(
    client: Queryable,
    options: { readonly fromOffset?: bigint; readonly limit?: number; readonly subject?: string } = {},
  ): Promise<readonly JournalEntry[]> {
    const size = Math.max(1, Math.min(options.limit ?? 50, 500));
    const rows = await many<JournalRow>(
      client,
      `SELECT offset_id, event_id, subject, event_type, occurred_at, payload
       FROM bursar_trust_events
       WHERE offset_id >= $1::bigint
         AND ($3::text IS NULL OR subject = $3)
       ORDER BY offset_id ASC
       LIMIT $2`,
      [(options.fromOffset ?? 0n).toString(), size, options.subject ?? null],
    );

    return rows.map((row) => ({
      offset: BigInt(row.offset_id),
      eventId: row.event_id,
      subject: row.subject,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      payload: row.payload,
    }));
  }
}

/**
 * Exponential backoff, doubling from two seconds and capped at an hour.
 *
 * The cap matters more than the curve. An uncapped doubling reaches days after a dozen attempts,
 * which turns a sink that was down for an afternoon into a queue that stays stalled overnight.
 */
export function backoffMs(attempt: number): number {
  const steps = Math.max(0, Math.min(attempt, 11));
  return Math.min(2_000 * 2 ** steps, 3_600_000);
}
