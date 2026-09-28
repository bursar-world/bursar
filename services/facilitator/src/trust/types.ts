import type { Micro } from '@bursar/core';
import type { LaneMode } from '../lanes/types.js';

/**
 * What the ledger reports to the trust layer.
 *
 * Every one of these is an outcome that already happened and is recorded elsewhere in the same
 * transaction. Nothing here is a prediction, an intent, or a score.
 */
export type TrustEventType =
  | 'settlement_confirmed'
  | 'repayment_received'
  | 'collateral_deposited'
  | 'collateral_withdrawn'
  | 'prefund_deposited'
  | 'prefund_withdrawn';

export const TRUST_EVENT_TYPES: readonly TrustEventType[] = Object.freeze([
  'settlement_confirmed',
  'repayment_received',
  'collateral_deposited',
  'collateral_withdrawn',
  'prefund_deposited',
  'prefund_withdrawn',
]);

/**
 * The body a consumer receives.
 *
 * Amounts travel as decimal strings of atomic micro-USD. JSON has one number type and it is a
 * double, so a bigint that crosses as a number silently loses precision above about nine billion
 * micro-USD. A string costs nothing and cannot.
 */
export type TrustEventPayload = {
  readonly eventId: string;
  readonly eventType: TrustEventType;
  readonly subject: string;
  readonly occurredAt: string;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly network: string | null;
  readonly amountMicro: string | null;
  readonly currency: string | null;
  readonly txHash: string | null;
  readonly referenceId: string | null;
  readonly settlementId: string | null;
  readonly reservationId: string | null;
  readonly debtId: string | null;
  readonly payerWallet: string | null;
  readonly repayWallet: string | null;
  readonly merchantWallet: string | null;
  readonly collateralAccount: string | null;
  readonly assetId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
};

/** What a ledger operation hands the store. The store derives the event id and the payload. */
export type TrustEventInput = {
  readonly eventType: TrustEventType;
  readonly subject: string;
  /**
   * The caller's natural key for this outcome, such as `settlement:<id>`. Queuing the same key
   * twice is a no-op, which is what lets a retried ledger call be safe.
   */
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly network?: string | null;
  readonly amountMicro?: Micro | null;
  readonly currency?: string | null;
  readonly txHash?: string | null;
  readonly referenceId?: string | null;
  readonly settlementId?: string | null;
  readonly reservationId?: string | null;
  readonly debtId?: string | null;
  readonly payerWallet?: string | null;
  readonly repayWallet?: string | null;
  readonly merchantWallet?: string | null;
  readonly collateralAccount?: string | null;
  readonly assetId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type OutboxStatus = 'pending' | 'processing' | 'published';

export type OutboxMessage = {
  readonly id: string;
  readonly eventId: string;
  readonly offset: bigint;
  readonly topic: string;
  readonly eventKey: string;
  readonly payload: TrustEventPayload;
  readonly attemptCount: number;
};

export type OutboxCounts = {
  readonly pending: number;
  readonly processing: number;
  readonly published: number;
  readonly deadLettered: number;
  readonly oldestPendingAt: Date | null;
  readonly latestPublishedAt: Date | null;
};

export type DeadLetter = {
  readonly eventId: string;
  readonly offset: bigint;
  readonly topic: string;
  readonly eventKey: string;
  readonly payload: TrustEventPayload;
  readonly attemptCount: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string;
  readonly firstSeenAt: Date;
  readonly deadLetteredAt: Date;
};

export type JournalEntry = {
  readonly offset: bigint;
  readonly eventId: string;
  readonly subject: string;
  readonly eventType: TrustEventType;
  readonly occurredAt: Date;
  readonly payload: TrustEventPayload;
};

export type RedriveStats = {
  readonly selected: number;
  readonly redriven: number;
  /** Already queued under the same event id, so the quarantined copy was left where it is. */
  readonly skipped: number;
};

export type SweepStats = {
  /** Quarantined messages past retention, and how many of them were deleted. */
  readonly selected: number;
  readonly deleted: number;
  /** Delivered outbox rows past retention, and how many of them were deleted. */
  readonly published: number;
  readonly pruned: number;
};

export type ReplayStats = {
  readonly scanned: number;
  readonly enqueued: number;
  readonly nextOffset: bigint;
};

/** Where a delivered event goes. Anything that can fail per message and report a status fits. */
export type TrustEventSink = {
  readonly name: string;
  deliver(messages: readonly OutboxMessage[]): Promise<SinkResult>;
};

export type SinkResult = {
  /** Event ids the sink accepted. Anything absent is retried or quarantined. */
  readonly delivered: readonly string[];
  readonly statusCode: number | null;
  readonly error: string | null;
  /**
   * True when the message is at fault, not the sink: a 4xx that will fail identically
   * for ever. Those go straight to quarantine instead of consuming the whole retry budget.
   */
  readonly permanent: boolean;
};
