import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';

import { createUnderwriterClient } from '../src/client.js';

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
});
