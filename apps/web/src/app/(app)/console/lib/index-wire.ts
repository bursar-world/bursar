/**
 * What the browser and the route handler agree on about the network index.
 *
 * The index for Robinhood Chain is paid. A key in client JavaScript is a key given away, so the
 * browser talks to this app and this app talks to the index. Both halves need the same vocabulary
 * for what went wrong, and this is it: no request code, no response code, nothing that drags the
 * server module into the bundle.
 */

/** The route every index read in the browser goes to. Same origin, and it holds no key. */
export const INDEX_ROUTE = '/api/index';

/** The three questions this product asks the index. Anything else is refused before a key is used. */
export const INDEX_RESOURCES = ['logs', 'transactions', 'transaction'] as const;

export type IndexResource = (typeof INDEX_RESOURCES)[number];

/**
 * Why there is no reading, told apart.
 *
 * `rate-limited` is the index metering this deployment: it answered, and the answer was to wait.
 * `unkeyed` is the index charging for the answer and this deployment having nothing to pay with,
 * which is an operator's problem and not an outage. `refused` is the index answering with a status
 * of its own. `blocked` is a host answering and the browser refusing to hand the response over for
 * want of a cross-origin header. `unreachable` is nothing answering at all.
 */
export const INDEX_FAILURES = [
  'rate-limited',
  'refused',
  'unkeyed',
  'blocked',
  'unreachable',
  'timed-out',
  'malformed',
] as const;

export type IndexFailure = (typeof INDEX_FAILURES)[number];

/** What the route handler answers with when it has no reading to pass on. */
export type IndexErrorBody = {
  readonly failure: IndexFailure;
  /** The host the route could not get an answer out of, so the browser can name it. */
  readonly host: string;
  /** What the index answered, where it answered at all. */
  readonly status?: number;
};

export function isIndexFailure(value: unknown): value is IndexFailure {
  return typeof value === 'string' && (INDEX_FAILURES as readonly string[]).includes(value);
}

export function isIndexResource(value: unknown): value is IndexResource {
  return typeof value === 'string' && (INDEX_RESOURCES as readonly string[]).includes(value);
}
