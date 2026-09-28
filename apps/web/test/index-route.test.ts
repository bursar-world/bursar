import { INDEX_ENV } from '@bursar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from '@/app/api/index/route';
import { cursorQuery, upstreamPath } from '@/app/api/index/upstream';
import { CHAIN_ID, RHC } from '@/chain/rhc';

/**
 * The half of the index read that holds the key.
 *
 * Robinhood Chain's index is paid. The browser cannot hold the key, so this route does, and that
 * makes it the one place in this app where a secret and a request off the public internet meet.
 * Four things have to hold: the key travels in a header and never in a URL, the route makes only
 * the requests this product needs, a deployment with no key says so plainly instead of spending a
 * request to be told 402, and the explorer host is never fetched whatever the configuration says.
 */
const MANDATE = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;
const KEY = 'test-key-not-a-real-one';

type Call = { readonly url: string; readonly init: RequestInit | undefined };

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function upstreamAnswering(handler: () => Promise<Response>): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), init: init as RequestInit | undefined });
    return handler();
  }) as typeof fetch;
}

function ask(query: string): Promise<Response> {
  return GET(new Request(`https://bursar.example/api/index?${query}`));
}

function answered(status: number, body = '{}', headers: Record<string, string> = {}): void {
  upstreamAnswering(async () => new Response(body, { status, headers }));
}

beforeEach(() => {
  calls = [];
  process.env[INDEX_ENV.apiKey] = KEY;
  delete process.env[INDEX_ENV.apiBase];
  answered(200, '{"items":[]}', { 'content-type': 'application/json' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[INDEX_ENV.apiKey];
  delete process.env[INDEX_ENV.apiBase];
});

describe('a deployment with no index key', () => {
  it('answers 402 and says so, rather than spending a request to be told', async () => {
    delete process.env[INDEX_ENV.apiKey];

    const answer = await ask(`resource=logs&address=${MANDATE}`);
    const body = (await answer.json()) as { failure: string; host: string; status: number };

    expect(answer.status).toBe(402);
    expect(body.failure).toBe('unkeyed');
    expect(body.status).toBe(402);
    expect(calls).toHaveLength(0);
  });

  it('names the index host, so the browser can say which one is charging', async () => {
    delete process.env[INDEX_ENV.apiKey];

    const body = (await (await ask(`resource=logs&address=${MANDATE}`)).json()) as { host: string };
    expect(body.host).toBe('api.blockscout.com');
  });
});

describe('the key reaches the index and nothing else', () => {
  it('travels as a header, never in the URL', async () => {
    await ask(`resource=logs&address=${MANDATE}`);

    const [call] = calls;
    expect(call?.url).not.toContain(KEY);
    expect(call?.url).not.toContain('apikey');
    expect((call?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('is never in what the browser gets back', async () => {
    const answer = await ask(`resource=logs&address=${MANDATE}`);
    const text = await answer.text();

    expect(text).not.toContain(KEY);
    for (const [, value] of answer.headers) expect(value).not.toContain(KEY);
  });

  it('goes to the machine index for this chain', async () => {
    await ask(`resource=logs&address=${MANDATE}`);
    expect(calls[0]?.url).toBe(`https://api.blockscout.com/${CHAIN_ID}/api/v2/addresses/${MANDATE}/logs`);
  });
});

/**
 * The explorer readers click through to answers a challenge that expects a person, so a request
 * from a server gets an HTML page. Parsed as history that is a timeline of nothing, and it looks
 * exactly like an index that has gone quiet.
 */
describe('the explorer a reader clicks is never fetched', () => {
  it('is refused as an index host, and no request is made to it', async () => {
    process.env[INDEX_ENV.apiBase] = RHC.explorer;

    const answer = await ask(`resource=logs&address=${MANDATE}`);
    const body = (await answer.json()) as { failure: string; status: number };

    expect(calls).toHaveLength(0);
    expect(body.failure).toBe('unkeyed');
    expect(body.status).toBe(500);
  });

  it('is refused whatever path is hung off it', async () => {
    process.env[INDEX_ENV.apiBase] = `${RHC.explorer}/api/v2`;

    await ask(`resource=logs&address=${MANDATE}`);
    expect(calls).toHaveLength(0);
  });
});

describe('what may be asked of a paid index', () => {
  it('refuses a resource outside the three this product reads', async () => {
    const answer = await ask(`resource=tokens&address=${MANDATE}`);

    expect(answer.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses an address that is not one, before a request is spent on it', async () => {
    const answer = await ask('resource=logs&address=0xnope');

    expect(answer.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses a transaction hash that is not one', () => {
    expect(upstreamPath('transaction', { hash: '0x1234' })).toBeUndefined();
    expect(upstreamPath('transaction', { hash: HASH })).toBe(`/transactions/${HASH}`);
  });

  it('hands the index its own page cursor back, untouched', async () => {
    await ask(`resource=transactions&address=${MANDATE}&cursor=${encodeURIComponent('{"block_number":5,"index":11}')}`);

    expect(calls[0]?.url).toContain('block_number=5');
    expect(calls[0]?.url).toContain('index=11');
  });

  it('refuses a cursor that is not a cursor', () => {
    expect(cursorQuery('not json')).toBeUndefined();
    expect(cursorQuery('[1,2,3]')).toBeUndefined();
    expect(cursorQuery('{"nested":{"a":1}}')).toBeUndefined();
    expect(cursorQuery(`{"long":"${'x'.repeat(200)}"}`)).toBeUndefined();
    expect(cursorQuery(null)).toEqual({});
  });
});

describe('what the index answered, passed on as itself', () => {
  it('reports a 402 from the index as the same missing key', async () => {
    answered(402, '{"error":"Proceed with API key or make a X402 payment to continue"}');

    const answer = await ask(`resource=logs&address=${MANDATE}`);
    const body = (await answer.json()) as { failure: string };

    expect(answer.status).toBe(402);
    expect(body.failure).toBe('unkeyed');
  });

  it('reports a key the index rejected as the same failure, with its own status', async () => {
    answered(401, '{"error":"Unauthorized"}');

    const body = (await (await ask(`resource=logs&address=${MANDATE}`)).json()) as { failure: string; status: number };
    expect(body.failure).toBe('unkeyed');
    expect(body.status).toBe(401);
  });

  it('keeps a rate limit apart from a refusal the index made for itself', async () => {
    answered(429);
    const metered = (await (await ask(`resource=logs&address=${MANDATE}`)).json()) as { failure: string };

    answered(403);
    const refused = (await (await ask(`resource=logs&address=${MANDATE}`)).json()) as { failure: string };

    expect(metered.failure).toBe('rate-limited');
    expect(refused.failure).toBe('refused');
  });

  it('answers 502 when the index is not there at all', async () => {
    upstreamAnswering(async () => {
      throw new TypeError('fetch failed');
    });

    const answer = await ask(`resource=logs&address=${MANDATE}`);
    const body = (await answer.json()) as { failure: string };

    expect(answer.status).toBe(502);
    expect(body.failure).toBe('unreachable');
  });

  it('answers malformed when the index sends something that is not JSON', async () => {
    answered(200, '<html>Just a moment…</html>');

    const answer = await ask(`resource=logs&address=${MANDATE}`);
    const body = (await answer.json()) as { failure: string };

    expect(answer.status).toBe(502);
    expect(body.failure).toBe('malformed');
  });

  it('passes a good answer through to the browser', async () => {
    answered(200, '{"items":[{"block_number":57681720,"index":3}],"next_page_params":null}', { 'content-type': 'application/json' });

    const body = (await (await ask(`resource=logs&address=${MANDATE}`)).json()) as { items: readonly unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it('lets a shared cache hold a good answer for seconds, so readers polling one mandate share it', async () => {
    const answer = await ask(`resource=logs&address=${MANDATE}`);
    expect(answer.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=10');
    expect(answer.headers.get('vary')).toBe('Origin, Sec-Fetch-Site');
  });

  it('never lets a cache hold a failure', async () => {
    answered(503, 'down');
    const answer = await ask(`resource=logs&address=${MANDATE}`);
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });
});

/**
 * Every answer here is paid for with this deployment's key, so another site's page may not spend
 * it through a reader's browser. The browser says where a request came from; a request that says
 * nothing did not come from a page.
 */
describe('a request from another site', () => {
  function from(headers: Record<string, string>): Promise<Response> {
    return GET(new Request(`https://bursar.example/api/index?resource=logs&address=${MANDATE}`, { headers }));
  }

  it('is refused with 403 before the index is asked', async () => {
    const answer = await from({ 'sec-fetch-site': 'cross-site' });

    expect(answer.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('is refused from a sibling subdomain too', async () => {
    expect((await from({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
  });

  it('is refused by origin where the browser sends no fetch metadata', async () => {
    const answer = await from({ origin: 'https://bursar-world.example' });

    expect(answer.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('is served when it comes from this app', async () => {
    expect((await from({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await from({ origin: 'https://bursar.example' })).status).toBe(200);
  });

  it('is served when the origin matches the host a proxy forwarded', async () => {
    const answer = await GET(
      new Request(`http://10.0.0.4:4310/api/index?resource=logs&address=${MANDATE}`, {
        headers: { origin: 'https://console.bursar.example', 'x-forwarded-host': 'console.bursar.example', 'x-forwarded-proto': 'https' },
      }),
    );
    expect(answer.status).toBe(200);
  });

  it('is served when typed into the address bar', async () => {
    expect((await from({ 'sec-fetch-site': 'none' })).status).toBe(200);
  });
});
