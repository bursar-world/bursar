import { microToAtomicString } from '@bursar/core';

import type { AccountState } from '../chain.js';
import { MAX_AMOUNT_MICROS, type MandateDocument, parseDocument } from '../document.js';

/*
 * The mandate as the account itself states it.
 *
 * This is the `chain` document source: no principal wrote a document, so the terms are read off
 * the MandateAccount and expressed in the same shape one would have. Nothing here is invented.
 * Every field is a value the contract holds, and the two fields the contract has no concept of
 * are set so they cannot bind:
 *
 *   - `rules` admits every action, because action strings are a document idea and the contract's
 *     own gate is the capability allowlist, which `previewSpend` already applies;
 *   - `ceiling_micros` is the widest amount the contract can store, because there is no lifetime
 *     ceiling on chain and a smaller number here would be a limit this service invented.
 *
 * The merchant roster and the capability allowlist are left undeclared. Both are mappings on the
 * account and neither can be enumerated through a read, so a document claiming to list them would
 * be describing a roster it never saw.
 */

/**
 * The last second a JavaScript date can express as an ISO string without losing the year, and what
 * both `validUntil == 0` and a validity that runs past it are expressed as.
 *
 * `MandateAccount._setLimits` only asks that `validUntil` be greater than `validFrom`, so
 * `type(uint64).max` is a legal way to say "never expires". It is also 584 billion years out: fed
 * to `new Date` it throws a `RangeError`, which is neither a refusal nor a `BursarError`, and
 * the mandate becomes undecidable. Clamping keeps the derived terms at or inside the account's,
 * which is the direction that is always safe.
 */
const FURTHEST_SECONDS = 253_402_300_799n;

export function deriveDocument(subject: string, state: AccountState, chainId: number): MandateDocument {
  const { limits } = state;

  const daily = limits.dailyWindowSeconds > 0 ? limits.dailyWindowSeconds : null;
  const monthly = limits.monthlyWindowSeconds > 0 ? limits.monthlyWindowSeconds : null;

  const expires = limits.validUntil === 0n ? FURTHEST_SECONDS : atMost(limits.validUntil, FURTHEST_SECONDS);

  return parseDocument(
    {
      subject,
      account: state.account,
      chain_id: chainId,
      version: state.version,
      // A document is rejected unless `valid_from` falls before `expires_at`, and both can be
      // clamped to the same instant on an account whose validity runs past the calendar.
      ...(limits.validFrom === 0n ? {} : { valid_from: isoSeconds(atMost(limits.validFrom, expires - 1n)) }),
      expires_at: isoSeconds(expires),
      rules: [{ pattern: '*', effect: 'allow' }],
      ceiling_micros: MAX_AMOUNT_MICROS.toString(10),
      per_call_cap_micros: microToAtomicString(limits.perCallCapMicros),
      approval_threshold_micros: microToAtomicString(limits.approvalThresholdMicros),
      ...(daily === null
        ? {}
        : {
            daily_limit_micros: microToAtomicString(limits.dailyCapMicros),
            daily_window_seconds: daily,
          }),
      ...(monthly === null
        ? {}
        : {
            monthly_limit_micros: microToAtomicString(limits.monthlyCapMicros),
            monthly_window_seconds: monthly,
          }),
      ...(daily === null && monthly === null ? {} : { window_anchor: isoSeconds(windowAnchor(state)) }),
    },
    `MandateAccount ${state.account}`,
  );
}

/**
 * Both rolling windows share one anchor in the document and two on chain, so the earlier start is
 * taken. An anchor earlier than a window's real start rolls that window no later than the contract
 * does, which keeps the derived terms at or inside the account's.
 */
function windowAnchor(state: AccountState): bigint {
  const daily = state.limits.dailyWindowSeconds > 0 ? state.daily.startSeconds : null;
  const monthly = state.limits.monthlyWindowSeconds > 0 ? state.monthly.startSeconds : null;
  if (daily === null) return monthly ?? 0n;
  if (monthly === null) return daily;
  return daily < monthly ? daily : monthly;
}

function atMost(seconds: bigint, ceiling: bigint): bigint {
  return seconds > ceiling ? ceiling : seconds;
}

function isoSeconds(seconds: bigint): string {
  return new Date(Number(atMost(seconds, FURTHEST_SECONDS)) * 1_000).toISOString();
}
