import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';

import { createUnderwriterClient, createUnderwriterProbe } from '../src/client.js';

const ACCOUNT = '0x00000000000000000000000000000000000000a1';
const MERCHANT = '0x00000000000000000000000000000000000000b2';
const PROOF = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] as const;

/** A fetch that records what the client sent and answers like a live underwriter. */
function recordingFetch() {
  const sent: { url: string; body: Record<string, unknown> | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    sent.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    const body = url.endsWith('/v1/underwrite')
      ? { decision: { decision: 'allow' }, quote: null, idempotent: false }
      : { account: ACCOUNT };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, sent };
}

describe('the remote underwriter client', () => {
  it('forwards the merchant proof, which an account behind a Merkle gate refuses without', async () => {
    const { fetch, sent } = recordingFetch();
    const port = await createUnderwriterClient({ baseUrl: 'http://underwriter.test', fetch })('agent-1');

    await port?.authorize({
      requestId: 'r-1',
      subject: 'agent-1',
      action: 'doc.summarize:1',
      amountMicros: toMicro(1_000n),
      at: '2026-09-27T12:00:00.000Z',
      merchant: MERCHANT,
      merchantProof: PROOF,
    });

    const underwrite = sent.find((call) => call.url.endsWith('/v1/underwrite'));
    expect(underwrite?.body?.['merchantProof']).toEqual(PROOF);
  });

  it('leaves the proof out when there is none, rather than sending an empty gate answer', async () => {
    const { fetch, sent } = recordingFetch();
    const port = await createUnderwriterClient({ baseUrl: 'http://underwriter.test', fetch })('agent-1');

    await port?.authorize({
      requestId: 'r-2',
      subject: 'agent-1',
      action: 'doc.summarize:1',
      amountMicros: toMicro(1_000n),
      at: '2026-09-27T12:00:00.000Z',
    });

    const underwrite = sent.find((call) => call.url.endsWith('/v1/underwrite'));
    expect(underwrite?.body).not.toHaveProperty('merchantProof');
  });

  /**
   * The URL is declared secret because one routinely carries a key in its userinfo, path or query,
   * and these messages travel to the facilitator's caller as the detail of a 503.
   */
  it('names the underwriter by its origin alone when it cannot be reached or answers badly', async () => {
    const base = 'https://ops:key-material@underwriter.test/private/v2?token=abc';
    const down: typeof globalThis.fetch = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:8403');
    };
    const unreachable = await createUnderwriterClient({ baseUrl: base, fetch: down })('agent-1').catch((error: Error) => error);
    expect(unreachable).toBeInstanceOf(Error);
    expect((unreachable as Error).message).toContain('https://underwriter.test');
    expect((unreachable as Error).message).not.toMatch(/key-material|private|token=|ECONNREFUSED/);

    const garbled: typeof globalThis.fetch = async () => new Response('<html>', { status: 502 });
    const unusable = await createUnderwriterClient({ baseUrl: base, fetch: garbled })('agent-1').catch((error: Error) => error);
    expect((unusable as Error).message).toContain('https://underwriter.test');
    expect((unusable as Error).message).not.toMatch(/key-material|private|token=/);

    const refusing: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'underwriter_journal_held', detail: 'held' }), { status: 409, headers: { 'content-type': 'application/json' } });
    const refused = await createUnderwriterClient({ baseUrl: base, fetch: refusing })('agent-1').catch((error: Error) => error);
    expect((refused as Error).message).toContain('https://underwriter.test');
    expect((refused as Error).message).not.toMatch(/key-material|private|token=/);
  });

  it('reports an unreachable underwriter to the readiness probe without the transport\u2019s words', async () => {
    const down: typeof globalThis.fetch = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:8403');
    };
    const probe = createUnderwriterProbe({ baseUrl: 'https://ops:key-material@underwriter.test/private', fetch: down });
    const answer = await probe();
    expect(answer).toMatchObject({ ready: false, reachable: false });
    expect(String(answer['detail'])).toContain('https://underwriter.test');
    expect(String(answer['detail'])).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|key-material|private/);
  });
});
