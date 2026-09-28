import type { Micro } from '@bursar/core';
import type { LaneMode } from '../lanes/types.js';

/**
 * The decision half of a spend, as this service needs to see it.
 *
 * `@bursar/underwriter` satisfies these structurally. They are declared here, not imported, so a
 * deployment can put the underwriter behind HTTP, in another process, or on another host without
 * this file changing. The mandate account is on chain and both sides read it, so nothing about the
 * decision requires the two to share memory.
 *
 * The account is the authority. Everything here mirrors a verdict it already reached or would
 * reach; none of it grants anything the contract would refuse.
 */

export type UnderwriterDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'hold'; readonly threshold_micros: bigint }
  | { readonly decision: 'refuse'; readonly reason: string };

export type SpendQuote = {
  readonly decision: UnderwriterDecision;
  readonly bucket: string | null;
  readonly documentHash: string;
  readonly accountVersion: bigint | null;
  readonly headroom: {
    readonly perCall: Micro;
    readonly daily: Micro;
    readonly monthly: Micro;
    readonly balance: Micro;
  } | null;
};

export type SpendAuthorization = {
  readonly decision: UnderwriterDecision;
  readonly quote: SpendQuote | null;
  /** True when this request id was already decided, so the answer is the one already recorded. */
  readonly idempotent: boolean;
};

export type MandateUnderwriter = {
  readonly account: string;
  authorize(request: {
    readonly requestId: string;
    readonly subject: string;
    readonly action: string;
    readonly amountMicros: Micro;
    readonly at: string;
    readonly merchant?: `0x${string}`;
    readonly capabilityId?: `0x${string}`;
    /** The merchant's Merkle path, for an account behind a merchant gate. Refused without it. */
    readonly merchantProof?: readonly `0x${string}`[];
  }): Promise<SpendAuthorization>;
};

/**
 * Finds the underwriter that speaks for one agent, or null when none is configured for it.
 *
 * A mandate is per account and an underwriter holds the decision log for exactly one, so this is
 * where a deployment decides how many it runs and how it maps agents onto them. Returning null is
 * a supported answer: the route then refuses.
 */
export type UnderwriterLookup = (agentId: string) => Promise<MandateUnderwriter | null>;

export type UnderwriteRequest = {
  readonly agentId: string;
  readonly payerWallet: string;
  readonly repayWallet: string;
  readonly requestNonce: string;
  readonly network: string;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly subject: string;
  readonly action: string;
  readonly amountMicro: Micro;
  readonly merchant?: `0x${string}`;
  readonly capabilityId?: `0x${string}`;
  readonly merchantProof?: readonly `0x${string}`[];
  readonly requestHash?: string;
};

/**
 * What a decision becomes in the ledger.
 *
 * A hold is recorded as not approved: the funds are not committed until a principal signs for
 * them, and a row that said otherwise would let a reservation open against an amount nobody has
 * agreed to yet. The reason travels so an operator can see which limit or gate produced it.
 */
export function authorizationFrom(
  request: UnderwriteRequest,
  result: SpendAuthorization,
  outstandingMicro: Micro,
): {
  readonly agentId: string;
  readonly payerWallet: string;
  readonly repayWallet: string;
  readonly requestNonce: string;
  readonly network: string;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly requestedMicro: Micro;
  readonly approved: boolean;
  readonly approvedMicro: Micro;
  readonly availableMicro: Micro;
  readonly outstandingMicro: Micro;
  readonly reasonCodes: readonly string[];
  readonly documentHash: string | null;
  readonly requestHash: string | null;
} {
  const verdict = result.decision;
  const approved = verdict.decision === 'allow';
  const zero = 0n as Micro;

  return {
    agentId: request.agentId,
    payerWallet: request.payerWallet,
    repayWallet: request.repayWallet,
    requestNonce: request.requestNonce,
    network: request.network,
    lane: request.lane,
    poolId: request.poolId,
    requestedMicro: request.amountMicro,
    approved,
    approvedMicro: approved ? request.amountMicro : zero,
    availableMicro: availableFrom(result.quote) ?? zero,
    outstandingMicro,
    reasonCodes: reasonsFor(verdict, result.quote),
    documentHash: result.quote?.documentHash ?? null,
    requestHash: request.requestHash ?? null,
  };
}

/** The tightest limit standing between this agent and its next call. */
function availableFrom(quote: SpendQuote | null): Micro | null {
  if (!quote?.headroom) return null;
  const { perCall, daily, monthly, balance } = quote.headroom;
  return [daily, monthly, balance].reduce((least, value) => (value < least ? value : least), perCall);
}

function reasonsFor(verdict: UnderwriterDecision, quote: SpendQuote | null): readonly string[] {
  if (verdict.decision === 'allow') return [];
  if (verdict.decision === 'hold') return ['approval_required'];
  return quote?.bucket ? [verdict.reason, quote.bucket] : [verdict.reason];
}
