'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { ADDRESSES } from '@/chain/rhc';
import { approvedCapabilities, decodeLockEvents, decodeMandateEvents } from './activity';
import type { LockEvents, MandateEvent } from './activity';
import { indexedLogs, indexedRevert, indexedTransactions, resetIndexBackoff } from './explorer';
import type { IndexedTransaction } from './explorer';
import { readLedgerState } from './reads';
import type { ApprovalState, GateEntry, LockRecord } from './reads';
import { readingOf } from './reading';
import type { Reading } from './reading';
import { describeAttempt, refusalFor } from './refusals';
import type { RefusalContext } from './refusals';
import type { Attempt, RefusalCause } from './refusals';

const INDEX_REFETCH_MS = 30_000;
const LEDGER_REFETCH_MS = 20_000;

/** How many recent transactions are examined for refusals. A failed call costs a request to read. */
const REFUSAL_SCAN = 40;
const REFUSAL_DETAIL_LIMIT = 12;

/** How far back the approvals table looks for the grants behind the ids it is showing. */
const GRANT_SCAN = 40;

export type MandateLedger = {
  /** Everything the account has recorded about itself, newest first. */
  readonly events: readonly MandateEvent[];
  readonly lockEvents: ReadonlyMap<string, LockEvents>;
  readonly locks: ReadonlyMap<string, LockRecord>;
  readonly merchants: readonly GateEntry<Address>[];
  readonly capabilities: readonly GateEntry<Hex>[];
  readonly approvals: readonly ApprovalState[];
  readonly allowance: Micro | undefined;
  readonly ownerBalance: Micro | undefined;
  readonly domainSeparator: Hex | undefined;
  /** The chain's clock at the block the locks were read from. A deadline is measured against it. */
  readonly chainTime: Date | undefined;
  /**
   * Whether the network index answered. Until this reads, `events` is unknown and so is everything
   * assembled from it: the payments, the payees, the capabilities. Unknown is not empty.
   */
  readonly timeline: Reading;
  /**
   * Whether the contracts answered. The locks, the gate entries, the approvals and both balances
   * come from here. What is put to them is drawn from the timeline, so a list that needs the index
   * to know what exists and the contracts to say what it is now reads `weaker(timeline, chain)`.
   */
  readonly chain: Reading;
  /** Set when the network index did not answer. Chain state is still current; the timeline is not. */
  readonly timelineError: unknown;
  /** Set when the contracts did not answer. The timeline may well be whole. */
  readonly chainError: unknown;
  /** True until both sources have answered once. No list here means anything before then. */
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly refresh: () => void;
};

/**
 * The account's history, and the current truth behind it.
 *
 * Two sources. The timeline comes from the network's index, read through this app's own route,
 * because the chain caps a log query and produces a block faster than once a second, so nothing in
 * a browser can scan for it.
 * What the money is doing now comes from the contracts, in one batched request, because an index
 * is a copy and a copy is the wrong thing to answer "can this be spent" with.
 */
export function useMandateLedger(mandate: Address | undefined, owner?: Address, escrow?: Address): MandateLedger {
  const timeline = useQuery({
    queryKey: ['console', 'timeline', mandate ?? 'none'],
    queryFn: async () => decodeMandateEvents(await indexedLogs(mandate as Address)),
    enabled: mandate !== undefined,
    refetchInterval: INDEX_REFETCH_MS,
  });

  // The escrow serves every mandate on its deployment, so its log is fetched once and shared
  // across every screen that wants it. Which escrow is the mandate's own: a v1 mandate settles
  // through the v1 one, and its locks are not in the current escrow's log.
  const lockEscrow = escrow ?? ADDRESSES.escrow;
  const escrowLog = useQuery({
    queryKey: ['console', 'escrow-log', lockEscrow.toLowerCase()],
    queryFn: async () => decodeLockEvents(await indexedLogs(lockEscrow)),
    enabled: escrow !== undefined,
    refetchInterval: INDEX_REFETCH_MS,
  });

  const timelineData = timeline.data;
  const events = timelineData ?? EMPTY_EVENTS;

  // The candidates are drawn from the log and their current state is read from the chain. A
  // merchant removed yesterday is still in the log, and only the mapping says which it is today.
  const candidates = useMemo(() => {
    const merchants = new Set<Address>();
    const capabilities = new Set<Hex>();
    const approvals = new Set<Hex>();
    const lockIds = new Set<string>();

    for (const event of events) {
      if (event.kind === 'merchant-updated') merchants.add(event.merchant);
      if (event.kind === 'spent') {
        merchants.add(event.merchant);
        capabilities.add(event.capabilityId);
        lockIds.add(event.escrowId.toString());
      }
      if (event.kind === 'capability-updated') capabilities.add(event.capabilityId);
      if (event.kind === 'approval-granted' || event.kind === 'approval-revoked' || event.kind === 'approval-consumed') {
        approvals.add(event.approvalId);
      }
      if (event.kind === 'credited') lockIds.add(event.escrowId.toString());
    }

    return {
      merchants: [...merchants],
      capabilities: [...capabilities],
      approvals: [...approvals],
      lockIds: [...lockIds].map((id) => BigInt(id)),
    };
  }, [events]);

  const ledger = useQuery({
    queryKey: [
      'console',
      'ledger',
      mandate ?? 'none',
      owner ?? 'none',
      candidates.merchants.join(','),
      candidates.capabilities.join(','),
      candidates.approvals.join(','),
      candidates.lockIds.join(','),
      lockEscrow.toLowerCase(),
    ],
    queryFn: () =>
      readLedgerState({
        mandate: mandate as Address,
        escrow: lockEscrow,
        ...(owner === undefined ? {} : { owner }),
        lockIds: candidates.lockIds,
        merchants: candidates.merchants,
        capabilities: candidates.capabilities,
        approvals: candidates.approvals,
      }),
    // Lock ids only mean something against the escrow that issued them.
    enabled: mandate !== undefined && (escrow !== undefined || candidates.lockIds.length === 0),
    refetchInterval: LEDGER_REFETCH_MS,
  });

  const escrowData = escrowLog.data;
  const chainData = ledger.data;
  const indexError = timeline.error ?? escrowLog.error ?? null;
  const chainError = ledger.error ?? null;
  const isFetching = timeline.isFetching || escrowLog.isFetching || ledger.isFetching;
  const { refetch: refetchTimeline } = timeline;
  const { refetch: refetchEscrow } = escrowLog;
  const { refetch: refetchChain } = ledger;

  // Every panel under a mandate takes this through one context value, so a fresh object here
  // re-renders all of them on every keystroke in any of them. React Query builds a new result
  // object each render, which is why the dependencies are the parts of it that hold still.
  return useMemo<MandateLedger>(() => {
    const index = readingOf(timelineData !== undefined && escrowData !== undefined, indexError);
    const contracts = readingOf(chainData !== undefined, chainError);
    return {
      events,
      lockEvents: escrowData ?? EMPTY_LOCK_EVENTS,
      locks: chainData?.locks ?? EMPTY_LOCKS,
      merchants: chainData?.merchants ?? EMPTY_GATE,
      capabilities: chainData?.capabilities ?? EMPTY_CAPABILITIES,
      approvals: chainData?.approvals ?? EMPTY_APPROVALS,
      allowance: chainData?.allowance,
      ownerBalance: chainData?.ownerBalance,
      domainSeparator: chainData?.domainSeparator,
      chainTime: chainData?.chainTime,
      timeline: index,
      chain: contracts,
      timelineError: index.error,
      chainError: contracts.error,
      isLoading: index.state === 'loading' || contracts.state === 'loading',
      isFetching,
      // A person pressing this has asked for a request, so one is made. Three surfaces poll the
      // index on timers and a refusal quiets all of them for a while, which is right for a timer
      // and wrong for a control: "Read again" that fires nothing reads as a dead button, and the
      // reader has no way to see the pause because it is not on the control.
      refresh: () => {
        resetIndexBackoff();
        void refetchTimeline();
        void refetchEscrow();
        void refetchChain();
      },
    };
  }, [events, timelineData, escrowData, chainData, indexError, chainError, isFetching, refetchTimeline, refetchEscrow, refetchChain]);
}

/**
 * What each approval on this account was granted for.
 *
 * The capability is hashed into the approval and never emitted, so the approvals table had nothing
 * to name a consent it had just registered with. It is in the calldata of the grant, which this
 * reads from the same window of transactions the refusals come from. An approval older than that
 * window, or granted through a contract wallet, stays unnamed rather than guessed at.
 */
export function useApprovedCapabilities(mandate: Address | undefined): {
  readonly byApproval: ReadonlyMap<string, Hex>;
  /** Read again now. The surface that grants an approval calls this on the receipt. */
  readonly refresh: () => void;
} {
  const query = useQuery({
    queryKey: ['console', 'approved-capabilities', mandate ?? 'none'],
    queryFn: async () => approvedCapabilities(await indexedTransactions(mandate as Address, GRANT_SCAN)),
    enabled: mandate !== undefined,
    refetchInterval: INDEX_REFETCH_MS,
  });

  const { refetch } = query;

  return useMemo(
    () => ({
      byApproval: query.data ?? EMPTY_CAPABILITY_IDS,
      refresh: () => {
        resetIndexBackoff();
        void refetch();
      },
    }),
    [query.data, refetch],
  );
}

export type Refusal = {
  readonly transaction: IndexedTransaction;
  readonly cause: RefusalCause;
  readonly attempt: Attempt | undefined;
};

export type RefusalFeed = {
  readonly refusals: readonly Refusal[];
  /** True when older failures exist beyond the window this reads. */
  readonly truncated: boolean;
  /** Whether the index answered. An empty feed counts as no refusals only once this reads. */
  readonly reading: Reading;
  readonly isFetching: boolean;
  readonly refresh: () => void;
};

/**
 * Payments the contract refused.
 *
 * A refusal is a mined transaction: the fee was paid and the call was rolled back, so it is in the
 * record with its reason attached. Reading that reason costs one request per failure, which is why
 * only the failures in the recent window are read and the surface says when it stopped.
 */
export function useRefusals(mandate: Address | undefined, context: RefusalContext = {}): RefusalFeed {
  const query = useQuery({
    queryKey: ['console', 'refusals', mandate ?? 'none', context.totalBudget === true],
    queryFn: async () => {
      const transactions = await indexedTransactions(mandate as Address, REFUSAL_SCAN);
      const failed = transactions.filter((entry) => entry.failed);
      const read = failed.slice(0, REFUSAL_DETAIL_LIMIT);

      const refusals: Refusal[] = [];
      // Sequential because refusals are rare, and firing twelve requests at once to explain
      // twelve failures is its own kind of failure.
      for (const transaction of read) {
        const reading = await indexedRevert(transaction.hash).catch(() => undefined);
        refusals.push({
          transaction,
          cause: refusalFor(reading, context),
          attempt: describeAttempt(transaction.input),
        });
      }

      return { refusals, truncated: failed.length > read.length };
    },
    enabled: mandate !== undefined,
    refetchInterval: INDEX_REFETCH_MS,
  });

  return {
    refusals: query.data?.refusals ?? EMPTY_REFUSALS,
    truncated: query.data?.truncated ?? false,
    reading: readingOf(query.data !== undefined, query.error),
    isFetching: query.isFetching,
    refresh: () => {
      resetIndexBackoff();
      void query.refetch();
    },
  };
}

const EMPTY_EVENTS: readonly MandateEvent[] = [];
const EMPTY_LOCK_EVENTS: ReadonlyMap<string, LockEvents> = new Map();
const EMPTY_LOCKS: ReadonlyMap<string, LockRecord> = new Map();
const EMPTY_GATE: readonly GateEntry<Address>[] = [];
const EMPTY_CAPABILITIES: readonly GateEntry<Hex>[] = [];
const EMPTY_APPROVALS: readonly ApprovalState[] = [];
const EMPTY_REFUSALS: readonly Refusal[] = [];
const EMPTY_CAPABILITY_IDS: ReadonlyMap<string, Hex> = new Map();
