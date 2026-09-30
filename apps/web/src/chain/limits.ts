import { DEFAULT_CLASS_MASK, isTotalBudgetWindow, micro } from '@bursar/core';
import type { ContractSet, Micro } from '@bursar/core';
import type { MandateLimits, SpendWindow } from '@bursar/sdk';

import type { RawLimits, RawLimitsV1 } from './reader';

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
  /**
   * Seconds. Named daily and monthly by convention; the contract holds two arbitrary windows. The
   * console uses the first as the period cap and the second as the total budget, which is a window
   * long enough never to roll (see `totalBudgetWindowSeconds`).
   */
  readonly dailyWindow: number;
  readonly monthlyWindow: number;
  /** At and above this, the account owner signs the payment personally. Never zero. */
  readonly approvalThreshold: Micro;
  readonly validFrom?: number;
  /** Zero, or absent, means no expiry. */
  readonly validUntil?: number;
  /**
   * The spend classes a v2 account allows, one bit each: 0 services, 1 agent hires, 2 eligible
   * stocks. Absent means services and hires. A v1 account has no such field.
   */
  readonly classMask?: number;
  /** A v2 account's lifetime total, net of refunds. Zero, or absent, means none. */
  readonly totalCap?: Micro;
  /** Where a v2 account settles. Zero, the escrow, is the only lane with contracts behind it. */
  readonly lane?: number;
};

export const DAY_SECONDS = 86_400;
export const MONTH_SECONDS = 30 * DAY_SECONDS;

export type LimitsProblem = { readonly field: keyof LimitsForm; readonly problem: string };

/** What the contract refuses, checked here so a form says it before a wallet opens. */
export function checkLimits(form: LimitsForm): readonly LimitsProblem[] {
  const problems: LimitsProblem[] = [];

  if (form.perCallCap <= 0n) problems.push({ field: 'perCallCap', problem: 'A mandate needs a ceiling on a single payment.' });
  const native = (form.totalCap ?? 0n) > 0n;
  // On v2 the total has a field of its own, so the second window is a rolling cap however long.
  const total = !native && isTotalBudgetWindow(form.monthlyWindow);
  if (form.dailyCap < form.perCallCap) problems.push({ field: 'dailyCap', problem: 'The period cap has to be at least the per-payment limit.' });
  if (native && (form.totalCap ?? 0n) < form.dailyCap) {
    problems.push({ field: 'totalCap', problem: 'The total budget has to be at least the period cap.' });
  }
  if (form.classMask !== undefined && form.classMask === 0) {
    problems.push({ field: 'classMask', problem: 'Allow at least one spend class, or the mandate refuses every payment.' });
  }
  if (form.monthlyCap < form.dailyCap) {
    problems.push({
      field: 'monthlyCap',
      problem: total ? 'The total budget has to be at least the period cap.' : 'The second cap has to be at least the period cap.',
    });
  }
  if (form.approvalThreshold <= 0n) problems.push({ field: 'approvalThreshold', problem: 'Set the amount above which you want to sign personally.' });
  if (form.dailyWindow <= 0) problems.push({ field: 'dailyWindow', problem: 'The period has to be longer than zero.' });
  if (form.monthlyWindow < form.dailyWindow) problems.push({ field: 'monthlyWindow', problem: 'The second cap has to refill no faster than the period cap.' });
  if (form.validUntil !== undefined && form.validUntil !== 0 && form.validFrom !== undefined && form.validUntil <= form.validFrom) {
    problems.push({ field: 'validUntil', problem: 'The mandate would expire before it opens.' });
  }

  return problems;
}

/** The struct the current ABI takes. Ordering matters; the contract reads it positionally. */
export function toLimitsTuple(form: LimitsForm): RawLimits {
  return {
    ...toLimitsTupleV1(form),
    classMask: form.classMask ?? DEFAULT_CLASS_MASK,
    totalCap: form.totalCap ?? micro(0n),
    lane: form.lane ?? 0,
  };
}

/** The eight-field struct a v1 account takes. It has nowhere to put classes or a native total. */
export function toLimitsTupleV1(form: LimitsForm): RawLimitsV1 {
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

/** What a mandate reading needs to say whether it carries a total budget, and what is left of it. */
export type TotalBudgetSource = {
  readonly contractSet: ContractSet;
  readonly limits: Pick<MandateLimits, 'totalCap'>;
  readonly totalSpent: Micro | undefined;
  readonly daily: SpendWindow;
  readonly monthly: SpendWindow;
};

export type TotalBudget = { readonly cap: Micro; readonly spent: Micro; readonly remaining: Micro };

/**
 * The mandate's total budget, or undefined when it has none.
 *
 * An account from v2 on holds it natively in `totalCap`. A v1 account has no such field, and the
 * console gave it one by making the second window long enough never to roll.
 */
export function totalBudgetOf(account: TotalBudgetSource): TotalBudget | undefined {
  if (account.contractSet !== 'v1') {
    const cap = account.limits.totalCap;
    if (cap === 0n) return undefined;
    const spent = account.totalSpent ?? micro(0n);
    return { cap, spent, remaining: micro(cap > spent ? cap - spent : 0n) };
  }
  if (!isTotalBudgetWindow(account.monthly.duration)) return undefined;
  return { cap: account.monthly.cap, spent: account.monthly.spent, remaining: account.monthly.remaining };
}

/**
 * Whether the second window is a rolling cap worth showing. On v1 it is not when it stands in for
 * the total. From v2 on the console writes it as a copy of the first window, which binds nothing
 * extra.
 */
export function showsSecondCap(account: TotalBudgetSource): boolean {
  if (account.contractSet === 'v1') return !isTotalBudgetWindow(account.monthly.duration);
  return !(account.monthly.duration === account.daily.duration && account.monthly.cap === account.daily.cap);
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
    classMask: limits.classMask,
    totalCap: limits.totalCap,
    lane: limits.lane,
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
