import { stockSpendRouterAbi } from '@bursar/core';
import { encodeAbiParameters, encodeEventTopics, getAbiItem } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { decodeRouterEvents, mergeHistories } from '@/app/(app)/console/lib/activity';
import type { IndexedLog } from '@/app/(app)/console/lib/explorer';

const MANDATE: Address = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const OTHER: Address = '0x23746AA39Deba9D1fa914AB3D0e52929E4d05C57';
const SPY: Address = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const ROUTER: Address = '0xBF6bC24d44f5A432a5682De650981A1885D31660';

function log(name: 'StockSold' | 'Recalled', mandate: Address, block: bigint, data: Hex): IndexedLog {
  const event = getAbiItem({ abi: stockSpendRouterAbi as Abi, name });
  const topics = encodeEventTopics({ abi: [event], eventName: name, args: { mandate, asset: SPY } }) as Hex[];
  return {
    address: ROUTER,
    topics,
    data,
    blockNumber: block,
    at: new Date('2026-10-10T15:40:00Z'),
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: 2,
  };
}

const sold = (mandate: Address, block: bigint, usdgOut: bigint) =>
  log('StockSold', mandate, block, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [640_554_959_594_479n, usdgOut, 78_005_783_409n]));
const recalled = (mandate: Address, block: bigint) => log('Recalled', mandate, block, encodeAbiParameters([{ type: 'uint256' }], [1_000n]));

describe('the stock router in a mandate history', () => {
  it('keeps the sales and recalls of this mandate only', () => {
    const events = decodeRouterEvents([sold(MANDATE, 10n, 499_374n), sold(OTHER, 11n, 5_000_000n), recalled(MANDATE, 12n)], MANDATE);
    expect(events.map((event) => event.kind)).toEqual(['recalled', 'sold']);
    expect(events[1]).toMatchObject({ kind: 'sold', asset: SPY, amountIn: 640_554_959_594_479n, usdgOut: 499_374n });
    expect(events[0]).toMatchObject({ kind: 'recalled', asset: SPY, amount: 1_000n });
  });

  it('merges newest first with the account’s own events', () => {
    const router = decodeRouterEvents([sold(MANDATE, 12n, 1_000_000n)], MANDATE);
    const own = [{ kind: 'bought' as const, asset: SPY, usdgIn: 500_000n, amountOut: 1n, at: new Date(), transactionHash: `0x${'cd'.repeat(32)}` as Hex, blockNumber: 11n, logIndex: 0 }];
    expect(mergeHistories(own as never, router).map((event) => event.kind)).toEqual(['sold', 'bought']);
  });
});
