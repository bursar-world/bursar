import { describe, expect, it } from 'vitest';
import { ProviderLimiter, Semaphore, TokenBucket } from '../src/rpc/limiter.js';
import type { Scheduler } from '../src/rpc/limiter.js';

/**
 * Pacing is a function of the clock, so the clock is supplied. Nothing here waits on wall time, and
 * a test that asserts "a second later" means it exactly.
 */
function testClock() {
  let now = 0;
  let nextId = 0;
  const timers: { at: number; id: number; fn: () => void }[] = [];

  const schedule: Scheduler = (fn, ms) => {
    const timer = { at: now + ms, id: (nextId += 1), fn };
    timers.push(timer);
    return () => {
      const at = timers.indexOf(timer);
      if (at >= 0) timers.splice(at, 1);
    };
  };

  return {
    now: () => now,
    schedule,
    pending: () => timers.length,
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = Math.max(now, due.at);
        due.fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

/** Lets every resolved waiter's continuation run before the test looks at the result. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function track(promise: Promise<boolean>): { granted: boolean | null } {
  const state: { granted: boolean | null } = { granted: null };
  void promise.then((granted) => {
    state.granted = granted;
  });
  return state;
}

describe('TokenBucket', () => {
  it('spends the burst at once and then hands out tokens at the refill rate', async () => {
    const clock = testClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 5, ...clock });

    const calls = Array.from({ length: 8 }, () => track(bucket.acquire()));
    await settle();

    expect(calls.filter((c) => c.granted === true)).toHaveLength(5);
    expect(bucket.queued).toBe(3);

    await clock.advance(100);
    expect(calls.filter((c) => c.granted === true)).toHaveLength(6);

    await clock.advance(200);
    expect(calls.every((c) => c.granted === true)).toBe(true);
  });

  it('serves waiters in the order they arrived', async () => {
    const clock = testClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 1, ...clock });
    const served: number[] = [];

    await bucket.acquire();
    for (const id of [1, 2, 3]) {
      void bucket.acquire().then(() => served.push(id));
    }

    await clock.advance(100);
    expect(served).toEqual([1]);
    await clock.advance(200);
    expect(served).toEqual([1, 2, 3]);
  });

  it('lets a caller with somewhere else to go give up on the queue', async () => {
    const clock = testClock();
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 1, ...clock });

    await bucket.acquire();
    const impatient = track(bucket.acquire(50));

    await clock.advance(49);
    expect(impatient.granted).toBeNull();

    await clock.advance(1);
    expect(impatient.granted).toBe(false);
    expect(bucket.queued).toBe(0);

    // Giving up must not leave a token owed to nobody.
    await clock.advance(1_000);
    await expect(bucket.acquire(0)).resolves.toBe(true);
  });

  it('halves the rate in force on a 429 and climbs back on its own', async () => {
    const clock = testClock();
    const bucket = new TokenBucket({ ratePerSecond: 20, burst: 20, ...clock });

    expect(bucket.penalize()).toBe(10);

    // The rest of the burst is still arriving. Those 429s are the same mistake, not new ones.
    expect(bucket.penalize()).toBe(10);
    expect(bucket.penalize()).toBe(10);
    expect(bucket.snapshot()).toMatchObject({ ratePerSecond: 20, effectiveRatePerSecond: 10, throttled: 3 });

    // Recovery defaults to a tenth of the configured rate per second, so 10 -> 12 over a second.
    await clock.advance(1_000);
    expect(bucket.effectiveRatePerSecond).toBe(12);
    expect(bucket.penalize()).toBe(6);

    await clock.advance(10_000);
    expect(bucket.effectiveRatePerSecond).toBe(20);
    expect(bucket.snapshot().throttled).toBe(4);
  });

  it('drops the banked burst on a 429, because the endpoint has already counted those requests', async () => {
    const clock = testClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 10, ...clock });

    bucket.penalize();
    expect(bucket.snapshot().tokens).toBe(0);
    await expect(bucket.acquire(0)).resolves.toBe(false);

    // A fifth of a second at the halved rate is one token.
    await clock.advance(200);
    await expect(bucket.acquire(0)).resolves.toBe(true);
  });

  it('holds off for a Retry-After rather than resuming at the halved rate', async () => {
    const clock = testClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 10, ...clock });

    bucket.penalize(2_000);
    await clock.advance(1_900);
    await expect(bucket.acquire(0)).resolves.toBe(false);

    await clock.advance(300);
    await expect(bucket.acquire(0)).resolves.toBe(true);
  });

  it('will not halve past the floor, whatever the endpoint says', () => {
    const clock = testClock();
    const bucket = new TokenBucket({
      ratePerSecond: 16,
      minRatePerSecond: 4,
      penaltyWindowMs: 0,
      ...clock,
    });

    for (let i = 0; i < 10; i += 1) bucket.penalize();
    expect(bucket.effectiveRatePerSecond).toBe(4);
  });

  it('forgets the feedback on reset without dropping anyone who is waiting', async () => {
    const clock = testClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 1, ...clock });

    await bucket.acquire();
    const queued = track(bucket.acquire());
    bucket.penalize();
    bucket.reset();

    expect(bucket.effectiveRatePerSecond).toBe(10);
    expect(bucket.snapshot().throttled).toBe(0);

    await clock.advance(100);
    expect(queued.granted).toBe(true);
  });

  it('holds no timer open when nobody is waiting', async () => {
    const clock = testClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 2, ...clock });

    await bucket.acquire();
    await bucket.acquire();
    expect(clock.pending()).toBe(0);
  });

  it('refuses a rate that cannot be honoured', () => {
    expect(() => new TokenBucket({ ratePerSecond: 0 })).toThrow(RangeError);
    expect(() => new TokenBucket({ ratePerSecond: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => new TokenBucket({ ratePerSecond: 10, burst: 0 })).toThrow(RangeError);
    expect(() => new TokenBucket({ ratePerSecond: 10, minRatePerSecond: 11 })).toThrow(RangeError);
    expect(() => new TokenBucket({ ratePerSecond: 10, recoveryPerSecond: 0 })).toThrow(RangeError);
  });
});

describe('Semaphore', () => {
  it('holds the cap and hands a freed slot to the next waiter in line', async () => {
    const semaphore = new Semaphore(2);
    const order: number[] = [];

    await semaphore.acquire();
    await semaphore.acquire();
    expect(semaphore.active).toBe(2);

    void semaphore.acquire().then(() => order.push(1));
    void semaphore.acquire().then(() => order.push(2));
    expect(semaphore.queued).toBe(2);

    semaphore.release();
    semaphore.release();
    await settle();

    expect(order).toEqual([1, 2]);
    expect(semaphore.active).toBe(2);
  });

  it('releases the slot when the body throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(semaphore.active).toBe(0);
  });

  it('refuses a cap that is not a whole number of slots', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });
});

describe('ProviderLimiter', () => {
  it('binds the rate and the concurrency cap independently', async () => {
    const clock = testClock();
    const limiter = new ProviderLimiter({ ratePerSecond: 100, burst: 10, maxConcurrent: 2, ...clock });

    const first = await limiter.acquire();
    const second = await limiter.acquire();
    const third = track(limiter.acquire().then((lease) => lease !== null));
    await settle();

    // Tokens were there for all three; the third is held by the slot cap alone.
    expect(limiter.snapshot()).toMatchObject({ inFlight: 2, queued: 1, maxConcurrent: 2 });
    expect(third.granted).toBeNull();

    first?.release();
    await settle();
    expect(third.granted).toBe(true);

    second?.release();
    expect(limiter.snapshot().inFlight).toBe(1);
  });

  it('paces an endpoint with no concurrency cap at all', async () => {
    const clock = testClock();
    const limiter = new ProviderLimiter({ ratePerSecond: 4, burst: 1, ...clock });

    expect(await limiter.acquire()).not.toBeNull();
    expect(await limiter.acquire(0)).toBeNull();

    await clock.advance(250);
    expect(await limiter.acquire(0)).not.toBeNull();
    expect(limiter.snapshot()).toMatchObject({ ratePerSecond: 4, burst: 1, maxConcurrent: null });
  });

  it('counts a lease once however many times it is released', async () => {
    const limiter = new ProviderLimiter({ maxConcurrent: 1 });
    const lease = await limiter.acquire();

    lease?.release();
    lease?.release();

    expect(limiter.inFlight).toBe(0);
    expect(await limiter.acquire(0)).not.toBeNull();
  });

  it('reports nothing to pace for an endpoint nobody bounded', async () => {
    const limiter = new ProviderLimiter({});

    expect(await limiter.acquire(0)).not.toBeNull();
    expect(limiter.penalize()).toBeNull();
    expect(limiter.snapshot()).toMatchObject({
      ratePerSecond: null,
      effectiveRatePerSecond: null,
      maxConcurrent: null,
    });
  });
});
