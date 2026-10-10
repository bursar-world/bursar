import { NextResponse } from 'next/server';
import { isAddress } from 'viem';

import { isCrossSite } from '@/app/api/index/upstream';

import { discoverIdentities } from './lookup';

/**
 * The ERC-8004 identities an address owns, as the indexes know them. A browser proves each id
 * against the registry before it shows anything; this route only shortens the search.
 */
export const dynamic = 'force-dynamic';

const SHARED_CACHE_SECONDS = 15;

export async function GET(request: Request): Promise<Response> {
  if (isCrossSite(request)) return NextResponse.json({ error: 'refused' }, { status: 403, headers: { 'cache-control': 'no-store' } });

  const owner = new URL(request.url).searchParams.get('owner') ?? '';
  if (!isAddress(owner, { strict: false })) {
    return NextResponse.json({ error: 'owner is a 20-byte address.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const found = await discoverIdentities(owner);
  return NextResponse.json(found, {
    status: 200,
    headers: { 'cache-control': `public, max-age=0, s-maxage=${SHARED_CACHE_SECONDS}`, vary: 'Origin, Sec-Fetch-Site' },
  });
}
