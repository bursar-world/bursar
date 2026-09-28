import { INDEX_ENV, createIndexClient, indexApiBase, isBursarError } from '@bursar/core';
import { NextResponse } from 'next/server';

import { CHAIN_ID } from '@/chain/rhc';
import { isIndexResource } from '@/app/(app)/console/lib/index-wire';
import type { IndexErrorBody, IndexFailure } from '@/app/(app)/console/lib/index-wire';
import { cursorQuery, isCrossSite, upstreamPath } from './upstream';

/**
 * The network index, read on the server because the key cannot be in the browser.
 *
 * Robinhood Chain's index is paid: it answers 402 to a request that carries no key, and a key
 * shipped in client JavaScript is a key given away to everyone who opens the page. So the history
 * and the revert reasons are fetched here, with the key held in this process, and the browser asks
 * this app instead of asking the index.
 *
 * This is a boundary, not a cache and not a rewrite. One request in, one request out, the index's
 * own body back. The bounded page walk, the backoff and the reading of what went wrong all stay in
 * the browser, which is where the reader whose screen is empty is.
 */
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 12_000;

/**
 * How long a shared cache may hold a successful page. The history panels poll, and several readers
 * on one mandate would otherwise each spend a paid request on the same page within seconds.
 */
const SHARED_CACHE_SECONDS = 10;

export async function GET(request: Request): Promise<Response> {
  if (isCrossSite(request)) return json({ failure: 'refused', host: 'this app', status: 403 } satisfies IndexErrorBody, 403);

  const asked = new URL(request.url).searchParams;
  const resource = asked.get('resource');

  if (!isIndexResource(resource)) return badRequest('resource names one of logs, transactions or transaction.');

  const path = upstreamPath(resource, { address: asked.get('address') ?? '', hash: asked.get('hash') ?? '' });
  if (path === undefined) {
    return badRequest(resource === 'transaction' ? 'transaction needs a 32-byte hash.' : `${resource} needs a 20-byte address.`);
  }

  const query = cursorQuery(asked.get('cursor'));
  if (query === undefined) return badRequest('cursor is not the page cursor the index handed out.');

  // Built on every request, so an operator who sets the key restarts nothing and a deployment
  // without one is told the same thing on every read instead of once at boot.
  let client;
  try {
    client = createIndexClient({ chainId: CHAIN_ID, timeoutMs: TIMEOUT_MS });
  } catch (caught) {
    return misconfigured(caught);
  }

  try {
    return NextResponse.json(await client.get<unknown>(path, query), {
      status: 200,
      headers: {
        'cache-control': `public, max-age=0, s-maxage=${SHARED_CACHE_SECONDS}`,
        // The route answers differently to a cross-site request, so a cache must not hand one
        // caller's answer to the other.
        vary: 'Origin, Sec-Fetch-Site',
      },
    });
  } catch (caught) {
    return readingFailed(caught, new URL(client.baseUrl).host);
  }
}

/**
 * The index answered and the answer was not data.
 *
 * 402 is it charging for the reading and 401 is it rejecting the key this deployment sent. Both
 * are the same thing to a reader waiting for history and the same thing to fix, so they share a
 * failure and are told apart by the status that travels with it.
 */
function readingFailed(caught: unknown, host: string): NextResponse {
  if (isBursarError(caught) && caught.code === 'index_request_failed') {
    const status = (caught as { status?: unknown }).status;
    const answered = typeof status === 'number' ? status : 502;
    return failed(failureForStatus(answered), host, answered);
  }

  if (isBursarError(caught) && caught.code === 'index_bad_body') return failed('malformed', host, 502);
  if (caught instanceof DOMException && caught.name === 'TimeoutError') return failed('timed-out', host);
  return failed('unreachable', host);
}

/**
 * The deployment's index configuration, not the index. A missing key is the common one and says so
 * with the status the index would have answered; the rest are an operator pointing this at
 * something that cannot serve an index at all, and the server's own log carries which.
 */
function misconfigured(caught: unknown): NextResponse {
  const host = new URL(indexApiBase(CHAIN_ID)).host;
  const missingKey = isBursarError(caught) && caught.code === 'index_key_missing';
  if (!missingKey) console.error(`${INDEX_ENV.apiBase} cannot be used as an index:`, caught);

  return failed('unkeyed', host, missingKey ? 402 : 500);
}

function failureForStatus(status: number): IndexFailure {
  if (status === 429) return 'rate-limited';
  if (status === 402 || status === 401) return 'unkeyed';
  return 'refused';
}

function failed(failure: IndexFailure, host: string, status?: number): NextResponse {
  const body: IndexErrorBody = status === undefined ? { failure, host } : { failure, host, status };
  return json(body, statusFor(failure, status));
}

function statusFor(failure: IndexFailure, status: number | undefined): number {
  if (failure === 'timed-out') return 504;
  if (failure === 'unreachable' || failure === 'malformed') return 502;
  return status ?? 502;
}

/** A request this app built and this route will not make. The browser reads it as malformed. */
function badRequest(condition: string): NextResponse {
  const body: IndexErrorBody = { failure: 'malformed', host: 'this app', status: 400 };
  return json({ ...body, condition }, 400);
}

/** Failures are never cached: the next request should ask again rather than repeat this one. */
function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
