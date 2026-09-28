import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { indexedTransactions, resetIndexBackoff } from '@/app/(app)/console/lib/explorer';
import type { IndexFailure } from '@/app/(app)/console/lib/explorer';
import { INDEX_ROUTE } from '@/app/(app)/console/lib/index-wire';

/**
 * Six ways to have no settlement history, told apart, now that the index sits behind a key.
 *
 * The reads used to leave the browser for a public explorer. Robinhood Chain's index is paid, so
 * they go to this app instead and the key stays on the server. Everything that made the old
 * reading useful has to survive that move: a rate limit, a refusal, a response the browser
 * blocked and a network that is not there are four different problems with four different owners,
 * and none of them may share a sentence. One is new. An index that charges for the answer and a
 * deployment that has no key is not an outage at all, and a reader who is told to wait will wait
 * forever while the person who can fix it is never told.
 */
const MANDATE = '0x1111111111111111111111111111111111111111' as Address;

type FetchArgs = Parameters<typeof fetch>;

const realFetch = globalThis.fetch;

let asked: string[] = [];

function answering(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
  globalThis.fetch = ((input: FetchArgs[0], init?: FetchArgs[1]) => {
    asked.push(String(input));
    return handler(String(input), init as RequestInit | undefined);
  }) as typeof fetch;
}

/**
 * The route answers for the index, so it also reports what the index did. A real browser gets this
 * as an ordinary JSON body with an ordinary status.
 */
function route(status: number, failure: IndexFailure, upstreamStatus = status, headers: Record<string, string> = {}): void {
  answering(
    async () =>
      new Response(JSON.stringify({ failure, host: 'api.blockscout.com', status: upstreamStatus }), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  );
}

/** Something answered for this app's own origin and the browser would not hand it over. */
function corsBlocked(): void {
  answering(async (_url, init) => {
    if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
    throw new TypeError('Failed to fetch');
  });
}

/** Nothing is there, so the probe fails the same way the read did. */
function nothingThere(): void {
  answering(async () => {
    throw new TypeError('Failed to fetch');
  });
}

async function failureOf(): Promise<{ failure: IndexFailure; message: string }> {
  try {
    await indexedTransactions(MANDATE);
  } catch (error) {
    const shaped = error as { failure: IndexFailure; message: string };
    return { failure: shaped.failure, message: shaped.message };
  }

  throw new Error('the read was expected to fail');
}

beforeEach(() => {
  asked = [];
  resetIndexBackoff();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetIndexBackoff();
});

describe('the browser reads the index through this app', () => {
  it('asks its own origin and never the index host', async () => {
    route(429, 'rate-limited');
    await failureOf();

    expect(asked).toHaveLength(1);
    expect(asked[0]?.startsWith(`${INDEX_ROUTE}?`)).toBe(true);
    expect(asked[0]).not.toContain('blockscout');
    expect(asked[0]).not.toContain('apikey');
  });

  it('carries no credential of its own, because it holds none', async () => {
    let sent: RequestInit | undefined;
    answering(async (_url, init) => {
      sent = init;
      return new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await indexedTransactions(MANDATE);

    const headers = Object.keys((sent?.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
    expect(headers).toEqual(['accept']);
  });
});

describe('an index that charges for the answer', () => {
  it('is its own failure, and not an outage', async () => {
    route(402, 'unkeyed');
    const { failure, message } = await failureOf();

    expect(failure).toBe('unkeyed');
    expect(message).toContain('402');
    expect(message).not.toContain('429');
    expect(message).not.toContain('cross-origin');
    expect(message).not.toContain('Nothing answered at');
  });

  it('names the variable the operator sets, and says it stays off the browser', async () => {
    route(402, 'unkeyed');
    const { message } = await failureOf();

    expect(message).toContain('BLOCKSCOUT_API_KEY');
    expect(message).toContain('never reaches a browser');
  });

  it('tells the reader the money is still readable', async () => {
    route(402, 'unkeyed');
    const { message } = await failureOf();

    expect(message).toContain('read from the contracts and are unaffected');
  });

  it('separates a key that is missing from a key that was rejected', async () => {
    route(402, 'unkeyed');
    const missing = await failureOf();

    resetIndexBackoff();
    route(401, 'unkeyed');
    const rejected = await failureOf();

    expect(rejected.failure).toBe('unkeyed');
    expect(rejected.message).toContain('401');
    expect(rejected.message).toContain('did not accept');
    expect(rejected.message).not.toBe(missing.message);
  });

  it('keeps saying so while the pause from it is running', async () => {
    route(402, 'unkeyed');
    await failureOf();

    const waiting = await failureOf();
    expect(waiting.failure).toBe('unkeyed');
    expect(waiting.message).toContain('BLOCKSCOUT_API_KEY');
    expect(waiting.message).toMatch(/Nothing is asked of it for another \d+s/);
  });
});

describe('a response this browser blocked', () => {
  it('is not reported as the index refusing anything', async () => {
    corsBlocked();
    const { failure, message } = await failureOf();

    expect(failure).toBe('blocked');
    expect(message).toContain('cross-origin permission');
    expect(message).not.toContain('429');
    expect(message).not.toContain('402');
  });

  it('says the wait will not help, and where the history is read from', async () => {
    corsBlocked();
    const { message } = await failureOf();

    expect(message).toContain('waiting changes nothing');
    expect(message).toContain(INDEX_ROUTE);
  });
});

describe('the index metering this deployment', () => {
  it('names the rate limit, and nothing else', async () => {
    route(429, 'rate-limited');
    const { failure, message } = await failureOf();

    expect(failure).toBe('rate-limited');
    expect(message).toContain('429');
    expect(message).toContain('api.blockscout.com');
    expect(message).not.toContain('cross-origin');
    expect(message).not.toContain('BLOCKSCOUT_API_KEY');
  });

  it('waits as long as the index asked for', async () => {
    route(429, 'rate-limited', 429, { 'retry-after': '30' });
    await failureOf();

    const waiting = await failureOf();
    expect(waiting.failure).toBe('rate-limited');
    expect(waiting.message).toMatch(/another (2[0-9]|30)s/);
  });
});

describe('an index refusing for a reason of its own', () => {
  it('is its own failure, with the status it answered', async () => {
    route(403, 'refused');
    const { failure, message } = await failureOf();

    expect(failure).toBe('refused');
    expect(message).toContain('403');
    expect(message).not.toContain('BLOCKSCOUT_API_KEY.');
  });
});

describe('nothing answering at all', () => {
  it('sends the reader to the network and the host, not to a rate meter', async () => {
    nothingThere();
    const { failure, message } = await failureOf();

    expect(failure).toBe('unreachable');
    expect(message).toContain('Nothing answered at');
    expect(message).toContain('Check the network this browser is on');
    expect(message).not.toContain('429');
    expect(message).not.toContain('cross-origin');
  });
});

describe('the six together', () => {
  it('never reuse a sentence', async () => {
    const said: string[] = [];

    for (const arrange of [
      corsBlocked,
      nothingThere,
      () => route(429, 'rate-limited'),
      () => route(403, 'refused'),
      () => route(402, 'unkeyed'),
      () => route(504, 'timed-out'),
    ]) {
      resetIndexBackoff();
      arrange();
      said.push((await failureOf()).message);
    }

    expect(new Set(said).size).toBe(6);
  });
});
