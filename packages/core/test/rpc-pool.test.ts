import { describe, expect, it, vi } from 'vitest';
import {
  AllProvidersCoolingError,
  AllProvidersDownError,
  RpcPool,
  RpcResponseError,
  RpcWrongChainError,
  redactUrl,
} from '../src/rpc/pool.js';
import type { RpcPoolEvent } from '../src/rpc/pool.js';
import type { Scheduler } from '../src/rpc/limiter.js';

const PRIMARY = 'https://metered.example/v1/key';
const FALLBACK = 'https://backup.example';

type Answer = { status?: number; body?: unknown; text?: string; throws?: Error };

function fetcher(answers: Record<string, Answer | (() => Answer)>) {
  const seen: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const entry = answers[url];
    if (!entry) throw new Error(`no stub for ${url}`);
    const answer = typeof entry === 'function' ? entry() : entry;
    if (answer.throws) throw answer.throws;
    const text = answer.text ?? JSON.stringify(answer.body ?? { jsonrpc: '2.0', id: 1, result: '0x1' });
    return new Response(text, { status: answer.status ?? 200 });
  });
  return { fn: fn as unknown as typeof fetch, seen };
}

/** Retries are exercised everywhere, so no test is allowed to spend real time on a backoff. */
const instantRetry = { sleep: async () => {}, random: () => 0.5 } as const;

function pool(fetchFn: typeof fetch, onEvent?: (e: RpcPoolEvent) => void) {
  return new RpcPool({
    providers: [
      { name: 'primary', url: PRIMARY },
      { name: 'fallback', url: FALLBACK },
    ],
    fetchFn,
    breaker: { failureThreshold: 2, openMs: 30_000, now: () => 0 },
    retry: { maxPasses: 1, ...instantRetry },
    pacing: { spilloverMs: 5 },
    ...(onEvent ? { onEvent } : {}),
  });
}

describe('RpcPool', () => {
  it('serves from the first provider and never touches the second', async () => {
    const { fn, seen } = fetcher({ [PRIMARY]: { body: { jsonrpc: '2.0', id: 1, result: '0x4cef92' } } });
    await expect(pool(fn).request<string>('eth_blockNumber')).resolves.toBe('0x4cef92');
    expect(seen).toEqual([PRIMARY]);
  });

  it('reads method not found under an HTTP 400 as an answer, and keeps the breaker shut', async () => {
    // dRPC answers eth_fillTransaction, which viem probes before every write, with HTTP 400 and
    // -32601. Counted as failures, those probes opened the breaker on an endpoint that served every
    // other call, and a payment that had landed came back as a failure.
    const { fn, seen } = fetcher({
      [PRIMARY]: { status: 400, body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method is not available' } } },
    });
    const p = pool(fn);
    for (let i = 0; i < 3; i += 1) {
      await expect(p.request('eth_fillTransaction', [{}])).rejects.toBeInstanceOf(RpcResponseError);
    }
    expect(seen).toEqual([PRIMARY, PRIMARY, PRIMARY]);
    expect(p.status()[0]).toMatchObject({ name: 'primary', state: 'closed', consecutiveFailures: 0 });
  });

  it('falls through to the fallback on a 429, slows the primary and leaves its breaker alone', async () => {
    const events: RpcPoolEvent[] = [];
    const { fn, seen } = fetcher({
      [PRIMARY]: { status: 429, text: 'rate limited' },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = pool(fn, (e) => events.push(e));

    await expect(p.request('eth_chainId')).resolves.toBe('0x1');
    expect(seen).toEqual([PRIMARY, FALLBACK]);
    expect(events).toContainEqual({
      type: 'rate_limited',
      provider: 'primary',
      method: 'eth_chainId',
      ratePerSecond: 5,
    });
    expect(events).toContainEqual({
      type: 'fallback_used',
      provider: 'fallback',
      method: 'eth_chainId',
      skipped: ['primary'],
    });

    // Being told to slow down is not a strike. The endpoint answered; the pool sent too fast.
    expect(p.status()[0]).toMatchObject({ state: 'closed', failures: 0, throttled: 1 });
  });

  it('stops sending to a throttled endpoint rather than collecting more 429s from it', async () => {
    const { fn, seen } = fetcher({
      [PRIMARY]: { status: 429, text: 'rate limited' },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = pool(fn);

    for (let i = 0; i < 5; i += 1) await expect(p.request('eth_chainId')).resolves.toBe('0x1');

    // One 429 is enough: the pacer owes the primary a token it will not have for 200 ms, and
    // a caller with a healthy fallback in the list does not sit and wait for it.
    expect(seen.filter((url) => url === PRIMARY)).toHaveLength(1);
    expect(p.status()[0]).toMatchObject({ state: 'closed', failures: 0, throttled: 1 });
  });

  it('stops asking a dead provider once its breaker opens', async () => {
    const { fn, seen } = fetcher({
      [PRIMARY]: { status: 500 },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = pool(fn);

    await p.request('eth_chainId');
    await p.request('eth_chainId');
    seen.length = 0;

    await p.request('eth_chainId');
    expect(seen).toEqual([FALLBACK]);
    expect(p.status()[0]).toMatchObject({ name: 'primary', state: 'open', failures: 2 });
  });

  it('probes a recovered provider once the cooldown elapses', async () => {
    let healthy = false;
    let now = 0;
    const { fn, seen } = fetcher({
      [PRIMARY]: () => (healthy ? { body: { jsonrpc: '2.0', id: 1, result: '0xok' } } : { status: 503 }),
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0xfallback' } },
    });
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK },
      ],
      fetchFn: fn,
      breaker: { failureThreshold: 1, openMs: 10_000, now: () => now },
      retry: { maxPasses: 1, ...instantRetry },
    });

    await expect(p.request('eth_chainId')).resolves.toBe('0xfallback');
    seen.length = 0;

    await expect(p.request('eth_chainId')).resolves.toBe('0xfallback');
    expect(seen).toEqual([FALLBACK]);

    now = 10_000;
    healthy = true;
    await expect(p.request('eth_chainId')).resolves.toBe('0xok');
    expect(p.status()[0]).toMatchObject({ name: 'primary', state: 'closed' });
  });

  it('throws rather than degrading to whatever answers when every provider is down', async () => {
    const events: RpcPoolEvent[] = [];
    const { fn } = fetcher({
      [PRIMARY]: { throws: new TypeError('fetch failed') },
      [FALLBACK]: { status: 502 },
    });

    const error = await pool(fn, (e) => events.push(e))
      .request('eth_call')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllProvidersDownError);
    expect((error as AllProvidersDownError).attempts).toEqual([
      { provider: 'primary', reason: 'TypeError: fetch failed' },
      { provider: 'fallback', reason: 'HTTP 502 from fallback' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'all_providers_down', method: 'eth_call' });
  });

  it('a revert is an answer, so it returns straight away and leaves the breaker closed', async () => {
    const { fn, seen } = fetcher({
      [PRIMARY]: {
        body: { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0xdead' } },
      },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = pool(fn);

    const error = await p.request('eth_call').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcResponseError);
    expect((error as RpcResponseError).rpcCode).toBe(3);
    expect(seen).toEqual([PRIMARY]);
    expect(p.status()[0]).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('reads a limit-exceeded code as a rate limit, whatever HTTP status carried it', async () => {
    // Some providers pair HTTP 429 with this body. Others send it with a 200, which is why the
    // code is recognised as well as the status.
    const { fn, seen } = fetcher({
      [PRIMARY]: { body: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit exceeded' } } },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = pool(fn);

    await expect(p.request('eth_getLogs')).resolves.toBe('0x1');
    expect(seen).toEqual([PRIMARY, FALLBACK]);
    expect(p.status()[0]).toMatchObject({ failures: 0, throttled: 1 });
    // Halved from the pace an unmeasured endpoint is given once it answers 429, and climbing back.
    expect(p.status()[0]?.effectiveRatePerSecond).toBeCloseTo(5, 1);
  });

  it('rejects a body that is not JSON-RPC rather than passing undefined upward', async () => {
    const { fn } = fetcher({
      [PRIMARY]: { text: '<html>challenge</html>' },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1 } },
    });
    const error = await pool(fn)
      .request('eth_chainId')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllProvidersDownError);
    expect((error as AllProvidersDownError).attempts.map((a) => a.reason)).toEqual([
      'primary answered with a body that is not JSON.',
      'fallback answered without a result.',
    ]);
  });

  it('reports health and hides the API key in the endpoint', async () => {
    const { fn } = fetcher({ [PRIMARY]: { status: 500 }, [FALLBACK]: { status: 500 } });
    const p = pool(fn);
    expect(p.healthy()).toBe(true);

    await p.request('eth_chainId').catch(() => undefined);
    await p.request('eth_chainId').catch(() => undefined);
    expect(p.healthy()).toBe(false);
    expect(p.status().map((s) => s.url)).toEqual(['https://metered.example/…', 'https://backup.example']);

    p.reset();
    expect(p.healthy()).toBe(true);
  });

  it('survives a transient failure: the fallback drops one socket while the primary is fenced off', async () => {
    // Reproduces the live-run failure on eth_getTransactionCount: "primary: circuit open;
    // fallback: TypeError: fetch failed". Both endpoints were healthy again milliseconds later.
    let primed = false;
    let dropped = false;
    const { fn, seen } = fetcher({
      [PRIMARY]: { status: 503 },
      [FALLBACK]: () => {
        if (primed && !dropped) {
          dropped = true;
          return { throws: new TypeError('fetch failed') };
        }
        return { body: { jsonrpc: '2.0', id: 1, result: '0x2a' } };
      },
    });

    const events: RpcPoolEvent[] = [];
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK },
      ],
      fetchFn: fn,
      breaker: { failureThreshold: 2, openMs: 30_000, now: () => 0 },
      retry: instantRetry,
      onEvent: (e) => events.push(e),
    });

    await p.request('eth_chainId'); // two failures put the primary's breaker out of reach
    await p.request('eth_chainId');
    expect(p.status()[0]).toMatchObject({ name: 'primary', state: 'open' });

    primed = true;
    seen.length = 0;
    events.length = 0;

    await expect(p.request<string>('eth_getTransactionCount')).resolves.toBe('0x2a');
    expect(seen).toEqual([FALLBACK, FALLBACK]);
    expect(events).toContainEqual({
      type: 'request_failed',
      provider: 'fallback',
      method: 'eth_getTransactionCount',
      reason: 'TypeError: fetch failed',
    });
    expect(events).toContainEqual({
      type: 'retry_scheduled',
      method: 'eth_getTransactionCount',
      pass: 2,
      delayMs: 90,
    });
  });

  it('retries by default, and stops once the pass limit is spent', async () => {
    const { fn, seen } = fetcher({
      [PRIMARY]: { throws: new TypeError('fetch failed') },
      [FALLBACK]: { throws: new TypeError('fetch failed') },
    });
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK },
      ],
      fetchFn: fn,
      breaker: { failureThreshold: 10, now: () => 0 },
      retry: instantRetry,
    });

    await expect(p.request('eth_chainId')).rejects.toBeInstanceOf(AllProvidersDownError);
    expect(seen).toEqual([PRIMARY, FALLBACK, PRIMARY, FALLBACK]);
  });

  it('never retries a revert, on this provider or the next one', async () => {
    const { fn, seen } = fetcher({
      [PRIMARY]: {
        body: {
          jsonrpc: '2.0',
          id: 1,
          error: { code: 3, message: 'execution reverted', data: '0xcc70389d' },
        },
      },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK },
      ],
      fetchFn: fn,
      breaker: { failureThreshold: 1, now: () => 0 },
      retry: { maxPasses: 5, ...instantRetry },
    });

    const error = await p.request('eth_call').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcResponseError);
    expect((error as RpcResponseError).data).toBe('0xcc70389d');
    expect(seen).toEqual([PRIMARY]);
    expect(p.status()[0]).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('holds a provider that meters in flight to its concurrency ceiling', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const fn = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    }) as unknown as typeof fetch;

    const p = new RpcPool({
      providers: [{ name: 'primary', url: PRIMARY, maxConcurrent: 20 }],
      fetchFn: fn,
      retry: instantRetry,
    });

    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const calls = Promise.all(Array.from({ length: 30 }, () => p.request('eth_call')));
    await flush();

    expect(peak).toBe(20);
    expect(p.status()[0]).toMatchObject({ inFlight: 20, queued: 10, maxConcurrent: 20 });

    // Each release frees a slot, which admits a queued call and registers its own release.
    while (release.length > 0) {
      release.shift()?.();
      await flush();
    }

    await expect(calls).resolves.toHaveLength(30);
    expect(peak).toBe(20);
  });

  it('paces the endpoints it has measured, and caps nothing in flight', () => {
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: 'https://rpc.mainnet.chain.robinhood.com' },
        { name: 'fallback', url: 'https://robinhood.drpc.org' },
        { name: 'local', url: 'http://127.0.0.1:8545' },
      ],
    });

    // A local node or a fork is nobody's metered endpoint, so it runs unpaced until it says
    // otherwise with a 429.
    expect(p.status().map((s) => s.ratePerSecond)).toEqual([40, 100, null]);
    expect(p.status().map((s) => s.maxConcurrent)).toEqual([null, null, null]);
  });

  it('paces a burst against one endpoint rather than handing it 429s', async () => {
    const sentAt: number[] = [];
    const fn = (async () => {
      sentAt.push(Date.now());
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    }) as unknown as typeof fetch;

    const p = new RpcPool({
      providers: [{ name: 'primary', url: PRIMARY, maxRatePerSecond: 50, burst: 5 }],
      fetchFn: fn,
      retry: instantRetry,
    });

    const started = Date.now();
    await expect(Promise.all(Array.from({ length: 15 }, () => p.request('eth_call')))).resolves.toHaveLength(15);

    // The burst leaves at once and the other ten go out at fifty a second: two hundred
    // milliseconds of queueing in place of ten 429s.
    expect(sentAt.filter((at) => at - started < 20).length).toBeLessThanOrEqual(6);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it('waits on the last endpoint standing instead of refusing the call', async () => {
    const answers: number[] = [];
    const fn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === PRIMARY) throw new TypeError('fetch failed');
      answers.push(Date.now());
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    }) as unknown as typeof fetch;

    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK, maxRatePerSecond: 100, burst: 2 },
      ],
      fetchFn: fn,
      breaker: { failureThreshold: 1, openMs: 60_000 },
      retry: instantRetry,
      pacing: { spilloverMs: 5 },
    });

    // The primary is dead and the fallback is metered, which is the shape that failed the live
    // run: forty reads fanned out, one endpoint left, and the call dropped.
    const calls = await Promise.all(Array.from({ length: 12 }, () => p.request('eth_call')));

    expect(calls).toHaveLength(12);
    expect(answers).toHaveLength(12);
    expect(p.status()[1]).toMatchObject({ state: 'closed', throttled: 0 });
  });

  it('refuses to read from a provider serving another chain, and does not try the next one', async () => {
    const { fn, seen } = fetcher({
      [PRIMARY]: { body: { jsonrpc: '2.0', id: 1, result: '0xb626' } },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK },
      ],
      chainId: 4663,
      fetchFn: fn,
      retry: { maxPasses: 3, ...instantRetry },
    });

    const error = await p.request('eth_getBalance').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RpcWrongChainError);
    expect(error).toMatchObject({ expected: 4663, actual: 46630 });
    // One eth_chainId and nothing else. A read that reached the fallback would have been answered
    // with another chain's state, which is worse than no answer.
    expect(seen).toEqual([PRIMARY]);
    expect(p.status()[0]).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('asks each provider for its chain once, then stays out of the way', async () => {
    const bodies: unknown[] = [];
    const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      bodies.push(body);
      const method = (body as { method: string }).method;
      const result = method === 'eth_chainId' ? '0x1237' : '0x2a';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    }) as unknown as typeof fetch;

    const p = new RpcPool({
      providers: [{ name: 'primary', url: PRIMARY }],
      chainId: 4663,
      fetchFn: fn,
      retry: instantRetry,
    });

    await expect(p.request('eth_blockNumber')).resolves.toBe('0x2a');
    await expect(p.request('eth_blockNumber')).resolves.toBe('0x2a');

    expect(bodies.map((b) => (b as { method: string }).method)).toEqual([
      'eth_chainId',
      'eth_blockNumber',
      'eth_blockNumber',
    ]);
  });

  it('asks the wrong-chain question again when it could not be answered', async () => {
    let reachable = false;
    const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (!reachable) throw new TypeError('fetch failed');
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'eth_chainId' ? '0x1237' : '0x2a' }),
      );
    }) as unknown as typeof fetch;

    const p = new RpcPool({
      providers: [{ name: 'primary', url: PRIMARY }],
      chainId: 4663,
      fetchFn: fn,
      breaker: { failureThreshold: 10, now: () => 0 },
      retry: { maxPasses: 1, ...instantRetry },
    });

    await expect(p.request('eth_blockNumber')).rejects.toBeInstanceOf(AllProvidersDownError);

    reachable = true;
    await expect(p.request('eth_blockNumber')).resolves.toBe('0x2a');
  });

  it('asks the next provider about an internal error instead of handing it to the caller', async () => {
    const { fn, seen } = fetcher({
      [PRIMARY]: {
        body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal error' } },
      },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = pool(fn);

    await expect(p.request('eth_call')).resolves.toBe('0x1');
    expect(seen).toEqual([PRIMARY, FALLBACK]);
    expect(p.status()[0]).toMatchObject({ failures: 1, throttled: 0 });
  });

  it('treats an error with no numeric code as a broken endpoint rather than inventing one', async () => {
    const { fn, seen } = fetcher({
      [PRIMARY]: { body: { jsonrpc: '2.0', id: 1, error: { message: 'upstream unavailable' } } },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = pool(fn);

    await expect(p.request('eth_call')).resolves.toBe('0x1');
    expect(seen).toEqual([PRIMARY, FALLBACK]);
    expect(p.status()[0]).toMatchObject({ failures: 1 });
  });

  it('a revert does not wipe the failures of the provider that answered it', async () => {
    let revert = false;
    const { fn } = fetcher({
      [PRIMARY]: () =>
        revert
          ? { body: { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } } }
          : { throws: new TypeError('fetch failed') },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK },
      ],
      fetchFn: fn,
      breaker: { failureThreshold: 3, openMs: 30_000, now: () => 0 },
      retry: { maxPasses: 1, ...instantRetry },
    });

    await p.request('eth_call');
    await p.request('eth_call');
    expect(p.status()[0]).toMatchObject({ state: 'closed', consecutiveFailures: 2 });

    revert = true;
    await expect(p.request('eth_call')).rejects.toBeInstanceOf(RpcResponseError);
    expect(p.status()[0]).toMatchObject({ state: 'closed', consecutiveFailures: 2 });

    // The third network failure is the one that opens it. A revert in between is the contract
    // talking, not the endpoint, so it neither strikes the provider nor forgives it.
    revert = false;
    await p.request('eth_call');
    expect(p.status()[0]).toMatchObject({ state: 'open', consecutiveFailures: 3 });
  });

  // An hour in seconds, and a date far enough out that the delay computed from it overflows the
  // timer Node is asked to set, which it silently turns into one millisecond of busy loop.
  it.each(['3600', 'Fri, 31 Dec 2100 23:59:59 GMT'])(
    'clamps Retry-After: %s so one header cannot park the last provider standing',
    async (header) => {
      const scheduled: number[] = [];
      const schedule: Scheduler = (_fn, ms) => {
        scheduled.push(ms);
        return () => {};
      };
      const fn = (async () =>
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': header },
        })) as unknown as typeof fetch;

      const p = new RpcPool({
        providers: [{ name: 'primary', url: PRIMARY, maxRatePerSecond: 15, burst: 10 }],
        fetchFn: fn,
        retry: { maxPasses: 2, ...instantRetry },
        pacing: { now: () => 0, schedule },
      });

      // Nothing ever fires the scheduler, so the retry pass queues behind the debt and stays there.
      // What is being measured is how long it was told to wait.
      void p.request('eth_call').catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(scheduled.length).toBeGreaterThan(0);
      expect(Math.max(...scheduled)).toBeLessThanOrEqual(61_000);
    },
  );

  it('refuses a configuration that cannot report a degrade', () => {
    expect(() => new RpcPool({ providers: [] })).toThrow(/at least one provider/);
    expect(
      () =>
        new RpcPool({
          providers: [
            { name: 'primary', url: PRIMARY },
            { name: 'primary', url: FALLBACK },
          ],
        }),
    ).toThrow(/unique/);
  });
});

it('redactUrl keeps the origin and drops a path that may hold a key', () => {
  expect(redactUrl('https://rpc.example/v2/secret-key')).toBe('https://rpc.example/…');
  expect(redactUrl('https://rpc.example/')).toBe('https://rpc.example');
  expect(redactUrl('not a url')).toBe('<malformed url>');
});

/**
 * What a connect-level failure tells whoever has to fix it.
 *
 * `fetch` rejects with one `TypeError: fetch failed` for a name that does not resolve, a route
 * that goes nowhere and a connection refused alike. Keeping only that wrapper is how an
 * unroutable IPv6 leg timing out reached a developer as "an unknown RPC error occurred", with
 * nothing at any `cause` depth saying otherwise; finding it took a patched global `fetch`.
 */
describe('the reason a call failed', () => {
  /** What Node raises when a host resolves to several addresses and every one of them fails. */
  function dualStackRefusal(): TypeError {
    const legs = [
      Object.assign(new Error('connect ECONNREFUSED ::1:8600'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8600'), { code: 'ECONNREFUSED' }),
    ];
    // The aggregate carries no message of its own, which is what made it disappear.
    const aggregate = Object.assign(new AggregateError(legs, ''), { code: 'ECONNREFUSED' });
    return Object.assign(new TypeError('fetch failed'), { cause: aggregate });
  }

  it('names every address a dual-stack connect tried, through an AggregateError with no message', async () => {
    const { fn } = fetcher({
      [PRIMARY]: { throws: dualStackRefusal() },
      [FALLBACK]: { throws: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND backup.example'), { code: 'ENOTFOUND' }),
      }) },
    });

    const error = await pool(fn).request('eth_getCode').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllProvidersDownError);
    expect((error as AllProvidersDownError).attempts.map((a) => a.reason)).toEqual([
      'connect ECONNREFUSED ::1:8600, connect ECONNREFUSED 127.0.0.1:8600',
      'getaddrinfo ENOTFOUND backup.example',
    ]);
    expect((error as Error).message).toContain('connect ECONNREFUSED ::1:8600');
  });

  it('keeps the failure itself reachable, so a caller can read more than the sentence', async () => {
    const thrown = dualStackRefusal();
    const { fn } = fetcher({ [PRIMARY]: { throws: thrown }, [FALLBACK]: { throws: thrown } });

    const error = await pool(fn).request('eth_getCode').catch((e: unknown) => e);

    expect((error as Error).cause).toBe(thrown);
  });

  it('says how long it waited when the wait is what ran out', async () => {
    const { fn } = fetcher({
      [PRIMARY]: { throws: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x1' } },
    });
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK },
      ],
      fetchFn: fn,
      timeoutMs: 700,
      breaker: { now: () => 0 },
      retry: instantRetry,
    });

    await expect(p.request('eth_chainId')).resolves.toBe('0x1');
    expect(p.status()[0]?.lastFailure).toBe('request timed out after 700ms');
  });
});

/**
 * A cooldown this client is holding, told apart from a network that is not answering.
 *
 * Both used to arrive as the same `AllProvidersDownError`, and the per-provider line read
 * "circuit open" with nothing to say whose state that was or how long it lasts. Read as a fault
 * at the far end it is a dead deployment; it is fifteen seconds, opened here, and it lifts by
 * itself.
 */
describe('when no request is sent at all', () => {
  function coolingPool(now: () => number, onEvent?: (e: RpcPoolEvent) => void) {
    const { fn, seen } = fetcher({ [PRIMARY]: { status: 500 }, [FALLBACK]: { status: 500 } });
    const p = new RpcPool({
      providers: [
        { name: 'primary', url: PRIMARY },
        { name: 'fallback', url: FALLBACK },
      ],
      fetchFn: fn,
      breaker: { failureThreshold: 1, openMs: 15_000, now },
      retry: { maxPasses: 1, ...instantRetry },
      ...(onEvent === undefined ? {} : { onEvent }),
    });
    return { pool: p, seen };
  }

  it('is a different failure from every provider being tried and failing', async () => {
    let now = 0;
    const { pool: p } = coolingPool(() => now);

    const tried = await p.request('eth_chainId').catch((e: unknown) => e);
    expect((tried as { code?: string }).code).toBe('rpc_all_providers_down');

    now = 1_000;
    const cooling = await p.request('eth_chainId').catch((e: unknown) => e);
    expect((cooling as { code?: string }).code).toBe('rpc_all_providers_cooling');
    expect(cooling).toBeInstanceOf(AllProvidersCoolingError);
  });

  it('sends nothing while it holds, so the endpoints are not the thing to look at', async () => {
    let now = 0;
    const { pool: p, seen } = coolingPool(() => now);

    await p.request('eth_chainId').catch(() => undefined);
    seen.length = 0;

    now = 1_000;
    await p.request('eth_chainId').catch(() => undefined);
    expect(seen).toEqual([]);
  });

  it('says whose state it is, which provider, and when it is next probed', async () => {
    let now = 0;
    const { pool: p } = coolingPool(() => now);
    await p.request('eth_chainId').catch(() => undefined);

    now = 2_500;
    const error = await p.request('eth_chainId').catch((e: unknown) => e);
    const message = (error as Error).message;

    expect(message).toContain('this client');
    expect(message).toContain('primary');
    expect(message).toContain('fallback');
    expect(message).toContain('in 12.5s');
    expect(message).toContain('HTTP 500 from primary');
    expect(message).not.toContain('circuit open');
  });

  it('reports the moment the cooldown lifts on the health snapshot too', async () => {
    let now = 0;
    const { pool: p } = coolingPool(() => now);
    await p.request('eth_chainId').catch(() => undefined);

    expect(p.status()[0]).toMatchObject({ state: 'open', openedAt: 0, nextProbeAt: 15_000 });

    now = 15_000;
    expect(p.status()[0]).toMatchObject({ state: 'half-open', nextProbeAt: 15_000 });
    p.reset();
    expect(p.status()[0]).toMatchObject({ state: 'closed', nextProbeAt: null });
  });

  it('goes back to the ordinary failure once the probe is admitted and fails', async () => {
    let now = 0;
    const { pool: p } = coolingPool(() => now);
    await p.request('eth_chainId').catch(() => undefined);

    now = 15_000;
    const error = await p.request('eth_chainId').catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('rpc_all_providers_down');
  });
});

describe('an event observer that throws', () => {
  it('cannot turn an answered request into a failure', async () => {
    const { fn } = fetcher({
      [PRIMARY]: { status: 429, text: 'rate limited' },
      [FALLBACK]: { body: { jsonrpc: '2.0', id: 1, result: '0x4cef92' } },
    });
    const throwing = () => {
      throw new Error('logger exploded');
    };
    // The fallback answers, and emitting fallback_used on the success path must not undo that.
    await expect(pool(fn, throwing).request<string>('eth_blockNumber')).resolves.toBe('0x4cef92');
  });
});
