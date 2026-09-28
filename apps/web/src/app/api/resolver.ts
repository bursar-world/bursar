import { NextResponse } from 'next/server';

/**
 * The ruling service, reached from the server only.
 *
 * It runs on the private network beside this app with no public address of its own, so these
 * routes are its public face: one request in, one request out, its own answer passed back. Nothing
 * here decides anything about a ruling or a piece of evidence. The service verifies every
 * signature itself.
 */

const TIMEOUT_MS = 8_000;

/** `BURSAR_RESOLVER_URL`, read per request so an operator who sets it restarts nothing. */
function base(): string | undefined {
  const raw = process.env['BURSAR_RESOLVER_URL']?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

export async function forward(path: string, init: RequestInit = {}): Promise<NextResponse> {
  const root = base();
  if (root === undefined) {
    return json({ error: 'unconfigured', detail: 'This deployment is not connected to the ruling service.' }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${root}${path}`, { ...init, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (caught) {
    const timedOut = caught instanceof DOMException && caught.name === 'TimeoutError';
    return json({ error: timedOut ? 'timed-out' : 'unreachable', detail: 'The ruling service did not answer.' }, timedOut ? 504 : 502);
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return json({ error: 'malformed', detail: 'The ruling service answered with something that is not JSON.' }, 502);
  }
  return json(body, upstream.status);
}

export function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
