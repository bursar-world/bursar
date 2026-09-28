import type { IndexResource } from '@/app/(app)/console/lib/index-wire';

/**
 * What may be asked of a paid index, decided before a key is spent on it.
 *
 * The client itself lives in @bursar/core, which already refuses to exist in a browser, refuses a
 * key under a browser-visible name, and refuses to be pointed at the explorer people read. What
 * belongs here is narrower: this product asks the index three questions about addresses it was
 * given, and nothing that arrives on the route may turn into a fourth.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** An opaque cursor is passed straight back, and bounded so it cannot become a request of its own. */
const CURSOR_KEYS = 8;
const CURSOR_VALUE_CHARS = 128;

/** The three questions, as index paths. Anything else never reaches the index. */
export function upstreamPath(resource: IndexResource, subject: { readonly address?: string; readonly hash?: string }): string | undefined {
  if (resource === 'transaction') {
    const hash = subject.hash ?? '';
    return HASH.test(hash) ? `/transactions/${hash}` : undefined;
  }

  const address = subject.address ?? '';
  return ADDRESS.test(address) ? `/addresses/${address}/${resource}` : undefined;
}

/**
 * The index's own page cursor, handed back untouched.
 *
 * Its fields change with the endpoint, so nothing here reads them. What is checked is that it is
 * still a cursor: a short, flat object of names and scalars. That is what keeps a query parameter
 * from becoming a request this route never meant to make.
 */
export function cursorQuery(raw: string | null): Readonly<Record<string, string>> | undefined {
  if (raw === null || raw === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > CURSOR_KEYS) return undefined;

  const query: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) return undefined;
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;

    const text = String(value);
    if (text.length > CURSOR_VALUE_CHARS) return undefined;
    query[name] = text;
  }

  return query;
}

/**
 * A browser request from another site.
 *
 * Every answer here is paid for with this deployment's key, and a route any page can call is that
 * key lent to any page. Browsers mark where a request came from: `Sec-Fetch-Site` in current ones,
 * `Origin` on a cross-origin fetch in the rest. A request carrying neither did not come from a
 * page at all, and a check made of headers the caller writes cannot stop that caller anyway.
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site !== 'same-origin' && site !== 'none';

  const origin = request.headers.get('origin');
  if (origin === null) return false;
  return !servedFrom(request).has(originOf(origin) ?? '');
}

/**
 * The origins this app answers on. Behind a proxy the request URL can carry the internal host, so
 * the forwarded host and the configured site count as well.
 */
function servedFrom(request: Request): ReadonlySet<string> {
  const origins = new Set<string>([new URL(request.url).origin]);
  const forwarded = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '');
  if (forwarded) origins.add(originOf(`${proto}://${forwarded.split(',')[0]!.trim()}`) ?? '');

  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) origins.add(originOf(site) ?? '');
  origins.delete('');
  return origins;
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
