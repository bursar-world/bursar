// Decisions and refusal reasons live in @bursar/core with the evaluator that produces them. The
// wire spellings are unchanged: they are pinned by the conformance vector.
export { RefuseReason, allow, bucketFor, hold, refuse } from '@bursar/core';
export type { AllowDecision, Bucket, Decision, HoldDecision, RefuseDecision } from '@bursar/core';
