import { describe, expect, it, vi } from 'vitest';

const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_790_000_000n + blockNumber }));
const request = vi.fn(async () => [
  { address: '0x420BeB507F72173E7d78e0f956968f64fb508356', topics: [], data: '0x', blockNumber: '0x10', blockTimestamp: '0x6a8c1b00', transactionHash: '0x01', logIndex: '0x0' },
  { address: '0x420BeB507F72173E7d78e0f956968f64fb508356', topics: [], data: '0x', blockNumber: '0x20', blockTimestamp: '0x0', transactionHash: '0x02', logIndex: '0x0' },
]);

vi.mock('@/chain/client', () => ({ rhcClient: () => ({ getBlockNumber: async () => 69_564_500n, getBlock, request }) }));

const { historyLogs } = await import('@/app/(app)/console/lib/chain-logs');

describe('historyLogs', () => {
  it('dates a log the endpoint stamped 0x0 from its block, not from 1970', async () => {
    const logs = await historyLogs('0x420BeB507F72173E7d78e0f956968f64fb508356');
    expect(logs.map((log) => log.at.getTime() / 1000)).toEqual([0x6a8c1b00, 1_790_000_000 + 0x20]);
    expect(getBlock).toHaveBeenCalledTimes(1);
  });
});
