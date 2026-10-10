import type { Address, Log, PublicClient } from 'viem';

type LogReader = Pick<PublicClient, 'getLogs'> & Partial<Pick<PublicClient, 'getBlockNumber'>>;

/**
 * Every log a contract emitted from a block on. One query first, because the chain's own endpoint
 * answers millions of blocks at once; a provider that caps the range refuses it, and the walk then
 * takes the range in chunks, halving a chunk the provider refuses, down to a thousand blocks.
 */
export async function logsSince(reader: LogReader, address: Address, fromBlock: bigint, event?: unknown): Promise<Log[]> {
  const query = (from: bigint, to: bigint | 'latest') =>
    reader.getLogs({ address, fromBlock: from, toBlock: to, ...(event === undefined ? {} : { event }) } as never) as Promise<Log[]>;
  try {
    return await query(fromBlock, 'latest');
  } catch (error) {
    if (reader.getBlockNumber === undefined) throw error;
    const last = await reader.getBlockNumber();
    const logs: Log[] = [];
    let chunk = 5_000_000n;
    let from = fromBlock;
    while (from <= last) {
      const to = from + chunk - 1n < last ? from + chunk - 1n : last;
      try {
        logs.push(...(await query(from, to)));
      } catch (chunked) {
        if (chunk <= 1_000n) throw chunked;
        chunk /= 2n;
        continue;
      }
      from = to + 1n;
    }
    return logs;
  }
}
