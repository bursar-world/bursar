import { INDEX_ENV } from '@bursar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from '@/app/api/agents/discover/route';
import { discoverIdentities } from '@/app/api/agents/discover/lookup';

/**
 * Finding an owner's identities. Two indexes are asked and either may be down; what comes back is
 * only ever a list of candidate ids, which the registry is asked about before anything is shown.
 */
const OWNER = '0x72bB8416EeFE38Fe76A4568ed826359AC5253db1';
const IDENTITY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432';

const realFetch = globalThis.fetch;
let calls: string[] = [];

function answering(table: Record<string, () => Response>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    const match = Object.keys(table).find((key) => url.includes(key));
    return match === undefined ? new Response('{}', { status: 500 }) : table[match]!();
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  delete process.env[INDEX_ENV.apiKey];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[INDEX_ENV.apiKey];
});

describe('the lookup', () => {
  it('keeps only tokens of this registry on this chain, joined across indexes, lowest first', async () => {
    process.env[INDEX_ENV.apiKey] = 'test-key-not-real';
    const fetchFn = answering({
      '8004scan.io': () =>
        Response.json({
          items: [
            { chain_id: 4663, contract_address: IDENTITY, token_id: '8623' },
            { chain_id: 56, contract_address: IDENTITY, token_id: '370802' },
            { chain_id: 4663, contract_address: '0x1111111111111111111111111111111111111111', token_id: '1' },
          ],
        }),
      'api.blockscout.com': () => Response.json({ items: [{ id: '8623' }, { id: '9001' }] }),
    });

    const found = await discoverIdentities(OWNER, fetchFn);
    expect(found.ids).toEqual(['8623', '9001']);
    expect(found.sources).toEqual([
      { name: 'scan', ok: true },
      { name: 'index', ok: true },
    ]);
    expect(calls.some((url) => url.includes(`/tokens/${IDENTITY}/instances`) && url.includes(`holder_address_hash=${OWNER}`))).toBe(true);
  });

  it('says which index did not answer, and asks the paid one only with a key', async () => {
    const fetchFn = answering({ '8004scan.io': () => new Response('down', { status: 503 }) });
    const found = await discoverIdentities(OWNER, fetchFn);
    expect(found.ids).toEqual([]);
    expect(found.sources).toEqual([
      { name: 'scan', ok: false },
      { name: 'index', ok: false },
    ]);
    expect(calls.some((url) => url.includes('blockscout'))).toBe(false);
  });
});

describe('the route', () => {
  it('refuses a cross-site request and an owner that is not an address', async () => {
    const foreign = await GET(new Request('https://bursar.example/api/agents/discover?owner=' + OWNER, { headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(foreign.status).toBe(403);

    const junk = await GET(new Request('https://bursar.example/api/agents/discover?owner=nope'));
    expect(junk.status).toBe(400);
  });

  it('answers the ids with a short shared cache', async () => {
    globalThis.fetch = answering({ '8004scan.io': () => Response.json({ items: [{ chain_id: 4663, contract_address: IDENTITY, token_id: '77' }] }) });
    const answer = await GET(new Request('https://bursar.example/api/agents/discover?owner=' + OWNER));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toContain('s-maxage=15');
    expect(((await answer.json()) as { ids: string[] }).ids).toEqual(['77']);
  });
});
