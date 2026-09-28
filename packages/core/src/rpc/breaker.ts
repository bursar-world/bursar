export type BreakerState = 'closed' | 'open' | 'half-open';

export type BreakerOptions = {
  /** Consecutive failures that open the circuit. */
  readonly failureThreshold?: number;
  /** How long the circuit stays open before one probe is allowed through. */
  readonly openMs?: number;
  /** Consecutive probe successes needed to close the circuit again. */
  readonly successThreshold?: number;
  /** Injectable clock. Tests drive this instead of sleeping. */
  readonly now?: () => number;
};

export type BreakerSnapshot = {
  readonly name: string;
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
  /**
   * When the next probe is admitted, on this breaker's own clock. Null while the circuit is
   * closed. A caller told only that a circuit is open has no way to know whether that is a
   * fifteen-second wait or a permanent state, so the moment it lifts is reported with it.
   */
  readonly nextProbeAt: number | null;
  readonly lastFailure: string | null;
};

const DEFAULTS = { failureThreshold: 3, openMs: 15_000, successThreshold: 1 } as const;

/**
 * State changes are driven by the clock, not a timer. Nothing here keeps the process alive, and a
 * test can move time forward without waiting. Half-open admits one probe at a time: the state
 * asks a recovering endpoint a single question and does not resume full traffic against something
 * that has not proved it is back.
 */
export class CircuitBreaker {
  readonly name: string;

  #failureThreshold: number;
  #openMs: number;
  #successThreshold: number;
  #now: () => number;

  #consecutiveFailures = 0;
  #consecutiveSuccesses = 0;
  #openedAt: number | null = null;
  #probeInFlight = false;
  #lastFailure: string | null = null;

  constructor(name: string, options: BreakerOptions = {}) {
    this.name = name;
    this.#failureThreshold = options.failureThreshold ?? DEFAULTS.failureThreshold;
    this.#openMs = options.openMs ?? DEFAULTS.openMs;
    this.#successThreshold = options.successThreshold ?? DEFAULTS.successThreshold;
    this.#now = options.now ?? Date.now;

    if (this.#failureThreshold < 1) throw new RangeError('failureThreshold must be at least 1');
    if (this.#openMs < 0) throw new RangeError('openMs must not be negative');
    if (this.#successThreshold < 1) throw new RangeError('successThreshold must be at least 1');
  }

  get state(): BreakerState {
    if (this.#openedAt === null) return 'closed';
    return this.#now() - this.#openedAt >= this.#openMs ? 'half-open' : 'open';
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  /**
   * How long until the next probe is admitted, in milliseconds. Null while the circuit is closed,
   * zero once the wait has elapsed and the probe slot is free.
   *
   * Read off the same clock the state is, so a test that moves time forward moves this with it.
   */
  get msUntilProbe(): number | null {
    if (this.#openedAt === null) return null;
    return Math.max(0, this.#openedAt + this.#openMs - this.#now());
  }

  /** Claims permission to send. A half-open circuit grants this to one caller until it reports back. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'open') return false;
    if (state === 'closed') return true;
    if (this.#probeInFlight) return false;
    this.#probeInFlight = true;
    return true;
  }

  /**
   * Hands a probe slot back with no verdict. Used when the call was answered by something other
   * than the endpoint's health, such as a contract refusing: that says nothing about whether a
   * recovering provider is back, and counting it as a success would clear the failures of one that
   * is not.
   */
  release(): void {
    this.#probeInFlight = false;
  }

  succeed(): void {
    this.#probeInFlight = false;
    this.#consecutiveFailures = 0;
    if (this.#openedAt === null) return;

    this.#consecutiveSuccesses += 1;
    if (this.#consecutiveSuccesses >= this.#successThreshold) {
      this.#openedAt = null;
      this.#consecutiveSuccesses = 0;
      this.#lastFailure = null;
    }
  }

  fail(reason: string): void {
    this.#probeInFlight = false;
    this.#consecutiveSuccesses = 0;
    this.#consecutiveFailures += 1;
    this.#lastFailure = reason;

    // A probe that fails restarts the cooldown from now, otherwise a long-dead provider would be
    // retried on every call once its first open window elapsed.
    if (this.#openedAt !== null || this.#consecutiveFailures >= this.#failureThreshold) {
      this.#openedAt = this.#now();
    }
  }

  reset(): void {
    this.#consecutiveFailures = 0;
    this.#consecutiveSuccesses = 0;
    this.#openedAt = null;
    this.#probeInFlight = false;
    this.#lastFailure = null;
  }

  snapshot(): BreakerSnapshot {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.#consecutiveFailures,
      openedAt: this.#openedAt,
      nextProbeAt: this.#openedAt === null ? null : this.#openedAt + this.#openMs,
      lastFailure: this.#lastFailure,
    };
  }
}
