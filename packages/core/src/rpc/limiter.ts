/** Schedules a wake-up and returns its canceller. Injected in tests so pacing costs no wall-clock time. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

export type Lease = { release(): void };

const defaultSchedule: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

type Waiter = {
  readonly resolve: (granted: boolean) => void;
  cancelDeadline: (() => void) | null;
};

export type TokenBucketOptions = {
  /** Requests per second this endpoint is believed to allow. */
  readonly ratePerSecond: number;
  /** How many requests may leave at once after an idle stretch. Defaults to one second of rate. */
  readonly burst?: number;
  /** The 429 feedback will not halve past this. Defaults to an eighth of the configured rate. */
  readonly minRatePerSecond?: number;
  /** Rate regained per second after a 429. Defaults to a tenth of the configured rate. */
  readonly recoveryPerSecond?: number;
  /**
   * How long one 429 speaks for. Further 429s inside this window are the same observation, since
   * a burst already in flight keeps arriving after the cut. Defaults to a second.
   */
  readonly penaltyWindowMs?: number;
  readonly now?: () => number;
  readonly schedule?: Scheduler;
};

export type TokenBucketSnapshot = {
  readonly ratePerSecond: number;
  readonly effectiveRatePerSecond: number;
  readonly burst: number;
  readonly tokens: number;
  readonly queued: number;
  readonly throttled: number;
};

/**
 * Token bucket with FIFO waiters and 429 feedback.
 *
 * A public endpoint meters a rate, not a count in flight: sixty simultaneous requests come back
 * clean a few seconds after sixty others, and two hundred a second do not come back at all. A
 * counting semaphore cannot bound a rate, which is why the limiter this replaced changed nothing
 * on chain. This one pays a token per request and refills at a measured rate, so a caller that
 * fans out two hundred reads queues instead of collecting 429s.
 *
 * The configured rate is a starting guess and is treated as one. A 429 halves the rate in force
 * and the bucket climbs back additively, so an endpoint whose operator retunes it is tracked
 * without argument. Recovery is slower than the cut because overshooting costs another 429 and
 * every caller behind it.
 *
 * Refill is computed from the clock on demand. Nothing here holds a timer open except while a
 * caller is waiting.
 */
export class TokenBucket {
  readonly ratePerSecond: number;
  readonly burst: number;

  #effective: number;
  #minRate: number;
  #recoveryPerSecond: number;
  #penaltyWindowMs: number;
  #penalisedAt: number | null = null;
  #tokens: number;
  #updatedAt: number;
  #waiters: Waiter[] = [];
  #wake: (() => void) | null = null;
  #throttled = 0;
  #now: () => number;
  #schedule: Scheduler;

  constructor(options: TokenBucketOptions) {
    const { ratePerSecond } = options;
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new RangeError('ratePerSecond must be a positive, finite number of requests per second');
    }

    const burst = options.burst ?? Math.ceil(ratePerSecond);
    if (!Number.isFinite(burst) || burst < 1) throw new RangeError('burst must be at least 1');

    const minRate = options.minRatePerSecond ?? Math.max(1, ratePerSecond / 8);
    if (minRate <= 0 || minRate > ratePerSecond) {
      throw new RangeError('minRatePerSecond must be positive and no greater than ratePerSecond');
    }

    const recovery = options.recoveryPerSecond ?? ratePerSecond / 10;
    if (!Number.isFinite(recovery) || recovery <= 0) {
      throw new RangeError('recoveryPerSecond must be a positive, finite rate');
    }

    const penaltyWindowMs = options.penaltyWindowMs ?? 1_000;
    if (!Number.isFinite(penaltyWindowMs) || penaltyWindowMs < 0) {
      throw new RangeError('penaltyWindowMs must be a non-negative number of milliseconds');
    }

    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.#effective = ratePerSecond;
    this.#minRate = minRate;
    this.#recoveryPerSecond = recovery;
    this.#penaltyWindowMs = penaltyWindowMs;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#tokens = burst;
    this.#updatedAt = this.#now();
  }

  get effectiveRatePerSecond(): number {
    this.#refill();
    return this.#effective;
  }

  get queued(): number {
    return this.#waiters.length;
  }

  get throttled(): number {
    return this.#throttled;
  }

  /**
   * Resolves true when a token is in hand. `maxWaitMs` lets a caller with somewhere else to go
   * give up: the pool uses it to try a second provider rather than sit in this queue.
   */
  acquire(maxWaitMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    this.#refill();

    // Queued callers go first, or a steady arrival stream would starve the ones already waiting.
    if (this.#waiters.length === 0 && this.#tokens >= 1) {
      this.#tokens -= 1;
      return Promise.resolve(true);
    }
    if (maxWaitMs <= 0) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { resolve, cancelDeadline: null };
      this.#waiters.push(waiter);

      if (Number.isFinite(maxWaitMs)) {
        waiter.cancelDeadline = this.#schedule(() => {
          const at = this.#waiters.indexOf(waiter);
          if (at >= 0) this.#waiters.splice(at, 1);
          resolve(false);
        }, maxWaitMs);
      }

      this.#scheduleWake();
    });
  }

  /**
   * The endpoint answered 429. Cuts the rate, drops whatever burst was banked, and honours a
   * Retry-After by holding the bucket in debt until it elapses. Returns the rate now in force.
   */
  penalize(retryAfterMs?: number): number {
    this.#refill();
    this.#throttled += 1;

    // Forty calls in flight produce forty 429s from one mistake. Halving on each would put the
    // pacer on the floor for a burst that one cut fixes.
    const now = this.#now();
    if (this.#penalisedAt === null || now - this.#penalisedAt >= this.#penaltyWindowMs) {
      this.#effective = Math.max(this.#minRate, this.#effective / 2);
      this.#penalisedAt = now;
    }

    const debt =
      retryAfterMs !== undefined && retryAfterMs > 0 ? -(retryAfterMs / 1000) * this.#effective : 0;
    this.#tokens = Math.min(this.#tokens, debt);
    this.#rewake();

    return this.#effective;
  }

  /** Forgets the 429 feedback. Queued callers keep their place. */
  reset(): void {
    this.#refill();
    this.#effective = this.ratePerSecond;
    this.#throttled = 0;
    this.#penalisedAt = null;
    this.#rewake();
  }

  snapshot(): TokenBucketSnapshot {
    this.#refill();
    return {
      ratePerSecond: this.ratePerSecond,
      effectiveRatePerSecond: this.#effective,
      burst: this.burst,
      tokens: this.#tokens,
      queued: this.#waiters.length,
      throttled: this.#throttled,
    };
  }

  #refill(): void {
    const now = this.#now();
    const elapsedMs = now - this.#updatedAt;
    if (elapsedMs <= 0) return;
    this.#updatedAt = now;

    const seconds = elapsedMs / 1000;
    this.#tokens = Math.min(this.burst, this.#tokens + seconds * this.#effective);
    if (this.#effective < this.ratePerSecond) {
      this.#effective = Math.min(
        this.ratePerSecond,
        this.#effective + seconds * this.#recoveryPerSecond,
      );
    }
  }

  #pump(): void {
    this.#refill();
    while (this.#waiters.length > 0 && this.#tokens >= 1) {
      const waiter = this.#waiters.shift();
      if (!waiter) break;
      waiter.cancelDeadline?.();
      this.#tokens -= 1;
      waiter.resolve(true);
    }
    this.#scheduleWake();
  }

  /** The rate changed under a pending wake-up, so the old one now fires at the wrong time. */
  #rewake(): void {
    this.#wake?.();
    this.#wake = null;
    this.#scheduleWake();
  }

  #scheduleWake(): void {
    if (this.#wake !== null || this.#waiters.length === 0) return;
    const ms = Math.max(1, Math.ceil(((1 - this.#tokens) / this.#effective) * 1000));
    this.#wake = this.#schedule(() => {
      this.#wake = null;
      this.#pump();
    }, ms);
  }
}

/**
 * Counting semaphore with FIFO waiters.
 *
 * Some endpoints meter what is in flight, not what arrives per second. This is that bound, kept
 * separate from the rate so neither one is mistaken for the other.
 */
export class Semaphore {
  readonly limit: number;

  #active = 0;
  #waiters: (() => void)[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('concurrency limit must be a positive integer');
    }
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiters.length;
  }

  acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.#waiters.shift();
    // The slot is handed straight to the next waiter, which keeps the queue in order under a
    // burst.
    if (next) {
      next();
      return;
    }
    this.#active -= 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export type ProviderLimiterOptions = {
  /** Omit for an endpoint that publishes no rate. Requests then leave as fast as they arrive. */
  readonly ratePerSecond?: number;
  readonly burst?: number;
  /** Independent of the rate, and usually absent. Only set it for an endpoint that meters in flight. */
  readonly maxConcurrent?: number;
  readonly minRatePerSecond?: number;
  readonly recoveryPerSecond?: number;
  readonly penaltyWindowMs?: number;
  readonly now?: () => number;
  readonly schedule?: Scheduler;
};

export type ProviderLimiterSnapshot = {
  readonly ratePerSecond: number | null;
  readonly effectiveRatePerSecond: number | null;
  readonly burst: number | null;
  readonly maxConcurrent: number | null;
  readonly inFlight: number;
  readonly queued: number;
  readonly throttled: number;
};

/**
 * What one provider is allowed: a rate, a concurrency cap, or both.
 *
 * A lease is the unit. Holding one means a token was paid and a slot, if the endpoint meters
 * slots, is held. Releasing it frees the slot; the token is spent either way, because the
 * endpoint counted the request the moment it arrived.
 */
export class ProviderLimiter {
  #bucket: TokenBucket | null;
  #slots: Semaphore | null;
  #inFlight = 0;

  constructor(options: ProviderLimiterOptions) {
    const { ratePerSecond, maxConcurrent, ...rate } = options;
    this.#bucket = ratePerSecond === undefined ? null : new TokenBucket({ ratePerSecond, ...rate });
    this.#slots = maxConcurrent === undefined ? null : new Semaphore(maxConcurrent);
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get queued(): number {
    return (this.#bucket?.queued ?? 0) + (this.#slots?.queued ?? 0);
  }

  /** Null when the caller's wait budget ran out before a token came free. */
  async acquire(maxWaitMs = Number.POSITIVE_INFINITY): Promise<Lease | null> {
    if (this.#bucket && !(await this.#bucket.acquire(maxWaitMs))) return null;

    // The budget covers the token only. Once it is paid there is nothing to gain by walking away
    // from a slot that a request already in flight is about to free.
    if (this.#slots) await this.#slots.acquire();

    this.#inFlight += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight -= 1;
        this.#slots?.release();
      },
    };
  }

  /** Returns the rate now in force, or null for an endpoint this limiter does not pace. */
  penalize(retryAfterMs?: number): number | null {
    return this.#bucket?.penalize(retryAfterMs) ?? null;
  }

  reset(): void {
    this.#bucket?.reset();
  }

  snapshot(): ProviderLimiterSnapshot {
    const bucket = this.#bucket?.snapshot() ?? null;
    return {
      ratePerSecond: bucket?.ratePerSecond ?? null,
      effectiveRatePerSecond: bucket?.effectiveRatePerSecond ?? null,
      burst: bucket?.burst ?? null,
      maxConcurrent: this.#slots?.limit ?? null,
      inFlight: this.#inFlight,
      queued: this.queued,
      throttled: bucket?.throttled ?? 0,
    };
  }
}
