import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { MandateLimits } from '@bursar/sdk';

import type { RawLimits } from './reader';

/**
 * The limit set as a form collects it and as the contract takes it.
 *
 * `IMandateAccount.Limits` is one struct written atomically, so a mandate is never briefly funded
 * without a bound. It is also part of the account's init code, which means the address depends on
 * it: the same salt with different limits is a different account, and a form that changes a limit
 * after predicting an address has predicted the wrong one.
 */
export type LimitsForm = {
  readonly perCallCap: Micro;
  readonly dailyCap: Micro;
  readonly monthlyCap: Micro;
  /** Seconds. Named daily and monthly by convention; the contract holds two arbitrary windows. */
  readonly dailyWindow: number;
  readonly monthlyWindow: number;
  /** At and above this, the account owner signs the payment personally. Never zero. */
  readonly approvalThreshold: Micro;
  readonly validFrom?: number;
  /** Zero, or absent, means no expiry. */
  readonly validUntil?: number;
};

export const DAY_SECONDS = 86_400;
export const MONTH_SECONDS = 30 * DAY_SECONDS;

export type LimitsProblem = { readonly field: keyof LimitsForm; readonly problem: string };

/** What the contract refuses, checked here so a form says it before a wallet opens. */
export function checkLimits(form: LimitsForm): readonly LimitsProblem[] {
  const problems: LimitsProblem[] = [];

  if (form.perCallCap <= 0n) problems.push({ field: 'perCallCap', problem: 'A mandate needs a ceiling on a single payment.' });
  if (form.dailyCap < form.perCallCap) problems.push({ field: 'dailyCap', problem: 'The daily limit has to be at least the per-payment limit.' });
  if (form.monthlyCap < form.dailyCap) problems.push({ field: 'monthlyCap', problem: 'The monthly limit has to be at least the daily limit.' });
  if (form.approvalThreshold <= 0n) problems.push({ field: 'approvalThreshold', problem: 'Set the amount above which you want to sign personally.' });
  if (form.dailyWindow <= 0) problems.push({ field: 'dailyWindow', problem: 'The daily window has to be longer than zero.' });
  if (form.monthlyWindow < form.dailyWindow) problems.push({ field: 'monthlyWindow', problem: 'The longer window has to be at least the shorter one.' });
  if (form.validUntil !== undefined && form.validUntil !== 0 && form.validFrom !== undefined && form.validUntil <= form.validFrom) {
    problems.push({ field: 'validUntil', problem: 'The mandate would expire before it opens.' });
  }

  return problems;
}

/** The struct the ABI takes. Ordering matters; the contract reads it positionally. */
export function toLimitsTuple(form: LimitsForm): RawLimits {
  return {
    perCallCap: form.perCallCap,
    dailyCap: form.dailyCap,
    monthlyCap: form.monthlyCap,
    dailyWindow: BigInt(form.dailyWindow),
    monthlyWindow: BigInt(form.monthlyWindow),
    approvalThreshold: form.approvalThreshold,
    validFrom: BigInt(form.validFrom ?? 0),
    validUntil: BigInt(form.validUntil ?? 0),
  };
}

/** The other direction, for a form seeded from a mandate that already exists. */
export function fromLimits(limits: MandateLimits): LimitsForm {
  return {
    perCallCap: limits.perCallCap,
    dailyCap: limits.dailyCap,
    monthlyCap: limits.monthlyCap,
    dailyWindow: Number(limits.dailyWindow),
    monthlyWindow: Number(limits.monthlyWindow),
    approvalThreshold: limits.approvalThreshold,
    validFrom: Number(limits.validFrom),
    validUntil: Number(limits.validUntil),
  };
}

export const ZERO_LIMITS: LimitsForm = {
  perCallCap: micro(0n),
  dailyCap: micro(0n),
  monthlyCap: micro(0n),
  dailyWindow: DAY_SECONDS,
  monthlyWindow: MONTH_SECONDS,
  approvalThreshold: micro(0n),
};
