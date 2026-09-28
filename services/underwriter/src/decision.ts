import { ISSUER_REFUSAL } from '@bursar/core';
import type { Micro } from '@bursar/core';

/**
 * Every way a spend can be turned down, from any of the three surfaces that can turn it
 * down: the off-chain document, the MandateAccount, and the escrow the account locks into.
 *
 * The first five values carry the wire spelling of the evaluator this was ported from and
 * are pinned by the conformance vector. Renaming one changes a decision body. That changes the
 * hash chain and breaks the anchored root. They do not get tidied.
 */
export const RefuseReason = {
  // Pinned by the conformance vector.
  WrongSubject: 'wrong_subject',
  Expired: 'expired',
  OutsideMandate: 'outside_mandate',
  OverPerCallCap: 'over_per_call_cap',
  OverCumulativeCeiling: 'over_cumulative_ceiling',

  // Limits the MandateAccount enforces that the source document had no concept of.
  ZeroAmount: 'zero_amount',
  NotYetValid: 'not_yet_valid',
  DailyCapExceeded: 'daily_cap_exceeded',
  MonthlyCapExceeded: 'monthly_cap_exceeded',
  MerchantNotAllowed: 'merchant_not_allowed',
  CapabilityNotAllowed: 'capability_not_allowed',
  BadMerkleProof: 'bad_merkle_proof',
  StaleMerchantProof: 'stale_merchant_proof',
  MerchantGateUndecidable: 'merchant_gate_undecidable',
  ApprovalRequired: 'approval_required',
  Paused: 'paused',
  Revoked: 'revoked',
  NotAgent: 'not_agent',
  ZeroAddress: 'zero_address',

  // Terms that live on the escrow, outside what previewSpend can answer.
  TtlTooShort: 'ttl_too_short',
  TtlTooLong: 'ttl_too_long',
  // The escrow reports both ends of the TTL window with one error, so a decoded revert can
  // only say the deadline was out of bounds. The preflight, which holds the bounds, says which.
  TtlOutOfBounds: 'ttl_out_of_bounds',
  MerchantInactive: 'merchant_inactive',
  MerchantBlacklisted: 'merchant_blacklisted',
  MerchantNotParty: 'merchant_not_party',
  PayeeCapExceeded: 'payee_cap_exceeded',
  AccountUnderfunded: 'account_underfunded',

  // The settlement asset's own controls, which belong to the token issuer rather than to the
  // principal, the operator or this service. None of them can be cleared from here, and a refusal
  // that said otherwise would send a principal to raise a limit that was never in the way. The
  // words are `@bursar/core`'s, so this service and the facilitator refuse in one vocabulary.
  AssetPaused: ISSUER_REFUSAL.assetPaused,
  PayerFrozen: ISSUER_REFUSAL.payerFrozen,
  PayeeFrozen: ISSUER_REFUSAL.payeeFrozen,
  AssetControlAbsent: ISSUER_REFUSAL.assetControlAbsent,
  AssetControlUnreadable: ISSUER_REFUSAL.assetControlUnreadable,

  // A held call the principal declined. Distinct from the ceiling, which is a limit running out.
  ApprovalDenied: 'approval_denied',

  /**
   * A held call approved so long after it was quoted that the quote is no longer worth anything.
   * Distinct from `expired`, which is the mandate's own validity window running out.
   */
  HoldExpired: 'hold_expired',

  // The mandate document does not describe the account that was asked about.
  DocumentAccountMismatch: 'document_account_mismatch',

  // Default-deny backstops. Neither is a policy outcome; both mean the underwriter could
  // not establish that the spend was permitted, which is the same thing as refusing it.
  ChainUnavailable: 'chain_unavailable',
  ChainRefusedUnrecognised: 'chain_refused_unrecognised',
} as const;

export type RefuseReason = (typeof RefuseReason)[keyof typeof RefuseReason];

/** Which limit ran out, so an operator is told what to raise. */
export type Bucket = 'per_call' | 'daily' | 'monthly' | 'ceiling' | 'payee_cap' | 'balance';

export type AllowDecision = { readonly decision: 'allow' };

/**
 * The spend is inside every limit but at or above the principal's approval threshold, so it
 * needs consent before it settles. On chain that is the `spendApproved` path; here it is a
 * decision in its own right, and the amount stays reserved against the ceiling while the
 * hold is open so a parked hold cannot be approved past it later.
 *
 * `threshold_micros` keeps its wire spelling because it is hashed into the decision body.
 */
export type HoldDecision = { readonly decision: 'hold'; readonly threshold_micros: Micro };

export type RefuseDecision = { readonly decision: 'refuse'; readonly reason: RefuseReason };

export type Decision = AllowDecision | HoldDecision | RefuseDecision;

export const allow = (): AllowDecision => ({ decision: 'allow' });
export const hold = (thresholdMicros: Micro): HoldDecision => ({
  decision: 'hold',
  threshold_micros: thresholdMicros,
});
export const refuse = (reason: RefuseReason): RefuseDecision => ({ decision: 'refuse', reason });

/** Which bucket a refusal drained, or null where it is not about headroom. */
export function bucketFor(reason: RefuseReason): Bucket | null {
  switch (reason) {
    case RefuseReason.OverPerCallCap:
      return 'per_call';
    case RefuseReason.DailyCapExceeded:
      return 'daily';
    case RefuseReason.MonthlyCapExceeded:
      return 'monthly';
    case RefuseReason.OverCumulativeCeiling:
      return 'ceiling';
    case RefuseReason.PayeeCapExceeded:
      return 'payee_cap';
    case RefuseReason.AccountUnderfunded:
      return 'balance';
    default:
      return null;
  }
}
