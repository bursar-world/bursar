import { BursarError } from '../errors.js';
import { CircuitBreaker } from './breaker.js';
import type { BreakerOptions, BreakerSnapshot } from './breaker.js';
import { ProviderLimiter } from './limiter.js';
import type { Scheduler } from './limiter.js';
import { DISCOVERED_RATE, rateLimitFor } from './limits.js';

export type RpcProvider = {
  /** Short label used in logs, metrics and breaker events. Not a secret. */
  readonly name: string;
  readonly url: string;
  /** Extra headers, for an endpoint that authenticates by header. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Requests per second this endpoint is believed to allow. Robinhood's public endpoint meters
   * arrivals somewhere between sixty and seventy a second. Pacing a fan-out here keeps those
   * arrivals from coming back as 429s. The figure is a starting point: a 429 halves it and it
   * recovers on its own.
   */
  readonly maxRatePerSecond?: number;
  /** How many may leave at once after an idle stretch. Defaults to one second of rate. */
  readonly burst?: number;
  /**
   * Calls this endpoint will carry at once. A separate bound from the rate, and usually absent:
   * set it only for an endpoint that is known to meter what is in flight.
   */
  readonly maxConcurrent?: number;
};

export type ProviderAttempt = {
  readonly provider: string;
  readonly reason: string;
};

/**
 * Raised when nothing left the process, because every provider is inside a cooldown this client
 * is holding after earlier failures.
 *
 * Apart from `AllProvidersDownError` because the next step differs. There, every endpoint was
 * asked and every one of them failed, so the network or the configuration is the thing to look
 * at. Here no request was sent at all: the endpoints may be perfectly well, and the state clears
 * on its own once the cooldown elapses. Reported as the same failure, the two send a developer
 * looking at an endpoint that was never contacted.
 */
export class AllProvidersCoolingError extends BursarError {
  readonly attempts: readonly ProviderAttempt[];

  constructor(method: string, attempts: readonly ProviderAttempt[]) {
    super(
      'rpc_all_providers_cooling',
      `No request was sent for ${method}. Every RPC provider is inside a cooldown this client ` +
        'opened after earlier failures, so nothing was asked of the network and no endpoint ' +
        `refused anything. It lifts on its own. ${attempts
          .map((a) => `${a.provider}: ${a.reason}`)
          .join('; ')}`,
      { method, attempts },
    );
    this.attempts = attempts;
  }
}

export type ProviderStatus = BreakerSnapshot & {
  readonly url: string;
  readonly requests: number;
  readonly failures: number;
  /** 429s. Counted apart from failures: the endpoint answered, and the pool sent too fast. */
  readonly throttled: number;
  readonly inFlight: number;
  readonly queued: number;
  /** null when this endpoint runs unpaced. */
  readonly ratePerSecond: number | null;
  /** What the pacer is holding right now, which drops after a 429 and climbs back. */
  readonly effectiveRatePerSecond: number | null;
  /** null unless this endpoint is known to meter what is in flight. */
  readonly maxConcurrent: number | null;
};

export type RpcPoolEvent =
  | { readonly type: 'request_failed'; readonly provider: string; readonly method: string; readonly reason: string }
  | { readonly type: 'rate_limited'; readonly provider: string; readonly method: string; readonly ratePerSecond: number | null }
  | { readonly type: 'breaker_opened'; readonly provider: string; readonly consecutiveFailures: number }
  | { readonly type: 'breaker_closed'; readonly provider: string }
  | { readonly type: 'fallback_used'; readonly provider: string; readonly method: string; readonly skipped: readonly string[] }
  | { readonly type: 'retry_scheduled'; readonly method: string; readonly pass: number; readonly delayMs: number }
  | { readonly type: 'all_providers_down'; readonly method: string; readonly attempts: readonly ProviderAttempt[] };

/**
 * Raised when the ordered provider list is exhausted. Fatal to the call: falling through to
 * whatever public endpoint happens to answer is how a service ends up running for days on an
 * endpoint nobody is paying for and nobody is watching.
 */
export class AllProvidersDownError extends BursarError {
  readonly attempts: readonly ProviderAttempt[];

  /**
   * `cause` carries the last failure as it was thrown, so a caller holding this error can still
   * reach the `AggregateError` a dual-stack connect produced and read the address each leg tried.
   */
  constructor(method: string, attempts: readonly ProviderAttempt[], cause?: unknown) {
    super(
      'rpc_all_providers_down',
      `No RPC provider answered ${method}. ${attempts
        .map((a) => `${a.provider}: ${a.reason}`)
        .join('; ')}`,
      { method, attempts },
    );
    this.attempts = attempts;
    if (cause !== undefined) this.cause = cause;
  }
}

/** A provider answered with a JSON-RPC error. That is an answer, so it does not count against the breaker. */
export class RpcResponseError extends BursarError {
  readonly rpcCode: number;
  readonly data: unknown;

  constructor(provider: string, method: string, rpcCode: number, message: string, data: unknown) {
    super('rpc_error', message, { provider, method, rpcCode, data });
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

/**
 * A provider answering for a different chain than the pool was built for.
 *
 * Fatal to the call and never retried anywhere. A wrong-chain endpoint is confidently wrong: it
 * returns balances, nonces and receipts that parse cleanly and describe another network. The
 * usual failure is a fallback left on its testnet default under a mainnet primary, and nothing
 * notices until the primary's breaker opens.
 */
export class RpcWrongChainError extends BursarError {
  readonly expected: number;
  readonly actual: number;

  constructor(provider: string, expected: number, actual: number) {
    super(
      'rpc_wrong_chain',
      `${provider} serves chain ${actual}, not ${expected}. It will not be used.`,
      { provider, expected, actual },
    );
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The endpoint throttled the call for rate. It is not sick and it did not answer the question, so
 * this costs the provider no breaker strike and instead slows the pacer in front of it.
 */
export class RpcThrottledError extends BursarError {
  readonly retryAfterMs: number | undefined;

  constructor(provider: string, method: string, detail: string, retryAfterMs?: number) {
    super('rpc_rate_limited', `${provider} rate limited ${method} (${detail})`, {
      provider,
      method,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
    this.retryAfterMs = retryAfterMs;
  }
}

export type RpcRetryOptions = {
  /**
   * Passes over the provider set, not sends. One pass is a plain failover, so the bound is on
   * repeats and a retry can never truncate the walk to the last provider. Worst case per call is
   * maxPasses x providers x timeoutMs, plus the backoffs between passes.
   */
  readonly maxPasses?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injected in tests so a retry costs no wall-clock time. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
};

export type RpcPoolOptions = {
  /** Tried in order. The first entry is the endpoint this deployment pays for. */
  readonly providers: readonly RpcProvider[];
  /**
   * Checked against `eth_chainId` before a provider serves its first read, and again if that check
   * could not be completed. Omit only where there is no chain to check against.
   */
  readonly chainId?: number;
  readonly timeoutMs?: number;
  readonly breaker?: BreakerOptions;
  readonly retry?: RpcRetryOptions;
  /**
   * Applied to any provider that carries neither its own figure nor a known one for its host.
   * Left unset, Robinhood's endpoints and dRPC get their measured pace and everything else,
   * including a local fork, runs unpaced until it answers a 429.
   */
  readonly maxRatePerSecond?: number;
  readonly burst?: number;
  /** A concurrency cap for every provider. Rarely what you want; the rate is the usual bound. */
  readonly maxConcurrent?: number;
  readonly pacing?: PacingOptions;
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
  readonly onEvent?: (event: RpcPoolEvent) => void;
  /**
   * JSON-RPC error codes that mean "ask someone else" rather than "here is your answer". Rate
   * limits are not in this list: they are recognised on their own and slow the pacer instead.
   */
  readonly retryableRpcErrorCodes?: readonly number[];
};

export type PacingOptions = {
  /**
   * How long a call waits for a token before trying the next provider instead. It only applies
   * while a later provider is still eligible; the last one standing is waited on for as long as
   * it takes, which is what keeps a fan-out alive when a single endpoint is all that is left.
   */
  readonly spilloverMs?: number;
  readonly now?: () => number;
  readonly schedule?: Scheduler;
};

const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * -32603 is "internal error". A node sends it when it is broken, not when the call is wrong, so
 * the next provider may well answer. Code 3, a revert, stays off this list: the contract refused,
 * and asking elsewhere returns the same answer.
 */
const DEFAULT_RETRYABLE_CODES: readonly number[] = [-32603];
const DEFAULT_SPILLOVER_MS = 50;
/** Codes providers use for "too fast", whatever HTTP status they pair it with. */
const THROTTLE_RPC_CODES = new Set([-32005, -32029, 429]);
const DEFAULT_RETRY = { maxPasses: 2, baseDelayMs: 120, maxDelayMs: 2_000 } as const;

type JsonRpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

type Attempt<T> =
  | { readonly kind: 'result'; readonly value: T }
  | { readonly kind: 'failed'; readonly reason: string; readonly error: unknown }
  /** `cooling` marks a breaker holding the provider back, as against the pacer in front of it. */
  | { readonly kind: 'skipped'; readonly reason: string; readonly cooling: boolean };

type ResolvedRetry = {
  readonly maxPasses: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
};

/**
 * Ordered RPC fallback with a breaker and a pacer in front of every endpoint.
 *
 * The failure this is built against: a metered provider quietly hit its plan cap, every call
 * started coming back 429, and the service kept working against a public endpoint for long enough
 * that nobody noticed until the public endpoint rate-limited too. So a degrade here is loud. The
 * pool emits an event the moment it leaves the primary, keeps per-provider counters a health
 * endpoint can read, and throws once the list runs out.
 *
 * Retries live here rather than in the transport underneath. viem's retry would spend three
 * attempts on one dead endpoint before the pool ever reached the next provider; a retry at this
 * level moves to a different provider first and only comes back round, after a jittered pause,
 * once the whole set has failed. A refusal from the contract is not a transient failure and is
 * never retried.
 *
 * Pacing is what keeps that machinery for real failures. A public endpoint throttling a burst is
 * neither sick nor out of quota, so a 429 slows the pacer, leaves the breaker alone, and is
 * counted on its own line in `status()`.
 */
export class RpcPool {
  readonly providers: readonly RpcProvider[];

  #breakers: Map<string, CircuitBreaker>;
  #counters: Map<string, { requests: number; failures: number; throttled: number }>;
  #openState: Map<string, boolean>;
  #limiters: Map<string, ProviderLimiter | null>;
  #pacing: PacingOptions;
  #spilloverMs: number;
  #timeoutMs: number;
  #retry: ResolvedRetry;
  #fetch: typeof fetch;
  #onEvent: (event: RpcPoolEvent) => void;
  #retryableCodes: ReadonlySet<number>;
  #chainId: number | undefined;
  #chainChecks = new Map<string, Promise<void>>();
  #nextId = 1;

  constructor(options: RpcPoolOptions) {
    if (options.providers.length === 0) {
      throw new BursarError('rpc_no_providers', 'An RPC pool needs at least one provider.');
    }
    const names = new Set(options.providers.map((p) => p.name));
    if (names.size !== options.providers.length) {
      throw new BursarError(
        'rpc_duplicate_provider',
        'RPC provider names must be unique; they are how a degrade is reported.',
        { names: options.providers.map((p) => p.name) },
      );
    }

    this.providers = options.providers;
    this.#chainId = options.chainId;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retry = resolveRetry(options.retry);
    // A browser's fetch throws "Illegal invocation" when called detached from the global object,
    // and storing it on a private field detaches it.
    this.#fetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    // Wrapped once, here, because every emit sits on a request path. A logging callback that
    // throws would otherwise turn an answered read into a failure, or a retry into an abort.
    const onEvent = options.onEvent;
    this.#onEvent =
      onEvent === undefined
        ? () => {}
        : (event) => {
            try {
              onEvent(event);
            } catch {
              // An observer's fault is not the request's.
            }
          };
    this.#retryableCodes = new Set(options.retryableRpcErrorCodes ?? DEFAULT_RETRYABLE_CODES);
    this.#breakers = new Map(
      options.providers.map((p) => [p.name, new CircuitBreaker(p.name, options.breaker ?? {})]),
    );
    this.#counters = new Map(
      options.providers.map((p) => [p.name, { requests: 0, failures: 0, throttled: 0 }]),
    );
    this.#openState = new Map(options.providers.map((p) => [p.name, false]));
    this.#pacing = options.pacing ?? {};
    this.#spilloverMs = options.pacing?.spilloverMs ?? DEFAULT_SPILLOVER_MS;
    this.#limiters = new Map(
      options.providers.map((p) => {
        const known = rateLimitFor(p.url);
        const configured = p.maxRatePerSecond ?? options.maxRatePerSecond ?? known?.ratePerSecond;
        // Infinity is how a caller says "this endpoint is mine, do not pace it".
        const ratePerSecond = configured === Infinity ? undefined : configured;
        const burst = p.burst ?? options.burst ?? known?.burst;
        const maxConcurrent = p.maxConcurrent ?? options.maxConcurrent;

        if (ratePerSecond === undefined && maxConcurrent === undefined) return [p.name, null];
        return [p.name, this.#limiter({ ratePerSecond, burst, maxConcurrent })];
      }),
    );
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const reasons = new Map<string, string>();
    const passedOver = new Set<string>();
    // Whether this call ever reached an endpoint, and the failure it came back with. Together
    // they decide which of the two refusals below the caller gets, which is the difference
    // between an endpoint that failed and an endpoint that was never contacted.
    let everSent = false;
    let allCooling = true;
    let lastFailure: unknown;

    for (let pass = 0; pass < this.#retry.maxPasses; pass += 1) {
      if (pass > 0) {
        const delayMs = this.#backoff(pass);
        this.#onEvent({ type: 'retry_scheduled', method, pass: pass + 1, delayMs });
        await this.#retry.sleep(delayMs);
      }

      let sent = 0;

      for (const [index, provider] of this.providers.entries()) {
        const outcome = await this.#attempt<T>(provider, method, params, this.#waitBudget(index));
        if (outcome.kind === 'skipped') {
          if (!outcome.cooling) allCooling = false;
        } else {
          sent += 1;
          everSent = true;
        }

        if (outcome.kind === 'result') {
          const skipped = [...passedOver].filter((name) => name !== provider.name);
          if (skipped.length > 0) {
            this.#onEvent({ type: 'fallback_used', provider: provider.name, method, skipped });
          }
          return outcome.value;
        }

        if (outcome.kind === 'failed') lastFailure = outcome.error;
        reasons.set(provider.name, outcome.reason);
        passedOver.add(provider.name);
      }

      // Nothing was sent: no breaker would admit the call, either open or half-open with its
      // probe slot already taken. Sleeping would only burn the caller's time against a cooldown
      // that has not elapsed.
      if (sent === 0) break;
    }

    const attempts: ProviderAttempt[] = [];
    for (const provider of this.providers) {
      const reason = reasons.get(provider.name);
      if (reason !== undefined) attempts.push({ provider: provider.name, reason });
    }

    this.#onEvent({ type: 'all_providers_down', method, attempts });
    if (!everSent && allCooling) throw new AllProvidersCoolingError(method, attempts);
    throw new AllProvidersDownError(method, attempts, lastFailure);
  }

  status(): readonly ProviderStatus[] {
    return this.providers.map((provider) => {
      const counters = this.#counters.get(provider.name) ?? { requests: 0, failures: 0, throttled: 0 };
      const limiter = this.#limiters.get(provider.name) ?? null;
      const pace = limiter?.snapshot() ?? null;
      return {
        ...this.#breaker(provider.name).snapshot(),
        url: redactUrl(provider.url),
        requests: counters.requests,
        failures: counters.failures,
        throttled: counters.throttled,
        inFlight: pace?.inFlight ?? 0,
        queued: pace?.queued ?? 0,
        ratePerSecond: pace?.ratePerSecond ?? null,
        effectiveRatePerSecond: pace?.effectiveRatePerSecond ?? null,
        maxConcurrent: pace?.maxConcurrent ?? null,
      };
    });
  }

  /** True when at least one endpoint is currently eligible. A health check should read this. */
  healthy(): boolean {
    return this.providers.some((p) => this.#breaker(p.name).state !== 'open');
  }

  reset(): void {
    for (const breaker of this.#breakers.values()) breaker.reset();
    for (const limiter of this.#limiters.values()) limiter?.reset();
    for (const counters of this.#counters.values()) {
      counters.requests = 0;
      counters.failures = 0;
      counters.throttled = 0;
    }
    for (const name of this.#openState.keys()) this.#openState.set(name, false);
  }

  #breaker(name: string): CircuitBreaker {
    const breaker = this.#breakers.get(name);
    if (!breaker) throw new BursarError('rpc_unknown_provider', `No breaker for provider ${name}.`);
    return breaker;
  }

  #limiter(options: {
    ratePerSecond: number | undefined;
    burst: number | undefined;
    maxConcurrent: number | undefined;
  }): ProviderLimiter {
    return new ProviderLimiter({ ...options, now: this.#pacing.now, schedule: this.#pacing.schedule });
  }

  /**
   * Unbounded for the last provider that could still answer. Anything earlier gets a short
   * budget. A burst spills onto a healthy second endpoint instead of queueing behind the first.
   */
  #waitBudget(index: number): number {
    for (let i = index + 1; i < this.providers.length; i += 1) {
      const later = this.providers[i];
      if (later && this.#breaker(later.name).state !== 'open') return this.#spilloverMs;
    }
    return Number.POSITIVE_INFINITY;
  }

  #backoff(pass: number): number {
    const ceiling = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** (pass - 1));
    // Half-to-full jitter. Enough spread that a fleet retrying the same endpoint does not come
    // back in lockstep, without letting one call idle for the whole ceiling.
    return Math.round(ceiling * (0.5 + this.#retry.random() * 0.5));
  }

  #reportBreaker(name: string, breaker: CircuitBreaker): void {
    const isOpen = breaker.state !== 'closed';
    if (isOpen === this.#openState.get(name)) return;
    this.#openState.set(name, isOpen);
    this.#onEvent(
      isOpen
        ? { type: 'breaker_opened', provider: name, consecutiveFailures: breaker.consecutiveFailures }
        : { type: 'breaker_closed', provider: name },
    );
  }

  async #attempt<T>(
    provider: RpcProvider,
    method: string,
    params: readonly unknown[],
    maxWaitMs: number,
  ): Promise<Attempt<T>> {
    // Checked before queueing so a call does not wait for a token at an endpoint it may not use.
    if (this.#breaker(provider.name).state === 'open') {
      return { kind: 'skipped', reason: this.#coolingReason(provider.name), cooling: true };
    }

    const limiter = this.#limiters.get(provider.name);
    if (!limiter) return this.#guarded<T>(provider, method, params);

    const lease = await limiter.acquire(maxWaitMs);
    if (!lease) {
      return {
        kind: 'skipped',
        reason: 'not sent; this client had no rate token for it in time and another provider was free',
        cooling: false,
      };
    }
    try {
      return await this.#guarded<T>(provider, method, params);
    } finally {
      lease.release();
    }
  }

  async #guarded<T>(
    provider: RpcProvider,
    method: string,
    params: readonly unknown[],
  ): Promise<Attempt<T>> {
    const breaker = this.#breaker(provider.name);
    if (!breaker.tryAcquire()) {
      return { kind: 'skipped', reason: this.#coolingReason(provider.name), cooling: true };
    }

    const counters = this.#counters.get(provider.name);
    if (counters) counters.requests += 1;

    try {
      await this.#assertChain(provider);
      const value = await this.#send<T>(provider, method, params);
      breaker.succeed();
      this.#reportBreaker(provider.name, breaker);
      return { kind: 'result', value };
    } catch (error) {
      if (error instanceof RpcWrongChainError) {
        breaker.release();
        throw error;
      }

      if (error instanceof RpcThrottledError) {
        if (counters) counters.throttled += 1;
        const ratePerSecond = this.#slowDown(provider, error.retryAfterMs);
        this.#onEvent({ type: 'rate_limited', provider: provider.name, method, ratePerSecond });

        // A 429 says this pool sent too fast, not that the endpoint is sick, so it costs no
        // breaker strike. A probe is the exception: the circuit is already open and a 429 has not
        // proved it is back.
        if (breaker.state !== 'closed') {
          breaker.fail('rate limited');
          this.#reportBreaker(provider.name, breaker);
        }
        return { kind: 'failed', reason: describe(error, this.#timeoutMs), error };
      }

      if (error instanceof RpcResponseError && !this.#retryableCodes.has(error.rpcCode)) {
        // The endpoint understood the call and rejected it. A revert is not a sick provider, and
        // asking again, here or anywhere else, returns the same refusal. It is not evidence the
        // endpoint is well either: calling succeed() here clears the failure count of a node that
        // is failing every other call, so the probe slot is handed back without a verdict.
        breaker.release();
        throw error;
      }

      const reason = describe(error, this.#timeoutMs);
      if (counters) counters.failures += 1;
      breaker.fail(reason);
      this.#reportBreaker(provider.name, breaker);
      this.#onEvent({ type: 'request_failed', provider: provider.name, method, reason });
      return { kind: 'failed', reason, error };
    }
  }

  /**
   * Why a provider was passed over without being asked anything.
   *
   * This is a state this process is holding, not a refusal from the endpoint, and the difference
   * decides what a reader does next. A line reading only "circuit open" was taken on the last
   * live run as an endpoint that had gone away for good; it was a fifteen-second cooldown opened
   * here, three failures earlier, and it lifted on its own. So the sentence says whose state it
   * is, what opened it, when it is next probed, and what the failure under it was.
   */
  #coolingReason(name: string): string {
    const breaker = this.#breaker(name);
    const { state, consecutiveFailures, lastFailure } = breaker.snapshot();
    const since = lastFailure === null ? '' : ` Last failure here: ${lastFailure}.`;

    if (state === 'half-open') {
      return `not sent; this client is already probing ${name} on another call, and admits one at a time.${since}`;
    }

    const wait = breaker.msUntilProbe;
    const when = wait === null ? 'on the next call' : `in ${seconds(wait)}s`;
    const failures = consecutiveFailures === 1 ? '1 failure' : `${consecutiveFailures} consecutive failures`;
    return (
      `not sent; this client stopped using ${name} after ${failures} and probes it again ${when}. ` +
      `The endpoint refused nothing and was not asked.${since}`
    );
  }

  /**
   * A 429 from an endpoint nobody configured a pace for means the pace exists and was never
   * written down. Start one, conservatively.
   */
  #slowDown(provider: RpcProvider, retryAfterMs: number | undefined): number | null {
    let limiter = this.#limiters.get(provider.name) ?? null;
    if (!limiter) {
      limiter = this.#limiter({
        ratePerSecond: DISCOVERED_RATE.ratePerSecond,
        burst: DISCOVERED_RATE.burst,
        maxConcurrent: provider.maxConcurrent,
      });
      this.#limiters.set(provider.name, limiter);
    }
    return limiter.penalize(retryAfterMs);
  }

  /**
   * One `eth_chainId` per provider before it is trusted with anything. A wrong answer is cached,
   * because the chain an endpoint serves does not change; a check that could not be completed is
   * not, because the question still stands.
   */
  async #assertChain(provider: RpcProvider): Promise<void> {
    const expected = this.#chainId;
    if (expected === undefined) return;

    const pending = this.#chainChecks.get(provider.name);
    if (pending) return pending;

    const check = this.#checkChain(provider, expected);
    this.#chainChecks.set(provider.name, check);
    try {
      await check;
    } catch (error) {
      if (!(error instanceof RpcWrongChainError)) this.#chainChecks.delete(provider.name);
      throw error;
    }
  }

  async #checkChain(provider: RpcProvider, expected: number): Promise<void> {
    const answer = await this.#send<unknown>(provider, 'eth_chainId', []);
    const actual = typeof answer === 'string' ? Number(answer) : Number.NaN;
    if (!Number.isInteger(actual)) {
      throw new BursarError(
        'rpc_bad_body',
        `${provider.name} answered eth_chainId with ${JSON.stringify(answer)}.`,
        { provider: provider.name, answer },
      );
    }
    if (actual !== expected) throw new RpcWrongChainError(provider.name, expected, actual);
  }

  async #send<T>(provider: RpcProvider, method: string, params: readonly unknown[]): Promise<T> {
    const id = this.#nextId++;
    const response = await this.#fetch(provider.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...provider.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (response.status === 429) {
      throw new RpcThrottledError(
        provider.name,
        method,
        'HTTP 429',
        retryAfterMs(response.headers.get('retry-after')),
      );
    }

    if (!response.ok) {
      // Some providers send "method not found" with an HTTP error status. That is an answer about the
      // method, not a sick endpoint: counted as a failure it opens the breaker of a provider that
      // serves every other call, and viem probes optional methods such as eth_fillTransaction on
      // every write.
      const unsupported = await methodNotFound(response);
      if (unsupported !== undefined) throw new RpcResponseError(provider.name, method, METHOD_NOT_FOUND, unsupported, undefined);
      throw new BursarError('rpc_http_error', `HTTP ${response.status} from ${provider.name}`, {
        provider: provider.name,
        status: response.status,
      });
    }

    const text = await response.text();
    let body: JsonRpcResponse;
    try {
      body = JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new BursarError('rpc_bad_body', `${provider.name} answered with a body that is not JSON.`, {
        provider: provider.name,
        preview: text.slice(0, 200),
      });
    }

    if (body.error) {
      const code = body.error.code;
      // Naming a code the provider did not send turns a malformed answer into an error nobody
      // retries. A body this broken is a sick endpoint and is reported as one.
      if (typeof code !== 'number') {
        throw new BursarError(
          'rpc_bad_body',
          `${provider.name} answered with a JSON-RPC error carrying no numeric code.`,
          { provider: provider.name, preview: text.slice(0, 200) },
        );
      }
      const message = typeof body.error.message === 'string' ? body.error.message : 'JSON-RPC error';
      if (THROTTLE_RPC_CODES.has(code)) {
        throw new RpcThrottledError(provider.name, method, message);
      }
      throw new RpcResponseError(provider.name, method, code, message, body.error.data);
    }

    if (!('result' in body)) {
      throw new BursarError('rpc_bad_body', `${provider.name} answered without a result.`, {
        provider: provider.name,
      });
    }

    return body.result as T;
  }
}

const METHOD_NOT_FOUND = -32601;

/** The JSON-RPC message of a "method not found" answer sent under an HTTP error status, if that is what it is. */
async function methodNotFound(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as JsonRpcResponse;
    if (body.error?.code !== METHOD_NOT_FOUND) return undefined;
    return typeof body.error.message === 'string' ? body.error.message : 'method not found';
  } catch {
    return undefined;
  }
}

function resolveRetry(options: RpcRetryOptions | undefined): ResolvedRetry {
  const maxPasses = options?.maxPasses ?? DEFAULT_RETRY.maxPasses;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;

  if (!Number.isInteger(maxPasses) || maxPasses < 1) {
    throw new RangeError('retry.maxPasses must be a positive integer');
  }
  if (baseDelayMs < 0 || maxDelayMs < baseDelayMs) {
    throw new RangeError('retry delays must be non-negative and maxDelayMs at least baseDelayMs');
  }

  return {
    maxPasses,
    baseDelayMs,
    maxDelayMs,
    sleep: options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options?.random ?? Math.random,
  };
}

/**
 * How long one Retry-After is allowed to hold a caller. The header is a request, not a contract,
 * and there is another provider in the list; the bucket also climbs back on its own. Taken at face
 * value an hour puts the pacer tens of thousands of tokens in debt and hands the last provider
 * standing a wait longer than any caller will survive. A far-future HTTP-date overflows the timer
 * the pump schedules from it, which Node clamps to a millisecond and spins.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** Retry-After is seconds or an HTTP date. Anything else is ignored. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return clampRetryAfter(seconds * 1000);
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return clampRetryAfter(at - Date.now());
}

function clampRetryAfter(ms: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/** How far down a `cause` chain to look. Undici nests two or three; past that it is a cycle. */
const MAX_CAUSE_DEPTH = 6;

/** How many legs of a multi-address connect failure are named before the rest are counted. */
const MAX_TRANSPORT_REASONS = 3;

/**
 * What went wrong, in terms whoever reads the log can act on.
 *
 * `fetch` rejects with the same `TypeError: fetch failed` for every transport failure there is: a
 * name that does not resolve, a route that goes nowhere, a connection refused, a handshake that
 * never completes. The reason sits one or more levels down in `cause`, and on a dual-stack host
 * it is an `AggregateError` with an empty message of its own carrying one entry per address
 * tried. Keeping only the wrapper is what turned an unroutable IPv6 leg timing out into "an
 * unknown RPC error occurred", with nothing at any depth saying otherwise.
 */
function describe(error: unknown, timeoutMs: number): string {
  if (error instanceof BursarError) return error.message;

  const chain = unwrap(error);
  if (chain.some((entry) => entry.name === 'TimeoutError')) {
    return `request timed out after ${timeoutMs}ms`;
  }

  const underneath = transportDetail(chain);
  if (underneath !== undefined) return underneath;

  const [top] = chain;
  if (top === undefined) return String(error);
  return top.message === '' ? top.name : `${top.name}: ${top.message}`;
}

/**
 * The error and everything under it, outermost first.
 *
 * `AggregateError` holds its members in `errors` rather than in `cause`, which is the shape Node
 * produces when it tries every address a host resolves to and each one fails.
 */
function unwrap(error: unknown, depth = 0): readonly Error[] {
  if (!(error instanceof Error) || depth > MAX_CAUSE_DEPTH) return [];

  const members: unknown[] = error instanceof AggregateError ? [...error.errors] : [];
  if (error.cause !== undefined) members.push(error.cause);

  return [error, ...members.flatMap((inner) => unwrap(inner, depth + 1))];
}

/** Every distinct message below the wrapper, which is where the useful one lives. */
function transportDetail(chain: readonly Error[]): string | undefined {
  const messages: string[] = [];
  for (const entry of chain.slice(1)) {
    const text = entry.message.trim();
    if (text !== '' && !messages.includes(text)) messages.push(text);
  }

  if (messages.length === 0) return undefined;

  const shown = messages.slice(0, MAX_TRANSPORT_REASONS);
  const rest = messages.length - shown.length;
  // Comma-joined so these stay readable inside a reason that is itself joined with semicolons.
  return rest > 0 ? `${shown.join(', ')}, and ${rest} more` : shown.join(', ');
}

/** One decimal place, so a cooldown of a few seconds does not report as "in 0s". */
function seconds(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

/** Endpoint URLs routinely carry an API key in the path, so only the origin is safe to surface. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' ? parsed.origin : `${parsed.origin}/…`;
  } catch {
    return '<malformed url>';
  }
}
