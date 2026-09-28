import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { canonicalStringify } from '../src/commit.js';
import { LockStatus, WriteFailed } from '../src/escrow.js';
import type { BlockRef, EscrowPort, EscrowTerms, LockRecord, LockedLog, TxOutcome } from '../src/escrow.js';
import type { FetchLike } from '../src/executor.js';
import type { LogFields, Logger } from '../src/log.js';
import type { StateStore, WatcherState } from '../src/state.js';

/**
 * Doubles for the chain, the network, the log and the cursor file. Together they run the whole
 * loop with no node, no server and no clock.
 */

export const PAYER: Address = '0x1111111111111111111111111111111111111111';
export const PAYEE: Address = '0x2222222222222222222222222222222222222222';
export const OTHER_PAYEE: Address = '0x5555555555555555555555555555555555555555';
export const SETTLEMENT_ASSET: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const ESCROW: Address = '0x4444444444444444444444444444444444444444';
export const RESOLVER: Address = '0x6666666666666666666666666666666666666666';
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
export const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`;

export const TERMS: EscrowTerms = {
  settlementAsset: SETTLEMENT_ASSET,
  feeBps: 100,
  resolverFeeBps: 200,
  disputeBondBps: 500,
  disputeWindow: 3_600n,
  resolver: RESOLVER,
};

export function rawDataURI(text: string): string {
  return `data:application/json;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
}

export function dataURI(value: unknown): string {
  return rawDataURI(canonicalStringify(value));
}

export function lockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    payer: PAYER,
    payee: PAYEE,
    disputer: ZERO_ADDRESS,
    capabilityId: ZERO_BYTES32,
    inputCommit: ZERO_BYTES32,
    outputCommit: ZERO_BYTES32,
    inputURI: '',
    outputURI: '',
    amount: micro(1_000_000n),
    deadline: 1_900_000_000n,
    releasedAt: 0n,
    bond: micro(0n),
    disputedAt: 0n,
    status: LockStatus.Locked,
    counted: false,
    ...overrides,
  };
}

export type WriteCall = {
  readonly action: 'release' | 'finalizeRelease' | 'dispute';
  readonly id: bigint;
  readonly outputCommit?: Hex;
  readonly outputURI?: string;
};

export type FakeChainOptions = {
  readonly head?: BlockRef;
  readonly terms?: EscrowTerms;
  readonly allowance?: Micro;
  /** Leave a released lock reading as locked, to prove the in-memory guard and not the re-read. */
  readonly settleOnWrite?: boolean;
  readonly onWrite?: (call: WriteCall) => Promise<TxOutcome> | TxOutcome;
};

export type FakeChain = {
  readonly port: EscrowPort;
  readonly locks: Map<bigint, LockRecord>;
  readonly writes: WriteCall[];
  readonly scans: Array<{ fromBlock: bigint; toBlock: bigint }>;
  publish(id: bigint, lock: LockRecord, block?: bigint): void;
  setHead(head: Partial<BlockRef>): void;
  head(): BlockRef;
};

export const DEFAULT_HEAD: BlockRef = { number: 10n, timestamp: 1_800_000_000n };

export function txReceipt(action: WriteCall['action'], id: bigint): TxOutcome {
  return {
    hash: `0x${action.slice(0, 2)}${id.toString(16).padStart(62, '0')}` as Hex,
    status: 'success',
    blockNumber: 11n,
    gasUsed: 61_098n,
  };
}

/**
 * A write whose transaction got out and whose receipt never came back. What a confirmation timeout
 * looks like from the loop: the transaction may well be mined a moment later.
 */
export function pendingWrite(action: WriteCall['action'], id: bigint): never {
  throw new WriteFailed(action, txReceipt(action, id).hash, new Error('timed out waiting for a receipt'));
}

/** A write that never produced a transaction. Nothing is in flight and nothing is racing. */
export function droppedWrite(reason = 'rpc down'): never {
  throw new Error(reason);
}

export function createFakeChain(options: FakeChainOptions = {}): FakeChain {
  const settleOnWrite = options.settleOnWrite ?? true;
  const terms = options.terms ?? TERMS;
  const locks = new Map<bigint, LockRecord>();
  const writes: WriteCall[] = [];
  const scans: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  const published: Array<{ block: bigint; log: LockedLog }> = [];
  let head: BlockRef = options.head ?? DEFAULT_HEAD;

  async function write(call: WriteCall): Promise<TxOutcome> {
    writes.push(call);
    const outcome = options.onWrite ? await options.onWrite(call) : txReceipt(call.action, call.id);

    const lock = locks.get(call.id);
    if (settleOnWrite && lock && outcome.status === 'success') {
      if (call.action === 'release') {
        locks.set(call.id, {
          ...lock,
          outputCommit: call.outputCommit ?? lock.outputCommit,
          outputURI: call.outputURI ?? lock.outputURI,
          releasedAt: head.timestamp,
          status: LockStatus.Released,
          counted: terms.disputeWindow === 0n,
        });
      } else if (call.action === 'finalizeRelease') {
        locks.set(call.id, { ...lock, counted: true });
      } else {
        locks.set(call.id, { ...lock, status: LockStatus.Disputed, disputer: PAYEE, disputedAt: head.timestamp });
      }
    }

    return outcome;
  }

  const port: EscrowPort = {
    latestBlock: async () => head,
    terms: async () => terms,

    lockedLogs: async (fromBlock, toBlock) => {
      scans.push({ fromBlock, toBlock });

      return published.filter((entry) => entry.block >= fromBlock && entry.block <= toBlock).map((entry) => entry.log);
    },

    getLock: async (id) => {
      const lock = locks.get(id);
      if (!lock) throw new Error(`No lock ${id}`);

      return lock;
    },

    bondAllowance: async () => options.allowance ?? micro(0n),

    release: (id, outputCommit, outputURI) => write({ action: 'release', id, outputCommit, outputURI }),
    finalizeRelease: (id) => write({ action: 'finalizeRelease', id }),
    dispute: (id) => write({ action: 'dispute', id }),
  };

  return {
    port,
    locks,
    writes,
    scans,
    head: () => head,
    publish(id, lock, block) {
      locks.set(id, lock);
      published.push({ block: block ?? head.number, log: { id, payee: lock.payee, blockNumber: block ?? head.number } });
    },
    setHead(next) {
      head = { ...head, ...next };
    },
  };
}

export type FetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

export type FakeFetch = {
  readonly fetch: FetchLike;
  readonly calls: FetchCall[];
};

export type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

export function createFakeFetch(handler: FetchHandler): FakeFetch {
  const calls: FetchCall[] = [];

  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });

      return handler({ url, init });
    },
  };
}

export type JsonResponseOptions = {
  readonly status?: number;
  readonly contentType?: string | null;
  readonly headers?: Record<string, string>;
};

export function jsonResponse(body: string, options: JsonResponseOptions = {}): Response {
  const headers: Record<string, string> = { ...options.headers };
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null) {
    headers['content-type'] = contentType;
  }

  return new Response(body, { status: options.status ?? 200, headers });
}

export type LogEntry = {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields;
};

export type RecordingLogger = {
  readonly logger: Logger;
  readonly entries: LogEntry[];
  events(): string[];
  find(event: string): LogEntry | undefined;
};

export function createRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry['level']) =>
    (event: string, fields: LogFields = {}): void => {
      entries.push({ level, event, fields });
    };

  return {
    entries,
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    events: () => entries.map((entry) => entry.event),
    find: (event) => entries.find((entry) => entry.event === event),
  };
}

export type MemoryStateStore = StateStore & {
  readonly writes: WatcherState[];
  current(): WatcherState | undefined;
};

export function createMemoryStateStore(initial?: WatcherState, failWrite?: () => void): MemoryStateStore {
  const writes: WatcherState[] = [];
  let stored = initial;

  return {
    writes,
    current: () => stored,
    read: async () => stored,
    write: async (state) => {
      failWrite?.();
      stored = state;
      writes.push(state);
    },
  };
}
