/**
 * A Blockscout v2 address-log endpoint backed by plain objects, served over the real explorer
 * reader. The cursor, the page walk and the decoding on the path are the shipped ones; only the
 * rows are made up.
 */
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import type { Address, Hex } from 'viem';
import { mandateAccountAbi } from '@bursar/core';

import { createExplorerIndex } from '../src/explorer.js';
import type { SettlementIndex } from '../src/explorer.js';
import { ACCOUNT } from './node.js';
import type { NodeState, SpentLog } from './node.js';

export const EXPLORER = 'https://index.test/api/v2';
const KEY = 'an-index-key';

export type FakeIndex = {
  index: SettlementIndex;
  /** Every URL the reader asked for, in order, so a suite can assert on the walk itself. */
  urls: string[];
};

type Row = {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  block: bigint;
  index: number;
  tx: Hex;
};

export type FakeIndexOptions = {
  readonly pageSize?: number;
  /** Answered instead of a page, to drive the refusal and backoff paths. */
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** Extra rows the account emitted, merged into the log by block and position. */
  readonly extra?: readonly Row[];
};

export function creditedRow(entry: SpentLog, address: Address = ACCOUNT): Row {
  return {
    address,
    topics: topicsOf({
      abi: mandateAccountAbi,
      eventName: 'SpendCredited',
      args: { escrowId: entry.escrowId },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }],
      [entry.amount, entry.dailySpent, entry.monthlySpent],
    ),
    block: entry.blockNumber,
    index: 11,
    tx: entry.txHash,
  };
}

function spentRow(entry: SpentLog, address: Address): Row {
  return {
    address,
    topics: topicsOf({
      abi: mandateAccountAbi,
      eventName: 'Spent',
      args: { escrowId: entry.escrowId, merchant: entry.merchant, capabilityId: entry.capabilityId },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }],
      [entry.amount, entry.dailySpent, entry.monthlySpent],
    ),
    block: entry.blockNumber,
    index: 10,
    tx: entry.txHash,
  };
}

/** An indexed argument left unset comes back as null, which a wire log never carries. */
function topicsOf(event: Parameters<typeof encodeEventTopics>[0]): readonly Hex[] {
  return encodeEventTopics(event).filter((topic): topic is Hex => typeof topic === 'string');
}

/** The order the index answers in. */
function newestFirst(a: Row, b: Row): number {
  if (a.block !== b.block) return a.block > b.block ? -1 : 1;
  return b.index - a.index;
}

export function createFakeIndex(state: NodeState, options: FakeIndexOptions = {}): FakeIndex {
  const pageSize = options.pageSize ?? 50;
  const urls: string[] = [];
  const rows = [...state.spent.map((entry) => spentRow(entry, ACCOUNT)), ...(options.extra ?? [])].sort(newestFirst);

  const fetchFn = (async (input: unknown): Promise<Response> => {
    const url = new URL(String(input));
    urls.push(url.toString());

    if (options.status !== undefined) {
      return new Response('no', { status: options.status, headers: options.headers });
    }

    const block = url.searchParams.get('block_number');
    const position = url.searchParams.get('index');

    const after =
      block === null
        ? rows
        : rows.filter((row) => {
            const ceiling = BigInt(block);

            if (row.block !== ceiling) return row.block < ceiling;

            return row.index < Number(position ?? 0);
          });

    const page = after.slice(0, pageSize);
    const last = page[page.length - 1];
    const more = after.length > page.length;

    return Response.json({
      items: page.map((row) => ({
        address: { hash: row.address },
        smart_contract: { hash: row.address },
        topics: row.topics,
        data: row.data,
        block_number: Number(row.block),
        block_timestamp: '2027-01-15T08:00:00.000000Z',
        transaction_hash: row.tx,
        index: row.index,
      })),
      next_page_params:
        more && last !== undefined
          ? { block_number: Number(last.block), index: last.index, items_count: pageSize }
          : null,
    });
  }) as typeof fetch;

  return { index: createExplorerIndex({ baseUrl: EXPLORER, apiKey: KEY, fetchFn }), urls };
}
