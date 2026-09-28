/**
 * The total budget, carried in the MandateAccount's second window.
 *
 * The live account holds two rolling windows and no lifetime field. The first window is the
 * per-period cap. The second is made a total by giving it a period the mandate can never outlive:
 * at least one hundred years, or longer if the mandate is valid for longer. It never rolls, so what
 * the agent spends from it never comes back. `setLimits` carries spent amounts across an amendment,
 * so raising or lowering the total keeps what was already spent.
 *
 * A window this long is how every surface recognises a total budget, so a refusal from it is named
 * "total budget" rather than "monthly cap".
 */

export const YEAR_SECONDS = 365 * 86_400;

/** One hundred years. Any second window at least this long is read as the total budget. */
export const TOTAL_BUDGET_MIN_SECONDS = 100 * YEAR_SECONDS;

/**
 * The second-window duration that makes it a total: `max(validUntil - now, 100 years)`, in seconds.
 *
 * A mandate with no expiry (`validUntil` 0) gets the hundred years. A longer expiry is rounded up to
 * a whole day, so the value, and the account address it feeds into, does not change every second.
 */
export function totalBudgetWindowSeconds(validUntil: number | bigint, now: number | bigint): bigint {
  const until = BigInt(validUntil);
  const at = BigInt(now);
  const floor = BigInt(TOTAL_BUDGET_MIN_SECONDS);
  if (until === 0n || until - at <= floor) return floor;
  const day = 86_400n;
  const span = until - at;
  return ((span + day - 1n) / day) * day;
}

/** Whether a window duration is the total budget rather than a rolling period. */
export function isTotalBudgetWindow(seconds: number | bigint): boolean {
  return BigInt(seconds) >= BigInt(TOTAL_BUDGET_MIN_SECONDS);
}
