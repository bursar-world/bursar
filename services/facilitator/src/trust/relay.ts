import type { Database, Queryable } from '../db/sql.js';
import type { OutboxMessage, TrustEventSink } from './types.js';

/**
 * The slice of the trust store the loop drives.
 *
 * `TrustStore` satisfies it. Keeping it structural is what lets the retry, quarantine and partial
 * acceptance paths be tested without a database, since none of them are about SQL.
 */
export type RelayStore = {
  claim(client: Queryable, limit: number): Promise<readonly OutboxMessage[]>;
  markPublished(client: Queryable, eventIds: readonly string[], statusCode: number | null): Promise<number>;
  recordFailure(
    client: Queryable,
    message: OutboxMessage,
    failure: { readonly statusCode: number | null; readonly error: string | null; readonly permanent: boolean },
  ): Promise<boolean>;
};

export type RelayEvent =
  | { readonly type: 'batch'; readonly claimed: number; readonly published: number; readonly retried: number; readonly quarantined: number }
  | { readonly type: 'idle' }
  | { readonly type: 'error'; readonly error: string };

export type RelayOptions = {
  readonly db: Database;
  readonly store: RelayStore;
  readonly sink: TrustEventSink;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly onEvent?: (event: RelayEvent) => void;
};

export type RelayPass = {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly quarantined: number;
};

/**
 * The delivery loop.
 *
 * One pass claims a batch, hands it to the sink, and settles each message: published, retried with
 * a longer wait, or quarantined. The loop owns no timers of its own beyond the sleep between
 * passes, so a caller can drive it a pass at a time from a test or a cron entry without waiting on
 * wall-clock time.
 */
export class TrustRelay {
  private readonly db: Database;
  private readonly store: RelayStore;
  private readonly sink: TrustEventSink;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly onEvent: (event: RelayEvent) => void;
  private running = false;
  private stopped: Promise<void> = Promise.resolve();
  private wake: (() => void) | null = null;

  constructor(options: RelayOptions) {
    this.db = options.db;
    this.store = options.store;
    this.sink = options.sink;
    this.batchSize = Math.max(1, options.batchSize ?? 50);
    this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 2_000);
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /**
   * Claims and delivers one batch.
   *
   * The claim commits before the sink is called. Holding a transaction open across a network call
   * would pin a connection for the length of the consumer's worst response, and the lease is what
   * protects the message in the meantime.
   */
  async pass(): Promise<RelayPass> {
    const claimed = await this.db.transaction((client) => this.store.claim(client, this.batchSize));
    if (claimed.length === 0) {
      this.onEvent({ type: 'idle' });
      return { claimed: 0, published: 0, retried: 0, quarantined: 0 };
    }

    const result = await this.sink.deliver(claimed);
    const delivered = new Set(result.delivered);
    const failed = claimed.filter((message) => !delivered.has(message.eventId));

    let quarantined = 0;
    await this.db.transaction(async (client) => {
      if (result.delivered.length > 0) {
        await this.store.markPublished(client, [...delivered], result.statusCode);
      }
      for (const message of failed) {
        const poisoned = await this.store.recordFailure(client, message, {
          statusCode: result.statusCode,
          error: result.error,
          permanent: result.permanent,
        });
        if (poisoned) quarantined += 1;
      }
    });

    const pass: RelayPass = {
      claimed: claimed.length,
      published: delivered.size,
      retried: failed.length - quarantined,
      quarantined,
    };
    this.onEvent({ type: 'batch', ...pass });
    return pass;
  }

  /**
   * Runs passes until `stop` is called, sleeping between them.
   *
   * A pass that throws does not end the loop. The outbox is durable, so the messages it failed on
   * are still there on the next pass; exiting on the first database blip would turn a recoverable
   * outage into a stopped queue that needs a human.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const pass = await this.pass();
        // A full batch means more is waiting, so go straight round again.
        if (pass.claimed >= this.batchSize) continue;
      } catch (error) {
        this.onEvent({ type: 'error', error: error instanceof Error ? error.message : String(error) });
      }
      await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.pollIntervalMs);
      // Do not hold the process open for a poll that is only waiting for work.
      timer.unref?.();
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.stopped;
  }
}

export type { OutboxMessage };
