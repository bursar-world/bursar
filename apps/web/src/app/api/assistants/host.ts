import { NextResponse } from 'next/server';

import { isCrossSite } from '@/app/api/index/upstream';

export { isCrossSite };

/**
 * The hosted MCP endpoint, reached from the server only.
 *
 * Its address is deployment configuration and the browser never needs it: the console asks this
 * app, this app asks the host, and the host's own answer comes back unchanged. The host checks
 * every signature itself, so nothing here decides anything.
 */

const TIMEOUT_MS = 20_000;

/** `BURSAR_MCP_HOST_URL`, read per request so an operator who sets it restarts nothing. */
export function hostBase(): string | undefined {
  const raw = process.env['BURSAR_MCP_HOST_URL']?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().replace(/\/+$/u, '') : undefined;
  } catch {
    return undefined;
  }
}

export async function forward(path: string, init: RequestInit = {}): Promise<NextResponse> {
  const root = hostBase();
  if (root === undefined) {
    return json({ error: 'unconfigured', detail: 'This deployment is not connected to a hosted MCP endpoint.' }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${root}${path}`, { ...init, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (caught) {
    const timedOut = caught instanceof DOMException && caught.name === 'TimeoutError';
    return json({ error: timedOut ? 'timed-out' : 'unreachable', detail: 'The hosted endpoint did not answer.' }, timedOut ? 504 : 502);
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return json({ error: 'malformed', detail: 'The hosted endpoint answered with something that is not JSON.' }, 502);
  }
  return json(body, upstream.status);
}

export function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
