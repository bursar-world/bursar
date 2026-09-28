import { describe, expect, it } from 'vitest';
import type { Queryable } from '../src/db/sql.js';
import { TrustRelay } from '../src/trust/relay.js';
import { drain } from './support/drain.js';
import type { RelayStore } from '../src/trust/relay.js';
import { backoffMs } from '../src/trust/store.js';
import type { OutboxMessage, SinkResult, TrustEventPayload, TrustEventSink } from '../src/trust/types.js';
import { RecordingDatabase } from './support/doubles.js';

function payload(eventId: string): TrustEventPayload {
  return {
    eventId,
    eventType: 'settlement_confirmed',
    subject: 'agent-1',
    occurredAt: '2026-09-11T00:00:00.000Z',
    lane: 'prefund',
    poolId: 'prefund-main',
    network: 'eip155:4663',
    amountMicro: '1000000',
    currency: 'USDG',
    txHash: null,
    referenceId: null,
    settlementId: null,
    reservationId: null,
    debtId: null,
    payerWallet: null,
    repayWallet: null,
    merchantWallet: null,
    collateralAccount: null,
    assetId: null,
    metadata: {},
  };
}

function message(eventId: string, attemptCount = 1): OutboxMessage {
  return {
    id: eventId,
    eventId,
    offset: 1n,
    topic: 'mandate.trust.v1',
    eventKey: 'agent-1',
    payload: payload(eventId),
    attemptCount,
  };
}

/** A store that hands out a queue once and records how each message was settled. */
class FakeStore implements RelayStore {
  published: string[] = [];
  failed: { eventId: string; permanent: boolean }[] = [];
  quarantined: string[] = [];

  constructor(
    private queue: OutboxMessage[][],
    private readonly maxAttempts = 3,
  ) {}

  async claim(_client: Queryable, _limit: number): Promise<readonly OutboxMessage[]> {
    return this.queue.shift() ?? [];
  }

  async markPublished(_client: Queryable, eventIds: readonly string[]): Promise<number> {
    this.published.push(...eventIds);
    return eventIds.length;
  }

  async recordFailure(
    _client: Queryable,
    msg: OutboxMessage,
    failure: { readonly permanent: boolean },
  ): Promise<boolean> {
    this.failed.push({ eventId: msg.eventId, permanent: failure.permanent });
    if (failure.permanent || msg.attemptCount >= this.maxAttempts) {
      this.quarantined.push(msg.eventId);
      return true;
    }
    return false;
  }
}

function sink(result: Partial<SinkResult>, name = 'test'): TrustEventSink {
  return {
    name,
    deliver: async () => ({ delivered: [], statusCode: null, error: null, permanent: false, ...result }),
  };
}

describe('trust relay', () => {
  it('publishes a batch the consumer accepted', async () => {
    const store = new FakeStore([[message('a'), message('b')]]);
    const relay = new TrustRelay({
      db: new RecordingDatabase(),
      store,
      sink: sink({ delivered: ['a', 'b'], statusCode: 202 }),
    });

    expect(await relay.pass()).toEqual({ claimed: 2, published: 2, retried: 0, quarantined: 0 });
    expect(store.published).toEqual(['a', 'b']);
    expect(store.failed).toEqual([]);
  });

  it('retries what the consumer did not accept and keeps what it did', async () => {
    const store = new FakeStore([[message('a'), message('b')]]);
    const relay = new TrustRelay({
      db: new RecordingDatabase(),
      store,
      sink: sink({ delivered: ['a'], statusCode: 200, error: 'consumer accepted 1 of 2' }),
    });

    expect(await relay.pass()).toEqual({ claimed: 2, published: 1, retried: 1, quarantined: 0 });
    expect(store.published).toEqual(['a']);
    expect(store.failed).toEqual([{ eventId: 'b', permanent: false }]);
  });

  it('quarantines a message the consumer will never take', async () => {
    const store = new FakeStore([[message('poison')]]);
    const relay = new TrustRelay({
      db: new RecordingDatabase(),
      store,
      sink: sink({ statusCode: 422, error: '422 Unprocessable', permanent: true }),
    });

    expect(await relay.pass()).toEqual({ claimed: 1, published: 0, retried: 0, quarantined: 1 });
    expect(store.quarantined).toEqual(['poison']);
  });

  it('quarantines a message that has run out of attempts', async () => {
    const store = new FakeStore([[message('tired', 3)]], 3);
    const relay = new TrustRelay({
      db: new RecordingDatabase(),
      store,
      sink: sink({ error: 'connection refused' }),
    });

    expect((await relay.pass()).quarantined).toBe(1);
  });

  it('reports an idle queue without touching the sink', async () => {
    const events: string[] = [];
    const relay = new TrustRelay({
      db: new RecordingDatabase(),
      store: new FakeStore([]),
      sink: {
        name: 'unused',
        deliver: async () => {
          events.push('delivered');
          return { delivered: [], statusCode: null, error: null, permanent: false };
        },
      },
      onEvent: (event) => events.push(event.type),
    });

    expect(await relay.pass()).toEqual({ claimed: 0, published: 0, retried: 0, quarantined: 0 });
    expect(events).toEqual(['idle']);
  });

  it('drains every queued batch and stops when there is nothing left', async () => {
    const store = new FakeStore([[message('a')], [message('b')], []]);
    const relay = new TrustRelay({
      db: new RecordingDatabase(),
      store,
      sink: { name: 'all', deliver: async (batch) => ({
        delivered: batch.map((m) => m.eventId),
        statusCode: 200,
        error: null,
        permanent: false,
      }) },
    });

    expect(await drain(relay)).toEqual({ claimed: 2, published: 2, retried: 0, quarantined: 0 });
    expect(store.published).toEqual(['a', 'b']);
  });

  it('keeps running after a pass throws', async () => {
    const errors: string[] = [];
    let attempted = 0;
    const failing: RelayStore = {
      claim: async () => {
        attempted += 1;
        if (attempted === 1) throw new Error('connection terminated');
        return [];
      },
      markPublished: async () => 0,
      recordFailure: async () => false,
    };
    const relay = new TrustRelay({
      db: new RecordingDatabase(),
      store: failing,
      sink: sink({}),
      pollIntervalMs: 100,
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.error);
      },
    });

    await expect(relay.pass()).rejects.toThrow('connection terminated');
    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await relay.stop();
    expect(attempted).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  });
});

describe('backoff', () => {
  it('doubles from two seconds', () => {
    expect(backoffMs(0)).toBe(2_000);
    expect(backoffMs(1)).toBe(4_000);
    expect(backoffMs(4)).toBe(32_000);
  });

  it('caps at an hour so an afternoon outage does not stall the queue overnight', () => {
    expect(backoffMs(11)).toBe(3_600_000);
    expect(backoffMs(50)).toBe(3_600_000);
  });

  it('treats a negative attempt as the first', () => {
    expect(backoffMs(-3)).toBe(2_000);
  });
});
