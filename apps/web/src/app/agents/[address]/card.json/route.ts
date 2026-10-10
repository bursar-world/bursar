import { getAddress } from 'viem';

import { readsAsAddress } from '@/lib/path';

import { buildCard } from '../../card';

/**
 * `/agents/<address>/card.json`: the ERC-8004 registration file for a Bursar address.
 *
 * An identity in the registry points here, so this is what 8004scan, OpenSea and any other agent
 * read about a provider or a mandate's agent. It is built from the chain and held for a minute,
 * which is the pace the listing and the record change at, and it is served to any origin: a card
 * nobody else can fetch describes nobody.
 */
export const dynamic = 'force-dynamic';

type Params = { readonly params: Promise<{ readonly address: string }> };

const HOLD_MS = 60_000;
const held = new Map<string, { readonly until: number; readonly body: string | null }>();

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { address } = await params;
  if (!readsAsAddress(address)) return refuse(404, 'not_an_address', 'The path names no address.');

  const subject = getAddress(address);
  const site = siteFor(request);
  const key = `${site}|${subject}`;
  const now = Date.now();
  const kept = held.get(key);
  let body = kept !== undefined && kept.until > now ? kept.body : undefined;

  if (body === undefined) {
    const card = await buildCard(subject, site);
    body = card === undefined ? null : JSON.stringify(card, null, 2);
    held.set(key, { until: now + HOLD_MS, body });
  }

  if (body === null) return refuse(404, 'not_a_bursar_agent', 'No provider listing and no mandate account at this address.');

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=60',
      'access-control-allow-origin': '*',
    },
  });
}

/** Where this deployment says it lives, else the origin the request arrived on. */
export function siteFor(request: Request): string {
  const declared = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (declared !== undefined && declared !== '') return declared.replace(/\/+$/, '');

  const url = new URL(request.url);
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host).split(',')[0]!.trim();
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

function refuse(status: number, error: string, detail: string): Response {
  return Response.json({ error, detail }, { status, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}
