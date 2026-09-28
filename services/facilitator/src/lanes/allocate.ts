import { ZERO_MICRO, addMicro, minMicro, subMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';

/**
 * The arithmetic behind repayment and collateral health, separated from the SQL that feeds it.
 *
 * Everything here is a pure function of its arguments. The decisions about who gets paid first and
 * whether a position is still solvent are the parts worth testing exhaustively, and they should
 * not need a database to exercise.
 */

export type OpenDebt = {
  readonly id: string;
  readonly outstandingMicro: Micro;
};

export type DebtApplication = {
  readonly debtId: string;
  readonly appliedMicro: Micro;
  readonly remainingMicro: Micro;
  readonly closes: boolean;
};

export type RepaymentAllocation = {
  readonly applications: readonly DebtApplication[];
  readonly appliedMicro: Micro;
  /** What the payment could not be applied to, because the debts ran out before the money did. */
  readonly unappliedMicro: Micro;
};

/**
 * Oldest debt first.
 *
 * The caller reads open debts with `ORDER BY created_at ASC ... FOR UPDATE`, so the list arriving
 * here is already in age order and already locked. Paying the oldest first keeps a long-lived debt
 * from sitting behind newer ones for ever, and it makes the outcome of a repayment depend on the
 * ledger alone, whatever order the planner happened to return rows in.
 */
export function allocateRepayment(
  debts: readonly OpenDebt[],
  amountMicro: Micro,
): RepaymentAllocation {
  const applications: DebtApplication[] = [];
  let remaining = amountMicro > ZERO_MICRO ? amountMicro : ZERO_MICRO;
  let applied = ZERO_MICRO;

  for (const debt of debts) {
    if (remaining <= ZERO_MICRO) break;
    if (debt.outstandingMicro <= ZERO_MICRO) continue;

    const payment = minMicro(debt.outstandingMicro, remaining);
    const nextOutstanding = subMicro(debt.outstandingMicro, payment);
    applications.push({
      debtId: debt.id,
      appliedMicro: payment,
      remainingMicro: nextOutstanding,
      closes: nextOutstanding === ZERO_MICRO,
    });

    applied = addMicro(applied, payment);
    remaining = subMicro(remaining, payment);
  }

  return { applications, appliedMicro: applied, unappliedMicro: remaining };
}

/**
 * Posted value after the asset's discount.
 *
 * Truncated toward zero, matching how the contracts compute basis points in Solidity. Rounding the
 * other way would credit backing that does not exist.
 */
export function effectiveCollateral(amountMicro: Micro, haircutBps: number): Micro {
  if (!Number.isInteger(haircutBps) || haircutBps < 0 || haircutBps > 10_000) {
    throw new RangeError(`haircut must be 0..10000 basis points, got ${haircutBps}`);
  }
  return ((amountMicro * BigInt(10_000 - haircutBps)) / 10_000n) as Micro;
}

/**
 * The posted amount whose value, once the haircut is taken off it, is at least `backingMicro`.
 *
 * The inverse of `effectiveCollateral`, rounded up. Rounding down would lock a hair less collateral
 * than the debt it backs, which is the same mistake as crediting backing that does not exist.
 */
export function grossedUpCollateral(backingMicro: Micro, haircutBps: number): Micro {
  if (!Number.isInteger(haircutBps) || haircutBps < 0 || haircutBps >= 10_000) {
    throw new RangeError(`haircut must be 0..9999 basis points to back anything, got ${haircutBps}`);
  }
  if (backingMicro <= ZERO_MICRO) return ZERO_MICRO;
  const divisor = BigInt(10_000 - haircutBps);
  return ((backingMicro * 10_000n + divisor - 1n) / divisor) as Micro;
}

/**
 * Debt as a fraction of backing, in basis points, clamped to a full draw.
 *
 * Zero backing with debt outstanding would be a division by zero, and is reported as 10000: the
 * position is drawn past anything that supports it, and that is the number a risk check acts on.
 */
export function ltvBps(outstandingMicro: Micro, effectiveCollateralMicro: Micro): number {
  if (outstandingMicro <= ZERO_MICRO) return 0;
  if (effectiveCollateralMicro <= ZERO_MICRO) return 10_000;
  const raw = (outstandingMicro * 10_000n) / effectiveCollateralMicro;
  return raw >= 10_000n ? 10_000 : Number(raw);
}

/**
 * How much room is left before the pool's borrowing cap is reached. One is the edge.
 *
 * Null when nothing is owed. A position with no debt has no health factor, and returning a large
 * number instead invites a comparison that treats "no debt" as "very healthy but measured".
 */
export function healthFactor(
  outstandingMicro: Micro,
  effectiveCollateralMicro: Micro,
  ltvCapBps: number,
): number | null {
  if (outstandingMicro <= ZERO_MICRO) return null;
  if (ltvCapBps <= 0 || effectiveCollateralMicro <= ZERO_MICRO) return 0;

  // Scaled to six decimals before the conversion to a float, so the result is exact for any
  // position the ledger can hold.
  const scaled = (effectiveCollateralMicro * BigInt(ltvCapBps) * 1_000_000n) / (outstandingMicro * 10_000n);
  return Number(scaled) / 1_000_000;
}

/**
 * The most an agent may draw without breaching the pool's cap.
 *
 * Returns zero when the position is already past the cap, since a caller asking "how much more"
 * cannot act on a negative answer.
 */
export function borrowingHeadroom(
  effectiveCollateralMicro: Micro,
  outstandingMicro: Micro,
  ltvCapBps: number,
): Micro {
  const ceiling = ((effectiveCollateralMicro * BigInt(ltvCapBps)) / 10_000n) as Micro;
  return ceiling > outstandingMicro ? subMicro(ceiling, outstandingMicro) : ZERO_MICRO;
}
