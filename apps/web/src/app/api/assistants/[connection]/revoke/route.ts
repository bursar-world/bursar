import { forward, isCrossSite, json } from '../../host';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { readonly params: Promise<{ readonly connection: string }> }): Promise<Response> {
  if (isCrossSite(request)) return json({ error: 'refused', detail: 'Connections are cut from this console only.' }, 403);
  const { connection } = await context.params;
  if (!/^[0-9a-f-]{36}$/u.test(connection)) return json({ error: 'bad_request', detail: 'connection is the id the host gave it.' }, 400);
  const body = await request.text();
  if (body.length > 16_384) return json({ error: 'body_too_large', detail: 'The request is larger than a signed message.' }, 413);
  return forward(`/connections/${connection}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}
