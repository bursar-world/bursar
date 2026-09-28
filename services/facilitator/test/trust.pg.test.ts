import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import { TrustStore, trustEventId } from '../src/trust/store.js';
import { TrustRelay } from '../src/trust/relay.js';
import { drain } from './support/drain.js';
import type { OutboxMessage, SinkResult, TrustEventInput, TrustEventSink } from '../src/trust/types.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

const SUBJECT = 'agent-1';

describe.skipIf(!TEST_DATABASE_URL)('trust store against Postgres', () => {
  let scratch: Scratch;
  let store: TrustStore;
  let now: Date;

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_trust_test');
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.reset();
    now = new Date('2026-09-11T12:00:00.000Z');
    store = new TrustStore({ topic: 'mandate.trust.v1', maxAttempts: 3, leaseMs: 60_000, now: () => now });
  });

  function event(key: string, overrides: Partial<TrustEventInput> = {}): TrustEventInput {
    return {
      eventType: 'settlement_confirmed',
      subject: SUBJECT,
      idempotencyKey: key,
      occurredAt: now,
      lane: 'prefund',
      poolId: 'prefund-main',
      network: 'eip155:4663',
      amountMicro: toMicro('90071992547409'),
      currency: 'USDG',
      ...overrides,
    };
  }

  const queue = (input: TrustEventInput): Promise<string> =>
    scratch.db.transaction((client) => store.queue(client, input));

  const claim = (limit = 10): Promise<readonly OutboxMessage[]> =>
    scratch.db.transaction((client) => store.claim(client, limit));

  function sink(result: Partial<SinkResult>): TrustEventSink {
    return {
      name: 'test',
      deliver: async () => ({ delivered: [], statusCode: null, error: null, permanent: false, ...result }),
    };
  }

  describe('journal and queue', () => {
    it('appends an event and queues it in the same transaction', async () => {
      const id = await queue(event('settlement:1'));
      expect(id).toBe(trustEventId('settlement:1'));

      const journal = await store.readJournal(scratch.db);
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({ offset: 1n, eventId: id, subject: SUBJECT });
      expect(await store.counts(scratch.db)).toMatchObject({ pending: 1, published: 0, deadLettered: 0 });
    });

    it('records one outcome once however many times it is queued', async () => {
      await queue(event('settlement:1'));
      await queue(event('settlement:1'));
      expect(await store.readJournal(scratch.db)).toHaveLength(1);
      expect((await store.counts(scratch.db)).pending).toBe(1);
    });

    it('rolls the event back with the change that produced it', async () => {
      await expect(
        scratch.db.transaction(async (client) => {
          await store.queue(client, event('settlement:1'));
          throw new Error('the ledger change failed');
        }),
      ).rejects.toThrow('the ledger change failed');
      expect(await store.readJournal(scratch.db)).toHaveLength(0);
    });

    it('carries an amount no double could hold', async () => {
      await queue(event('settlement:1'));
      const [entry] = await store.readJournal(scratch.db);
      expect(entry?.payload.amountMicro).toBe('90071992547409');
    });

    it('numbers events so a consumer can replay from an offset', async () => {
      for (const key of ['a', 'b', 'c']) await queue(event(key));
      const journal = await store.readJournal(scratch.db, { fromOffset: 2n });
      expect(journal.map((entry) => entry.offset)).toEqual([2n, 3n]);
    });

    it('reads the events of one subject without the rest', async () => {
      await queue(event('a'));
      await queue(event('b', { subject: 'agent-2' }));
      expect(await store.readJournal(scratch.db, { subject: 'agent-2' })).toHaveLength(1);
    });
  });

  describe('claiming', () => {
    it('hands a message to one worker at a time', async () => {
      await queue(event('a'));
      expect(await claim()).toHaveLength(1);
      expect(await claim()).toHaveLength(0);
    });

    it('returns a message whose lease expired without a worker reporting back', async () => {
      await queue(event('a'));
      const first = await claim();
      expect(first[0]?.attemptCount).toBe(1);

      now = new Date(now.getTime() + 61_000);
      const second = await claim();
      expect(second[0]?.eventId).toBe(first[0]?.eventId);
      expect(second[0]?.attemptCount).toBe(2);
    });

    it('takes the oldest due messages first', async () => {
      for (const key of ['a', 'b', 'c']) await queue(event(key));
      const batch = await claim(2);
      expect(batch.map((message) => message.offset)).toEqual([1n, 2n]);
    });

    it('stops handing out a published message', async () => {
      await queue(event('a'));
      const [message] = await claim();
      if (!message) throw new Error('expected a message');

      await scratch.db.transaction((client) => store.markPublished(client, [message.eventId], 202));
      now = new Date(now.getTime() + 3_600_000);
      expect(await claim()).toHaveLength(0);
      expect(await store.counts(scratch.db)).toMatchObject({ published: 1, pending: 0 });
    });

    it('prunes delivered messages past retention and keeps the journal', async () => {
      await queue(event('a'));
      await queue(event('b'));
      const [delivered] = await claim(1);
      if (!delivered) throw new Error('expected a message');
      await scratch.db.transaction((client) => store.markPublished(client, [delivered.eventId], 202));

      expect(await scratch.db.transaction((client) => store.sweep(client, 86_400_000))).toMatchObject({
        pruned: 0,
      });

      now = new Date(now.getTime() + 86_400_001);
      expect(
        await scratch.db.transaction((client) => store.sweep(client, 86_400_000, { dryRun: true })),
      ).toMatchObject({ published: 1, pruned: 0 });
      expect(await scratch.db.transaction((client) => store.sweep(client, 86_400_000))).toMatchObject({
        published: 1,
        pruned: 1,
      });

      // The undelivered one stays queued, and the journal still has both for a replay.
      expect(await store.counts(scratch.db)).toMatchObject({ published: 0, pending: 1 });
      expect(await store.readJournal(scratch.db)).toHaveLength(2);
    });
  });

  describe('failure and quarantine', () => {
    it('waits longer after each failure', async () => {
      await queue(event('a'));
      const [first] = await claim();
      if (!first) throw new Error('expected a message');

      await scratch.db.transaction((client) =>
        store.recordFailure(client, first, { statusCode: 503, error: 'upstream down', permanent: false }),
      );
      expect(await claim()).toHaveLength(0);

      now = new Date(now.getTime() + 2_001);
      const [second] = await claim();
      expect(second?.attemptCount).toBe(2);
    });

    it('quarantines a message the consumer will never take', async () => {
      await queue(event('a'));
      const [message] = await claim();
      if (!message) throw new Error('expected a message');

      const quarantined = await scratch.db.transaction((client) =>
        store.recordFailure(client, message, { statusCode: 422, error: 'schema rejected', permanent: true }),
      );

      expect(quarantined).toBe(true);
      expect(await store.counts(scratch.db)).toMatchObject({ pending: 0, deadLettered: 1 });
      const [dead] = await store.listDeadLetters(scratch.db);
      expect(dead).toMatchObject({ eventId: message.eventId, lastStatusCode: 422 });
      expect(dead?.lastError).toContain('schema rejected');
      // The event itself is still on record. Nobody delivered it; it still happened.
      expect(await store.readJournal(scratch.db)).toHaveLength(1);
    });

    it('quarantines a message that has used up its attempts', async () => {
      await queue(event('a'));
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const [message] = await claim();
        if (!message) throw new Error(`expected a message on attempt ${attempt}`);
        await scratch.db.transaction((client) =>
          store.recordFailure(client, message, { statusCode: null, error: 'refused', permanent: false }),
        );
        now = new Date(now.getTime() + 3_600_000);
      }
      expect(await store.counts(scratch.db)).toMatchObject({ deadLettered: 1 });
    });

    it('puts a quarantined message back in the queue on redrive', async () => {
      await queue(event('a'));
      const [message] = await claim();
      if (!message) throw new Error('expected a message');
      await scratch.db.transaction((client) =>
        store.quarantine(client, message, 500, 'the consumer was rebuilt'),
      );

      const stats = await scratch.db.transaction((client) => store.redrive(client, {}));
      expect(stats).toEqual({ selected: 1, redriven: 1, skipped: 0 });
      expect(await store.counts(scratch.db)).toMatchObject({ pending: 1, deadLettered: 0 });
      expect(await claim()).toHaveLength(1);
    });

    it('redrives one named message and leaves the rest quarantined', async () => {
      for (const key of ['a', 'b']) await queue(event(key));
      const messages = await claim();
      for (const message of messages) {
        await scratch.db.transaction((client) => store.quarantine(client, message, 500, 'down'));
      }

      const target = messages[1];
      if (!target) throw new Error('expected two messages');
      const stats = await scratch.db.transaction((client) =>
        store.redrive(client, { eventId: target.eventId }),
      );
      expect(stats.redriven).toBe(1);
      expect(await store.counts(scratch.db)).toMatchObject({ pending: 1, deadLettered: 1 });
    });

    it('deletes quarantined messages only once they are past the retention window', async () => {
      await queue(event('a'));
      const [message] = await claim();
      if (!message) throw new Error('expected a message');
      await scratch.db.transaction((client) => store.quarantine(client, message, 500, 'down'));

      expect(await scratch.db.transaction((client) => store.sweep(client, 86_400_000))).toEqual({
        selected: 0,
        deleted: 0,
        published: 0,
        pruned: 0,
      });

      now = new Date(now.getTime() + 86_400_001);
      expect(await scratch.db.transaction((client) => store.sweep(client, 86_400_000, { dryRun: true }))).toEqual({
        selected: 1,
        deleted: 0,
        published: 0,
        pruned: 0,
      });
      expect(await scratch.db.transaction((client) => store.sweep(client, 86_400_000))).toEqual({
        selected: 1,
        deleted: 1,
        published: 0,
        pruned: 0,
      });
      expect(await store.counts(scratch.db)).toMatchObject({ deadLettered: 0 });
    });
  });

  describe('replay', () => {
    it('requeues journal entries from an offset', async () => {
      for (const key of ['a', 'b', 'c']) await queue(event(key));
      const messages = await claim();
      await scratch.db.transaction((client) =>
        store.markPublished(client, messages.map((message) => message.eventId), 200),
      );
      expect(await store.counts(scratch.db)).toMatchObject({ published: 3, pending: 0 });

      // Delivery happened but the consumer lost its own state, so the queue is refilled from the
      // journal.
      await scratch.db.query('DELETE FROM bursar_trust_outbox');
      const stats = await scratch.db.transaction((client) => store.replay(client, { fromOffset: 2n }));
      expect(stats).toMatchObject({ scanned: 2, enqueued: 2, nextOffset: 4n });
      expect(await claim()).toHaveLength(2);
    });

    it('leaves a message that is already queued alone', async () => {
      await queue(event('a'));
      const stats = await scratch.db.transaction((client) => store.replay(client, {}));
      expect(stats).toMatchObject({ scanned: 1, enqueued: 0 });
      expect((await store.counts(scratch.db)).pending).toBe(1);
    });

    it('replays one subject', async () => {
      await queue(event('a'));
      await queue(event('b', { subject: 'agent-2' }));
      await scratch.db.query('DELETE FROM bursar_trust_outbox');

      const stats = await scratch.db.transaction((client) =>
        store.replay(client, { subject: 'agent-2' }),
      );
      expect(stats.enqueued).toBe(1);
    });
  });

  describe('the relay over a real queue', () => {
    it('drains everything a consumer accepts', async () => {
      for (const key of ['a', 'b', 'c']) await queue(event(key));
      const relay = new TrustRelay({
        db: scratch.db,
        store,
        sink: {
          name: 'accepting',
          deliver: async (batch) => ({
            delivered: batch.map((message) => message.eventId),
            statusCode: 202,
            error: null,
            permanent: false,
          }),
        },
        batchSize: 2,
      });

      expect(await drain(relay)).toMatchObject({ claimed: 3, published: 3, quarantined: 0 });
      expect(await store.counts(scratch.db)).toMatchObject({ published: 3, pending: 0 });
    });

    it('quarantines poison and keeps going', async () => {
      await queue(event('a'));
      const relay = new TrustRelay({
        db: scratch.db,
        store,
        sink: sink({ statusCode: 422, error: 'schema rejected', permanent: true }),
      });

      expect(await relay.pass()).toMatchObject({ claimed: 1, quarantined: 1 });
      expect(await relay.pass()).toMatchObject({ claimed: 0 });
      expect(await store.counts(scratch.db)).toMatchObject({ deadLettered: 1 });
    });

    it('holds events when nothing is configured to receive them, and loses none', async () => {
      await queue(event('a'));
      const relay = new TrustRelay({
        db: scratch.db,
        store,
        sink: sink({ error: 'TRUST_SINK_URL is not set' }),
      });

      await relay.pass();
      expect(await store.counts(scratch.db)).toMatchObject({ pending: 1, deadLettered: 0 });
      expect(await store.readJournal(scratch.db)).toHaveLength(1);
    });
  });
});
