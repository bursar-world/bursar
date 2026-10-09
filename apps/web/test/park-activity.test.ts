import { treasuryParkAbi } from '@bursar/core';
import { encodeAbiParameters, encodeEventTopics, getAbiItem } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { decodeParkEvents, mergeHistories } from '@/app/(app)/console/lib/activity';
import type { IndexedLog } from '@/app/(app)/console/lib/explorer';

const MANDATE: Address = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const OTHER: Address = '0x23746AA39Deba9D1fa914AB3D0e52929E4d05C57';
const ADAPTER: Address = '0xf290748637129740B19CbB799448cA7D199F7F42';

function unparked(mandate: Address, block: bigint, usdgOut: bigint): IndexedLog {
  const event = getAbiItem({ abi: treasuryParkAbi as Abi, name: 'Unparked' });
  const topics = encodeEventTopics({ abi: [event], eventName: 'Unparked', args: { mandate, adapter: ADAPTER } }) as Hex[];
  return {
    address: '0xfE7419caAd0181f77F850ae5D1c70bFd16Ef118f',
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [19_770_700_000_000_000n, usdgOut]),
    blockNumber: block,
    at: new Date('2026-10-09T21:15:00Z'),
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: 3,
  };
}

describe('the park in a mandate history', () => {
  it('keeps the sale that brings parked money back, for this mandate only', () => {
    const events = decodeParkEvents([unparked(MANDATE, 10n, 1_991_328n), unparked(OTHER, 11n, 5_000_000n)], MANDATE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'unparked', adapter: ADAPTER, usdgOut: 1_991_328n });
  });

  it('merges newest first with the account’s own events', () => {
    const park = decodeParkEvents([unparked(MANDATE, 12n, 1_000_000n)], MANDATE);
    const own = [{ kind: 'paused' as const, paused: true, at: new Date(), transactionHash: `0x${'cd'.repeat(32)}` as Hex, blockNumber: 11n, logIndex: 0 }];
    expect(mergeHistories(own, park).map((event) => event.kind)).toEqual(['unparked', 'paused']);
  });
});
