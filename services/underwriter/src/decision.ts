import { RefuseReason as CoreRefuseReason, bucketFor as coreBucketFor } from '@bursar/core';
import type { AllowDecision, Bucket, HoldDecision } from '@bursar/core';

// Decisions and refusal reasons live in @bursar/core with the evaluator that produces them. The
// wire spellings are unchanged: they are pinned by the conformance vector.
export { allow, hold } from '@bursar/core';
export type { AllowDecision, Bucket, HoldDecision } from '@bursar/core';

/**
 * Core's refusals, and one the escrow added that only this service checks: a lock under the
 * escrow's floor. The account's `previewSpend` does not know the floor, so a spend under it
 * clears every limit and then reverts inside `lock`. Nothing in the document evaluator can raise
 * it, which is why it lives beside the escrow checks here rather than in the shared vocabulary.
 */
export const RefuseReason = { ...CoreRefuseReason, BelowMinLock: 'below_min_lock' } as const;

export type RefuseReason = (typeof RefuseReason)[keyof typeof RefuseReason];

export type RefuseDecision = { readonly decision: 'refuse'; readonly reason: RefuseReason };

export type Decision = AllowDecision | HoldDecision | RefuseDecision;

export const refuse = (reason: RefuseReason): RefuseDecision => ({ decision: 'refuse', reason });

/** Which bucket a refusal drained, or null where it is not about headroom. The floor is not. */
export function bucketFor(reason: RefuseReason): Bucket | null {
  return reason === RefuseReason.BelowMinLock ? null : coreBucketFor(reason);
}
