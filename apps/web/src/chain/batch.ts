import { multicall } from 'viem/actions';
import type { Abi, Address } from 'viem';
import type { RhcPublicClient } from '@bursar/core';
import { arbSysAbi, multicall3Abi } from './abi';
import { ARB_SYS, MULTICALL3 } from './rhc';

/**
 * A read batch that leaves as one `eth_call`, or as few as the node will take.
 *
 * A public endpoint meters arrivals per second and reading one mandate's whole state is roughly
 * forty reads. Fanned out that is two seconds of queueing on a good day and a wall of 429s on a
 * busy one, in front of a treasurer who asked for one screen. Aggregated through Multicall3 it is
 * a single request, atomic at one block, so every number on the screen is from the same moment and
 * none of it is smeared across two seconds of chain.
 *
 * `allowFailure` is always on. One address that reverts a compliance read must not take the other
 * thirty-nine readings with it; a failed slot reads as unknown and the surface says so.
 */
export type Slot<T> = { readonly index: number; readonly label: string; readonly __value?: T };

type Call = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
};

export class ReadBatch {
  readonly calls: Call[] = [];

  /**
   * The `T` is the caller's claim about what this ABI entry decodes to, and the generated ABI is
   * what checks that claim against the contract. This signature does not. Keeping the assertion
   * in one place leaves every other call site reading a typed value.
   */
  add<T>(label: string, call: Call): Slot<T> {
    this.calls.push(call);
    return { index: this.calls.length - 1, label };
  }

  get size(): number {
    return this.calls.length;
  }
}

/**
 * The block and the clock, taken the same way by every surface.
 *
 * Both readings belong to the aggregate rather than to a request of their own, so the figure a
 * screen prints is the block the rest of the screen was read at. They are two functions on two
 * contracts for one reason, set out in `arbSysAbi`: on this chain the height and the timestamp do
 * not come from the same place.
 */
export function addBlockNumber(batch: ReadBatch, label = 'blockNumber'): Slot<bigint> {
  return batch.add<bigint>(label, { address: ARB_SYS, abi: arbSysAbi as never, functionName: 'arbBlockNumber' });
}

export function addChainTime(batch: ReadBatch, label = 'chainTime'): Slot<bigint> {
  return batch.add<bigint>(label, { address: MULTICALL3, abi: multicall3Abi as never, functionName: 'getCurrentBlockTimestamp' });
}

export type RawSlotResult =
  | { readonly status: 'success'; readonly result: unknown }
  | { readonly status: 'failure'; readonly error: Error };

export class BatchResults {
  constructor(private readonly raw: readonly RawSlotResult[]) {}

  /** The value, or undefined when that one call reverted or the node dropped it. */
  get<T>(slot: Slot<T> | undefined): T | undefined {
    if (!slot) return undefined;
    const entry = this.raw[slot.index];
    return entry?.status === 'success' ? (entry.result as T) : undefined;
  }

  /** Why a slot has no value. Undefined when it has one. */
  problem<T>(slot: Slot<T> | undefined): string | undefined {
    if (!slot) return undefined;
    const entry = this.raw[slot.index];
    if (!entry) return 'The node returned fewer results than the batch asked for.';
    return entry.status === 'failure' ? entry.error.message : undefined;
  }

  get failures(): number {
    return this.raw.filter((entry) => entry.status === 'failure').length;
  }
}

/**
 * Slots per aggregated call.
 *
 * Multicall3 will take more, but the node in front of it caps the gas an `eth_call` may burn and
 * the bytes it may carry, and an aggregate that trips either reverts whole: `allowFailure` reports
 * a slot that reverted, not a call that never landed. Uncapped, a mandate with a few hundred spends
 * comes back empty, which is worse than coming back slow. Two calls can land either side of a
 * block, which is half a second of drift on the few readings big enough to need a second call.
 */
const MAX_SLOTS_PER_CALL = 100;

/**
 * `batchSize: 0` turns off viem's own chunking. Left at its default it splits the calldata into
 * 1 KB pieces and sends several `eth_call`s, which is the fan-out this batch exists to avoid; the
 * chunking that remains is by slot count, above.
 *
 * The signal stops the calls that have not been sent. An `eth_call` already in flight cannot be
 * unsent, but a batch that outgrew one request is mostly requests that have not left yet, and a
 * reader who has moved to another screen should not be paying for them.
 */
export async function runBatch(
  client: RhcPublicClient,
  batch: ReadBatch,
  signal?: AbortSignal,
): Promise<BatchResults> {
  if (batch.size === 0) return new BatchResults([]);

  const raw: RawSlotResult[] = [];

  for (let first = 0; first < batch.calls.length; first += MAX_SLOTS_PER_CALL) {
    signal?.throwIfAborted();

    const results = (await multicall(client, {
      contracts: batch.calls.slice(first, first + MAX_SLOTS_PER_CALL),
      allowFailure: true,
      multicallAddress: MULTICALL3,
      batchSize: 0,
    })) as readonly RawSlotResult[];

    raw.push(...results);
  }

  return new BatchResults(raw);
}
