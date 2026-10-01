/**
 * The network's index, because the node will not answer the question a settlement history asks.
 *
 * Robinhood Chain produces sub-second blocks and the node caps one `eth_getLogs` at a range it
 * will not exceed, so a scan that stays inside the cap covers a short window while a settlement
 * an agent is chasing is days old. Asking for a wider range is refused outright. A history built
 * that way would show the recent end of the log and present it as the record. How far one scan
 * reaches on 4663 has not been measured, and a figure from another chain does not carry over.
 *
 * Blockscout's hosted index is what this reads instead, through `createIndexClient` in
 * `@bursar/core`: the machine-readable host behind an API key, never the explorer people read,
 * which answers a browser challenge rather than JSON. The money itself is still read from the
 * contracts: an index is a copy, and a copy is the wrong thing to answer "where are these funds"
 * with.
 */

import { IndexRequestError, MissingIndexKey, createIndexClient, isBursarError } from '@bursar/core';
import type { EnvSource, IndexClient } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { ToolError } from './errors.js';

export type IndexedLog = {
  /** The contract that emitted it. */
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
};

export type LogPage = {
  /** Newest first, which is the order a settlement history is read in. */
  readonly logs: readonly IndexedLog[];
  /** The oldest block this page reached. Null when the index held nothing for the address. */
  readonly oldestBlock: bigint | null;
  /** The index still had history behind what it returned. */
  readonly truncated: boolean;
};

export type LogQuery = {
  /** Read at this block and below. Null starts at the newest the index holds. */
  readonly before: bigint | null;
  readonly maxRows: number;
};

/** What the gateway reads history through. The server binds it to Blockscout; a test binds a double. */
export type SettlementIndex = {
  logsOf(address: Address, query: LogQuery): Promise<LogPage>;
};

export type ExplorerIndexOptions = {
  /** The chain whose index to read. The hosted index is keyed by chain id. */
  readonly chainId?: number;
  /** The machine-readable base, for example `https://api.blockscout.com/4663/api/v2`. */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly source?: EnvSource;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
};

const TIMEOUT_MS = 12_000;

/**
 * Pages are 50 rows and the cursor runs back to the account's first transaction. A listing shows
 * the recent end of a log, so the walk stops at four pages. An account with a long history costs
 * the same four requests as a new one, and what it cannot reach is older than anything the caller
 * asked for. The cursor in the reply is there for the rest.
 */
const MAX_PAGES = 4;
const PAGE_ROWS = 50;

/**
 * How long the index is left alone after it refuses.
 *
 * A model retries on its own schedule and that schedule does not know the last answer was a 429.
 * Without a pause the rate-limited case sends the same requests at the same rate and the index
 * never gets far enough ahead to answer one. The wait doubles per consecutive refusal, a
 * `Retry-After` overrides it when the index sends one, and a single good answer clears it.
 */
const BACKOFF_MS = 5_000;
const BACKOFF_CEILING_MS = 120_000;

type NamedAddress = { hash?: unknown };

type RawLog = {
  address?: NamedAddress;
  smart_contract?: NamedAddress;
  topics?: unknown;
  data?: unknown;
  block_number?: unknown;
  transaction_hash?: unknown;
  index?: unknown;
};

type RawPage = { items?: unknown; next_page_params?: unknown };

type Cursor = Readonly<Record<string, string | number>>;

/**
 * What the last refusal was about, because the two have different owners.
 *
 * A busy index is something to wait out. A 402 means the key is missing, wrong or out of quota,
 * and waiting does nothing about any of those: the operator has to set it. Reporting the second
 * as the first is how a service that was never configured gets read as a network having a bad
 * day.
 */
type Refusal = 'key' | 'other';

export function createExplorerIndex(options: ExplorerIndexOptions = {}): SettlementIndex {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  let client: IndexClient | null = null;
  let refusals = 0;
  let silentUntil = 0;
  let lastRefusal: Refusal = 'other';

  function unavailable(said: string): ToolError {
    const detail = withoutStop(said);

    return new ToolError(
      'history_unavailable',
      `The settlement history is kept by the network's index, and it did not answer: ${detail}. ` +
        'Every other read is unaffected: mandate_get_settlement still reports one settlement from ' +
        'the contracts by id, and mandate_inspect still reports the budgets. Try the listing again ' +
        'in a minute.',
      { detail },
    );
  }

  /**
   * A refusal only the operator can clear. Named apart from `unavailable` so an agent does not
   * retry a key into existence, and so the reply says who has to act.
   */
  function keyProblem(said: string): ToolError {
    const detail = withoutStop(said);

    return new ToolError(
      'history_key_missing',
      `The settlement history is kept by the network's index, and this server cannot authenticate ` +
        `to it: ${detail}. This is the operator's to fix, not something to retry: set ` +
        'BLOCKSCOUT_API_KEY in the server environment. Every other read is unaffected: ' +
        'mandate_get_settlement still reports one settlement from the contracts by id, and ' +
        'mandate_inspect still reports the budgets.',
      { detail },
    );
  }

  /** A detail is spliced mid-sentence, and one that arrives as a full sentence would end in "..". */
  function withoutStop(text: string): string {
    return text.replace(/[.\s]+$/u, '');
  }

  function backOff(kind: Refusal, asked?: number): void {
    refusals += 1;
    lastRefusal = kind;
    const doubled = BACKOFF_MS * 2 ** (refusals - 1);
    silentUntil = Date.now() + Math.min(Math.max(doubled, asked ?? 0), BACKOFF_CEILING_MS);
  }

  function need(): IndexClient {
    if (client !== null) return client;

    try {
      client = createIndexClient({
        ...(options.chainId === undefined ? {} : { chainId: options.chainId }),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof MissingIndexKey) throw keyProblem(error.message);
      throw error;
    }

    return client;
  }

  async function getJson(path: string, cursor: Cursor | null): Promise<RawPage> {
    const quiet = silentUntil - Date.now();

    if (quiet > 0) {
      const seconds = Math.ceil(quiet / 1_000);
      const waiting = `it refused the last request, so it is being left alone for another ${seconds}s`;

      throw lastRefusal === 'key' ? keyProblem(waiting) : unavailable(waiting);
    }

    const index = need();

    try {
      const page = await index.get<RawPage>(path, cursor ?? undefined);
      refusals = 0;
      silentUntil = 0;
      return page;
    } catch (error) {
      if (!isBursarError(error)) {
        backOff('other');
        throw unavailable(error instanceof Error ? error.message : 'the request did not complete');
      }

      // An index that says how long it wants is obeyed over this side's own doubling. Only
      // IndexRequestError carries that, because only a refusal the index answered has one.
      const asked = error instanceof IndexRequestError ? error.retryAfterMs : undefined;

      // Every refusal counts. An index that wants credentials answers 402 as steadily as a busy
      // one answers 429, and the answer to both is to stop asking for a while. Only the sentence
      // differs, because only one of them is something an agent could wait out.
      const status = error.details['status'];

      if (status === 402) {
        backOff('key', asked);
        throw keyProblem('the index answered 402, which is the key rather than the query');
      }

      backOff('other', asked);
      throw unavailable(typeof status === 'number' ? `HTTP ${status}` : error.message);
    }
  }

  async function logsOf(address: Address, query: LogQuery): Promise<LogPage> {
    const logs: IndexedLog[] = [];
    let cursor: Cursor | null = startAt(query.before);
    let exhausted = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await getJson(`addresses/${address}/logs`, cursor);
      const items = body.items;

      if (!Array.isArray(items)) throw unavailable('the reply carried no rows');

      for (const item of items) {
        const row = toIndexedLog(item as RawLog, address);

        if (row !== null) logs.push(row);
      }

      // The cursor's fields change with the endpoint, so it is passed back as it arrived, never
      // reconstructed from the rows.
      cursor = toCursor(body.next_page_params);

      if (cursor === null) {
        exhausted = true;
        break;
      }

      if (logs.length >= query.maxRows) break;
    }

    const oldest = logs[logs.length - 1];

    return { logs, oldestBlock: oldest?.blockNumber ?? null, truncated: !exhausted };
  }

  return { logsOf };
}

/**
 * Where a page starts.
 *
 * The index orders rows by block and then by position inside it, and a cursor names the row after
 * which reading continues. Position zero of the block above the one asked for is therefore the
 * first row at or below it, which is what a caller holding a cursor from an earlier reply means.
 */
function startAt(before: bigint | null): Cursor | null {
  if (before === null) return null;

  return { block_number: (before + 1n).toString(), index: 0, items_count: PAGE_ROWS };
}

function toCursor(value: unknown): Cursor | null {
  if (value === null || typeof value !== 'object') return null;

  const cursor: Record<string, string | number> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number') cursor[key] = entry;
  }

  return Object.keys(cursor).length === 0 ? null : cursor;
}

/**
 * One row, or null when the index sent something a history cannot use.
 *
 * `address` is the contract that emitted the log. The index also carries a `smart_contract` member
 * on the same row which is not always the emitter, so it is only read when the first is absent, and
 * a row from anywhere other than the address that was asked about is dropped.
 */
function toIndexedLog(row: RawLog, expected: Address): IndexedLog | null {
  const emitter = hashOf(row.address) ?? hashOf(row.smart_contract);

  if (emitter === null || emitter.toLowerCase() !== expected.toLowerCase()) return null;
  if (!Array.isArray(row.topics) || !isHexData(row.data)) return null;
  // The hash is reported to the caller as it came, so it has to be one. The index is a copy, and a
  // copy can carry anything in a field.
  if (!isHash(row.transaction_hash) || typeof row.index !== 'number') return null;

  const blockNumber = toBigint(row.block_number);

  if (blockNumber === null) return null;

  return {
    address: emitter,
    topics: row.topics.filter((topic): topic is Hex => typeof topic === 'string' && topic.startsWith('0x')),
    data: row.data,
    blockNumber,
    transactionHash: row.transaction_hash,
    logIndex: row.index,
  };
}

function isHexData(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/u.test(value);
}

function isHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

function hashOf(value: NamedAddress | undefined): Address | null {
  const hash = value?.hash;

  return typeof hash === 'string' && /^0x[0-9a-fA-F]{40}$/u.test(hash) ? (hash as Address) : null;
}

function toBigint(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value);

  return null;
}
