/** The console, which is the one browser page that calls this service. */
export const DEFAULT_ORIGIN = 'https://app.bursar.world';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export type OriginPolicy = {
  readonly allowed: ReadonlySet<string>;
  /** Pages served from this machine may call a listener bound to it. */
  readonly loopback: boolean;
};

export function isLoopback(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOSTS.has(host);
}

/**
 * Reads the comma-separated allowlist. Each entry has to be an http or https origin, and is kept
 * as the browser will send it, so `https://App.Bursar.World/` matches `https://app.bursar.world`.
 */
export function originPolicy(variable: string, list: string | undefined, host: string | undefined): OriginPolicy {
  const allowed = new Set<string>();
  for (const entry of (list ?? DEFAULT_ORIGIN).split(',')) {
    const raw = entry.trim();
    if (raw === '') continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${variable} holds "${raw}", which is not an origin such as https://app.example.`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error(`${variable} holds "${raw}", which is not an origin such as https://app.example.`);
    }
    allowed.add(url.origin);
  }
  return { allowed, loopback: isLoopback(host) };
}

/** The origin to echo in access-control-allow-origin, or null when the page may not call here. */
export function allowedOrigin(policy: OriginPolicy, origin: string | undefined): string | null {
  if (origin === undefined) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (policy.allowed.has(url.origin)) return url.origin;
  if (policy.loopback && LOOPBACK_HOSTS.has(url.hostname.replace(/^\[(.*)\]$/, '$1'))) return url.origin;
  return null;
}
