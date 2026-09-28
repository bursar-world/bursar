import type { Address, Hex } from 'viem';

import { RHC } from '@/chain/rhc';
import { INDEX_ROUTE, isIndexFailure } from './index-wire';
import type { IndexErrorBody, IndexFailure, IndexResource } from './index-wire';

/**
 * The network's index, for the two questions a node will not answer.
 *
 * Robinhood Chain produces a block faster than once a second and prunes history, so a bounded
 * `eth_getLogs` scan reaches back a few minutes. A settlement history built that way would show
 * the last part of the afternoon and present it as the record. The second question is why a
 * transaction failed: a receipt carries a status and nothing else, and the revert data a treasurer
 * needs is only kept by something that traced the call.
 *
 * So history and revert reasons come from the index, and the money itself is read from the
 * contracts. Everything here degrades to nothing: when the index does not answer, a surface still
 * renders current chain state and says the timeline is unavailable. It never says nothing happened.
 *
 * The index for this chain is paid, and a key in a browser is a key given away, so these requests
 * go to this app's own route and the key stays on the server. Everything below the route is
 * unchanged and belongs here: the walk is bounded, a refusal quiets the next one, and six different
 * ways to have no history stay six different sentences. The reader whose screen is empty is on
 * this side of the boundary.
 */

const TIMEOUT_MS = 12_000;

/**
 * Pages are 50 entries and the cursor runs back to the deployment block. These surfaces show the
 * recent end of a log, so the walk stops at four pages: a contract with a long history costs the
 * same four requests as a new one, and what it cannot show is older than anything on the screen.
 */
const MAX_PAGES = 4;
const MAX_ROWS = 200;

/**
 * How long the index is left alone after it refuses.
 *
 * Three surfaces poll this on their own timers, and a timer does not know the last answer was a
 * 429. Without a pause, a rate-limited index keeps taking the same requests at the same rate and
 * never gets far enough ahead to answer one. So the wait doubles per consecutive refusal. A
 * `Retry-After` overrides it, and one good answer clears it.
 */
const BACKOFF_MS = 5_000;
const BACKOFF_CEILING_MS = 120_000;

let refusals = 0;
let silentUntil = 0;
let lastFailure: IndexFailure | undefined;
let lastHost: string | undefined;
let lastStatus: number | undefined;

export type { IndexFailure };

/** Branched on by the error surface, which is how each failure gets its own heading. */
const CODES: Readonly<Record<IndexFailure, string>> = {
  'rate-limited': 'index_rate_limited',
  refused: 'index_refused',
  unkeyed: 'index_unkeyed',
  blocked: 'index_blocked',
  unreachable: 'index_unreachable',
  'timed-out': 'index_timeout',
  malformed: 'index_malformed',
};

export class IndexUnavailable extends Error {
  readonly code: string;
  readonly failure: IndexFailure;
  /** What is true right now, in the present tense. */
  readonly condition: string;
  /** Imperative, and addressed to whoever can move it. */
  readonly nextAction: string;
  /** What the index answered, where it answered at all. */
  readonly status: number | undefined;
  /** The host that could not be read, which is not always the index. */
  readonly host: string;

  constructor(failure: IndexFailure, host: string, condition: string, nextAction: string, status?: number) {
    super(`${condition} ${nextAction}`.trim());
    this.name = 'IndexUnavailable';
    this.code = CODES[failure];
    this.failure = failure;
    this.condition = condition;
    this.nextAction = nextAction;
    this.status = status;
    this.host = host;
  }
}

/** The origin this app is served from. Absent during a server render. */
function readerOrigin(): string {
  return typeof location === 'undefined' ? 'this app' : location.origin;
}

/**
 * The failure as a reader meets it. `quietMs` is set while the pause from the last one is still
 * running, so the wait is reported against the cause that started it, never on its own.
 */
function unavailable(failure: IndexFailure, host: string, status?: number, quietMs?: number): IndexUnavailable {
  const raised = describe(failure, host, status);

  if (quietMs === undefined) return raised;

  return new IndexUnavailable(
    failure,
    host,
    `${raised.condition} Nothing is asked of it for another ${Math.ceil(quietMs / 1_000)}s.`,
    raised.nextAction,
    status,
  );
}

function describe(failure: IndexFailure, host: string, status?: number): IndexUnavailable {
  switch (failure) {
    case 'rate-limited':
      return new IndexUnavailable(
        'rate-limited',
        host,
        `${host} is metering this deployment and answered HTTP 429.`,
        'Nothing here needs fixing. The history fills in on its own once the pause ends.',
        status,
      );
    case 'unkeyed':
      // The one failure with an owner who is not on this screen. The index is not down and the
      // chain is not down: this deployment is reading a paid index and has nothing to pay with.
      return status === 401
        ? new IndexUnavailable(
            'unkeyed',
            host,
            `${host} did not accept this deployment's index key and answered HTTP 401.`,
            `BURSAR replaces BLOCKSCOUT_API_KEY on the server that serves ${readerOrigin()}. Balances and limits are read from the contracts and are unaffected.`,
            status,
          )
        : new IndexUnavailable(
            'unkeyed',
            host,
            `${host} charges for the index for ${RHC.name} and this deployment holds no key, so it answered HTTP 402.`,
            `BURSAR sets BLOCKSCOUT_API_KEY on the server that serves ${readerOrigin()}. It is read there and never reaches a browser. Balances and limits are read from the contracts and are unaffected.`,
            status,
          );
    case 'refused':
      return new IndexUnavailable(
        'refused',
        host,
        `${host} answered HTTP ${status ?? 'an error'} rather than the history.`,
        `BURSAR reads that status on the server that serves ${readerOrigin()} and points BLOCKSCOUT_API_BASE at an index for ${RHC.name}, or the console runs without a timeline.`,
        status,
      );
    case 'blocked':
      return new IndexUnavailable(
        'blocked',
        host,
        `${host} answered and this browser would not hand the response over: it carried no cross-origin permission for ${readerOrigin()}.`,
        `Nothing is rate limiting this app and waiting changes nothing. The history is read through ${INDEX_ROUTE} on this app's own origin, so something in front of BURSAR is answering for it.`,
      );
    case 'unreachable':
      return new IndexUnavailable(
        'unreachable',
        host,
        `Nothing answered at ${host}.`,
        'Check the network this browser is on. If it is fine, the server that serves this app is not answering for the history it holds the key to.',
      );
    case 'timed-out':
      return new IndexUnavailable(
        'timed-out',
        host,
        `${host} did not finish answering within ${TIMEOUT_MS / 1_000}s.`,
        'The contracts are read separately and are unaffected. Ask for the history again.',
      );
    case 'malformed':
      return new IndexUnavailable(
        'malformed',
        host,
        `${host} answered with something that is not the history this console reads.`,
        `BURSAR checks that BLOCKSCOUT_API_BASE names the index for ${RHC.name} on the server that serves this app.`,
      );
  }
}

export type IndexedLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly at: Date;
  readonly transactionHash: Hex;
  readonly logIndex: number;
};

export type IndexedTransaction = {
  readonly hash: Hex;
  readonly from: Address;
  readonly to: Address | undefined;
  readonly at: Date;
  readonly blockNumber: bigint;
  /** The calldata as sent. The first four bytes name the function that was called. */
  readonly input: Hex;
  /** The transaction was mined and the call reverted. The fee was still paid. */
  readonly failed: boolean;
};

/** What a failed call reverted with, as far as the index could decode it. */
export type RevertReading = {
  readonly selector: Hex | undefined;
  /** Present when the contract reverted with a plain string, the way a require does. */
  readonly message: string | undefined;
};

/** The most recent logs one contract has emitted, oldest first. */
export async function indexedLogs(address: Address, signal?: AbortSignal): Promise<readonly IndexedLog[]> {
  const rows = await pages<RawLog>('logs', { address }, MAX_ROWS, signal);

  return rows
    .map((row) => ({
      address: (row.address?.hash ?? row.smart_contract?.hash ?? address) as Address,
      topics: (row.topics ?? []).filter((topic): topic is Hex => typeof topic === 'string'),
      data: (row.data ?? '0x') as Hex,
      blockNumber: BigInt(row.block_number),
      at: new Date(row.block_timestamp),
      transactionHash: row.transaction_hash as Hex,
      logIndex: row.index,
    }))
    .sort(byPosition);
}

/** Transactions touching one address, newest first, successful and reverted alike. */
export async function indexedTransactions(
  address: Address,
  limit = 40,
  signal?: AbortSignal,
): Promise<readonly IndexedTransaction[]> {
  const rows = await pages<RawTransaction>('transactions', { address }, limit, signal);

  return rows.slice(0, limit).map((row) => ({
    hash: row.hash as Hex,
    from: row.from.hash as Address,
    to: row.to ? (row.to.hash as Address) : undefined,
    at: new Date(row.timestamp),
    blockNumber: BigInt(row.block_number),
    input: (row.raw_input ?? '0x') as Hex,
    failed: row.status === 'error',
  }));
}

/**
 * What one reverted transaction reverted with.
 *
 * The custom-error selector is the useful part: `0xcc70389d` is the mandate saying the daily limit
 * was exhausted, and this app already turns that selector into the name. A contract that reverted
 * with a string instead comes back as the message.
 */
export async function indexedRevert(hash: Hex, signal?: AbortSignal): Promise<RevertReading | undefined> {
  const body = await getJson(routeUrl('transaction', { hash }), signal);
  const reason = (body as { revert_reason?: unknown }).revert_reason;
  if (reason === null || reason === undefined) return undefined;

  if (typeof reason === 'string') return readRevertString(reason);

  const shaped = reason as { method_id?: unknown; method_call?: unknown; raw?: unknown };
  if (typeof shaped.method_id === 'string' && shaped.method_id.length > 0) {
    const selector = (shaped.method_id.startsWith('0x') ? shaped.method_id : `0x${shaped.method_id}`) as Hex;
    // `Error(string)` is the selector of a plain `require`, so the call it names is the message.
    if (selector.toLowerCase() === '0x08c379a0') {
      return { selector, message: typeof shaped.method_call === 'string' ? shaped.method_call : undefined };
    }
    return { selector, message: undefined };
  }

  if (typeof shaped.raw === 'string') return readRevertString(shaped.raw);
  return undefined;
}

function readRevertString(value: string): RevertReading {
  if (/^0x[0-9a-fA-F]{8,}$/.test(value)) return { selector: value.slice(0, 10) as Hex, message: undefined };
  return { selector: undefined, message: value };
}

function byPosition(a: IndexedLog, b: IndexedLog): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

type NamedAddress = { hash: string };

type RawLog = {
  address?: NamedAddress;
  smart_contract?: NamedAddress;
  topics: (string | null)[];
  data: string;
  block_number: number;
  block_timestamp: string;
  transaction_hash: string;
  index: number;
};

type RawTransaction = {
  hash: string;
  from: NamedAddress;
  to: NamedAddress | null;
  timestamp: string;
  block_number: number;
  raw_input?: string;
  status: string;
};

type Page<T> = { items?: T[]; next_page_params?: Record<string, string | number> | null };

type Subject = { readonly address?: Address; readonly hash?: Hex };

function routeUrl(resource: IndexResource, subject: Subject, cursor?: Record<string, string | number> | null): string {
  const query = new URLSearchParams({ resource });
  if (subject.address !== undefined) query.set('address', subject.address);
  if (subject.hash !== undefined) query.set('hash', subject.hash);
  if (cursor !== undefined && cursor !== null) query.set('cursor', JSON.stringify(cursor));

  return `${INDEX_ROUTE}?${query.toString()}`;
}

/**
 * Follows the index's cursor until it stops, `enough` rows are in hand, or the page ceiling is
 * reached, whichever comes first.
 *
 * The cursor is opaque. Its fields change with the endpoint, so they go straight back untouched.
 * Paging is bounded, which is what stops a contract with a long history turning one screen into a
 * hundred requests, and on a paid index it is also what stops one screen becoming a bill.
 */
async function pages<T>(
  resource: IndexResource,
  subject: Subject,
  enough = MAX_ROWS,
  signal?: AbortSignal,
): Promise<readonly T[]> {
  const rows: T[] = [];
  let cursor: Record<string, string | number> | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = (await getJson(routeUrl(resource, subject, cursor), signal)) as Page<T>;

    if (!Array.isArray(body.items)) throw unavailable('malformed', readerOrigin());
    rows.push(...body.items);

    cursor = body.next_page_params ?? null;
    if (cursor === null || rows.length >= enough) break;
  }

  return rows;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const quiet = silentUntil - Date.now();
  if (quiet > 0 && lastFailure !== undefined) {
    // The pause is repeated with the cause that started it. An index that charges for the answer,
    // reported as "it refused the last request", sends an operator after a rate meter that never
    // fired and leaves the key that is missing unmentioned.
    throw unavailable(lastFailure, lastHost ?? readerOrigin(), lastStatus, quiet);
  }

  let response: Response;
  try {
    response = await fetch(url, { signal: deadline(signal), headers: { accept: 'application/json' } });
  } catch (caught) {
    // A read the reader walked away from is not the index failing, and holding it against the
    // index would silence the next screen they open.
    if (signal?.aborted === true) throw caught;

    const failure = await whyFetchFailed(url, caught);
    backOff(failure, readerOrigin());
    throw unavailable(failure, readerOrigin());
  }

  if (!response.ok) {
    // The route knows which host refused and what it answered, because it is the half that talked
    // to the index. Every refusal counts toward the pause either way: a paid index answers 402 to
    // each of these polls as steadily as a busy one answers 429, and the answer to both is to stop
    // asking for a while. They stay two different problems and are never reported as one.
    const reported = await reportedFailure(response);
    backOff(reported.failure, reported.host, retryAfter(response), reported.status);
    throw unavailable(reported.failure, reported.host, reported.status);
  }

  refusals = 0;
  silentUntil = 0;
  lastFailure = undefined;
  lastHost = undefined;
  lastStatus = undefined;

  try {
    return await response.json();
  } catch {
    throw unavailable('malformed', readerOrigin());
  }
}

/** What the route said went wrong, or what its status alone says when the body is not its own. */
async function reportedFailure(response: Response): Promise<Required<IndexErrorBody>> {
  const fallback: Required<IndexErrorBody> = {
    failure: response.status === 429 ? 'rate-limited' : response.status === 402 || response.status === 401 ? 'unkeyed' : 'refused',
    host: readerOrigin(),
    status: response.status,
  };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fallback;
  }

  if (typeof body !== 'object' || body === null) return fallback;
  const shaped = body as Partial<IndexErrorBody>;
  if (!isIndexFailure(shaped.failure)) return fallback;

  return {
    failure: shaped.failure,
    host: typeof shaped.host === 'string' && shaped.host !== '' ? shaped.host : fallback.host,
    status: typeof shaped.status === 'number' ? shaped.status : response.status,
  };
}

/**
 * Why a fetch rejected, which the browser will not say.
 *
 * `fetch` rejects with the same TypeError whether nothing answered or something answered and the
 * browser refused to hand the response over for want of a cross-origin header. Those have
 * different owners and different fixes, so they are separated by asking the same URL again with
 * the cross-origin check off: an opaque answer means the host is up and its headers are the
 * problem. A second failure means nothing is there.
 */
export async function whyFetchFailed(url: string, caught: unknown): Promise<IndexFailure> {
  if (caught instanceof DOMException && caught.name === 'TimeoutError') return 'timed-out';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'unreachable';

  try {
    await fetch(url, { mode: 'no-cors', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return 'blocked';
  } catch {
    return 'unreachable';
  }
}

/** Forgets the pause and the cause behind it. For a reader who asked again by hand, and for tests. */
export function resetIndexBackoff(): void {
  refusals = 0;
  silentUntil = 0;
  lastFailure = undefined;
  lastHost = undefined;
  lastStatus = undefined;
}

function deadline(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function backOff(failure: IndexFailure, host: string, asked?: number, status?: number): void {
  refusals += 1;
  lastFailure = failure;
  lastHost = host;
  lastStatus = status;
  const doubled = BACKOFF_MS * 2 ** (refusals - 1);
  silentUntil = Date.now() + Math.min(Math.max(doubled, asked ?? 0), BACKOFF_CEILING_MS);
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;

  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
}
