import { toCapabilityId } from '../commit.js';
import { type Micro, ZERO_MICRO, micro } from '../money.js';
import { type Decision, RefuseReason, allow, hold, refuse } from './decision.js';
import { RequestError } from './errors.js';
import { verifyMerchantProof } from './merkle.js';
import { permits } from './rules.js';
import { type Address, type Hex32, type MandateDocument, type ReplayOptions, type SpendHistory, parseTimestamp } from './types.js';

/**
 * The pure mandate evaluator: a document, the spend already committed against it, and one request
 * in; one decision out. It reads no chain and writes nothing.
 *
 * It lives here so the underwriter and the console run the same code. The underwriter decides live
 * spends with it; the console runs it on saved drafts before anything is deployed.
 */

export type SpendRequest = {
  readonly requestId: string;
  readonly subject: string;
  readonly action: string;
  readonly amountMicros: Micro;
  /** RFC 3339, carried verbatim into the hashed decision body. */
  readonly at: string;
  readonly merchant?: Address;
  readonly capabilityId?: Hex32;
  /** Required under a Merkle merchant gate, rejected under an allowlist, as on chain. */
  readonly merchantProof?: readonly Hex32[];
  /** Unix seconds. The escrow deadline the resulting lock would carry. */
  readonly deadline?: bigint;
};

export type WindowState = {
  readonly limitMicros: Micro;
  readonly spentMicros: Micro;
  readonly remainingMicros: Micro;
  readonly startMs: number;
  readonly seconds: number;
};

/**
 * Where the current period started. The anchor advances by whole periods, as
 * `MandateAccount._rolled` does, and for the same reason: snapping to now would let an agent that
 * waits out a window buy itself a fresh one on a schedule of its choosing.
 */
export function windowStartMs(anchorMs: number, seconds: number, atMs: number): number {
  const period = seconds * 1000;
  if (atMs <= anchorMs) return anchorMs;
  const elapsed = atMs - anchorMs;
  return anchorMs + Math.floor(elapsed / period) * period;
}

function windowState(
  limitMicros: Micro,
  seconds: number,
  anchorMs: number,
  atMs: number,
  log: SpendHistory,
  replay: ReplayOptions,
): WindowState {
  const startMs = windowStartMs(anchorMs, seconds, atMs);
  const spent = log.committedMicros(startMs, replay);
  const remaining = limitMicros > spent ? limitMicros - spent : 0n;
  return { limitMicros, spentMicros: spent, remainingMicros: micro(remaining), startMs, seconds };
}

export type DocumentWindows = { readonly daily: WindowState | null; readonly monthly: WindowState | null };

export function documentWindows(
  document: MandateDocument,
  log: SpendHistory,
  atMs: number,
  replay: ReplayOptions = {},
): DocumentWindows {
  const anchorMs = document.windowAnchor === null ? null : parseTimestamp(document.windowAnchor, 'window_anchor');
  return {
    daily:
      document.daily === null || anchorMs === null
        ? null
        : windowState(document.daily.limitMicros, document.daily.seconds, anchorMs, atMs, log, replay),
    monthly:
      document.monthly === null || anchorMs === null
        ? null
        : windowState(document.monthly.limitMicros, document.monthly.seconds, anchorMs, atMs, log, replay),
  };
}

/**
 * A capability label: a name and a version, as `doc.summarize:1`, optionally under a spend-class
 * namespace, as `service:doc.summarize:1`.
 *
 * The contract holds capabilities as the keccak of exactly this string, so a label is an id
 * anybody can compute and an id is a label nobody can read back.
 */
const CAPABILITY_LABEL = /^(?:(?:service|hire|rwa):)?[A-Za-z0-9][A-Za-z0-9._-]*:[0-9]+$/;

/**
 * The capability an action names, or null when the action is not a capability label.
 *
 * Every published example writes the action as the capability label, and the account's allowlist
 * is keyed on that label's hash, so an action in that form carries the id already. Deriving it
 * here is the difference between a caller having to hash a string themselves and a caller being
 * told their spend was outside a policy that never ran.
 */
export function capabilityFromAction(action: string): Hex32 | null {
  return CAPABILITY_LABEL.test(action) ? (toCapabilityId(action) as Hex32) : null;
}

export function assertRequest(request: SpendRequest): void {
  if (typeof request.requestId !== 'string' || request.requestId === '') {
    throw new RequestError('requestId must be a non-empty string');
  }
  if (request.amountMicros < 0n) {
    throw new RequestError('amountMicro must not be negative', { requestId: request.requestId });
  }
  parseTimestamp(request.at, 'at');
}

function merchantReason(document: MandateDocument, request: SpendRequest): RefuseReason | null {
  const gate = document.merchantGate;
  if (gate === null) return null;
  if (request.merchant === undefined) return RefuseReason.ZeroAddress;

  if (gate.kind === 'allowlist') {
    // A proof carried into an allowlist gate is a proof against a root nobody reads, and the
    // contract rejects it. Matching that here keeps the quote honest.
    if (request.merchantProof !== undefined && request.merchantProof.length > 0) {
      return RefuseReason.StaleMerchantProof;
    }
    const listed = gate.merchants.some((m) => m.toLowerCase() === request.merchant?.toLowerCase());
    return listed ? null : RefuseReason.MerchantNotAllowed;
  }

  if (request.merchantProof === undefined) return RefuseReason.MerchantGateUndecidable;
  return verifyMerchantProof(gate.root, request.merchant, request.merchantProof) ? null : RefuseReason.BadMerkleProof;
}

/**
 * Decides a request against the document and the spend already committed on its log.
 *
 * The checks run in a fixed order and the first that fails decides the call. The order the
 * ported evaluator established (subject, expiry, action, per-call cap, cumulative ceiling,
 * approval threshold) is preserved exactly, because the conformance vector pins the decision
 * each of its steps produces and every decision is hashed into the chain. The limits the
 * MandateAccount added are interleaved at the points where they do not disturb it.
 *
 * Two departures from the source:
 *
 *   - a zero amount is refused before evaluation, because the contract reverts on it;
 *   - the approval threshold binds at and above, not strictly above, because
 *     `MandateAccount._reason` uses `>=`. Leaving the source's `>` would have this service
 *     authorise a spend the contract then refuses with `ApprovalRequired`.
 *
 * A call exactly at the ceiling is allowed; the next micro is refused. This is a pure read.
 */
export function evaluateDocument(
  document: MandateDocument,
  log: SpendHistory,
  request: SpendRequest,
  replay: ReplayOptions = {},
): Decision {
  assertRequest(request);

  if (request.subject !== document.subject) return refuse(RefuseReason.WrongSubject);
  if (request.amountMicros === ZERO_MICRO) return refuse(RefuseReason.ZeroAmount);

  const atMs = Date.parse(request.at);
  if (document.validFrom !== null && atMs < Date.parse(document.validFrom)) {
    return refuse(RefuseReason.NotYetValid);
  }
  if (atMs >= Date.parse(document.expiresAt)) return refuse(RefuseReason.Expired);

  if (!permits(document.rules, request.action)) return refuse(RefuseReason.OutsideMandate);

  const merchant = merchantReason(document, request);
  if (merchant !== null) return refuse(merchant);

  if (document.capabilities !== null) {
    const id = request.capabilityId?.toLowerCase();
    if (id === undefined || !document.capabilities.some((c) => c.toLowerCase() === id)) {
      return refuse(RefuseReason.CapabilityNotAllowed);
    }
  }

  if (request.amountMicros > document.perCallCapMicros) return refuse(RefuseReason.OverPerCallCap);

  const windows = documentWindows(document, log, atMs, replay);
  if (windows.daily !== null && request.amountMicros > windows.daily.remainingMicros) {
    return refuse(RefuseReason.DailyCapExceeded);
  }
  if (windows.monthly !== null && request.amountMicros > windows.monthly.remainingMicros) {
    return refuse(RefuseReason.MonthlyCapExceeded);
  }

  const projected = log.committedMicros(Number.NEGATIVE_INFINITY, replay) + request.amountMicros;
  if (projected > document.ceilingMicros) return refuse(RefuseReason.OverCumulativeCeiling);

  const threshold = document.approvalThresholdMicros;
  if (threshold !== null && request.amountMicros >= threshold) return hold(threshold);

  return allow();
}

