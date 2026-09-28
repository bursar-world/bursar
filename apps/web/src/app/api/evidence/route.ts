import { parseEvidence } from '@bursar/sdk';

import { forward, json } from '../resolver';

/**
 * Signed delivery evidence and payer statements, passed to the ruling service.
 *
 * Open to any caller, a provider's sidecar included, and to other sites: a submission carries its
 * own signature, the service checks it against the party the escrow recorded, and a request forged
 * from another page can only deliver evidence somebody already signed.
 */
export const dynamic = 'force-dynamic';

/** The service's own limit. Refused here too, so a large body never reaches the private network. */
const MAX_BODY_BYTES = 64 * 1_024;

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return json({ error: 'too_large', detail: `A submission is at most ${MAX_BODY_BYTES} bytes.` }, 413);

  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return json({ error: 'too_large', detail: `A submission is at most ${MAX_BODY_BYTES} bytes.` }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
    parseEvidence(body);
  } catch (caught) {
    return json({ error: 'evidence_invalid', detail: caught instanceof Error ? caught.message : 'The body is not a submission.' }, 400);
  }

  return forward('/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
}
