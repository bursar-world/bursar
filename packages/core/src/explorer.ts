import type { Address, Hex } from 'viem';
import { RHC_MAINNET } from './chain.js';
import type { RhcChain } from './chain.js';
import { BursarError } from './errors.js';
import type { EnvSource } from './env.js';

/**
 * Robinhood Chain has two block explorers and they are not interchangeable.
 *
 * `robinhoodchain.blockscout.com` is where a person goes. It sits behind a Cloudflare JS
 * challenge, so a browser with a human in front of it gets through and a fetch from a service
 * gets an HTML interstitial that parses as neither JSON nor an error.
 *
 * `api.blockscout.com/4663/api/v2` is where code goes. It is a paid tier: without a key it
 * answers `402` with `{"error":"Proceed with API key or make a X402 payment to continue"}`. The
 * key is a server-side secret, so index reads run on a server and the browser calls that server.
 *
 * The two live behind separate names here, take different argument types, and the index client
 * refuses to build its URL from a chain record's explorer field. A caller that confuses them gets
 * a compile error or a named refusal, where the confusion used to surface as an explorer's HTML
 * interstitial parsed as index data.
 */

/** Where a person is sent. Link to these; never fetch them. */
export function explorerTxUrl(chain: RhcChain, hash: Hex): string {
  return `${trimSlash(chain.explorer)}/tx/${hash}`;
}

export function explorerAddressUrl(chain: RhcChain, address: Address): string {
  return `${trimSlash(chain.explorer)}/address/${address}`;
}

export function explorerBlockUrl(chain: RhcChain, block: bigint | number): string {
  return `${trimSlash(chain.explorer)}/block/${block.toString()}`;
}

export function explorerTokenUrl(chain: RhcChain, token: Address): string {
  return `${trimSlash(chain.explorer)}/token/${token}`;
}

/** Host of the human explorer, kept for the guard below rather than for building URLs. */
const HUMAN_EXPLORER_HOST = new URL(RHC_MAINNET.explorer).hostname.toLowerCase();

/** The hosted Blockscout index. Per chain id, so it cannot be pointed at the wrong network. */
export function indexApiBase(chainId: number): string {
  return `https://api.blockscout.com/${chainId}/api/v2`;
}

export const RHC_INDEX_API_BASE = indexApiBase(RHC_MAINNET.chainId);

/** Names the variables this client reads, so an operator can be told all of them at once. */
export const INDEX_ENV = Object.freeze({
  apiKey: 'BLOCKSCOUT_API_KEY',
  apiBase: 'BLOCKSCOUT_API_BASE',
} as const);

/**
 * Constructed in something that looks like a browser.
 *
 * This is the defect the split exists to prevent. An index client in a client bundle needs the
 * key in the bundle, and a key in client JavaScript is public. Index reads belong on a server
 * that the browser calls.
 */
export class IndexClientInBrowser extends BursarError {
  constructor(detail: string) {
    super(
      'index_browser_refused',
      `The Blockscout index client will not run in a browser: ${detail}. It authenticates with ` +
        `${INDEX_ENV.apiKey}, and a key shipped in client JavaScript is a published key. Read the ` +
        `index from a server route and have the browser call that.`,
      { detail },
    );
  }
}

export class MissingIndexKey extends BursarError {
  constructor() {
    super(
      'index_key_missing',
      `${INDEX_ENV.apiKey} is not set. The hosted Blockscout index is a paid tier and answers 402 ` +
        `without a key, so an unconfigured service would report every lookup as an outage. Set it ` +
        `in the server environment.`,
      { variable: INDEX_ENV.apiKey },
    );
  }
}

/**
 * The index answered, and not with data. `402` is its own case because it is about the key: a
 * service that reports it as a lookup failure sends an operator looking at the wrong thing.
 */
export class IndexRequestError extends BursarError {
  readonly status: number;
  /**
   * How long the index asked to be left alone, from its `Retry-After` header, or undefined when
   * it did not say. Carried on the error because the header is on the response and the response
   * does not survive the throw. Without it a caller either ignores what the index asked for or
   * reaches back through the fetch it passed in to catch the header on the way past.
   */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, path: string, detail: string, retryAfterMs?: number) {
    super(
      'index_request_failed',
      status === 402
        ? `The Blockscout index refused ${path} with 402. ${INDEX_ENV.apiKey} is missing, wrong or ` +
            `out of quota; the query itself is fine.`
        : `The Blockscout index answered ${status} for ${path}: ${detail}`,
      { status, path, detail, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
    );
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type IndexQuery = Readonly<Record<string, string | number | boolean | undefined>>;

export type IndexClient = {
  /** Carries no key. Safe to log and safe to show in an error. */
  readonly baseUrl: string;
  /**
   * One GET against the index. `path` is relative to the base, so a caller cannot redirect the
   * key at another host by passing an absolute URL.
   */
  get<T>(path: string, query?: IndexQuery): Promise<T>;
};

export type IndexClientOptions = {
  /** Defaults to 4663. Changes the base URL, because the index is keyed by chain. */
  readonly chainId?: number;
  /** Overrides the whole base. For a self-hosted Blockscout, not for pointing at the human site. */
  readonly baseUrl?: string;
  /** Read from the environment when absent. Never write one into a call site. */
  readonly apiKey?: string;
  readonly source?: EnvSource;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A client for the machine-readable index, which refuses to exist anywhere the key would leak.
 *
 * It checks three things before it will build: that it is not running in a browser, that no
 * browser-visible variable is carrying the key, and that the base URL is not the human explorer.
 * Each of those is a way this has gone wrong somewhere before, and each is silent at runtime:
 * a key in a bundle looks like a working feature, and an HTML challenge page looks like an
 * unparseable response from an endpoint that was fine yesterday.
 */
export function createIndexClient(options: IndexClientOptions = {}): IndexClient {
  refuseBrowser();

  const source = options.source ?? process.env;
  refusePublicKeyVariable(source);

  const baseUrl = trimSlash(options.baseUrl ?? readBase(source) ?? indexApiBase(options.chainId ?? RHC_MAINNET.chainId));
  const host = hostOfOrThrow(baseUrl);
  if (host === HUMAN_EXPLORER_HOST) {
    throw new BursarError(
      'index_base_is_human_explorer',
      `${baseUrl} is the explorer people read, not the index code reads. It answers a Cloudflare ` +
        `JS challenge, so a fetch gets an HTML page rather than JSON or an error. Use ` +
        `${RHC_INDEX_API_BASE}.`,
      { baseUrl, host },
    );
  }

  const apiKey = (options.apiKey ?? source[INDEX_ENV.apiKey])?.trim();
  if (!apiKey) throw new MissingIndexKey();

  const doFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    baseUrl,
    async get<T>(path: string, query?: IndexQuery): Promise<T> {
      const url = new URL(joinPath(baseUrl, path));
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      const response = await doFetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          // Bearer rather than the apikey query parameter the index also accepts. Both
          // authenticate; only one of them keeps the key out of URLs, and URLs end up in access
          // logs, error messages and anything that reports a failing request.
          authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 200);
        throw new IndexRequestError(response.status, path, body, retryAfterMs(response));
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BursarError(
          'index_bad_body',
          `The Blockscout index answered ${path} with a body that is not JSON.`,
          { path, preview: text.slice(0, 200) },
        );
      }
    },
  };
}

function refuseBrowser(): void {
  const global = globalThis as { window?: unknown; document?: unknown };
  if (global.window !== undefined && global.document !== undefined) {
    throw new IndexClientInBrowser('window and document are both defined');
  }
}

/**
 * A key under a browser-visible name is already public, whether or not this client is the thing
 * that reads it. Next.js inlines every `NEXT_PUBLIC_` variable into the client bundle at build
 * time, so the mistake is made at configuration and discovered in a bundle.
 */
function refusePublicKeyVariable(source: EnvSource): void {
  for (const name of Object.keys(source)) {
    if (name.startsWith('NEXT_PUBLIC_') && name.includes('BLOCKSCOUT')) {
      throw new IndexClientInBrowser(
        `${name} is set, and every NEXT_PUBLIC_ variable is compiled into the browser bundle`,
      );
    }
  }
}

function readBase(source: EnvSource): string | undefined {
  const declared = source[INDEX_ENV.apiBase]?.trim();
  return declared === '' ? undefined : declared;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The host, once the URL is known to be one the key may travel to.
 *
 * Every request carries the API key in a header, so a plain-http base sends it in the clear to
 * anything on the path. Loopback is the one exception, for a local stand-in during development.
 */
function hostOfOrThrow(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BursarError('index_base_invalid', `${url} is not a URL.`, { baseUrl: url });
  }
  const host = parsed.hostname.toLowerCase();
  const secure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(host));
  if (!secure) {
    throw new BursarError(
      'index_base_insecure',
      `${url} is not an https URL. The index client sends ${INDEX_ENV.apiKey} with every request, ` +
        `so only https is accepted, or http on localhost.`,
      { baseUrl: url },
    );
  }
  return host;
}

function joinPath(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    throw new BursarError(
      'index_path_absolute',
      `"${path}" is an absolute URL. The index client takes a path relative to ${baseUrl} so that ` +
        `no caller can send the API key to another host.`,
      { path, baseUrl },
    );
  }
  return `${baseUrl}/${path.replace(/^\/+/, '')}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * `Retry-After` in milliseconds. The header is either a whole number of seconds or an HTTP date,
 * and a reader that handles only the first silently ignores the second and backs off on its own
 * guess instead of what was asked for. A date already in the past, or a value that is neither
 * form, is no instruction at all.
 */
function retryAfterMs(response: Response, now: number = Date.now()): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  if (header === undefined || header === '') return undefined;

  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return seconds > 0 ? seconds * 1_000 : undefined;
  }

  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;

  const wait = at - now;
  return wait > 0 ? wait : undefined;
}
