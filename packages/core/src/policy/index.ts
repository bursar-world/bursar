export { DocumentError, RequestError } from './errors.js';
export { RefuseReason, allow, bucketFor, hold, refuse } from './decision.js';
export type { AllowDecision, Bucket, Decision, HoldDecision, RefuseDecision } from './decision.js';
export { parseRule, permits, ruleToPattern } from './rules.js';
export type { Rule, RuleEffect, RulePattern } from './rules.js';
export { merchantLeaf, processProof, verifyMerchantProof } from './merkle.js';
export { parseTimestamp, spendHistory } from './types.js';
export type {
  Address,
  Hex32,
  MandateDocument,
  MandateWindow,
  MerchantGate,
  ReplayOptions,
  SpendHistory,
} from './types.js';
export {
  assertRequest,
  capabilityFromAction,
  documentWindows,
  evaluateDocument,
  windowStartMs,
} from './evaluate.js';
export type { DocumentWindows, SpendRequest, WindowState } from './evaluate.js';
