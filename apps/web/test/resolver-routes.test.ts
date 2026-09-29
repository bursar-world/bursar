import { encodeEvidence, signDeliveryEvidence } from '@bursar/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { POST } from '@/app/api/evidence/route';
import { GET as health } from '@/app/api/rulings/health/route';
import { GET } from '@/app/api/rulings/route';
import { readRulingBody } from '@/app/(app)/resolvers/ruling';

/**
 * The console's public face for the ruling service, which has no public address of its own. The
 * routes pass requests through and decide nothing, so what is checked is what they refuse to pass
 * and what they say when the service is not there.
 */
const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit | undefined }[] = [];

function upstream(status: number, body: unknown): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  process.env['BURSAR_RESOLVER_URL'] = 'http://bursar-resolver:10000/';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['BURSAR_RESOLVER_URL'];
});

describe('rulings route', () => {
  it('asks the service for the dispute and passes its answer back', async () => {
    upstream(200, { status: 'sealed', disputeId: '4' });
    const response = await GET(new Request('https://app.example/api/rulings?dispute=4'));

    expect(calls.map((call) => call.url)).toEqual(['http://bursar-resolver:10000/rulings/4']);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'sealed', disputeId: '4' });
  });

  it('answers a dispute with no published ruling as none, not as a failed request', async () => {
    upstream(404, { error: 'unknown' });
    const response = await GET(new Request('https://app.example/api/rulings?dispute=1&registry=0x0000000000000000000000000000000000000001'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'none' });
    expect(readRulingBody(200, { status: 'none' })).toEqual({ kind: 'none' });
  });

  it('refuses an id that is not one, without asking anyone', async () => {
    upstream(200, {});
    for (const query of ['dispute=0', 'dispute=abc', 'dispute=1/../../health', 'dispute=1&registry=nope']) {
      expect((await GET(new Request(`https://app.example/api/rulings?${query}`))).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('says it is not connected when no service is configured', async () => {
    delete process.env['BURSAR_RESOLVER_URL'];
    const response = await GET(new Request('https://app.example/api/rulings?dispute=4'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'unconfigured' });
  });

  it('reports an unreachable service as a gateway failure', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect((await GET(new Request('https://app.example/api/rulings?dispute=4'))).status).toBe(502);
  });

  it('passes the service health through for an uptime check', async () => {
    upstream(503, { status: 'stale' });
    const response = await health();
    expect(calls.map((call) => call.url)).toEqual(['http://bursar-resolver:10000/health']);
    expect(response.status).toBe(503);
  });
});

describe('evidence route', () => {
  const payee = privateKeyToAccount(`0x${'a1'.repeat(32)}`);

  async function body(): Promise<string> {
    const submission = await signDeliveryEvidence(payee, '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4', 4663, {
      escrowId: 9n,
      inputCommit: `0x${'aa'.repeat(32)}`,
      outputCommit: `0x${'bb'.repeat(32)}`,
      outputURI: 'https://outputs.example.com/9.json',
      deliveredAt: 1n,
    });
    return JSON.stringify(encodeEvidence(submission));
  }

  it('forwards a well-formed submission unchanged', async () => {
    upstream(202, { accepted: true, counted: true });
    const sent = await body();
    const response = await POST(new Request('https://app.example/api/evidence', { method: 'POST', body: sent }));

    expect(response.status).toBe(202);
    expect(calls[0]?.url).toBe('http://bursar-resolver:10000/evidence');
    expect(calls[0]?.init?.body).toBe(sent);
  });

  it('refuses a body that is not a submission before it reaches the service', async () => {
    upstream(202, {});
    const response = await POST(new Request('https://app.example/api/evidence', { method: 'POST', body: '{"kind":"delivery"}' }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses an oversized body', async () => {
    upstream(202, {});
    const response = await POST(new Request('https://app.example/api/evidence', { method: 'POST', body: 'x'.repeat(70_000) }));
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('passes the service refusal through', async () => {
    upstream(403, { error: 'wrong_signer' });
    const response = await POST(new Request('https://app.example/api/evidence', { method: 'POST', body: await body() }));
    expect(response.status).toBe(403);
  });
});
