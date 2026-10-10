import { isAddress } from 'viem';

import { forward, isCrossSite, json } from './host';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const mandate = new URL(request.url).searchParams.get('mandate') ?? '';
  if (!isAddress(mandate, { strict: false })) return json({ error: 'bad_request', detail: 'mandate is a 0x address.' }, 400);
  return forward(`/connections?mandate=${mandate}`);
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) return json({ error: 'refused', detail: 'Connections are opened from this console only.' }, 403);
  const body = await request.text();
  if (body.length > 16_384) return json({ error: 'body_too_large', detail: 'The request is larger than a signed message.' }, 413);
  return forward('/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}
