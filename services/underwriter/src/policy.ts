import { evaluateDocument, parseTimestamp } from '@bursar/core';

import { RequestError } from './errors.js';
import type { SpendLog } from './log.js';

// The evaluator itself lives in @bursar/core, so the console runs the same code on drafts that
// this service runs on live spends.
export {
  assertRequest,
  capabilityFromAction,
  documentWindows,
  evaluateDocument,
  windowStartMs,
} from '@bursar/core';
export type { DocumentWindows, SpendRequest, WindowState } from '@bursar/core';

import type { Decision, MandateDocument, SpendRequest } from '@bursar/core';

/**
 * Holds the caller's `at` to the chain's own clock.
 *
 * `at` decides every limit the contract does not enforce: the validity window and both rolling
 * windows are measured against it, and it is hashed into the decision body. Left unchecked, the
 * caller picks them. A request dated a day forward buys itself a fresh daily window, one dated a
 * year back walks past an expiry, and both look ordinary in the journal afterwards.
 *
 * The allowance is the same drift the escrow deadline gets, because it answers the same question:
 * how far a caller's reading of now may sit from the block that decides.
 */
export function assertClock(at: string, chainSeconds: bigint, driftSeconds: bigint): void {
  const atSeconds = BigInt(Math.floor(parseTimestamp(at, 'at') / 1000));
  const skew = atSeconds > chainSeconds ? atSeconds - chainSeconds : chainSeconds - atSeconds;
  if (skew > driftSeconds) {
    throw new RequestError(
      `at is ${skew} seconds from the chain's clock, which allows ${driftSeconds}; the rolling windows and the validity window are measured against it. Leave at out and the time the request arrives is used.`,
      { at, chainSeconds: chainSeconds.toString(10), driftSeconds: driftSeconds.toString(10) },
    );
  }
}

export type DocumentAuthorization = {
  readonly decision: Decision;
  readonly idempotent: boolean;
};

/**
 * Document-only authorisation, kept for the conformance vector and for callers who have no
 * chain to read. Production callers use `Underwriter.authorize`, which will not allow anything
 * the MandateAccount would refuse.
 */
export function authorizeAgainstDocument(
  log: SpendLog,
  document: MandateDocument,
  request: SpendRequest,
): DocumentAuthorization & { readonly entry: ReturnType<SpendLog['record']>['entry'] } {
  const prior = log.decisionEntryFor(request.requestId);
  if (prior && prior.body.kind === 'decision') {
    return { decision: prior.body.decision, entry: prior, idempotent: true };
  }
  const decision = evaluateDocument(document, log, request);
  const { entry } = log.record(
    {
      requestId: request.requestId,
      subject: request.subject,
      action: request.action,
      amountMicros: request.amountMicros,
      at: request.at,
    },
    decision,
  );
  return { decision, entry, idempotent: false };
}
