import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hex } from 'viem';

import { canonicalStringify, capabilityId, commitCanonical } from './commit.js';
import { describeError } from './log.js';

export type CapabilityRoute = {
  readonly capability: string;
  readonly method: string;
  readonly path: string;
};

/** Keyed by `capabilityId`, because that is what the lock carries. */
export type RouteTable = ReadonlyMap<Hex, CapabilityRoute>;

export type LockJob = {
  readonly id: bigint;
  readonly capabilityId: Hex;
  readonly inputCommit: Hex;
  readonly inputURI: string;
};

/** What a release commits to: the hash that settles the lock, and where the bytes can be read. */
export type CommittedOutput = {
  readonly kind: 'executed';
  readonly outputCommit: Hex;
  readonly outputURI: string;
  readonly outputBytes: number;
};

/**
 * `rejected` is final for the lock: the input or the capability is wrong and no retry can fix it.
 * `failed` is a transient fault, so the watcher tries again while the deadline holds.
 */
export type ExecutionOutcome =
  | CommittedOutput
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** `inputCommit` is stored beside the output, so a restart can tell whose input it answered. */
export type OutputWriter = (id: bigint, canonicalOutput: string, inputCommit: Hex) => Promise<void>;

/**
 * An output read back, with the input commitment it was written for. Null when nothing recorded
 * one, which no output this build writes can be.
 */
export type StoredOutput = CommittedOutput & { readonly inputCommit: Hex | null };

export type OutputReader = (id: bigint) => Promise<StoredOutput | null>;

export type FetchPolicy = {
  readonly fetch: FetchLike;
  readonly fetchTimeoutMs: number;
  readonly maxBodyBytes: number;
};

export type ExecutorOptions = FetchPolicy & {
  readonly routes: RouteTable;
  readonly apiBase: string;
  readonly allowedHosts: ReadonlySet<string>;
  readonly writeOutput: OutputWriter;
  /**
   * Above this the output travels by commitment instead of in calldata. The chain charges 16 gas
   * per non-zero calldata byte, so a 32 KB inline output costs more in gas than the whole
   * lock-and-release round trip does.
   */
  readonly maxInlineOutputBytes: number;
  /** Where an output too large to inline can be fetched. Unset means the commitment travels alone. */
  readonly outputBaseUrl: string | undefined;
};

const DATA_URI_PREFIX = 'data:application/json;base64,';
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** A request body is illegal on these, so such a route would call the API without the input. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

class Rejection extends Error {}

/**
 * Fetches the committed input, proves it hashes to `inputCommit`, calls the capability, and
 * returns what the watcher needs for `release`. A mismatched commitment is the payer's problem: it
 * is rejected here and the lock is left to run to its own timeout.
 */
export async function executeJob(
  job: LockJob,
  options: ExecutorOptions,
  signal?: AbortSignal,
): Promise<ExecutionOutcome> {
  const route = options.routes.get(job.capabilityId);
  if (!route) {
    return { kind: 'rejected', reason: `unknown capability ${job.capabilityId}` };
  }

  try {
    const input = await readInput(job, options, signal);
    const output = await callCapability(route, canonicalStringify(input), options, signal);
    const canonicalOutput = canonicalStringify(output);

    await options.writeOutput(job.id, canonicalOutput, job.inputCommit);

    return {
      kind: 'executed',
      outputCommit: commitCanonical(output),
      outputURI: outputURI(job.id, canonicalOutput, options),
      outputBytes: Buffer.byteLength(canonicalOutput, 'utf8'),
    };
  } catch (error) {
    const reason = describeError(error);

    return error instanceof Rejection ? { kind: 'rejected', reason } : { kind: 'failed', reason };
  }
}

async function readInput(job: LockJob, options: ExecutorOptions, signal: AbortSignal | undefined): Promise<unknown> {
  const body = await readInputURI(job.inputURI, options, signal);

  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    throw new Rejection('input is not valid JSON');
  }

  const commit = commitCanonical(input);
  if (commit.toLowerCase() !== job.inputCommit.toLowerCase()) {
    throw new Rejection(`input commitment mismatch: fetched ${commit}, escrow ${job.inputCommit}`);
  }

  return input;
}

/**
 * Deny by default. Base64 data URIs are self-contained, HTTP is limited to the configured hosts,
 * and every other scheme, `file:` included, is rejected before any read.
 *
 * Loopback is not implied. The input URI is written by the payer, so an implicit loopback entry is
 * a payer reaching whatever this host serves to itself: the capability API, a metrics port, a cloud
 * metadata proxy. An operator who fetches inputs from this machine lists it.
 */
async function readInputURI(uri: string, options: ExecutorOptions, signal: AbortSignal | undefined): Promise<string> {
  if (uri.slice(0, DATA_URI_PREFIX.length).toLowerCase() === DATA_URI_PREFIX) {
    return decodeDataURI(uri.slice(DATA_URI_PREFIX.length), options.maxBodyBytes);
  }

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Rejection('input URI is not a URI');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Rejection(`input URI scheme ${url.protocol} is not allowed`);
  }

  if (url.username !== '' || url.password !== '') {
    throw new Rejection('input URI carries credentials');
  }

  const host = normalizeHost(url.hostname);
  if (!options.allowedHosts.has(host)) {
    throw new Rejection(`input URI host ${host} is not allowed`);
  }

  return fetchJson(url.toString(), { method: 'GET', permanent: permanentFromPayer, signal }, options);
}

/**
 * The form a host is compared in. `URL` keeps the brackets on an IPv6 literal, so `http://[::1]/`
 * has the hostname `[::1]` and never matches an allowlist entry written as `::1`.
 */
export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function decodeDataURI(payload: string, maxBodyBytes: number): string {
  if (!BASE64_PATTERN.test(payload)) {
    throw new Rejection('input data URI is not base64');
  }

  const bytes = Buffer.from(payload, 'base64');
  if (bytes.byteLength > maxBodyBytes) {
    throw new Rejection(`input data URI exceeds ${maxBodyBytes} bytes`);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Rejection('input data URI is not UTF-8');
  }
}

async function callCapability(
  route: CapabilityRoute,
  canonicalInput: string,
  options: ExecutorOptions,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const url = `${options.apiBase}${route.path}`;
  const body = await fetchJson(
    url,
    { method: route.method, body: canonicalInput, permanent: permanentFromCapability, signal },
    options,
  );

  try {
    return JSON.parse(body);
  } catch {
    throw new Rejection(`${route.capability} returned invalid JSON`);
  }
}

type JsonRequest = {
  readonly method: string;
  readonly body?: string | undefined;
  /**
   * Which statuses mean "and no retry will change that".
   *
   * It differs by who is answering. A payer's input URI that returns 404 is a commitment nobody
   * can fetch and the lock is left to time out. The operator's own capability API returning 404 is
   * almost always the operator: a deployment mid-roll, a gateway that has not picked up the route
   * yet, a container restarting. Treating that as final abandons every lock held at the time, and
   * the payee loses work it could have delivered a few seconds later.
   */
  readonly permanent: (status: number) => boolean;
  /** The shutdown signal. A capability call that outlives SIGTERM holds the process open. */
  readonly signal?: AbortSignal | undefined;
};

/** A payer's URI that answers anything but "busy" is not going to answer differently. */
const permanentFromPayer = (status: number): boolean => status < 500 && status !== 408 && status !== 429;

/**
 * The capability API is the operator's own. Only a refusal of the input itself is final: 400 and
 * 422 are the service saying it read the request and will not do it, and repeating it changes
 * nothing. Everything else is the deployment, and the lock's own deadline is the thing that ends
 * the retrying.
 */
const permanentFromCapability = (status: number): boolean => status === 400 || status === 422;

async function fetchJson(url: string, request: JsonRequest, policy: FetchPolicy): Promise<string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await policy.fetch(url, {
    method: request.method,
    body: request.body,
    headers,
    redirect: 'error',
    signal:
      request.signal === undefined
        ? AbortSignal.timeout(policy.fetchTimeoutMs)
        : AbortSignal.any([AbortSignal.timeout(policy.fetchTimeoutMs), request.signal]),
  });

  // `redirect: "error"` already rejects a redirect. The flag is checked as well so a fetch
  // implementation that ignores the option cannot widen the allowlist through a Location header.
  if (response.redirected) {
    throw new Rejection(`${url} redirected`);
  }

  if (!response.ok) {
    const detail = `${url} answered ${response.status}`;
    throw request.permanent(response.status) ? new Rejection(detail) : new Error(detail);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new Rejection(`${url} answered with content-type ${mediaType || 'none'}`);
  }

  return readCapped(response, policy.maxBodyBytes);
}

/**
 * Enforces the cap chunk by chunk and cancels the stream on the first byte over it, so an
 * unbounded response is never buffered even when it lies about `content-length`.
 */
async function readCapped(response: Response, maxBodyBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBodyBytes) {
    throw new Rejection(`response declares more than ${maxBodyBytes} bytes`);
  }

  const body = response.body;
  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      total += chunk.value.byteLength;
      if (total > maxBodyBytes) {
        throw new Rejection(`response exceeds ${maxBodyBytes} bytes`);
      }

      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(merged);
  } catch {
    throw new Rejection('response is not UTF-8');
  }
}

export type OutputUriPolicy = {
  readonly maxInlineOutputBytes: number;
  readonly outputBaseUrl: string | undefined;
};

/**
 * Small outputs ride along in calldata. Larger ones point at the sidecar's own published copy when
 * one is configured, and otherwise travel as a bare commitment: the hash binds the output either
 * way, and a payer that cannot fetch it can still verify it once the provider hands it over.
 */
export function outputURI(id: bigint, canonicalOutput: string, policy: OutputUriPolicy): string {
  const bytes = Buffer.from(canonicalOutput, 'utf8');
  if (bytes.byteLength <= policy.maxInlineOutputBytes) {
    return `${DATA_URI_PREFIX}${bytes.toString('base64')}`;
  }

  return policy.outputBaseUrl === undefined ? '' : `${policy.outputBaseUrl}/${id}.json`;
}

/**
 * Writes `<id>.json` under the output directory, creating the directory on first use, with the
 * input commitment it answered in `<id>.input` beside it.
 *
 * An existing file is never overwritten. Once a lock has been released, the commitment on chain
 * names those exact bytes, and a published copy that no longer hashes to it is worse than no copy
 * at all: the payer can neither verify the work nor tell that it changed.
 *
 * The input commitment goes down first. An output is only ever reused for the lock whose input it
 * was computed from, and a restart has no other way to know which input that was.
 */
export function createOutputWriter(directory: string): OutputWriter {
  return async (id, canonicalOutput, inputCommit) => {
    await mkdir(directory, { recursive: true });

    const commit = inputCommit.toLowerCase();
    const recorded = await placeOnce(join(directory, `${id}.input`), `${commit}\n`);
    if (recorded !== undefined && recorded.trim() !== commit) {
      throw new Rejection(
        `Lock ${id} already has an output recorded for input ${recorded.trim()}, and this lock's input is ${commit}`,
      );
    }

    const stored = await placeOnce(join(directory, `${id}.json`), canonicalOutput);
    if (stored !== undefined && stored !== canonicalOutput) {
      throw new Error(`Lock ${id} already has an output and this run produced different bytes`);
    }
  };
}

/**
 * Puts bytes at a path that must never be overwritten, and returns what was already there if it
 * was taken.
 *
 * The bytes go to a neighbouring file first, are flushed, and are linked into place, which is one
 * step the filesystem either did or did not take. Writing straight to the path is not: a process
 * killed partway leaves a file that has the name, will never be overwritten because it exists, and
 * does not parse when it is read back. `link` refuses a name that is taken, which is the reason
 * this is not a `rename`: a rename would replace bytes the chain has already committed to.
 */
async function placeOnce(path: string, text: string): Promise<string | undefined> {
  const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;

  try {
    const handle = await open(staging, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      // Without it a power cut can leave the linked name pointing at a file with no bytes in it.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(staging, path);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readFile(path, 'utf8');
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

/**
 * The output this payee already committed to for a lock, if it has one.
 *
 * The commitment lives on chain and the bytes live here, so a restart mid-lock reads them back.
 * Running the job again would commit to a second answer the payer never agreed to.
 *
 * A stored file that does not parse is reported by name rather than as a bare `SyntaxError` from
 * somewhere inside a poll. Writing through a staging file means a half-written one cannot be
 * produced here any more, so what is left is a file something else damaged, and the operator has
 * to be able to see which one.
 */
export function createOutputReader(directory: string, policy: OutputUriPolicy): OutputReader {
  return async (id) => {
    const path = join(directory, `${id}.json`);

    const stored = await readIfPresent(path);
    if (stored === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      throw new Error(
        `The stored output for lock ${id} at ${path} is not JSON: ${describeError(error)}. The commitment on chain names those exact bytes, so it cannot be regenerated; restore the file or remove it to let the lock run to its own timeout.`,
      );
    }

    const input = await readIfPresent(join(directory, `${id}.input`));

    return {
      kind: 'executed',
      outputCommit: commitCanonical(parsed),
      outputURI: outputURI(id, stored, policy),
      outputBytes: Buffer.byteLength(stored, 'utf8'),
      inputCommit: input === null ? null : (input.trim() as Hex),
    };
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The route table, which this service will not start without.
 *
 * It is as required as the variables the environment carries, but its absence reads as a path
 * that is not there. The message says what the file is for and names the one in
 * this package to copy, because an operator meeting this has no way to guess the shape from a
 * missing-file error.
 */
export async function readRoutes(path: string): Promise<RouteTable> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(
      missing
        ? `No capabilities file at ${path}. It declares the work this payee sells, keyed by "name:version", ` +
            'and a capability absent from it is never executed. Copy capabilities.example.json from ' +
            '@bursar/sidecar to that path, or set CAPABILITIES_PATH to where yours lives.'
        : `Cannot read capabilities from ${path}: ${describeError(error)}`,
    );
  }

  try {
    return parseRoutes(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `${path} is not valid JSON: ${describeError(error)}. It holds one object keyed by ` +
          '"name:version", in the shape of capabilities.example.json.',
      );
    }
    throw error;
  }
}

/**
 * Turns the `"name:version"` keys of the capabilities file into the ids the escrow emits. A
 * capability absent here is never executed, so the map is the payee's whole surface.
 */
export function parseRoutes(source: unknown): RouteTable {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('Capabilities must be a JSON object');
  }

  const routes = new Map<Hex, CapabilityRoute>();

  for (const [capability, value] of Object.entries(source)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Capability ${capability} must map to an object`);
    }

    const entry = value as Record<string, unknown>;
    const path = entry['path'];
    const method = entry['method'] ?? 'POST';

    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error(`Capability ${capability} needs a path beginning with "/"`);
    }

    if (typeof method !== 'string' || method.trim() === '') {
      throw new Error(`Capability ${capability} has an unusable method`);
    }

    const normalized = method.trim().toUpperCase();
    if (BODYLESS_METHODS.has(normalized)) {
      throw new Error(`Capability ${capability} cannot be routed over ${normalized}: it carries no request body`);
    }

    routes.set(capabilityId(capability), { capability, method: normalized, path });
  }

  return routes;
}
