import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { logsSince } from '../src/logs.js';

const ACCOUNT: Address = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';

describe('logsSince', () => {
  it('asks once when the endpoint answers the whole range', async () => {
    const calls: unknown[] = [];
    const reader = { getLogs: async (args: unknown) => (calls.push(args), [{ blockNumber: 7n }]) };
    expect(await logsSince(reader as never, ACCOUNT, 5n)).toEqual([{ blockNumber: 7n }]);
    expect(calls).toHaveLength(1);
  });

  it('walks the range in chunks the endpoint accepts when it refuses the whole', async () => {
    // A provider that serves at most 10,000 blocks a query, from block 100 to a head at 30,099.
    const accepted: [bigint, bigint][] = [];
    const reader = {
      getBlockNumber: async () => 30_099n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint | 'latest' }) => {
        if (toBlock === 'latest' || toBlock - fromBlock + 1n > 10_000n) throw new Error('Block range limit exceeded');
        accepted.push([fromBlock, toBlock]);
        return [{ blockNumber: fromBlock }];
      },
    };
    const logs = await logsSince(reader as never, ACCOUNT, 100n);
    expect(logs.map((log) => log.blockNumber)).toEqual(accepted.map(([from]) => from));
    expect(accepted[0]?.[0]).toBe(100n);
    expect(accepted.at(-1)?.[1]).toBe(30_099n);
    expect(accepted.every(([from, to]) => to - from + 1n <= 10_000n)).toBe(true);
    // Chunks are contiguous: each starts where the last ended.
    expect(accepted.every(([from], i) => i === 0 || from === accepted[i - 1]![1] + 1n)).toBe(true);
  });

  it('gives up with the endpoint’s refusal when even a thousand blocks are refused', async () => {
    const reader = { getBlockNumber: async () => 5_000n, getLogs: async () => { throw new Error('ranges over 100 blocks'); } };
    await expect(logsSince(reader as never, ACCOUNT, 0n)).rejects.toThrow(/100 blocks/);
  });
});
