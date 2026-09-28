import { afterEach, describe, expect, it } from 'vitest';
import { RHC_MAINNET } from '../src/chain.js';
import { BursarError } from '../src/errors.js';
import {
  INDEX_ENV,
  IndexClientInBrowser,
  IndexRequestError,
  MissingIndexKey,
  RHC_INDEX_API_BASE,
  createIndexClient,
  explorerAddressUrl,
  explorerBlockUrl,
  explorerTokenUrl,
  explorerTxUrl,
  indexApiBase,
} from '../src/explorer.js';

const KEY = { BLOCKSCOUT_API_KEY: 'test-key' };
const HASH = '0x646e80ea0c81fa3085f5dc4d76fc815c19d432878e90ec40695bd9772a0283a1' as const;
const ADDRESS = '0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4' as const;

function jsonFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): {
  fetchFn: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (input: unknown, options?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (options?.headers ?? {}) as Record<string, string>,
    });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      ...(init.headers === undefined ? {} : { headers: init.headers }),
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function refusal(init: { status: number; headers?: Record<string, string> }): Promise<IndexRequestError> {
  const { fetchFn } = jsonFetch('busy', init);
  const index = createIndexClient({ source: KEY, fetchFn });
  return (await index.get('/stats').catch((e: unknown) => e)) as IndexRequestError;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

describe('the explorer people read', () => {
  it('links at the host a browser can pass the challenge on', () => {
    expect(explorerTxUrl(RHC_MAINNET, HASH)).toBe(`https://robinhoodchain.blockscout.com/tx/${HASH}`);
    expect(explorerAddressUrl(RHC_MAINNET, ADDRESS)).toBe(
      `https://robinhoodchain.blockscout.com/address/${ADDRESS}`,
    );
    expect(explorerBlockUrl(RHC_MAINNET, 57_681_720n)).toBe(
      'https://robinhoodchain.blockscout.com/block/57681720',
    );
    expect(explorerTokenUrl(RHC_MAINNET, RHC_MAINNET.usdg)).toContain('/token/');
  });

  it('is a different host from the one code reads', () => {
    expect(new URL(explorerTxUrl(RHC_MAINNET, HASH)).hostname).not.toBe(
      new URL(RHC_INDEX_API_BASE).hostname,
    );
  });

  it('follows a moved explorer without a release', () => {
    const moved = { ...RHC_MAINNET, explorer: 'https://explorer.example/' };
    expect(explorerTxUrl(moved, HASH)).toBe(`https://explorer.example/tx/${HASH}`);
  });
});

describe('the index code reads', () => {
  it('addresses the index by chain id, so it cannot be pointed at another network', () => {
    expect(RHC_INDEX_API_BASE).toBe('https://api.blockscout.com/4663/api/v2');
    expect(indexApiBase(46630)).toBe('https://api.blockscout.com/46630/api/v2');
  });

  it('authenticates with a bearer header, keeping the key out of the URL', async () => {
    const { fetchFn, calls } = jsonFetch({ items: [] });
    const index = createIndexClient({ source: KEY, fetchFn });

    await index.get('/addresses/0x1/transactions', { filter: 'to', page: 2 });

    expect(calls[0]?.headers['authorization']).toBe('Bearer test-key');
    expect(calls[0]?.url).toBe(
      'https://api.blockscout.com/4663/api/v2/addresses/0x1/transactions?filter=to&page=2',
    );
    expect(calls[0]?.url).not.toContain('test-key');
    expect(index.baseUrl).not.toContain('test-key');
  });

  it('refuses to construct without a key rather than reporting every lookup as an outage', () => {
    const error = capture(() => createIndexClient({ source: {} })) as MissingIndexKey;

    expect(error).toBeInstanceOf(MissingIndexKey);
    expect(error.code).toBe('index_key_missing');
    expect(error.message).toContain(INDEX_ENV.apiKey);
    expect(error.message).toContain('402');
  });

  it('reports a 402 as the key, not as the query', async () => {
    const { fetchFn } = jsonFetch({ error: 'Proceed with API key or make a X402 payment to continue' }, { status: 402 });
    const index = createIndexClient({ source: KEY, fetchFn });

    const error = (await index.get('/stats').catch((e: unknown) => e)) as IndexRequestError;

    expect(error).toBeInstanceOf(IndexRequestError);
    expect(error.status).toBe(402);
    expect(error.message).toContain('out of quota');
    expect(error.message).not.toContain('test-key');
  });

  it('surfaces any other status with what the index said', async () => {
    const { fetchFn } = jsonFetch('not found', { status: 404 });
    const index = createIndexClient({ source: KEY, fetchFn });

    const error = (await index.get('/stats').catch((e: unknown) => e)) as IndexRequestError;
    expect(error.status).toBe(404);
    expect(error.message).toContain('404');
  });

  it('carries what the index asked to be left alone for, so a caller need not read the response', async () => {
    const error = await refusal({ status: 429, headers: { 'retry-after': '90' } });

    expect(error.retryAfterMs).toBe(90_000);
    expect(error.details['retryAfterMs']).toBe(90_000);
  });

  it('takes Retry-After as an HTTP date as well, which is the other form the header has', async () => {
    const at = new Date(Date.now() + 45_000).toUTCString();
    const error = await refusal({ status: 503, headers: { 'retry-after': at } });

    expect(error.retryAfterMs).toBeGreaterThan(30_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  it('leaves it undefined when the index said nothing or said something already past', async () => {
    expect((await refusal({ status: 429 })).retryAfterMs).toBeUndefined();
    expect((await refusal({ status: 429, headers: { 'retry-after': '0' } })).retryAfterMs).toBeUndefined();
    expect(
      (await refusal({ status: 429, headers: { 'retry-after': 'whenever' } })).retryAfterMs,
    ).toBeUndefined();
  });

  it('refuses a body that is not JSON instead of handing back a parsed challenge page', async () => {
    const { fetchFn } = jsonFetch('<html>Just a moment…</html>');
    const index = createIndexClient({ source: KEY, fetchFn });

    const error = (await index.get('/stats').catch((e: unknown) => e)) as BursarError;
    expect(error.code).toBe('index_bad_body');
  });
});

/**
 * The defect this split exists to prevent. Each of these ships a paid key to anyone who opens
 * devtools, and each of them looks like a working feature until someone does.
 */
describe('the index client will not run where its key would be public', () => {
  it('refuses to construct in a browser', () => {
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { document?: unknown }).document = {};

    const error = capture(() => createIndexClient({ source: KEY })) as IndexClientInBrowser;

    expect(error).toBeInstanceOf(IndexClientInBrowser);
    expect(error.code).toBe('index_browser_refused');
    expect(error.message).toContain('server route');
  });

  it('refuses when the key is configured under a browser-visible name', () => {
    const error = capture(() =>
      createIndexClient({ source: { ...KEY, NEXT_PUBLIC_BLOCKSCOUT_API_KEY: 'test-key' } }),
    ) as IndexClientInBrowser;

    expect(error).toBeInstanceOf(IndexClientInBrowser);
    expect(error.message).toContain('NEXT_PUBLIC_BLOCKSCOUT_API_KEY');
  });

  it('refuses to be pointed at the explorer people read', () => {
    const error = capture(() =>
      createIndexClient({ source: KEY, baseUrl: `${RHC_MAINNET.explorer}/api/v2` }),
    ) as BursarError;

    expect(error.code).toBe('index_base_is_human_explorer');
    expect(error.message).toContain('Cloudflare');
  });

  it('refuses an absolute path, which would send the key to another host', async () => {
    const { fetchFn, calls } = jsonFetch({});
    const index = createIndexClient({ source: KEY, fetchFn });

    const error = (await index.get('https://example.test/steal').catch((e: unknown) => e)) as BursarError;

    expect(error.code).toBe('index_path_absolute');
    expect(calls).toHaveLength(0);
  });

  it('takes a self-hosted base from the environment', async () => {
    const { fetchFn, calls } = jsonFetch({});
    const index = createIndexClient({
      source: { ...KEY, BLOCKSCOUT_API_BASE: 'https://blockscout.internal/api/v2/' },
      fetchFn,
    });

    await index.get('stats');
    expect(index.baseUrl).toBe('https://blockscout.internal/api/v2');
    expect(calls[0]?.url).toBe('https://blockscout.internal/api/v2/stats');
  });

  it('stops on a base that is not a URL', () => {
    const error = capture(() => createIndexClient({ source: KEY, baseUrl: 'api.blockscout.com' }));
    expect((error as BursarError).code).toBe('index_base_invalid');
  });
});

describe('the index client against the real endpoint', () => {
  const live = process.env['BLOCKSCOUT_API_KEY'];

  it.skipIf(!live)('reads chain 4663 stats with the key from the environment', async () => {
    const index = createIndexClient({ timeoutMs: 20_000 });
    const stats = await index.get<{ total_blocks?: string }>('/stats');

    expect(Number(stats.total_blocks ?? 0)).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!live)('answers 402 with no key, which is why the client demands one', async () => {
    const response = await fetch(`${RHC_INDEX_API_BASE}/stats`, { signal: AbortSignal.timeout(20_000) });
    expect(response.status).toBe(402);
  }, 30_000);
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('where the key may travel', () => {
  it('refuses a plain-http index base, which would send the key in the clear', () => {
    const error = (() => {
      try {
        createIndexClient({ source: { ...KEY, BLOCKSCOUT_API_BASE: 'http://index.example/api/v2' } });
        return null;
      } catch (caught) {
        return caught as BursarError;
      }
    })();
    expect(error?.code).toBe('index_base_insecure');
  });

  it('allows http on loopback for a local stand-in', () => {
    const index = createIndexClient({ source: { ...KEY, BLOCKSCOUT_API_BASE: 'http://localhost:4000/api/v2' } });
    expect(index.baseUrl).toBe('http://localhost:4000/api/v2');
  });
});
