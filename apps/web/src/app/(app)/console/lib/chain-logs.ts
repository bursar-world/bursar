import type { Address, Hex } from 'viem';

import { rhcClient } from '@/chain/client';
import { CHAIN_ID } from '@/chain/rhc';
import { indexedLogs } from './explorer';
import type { IndexedLog } from './explorer';

/**
 * An address's log, read from the chain's own endpoint, with the index as the fallback.
 *
 * The primary endpoint answers `eth_getLogs` over ten million blocks at a time (about twelve days
 * on this chain) in a fifth of a second, and it carries each log's block time. The hosted index
 * takes four to five seconds a page for the same rows. So history is asked of the chain first, in
 * parallel spans from the block the first Bursar contract was deployed at, and only a failed span
 * (the fallback endpoint caps a query at ten thousand blocks) sends the read to the index.
 */
const HISTORY_FLOOR: Readonly<Record<number, bigint>> = {
  // The first v1 deploy transaction on Robinhood Chain mainnet. Nothing Bursar deployed is older.
  4663: 69_564_399n,
};

const SPAN = 9_999_999n;

type RawLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: Hex;
  readonly blockTimestamp?: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: Hex;
  readonly removed?: boolean;
};

export async function historyLogs(address: Address, signal?: AbortSignal): Promise<readonly IndexedLog[]> {
  const floor = HISTORY_FLOOR[CHAIN_ID];
  if (floor === undefined) return indexedLogs(address, signal);
  try {
    return await chainLogs(address, floor);
  } catch {
    return indexedLogs(address, signal);
  }
}

async function chainLogs(address: Address, floor: bigint): Promise<readonly IndexedLog[]> {
  const client = rhcClient();
  const head = await client.getBlockNumber({ cacheTime: 0 });

  const spans: [bigint, bigint][] = [];
  for (let from = floor; from <= head; from += SPAN + 1n) {
    spans.push([from, from + SPAN > head ? head : from + SPAN]);
  }

  const pages = await Promise.all(
    spans.map(
      ([from, to]) =>
        client.request({
          method: 'eth_getLogs',
          params: [{ address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
        } as never) as Promise<readonly RawLog[]>,
    ),
  );

  const live = pages.flat().filter((raw) => raw.removed !== true);

  // The endpoint stamps most logs with their block time, but answers 0x0 for blocks it has not
  // finalised yet. Those few are read block by block, once each, rather than dated 1970.
  const unstamped = [...new Set(live.filter((raw) => !stamped(raw)).map((raw) => raw.blockNumber))];
  const times = new Map(
    await Promise.all(
      unstamped.map(async (block) => [block, (await client.getBlock({ blockNumber: BigInt(block) })).timestamp] as const),
    ),
  );

  const logs: IndexedLog[] = [];
  for (const raw of live) {
    const seconds = stamped(raw) ? BigInt(raw.blockTimestamp!) : times.get(raw.blockNumber);
    if (seconds === undefined) throw new Error('The endpoint returned logs without block times.');
    logs.push({
      address: raw.address,
      topics: [...raw.topics],
      data: raw.data,
      blockNumber: BigInt(raw.blockNumber),
      at: new Date(Number(seconds) * 1000),
      transactionHash: raw.transactionHash,
      logIndex: Number(BigInt(raw.logIndex)),
    });
  }

  return logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

function stamped(raw: RawLog): boolean {
  return raw.blockTimestamp !== undefined && BigInt(raw.blockTimestamp) > 0n;
}
