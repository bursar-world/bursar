import { contractSetAtLeast, isTotalBudgetWindow, micro } from '@bursar/core';
import type { ContractSet, Micro } from '@bursar/core';
import { LockStatus, MerchantGate } from '@bursar/sdk';

import { DAY_SECONDS } from '@/chain/limits';
import type { LimitsForm } from '@/chain/limits';
import type { StateLevel } from '@/state/types';
import { usd } from '@/money';
import { formatDuration } from '@/lib/time';

/**
 * The approval threshold, in the three readings a person means.
 *
 * The field binds at and above, so zero means every payment needs consent. The contract refuses
 * zero outright: a mandate that deployed that way would read to its owner like an outage. Turning
 * approvals off is therefore the largest value, not the smallest. Everything in the console goes
 * through these three so nobody has to hold that inversion in their head.
 */
export type ApprovalMode = 'every' | 'above' | 'never';

/** Consent on every payment: one micro-dollar, since the threshold binds at and above. */
export const APPROVE_EVERYTHING: Micro = micro(1n);

/** Consent on nothing: the largest value the field holds, which no payment can reach. */
export const APPROVE_NOTHING: Micro = micro(2n ** 128n - 1n);

export function approvalModeOf(threshold: Micro, perCallCap: Micro): ApprovalMode {
  if (threshold <= APPROVE_EVERYTHING) return 'every';
  if (threshold > perCallCap) return 'never';
  return 'above';
}

/**
 * The caps in the order an owner sets them, as the review reads them back. A second window that
 * only repeats the first is how a native total is written, so it is not read out twice.
 */
export function describeLimits(limits: LimitsForm): string {
  const parts = [`${usd(limits.perCallCap)} per payment`, `${usd(limits.dailyCap)} ${per(limits.dailyWindow)}`];
  const secondIsCopy = limits.monthlyWindow === limits.dailyWindow && limits.monthlyCap === limits.dailyCap;
  if (!secondIsCopy) {
    parts.push(isTotalBudgetWindow(limits.monthlyWindow) ? `${usd(limits.monthlyCap)} in total` : `${usd(limits.monthlyCap)} ${per(limits.monthlyWindow)}`);
  }
  if (limits.totalCap !== undefined && limits.totalCap > 0n) parts.push(`${usd(limits.totalCap)} in total`);
  return parts.join(', ');
}

function per(seconds: number): string {
  if (seconds === DAY_SECONDS) return 'per day';
  if (seconds === 30 * DAY_SECONDS) return 'per month';
  if (seconds % DAY_SECONDS === 0) return `per ${seconds / DAY_SECONDS} days`;
  if (seconds === 3_600) return 'per hour';
  if (seconds % 3_600 === 0) return `per ${seconds / 3_600} hours`;
  return `per ${formatDuration(seconds)}`;
}

/** Said to the owner by default; a reader who does not own the mandate is told who approves. */
export function describeApproval(threshold: Micro, perCallCap: Micro, reader: 'owner' | 'visitor' = 'owner'): string {
  const mode = approvalModeOf(threshold, perCallCap);
  if (reader === 'visitor') {
    if (mode === 'every') return 'The owner approves every payment';
    if (mode === 'never') return 'No payment needs the owner’s approval';
    return `The owner approves payments of ${usd(threshold)} and above`;
  }
  if (mode === 'every') return 'You approve every payment';
  if (mode === 'never') return 'No payment needs your approval';
  return `You approve payments of ${usd(threshold)} and above`;
}

/** What a lock is doing with the money right now. */
export function lockWord(status: LockStatus): string {
  switch (status) {
    case LockStatus.Locked:
      return 'Held';
    case LockStatus.Released:
      return 'Paid';
    case LockStatus.TimedOut:
      return 'Returned';
    case LockStatus.Disputed:
      return 'Disputed';
    case LockStatus.Cancelled:
      return 'Cancelled';
    case LockStatus.Resolved:
      return 'Ruled on';
    case LockStatus.None:
    default:
      return 'Unknown';
  }
}

export function lockDetail(status: LockStatus): string {
  switch (status) {
    case LockStatus.Locked:
      return 'Held in escrow until the provider delivers or the deadline passes.';
    case LockStatus.Released:
      return 'The provider delivered and was paid.';
    case LockStatus.TimedOut:
      return 'Not delivered in time. The money and the budget went back to the mandate.';
    case LockStatus.Disputed:
      return 'The delivery was contested. Resolvers decide where the money goes.';
    case LockStatus.Cancelled:
      return 'Called off before it settled.';
    case LockStatus.Resolved:
      return 'The resolvers decided where the money went.';
    case LockStatus.None:
    default:
      return 'No payment found under this id.';
  }
}

export function lockLevel(status: LockStatus): StateLevel {
  switch (status) {
    case LockStatus.Released:
      return 'ok';
    case LockStatus.Locked:
      return 'attention';
    case LockStatus.TimedOut:
    case LockStatus.Cancelled:
      return 'attention';
    case LockStatus.Disputed:
      return 'blocked';
    case LockStatus.Resolved:
      return 'attention';
    case LockStatus.None:
    default:
      return 'unknown';
  }
}

/**
 * Whether a complaint is still open on a payment, on the escrow's own conditions.
 *
 * A lock it still holds can be contested by either side, and on the current escrow only until its
 * deadline: past that the payer is owed the timeout refund, and the escrow answers `TooLate`. A
 * lock it has paid out can be contested by the payer alone, and only until the dispute window
 * closes. Both screens that offer the control read this one function, because a settlement listed
 * as contestable in one place and refused in the other is the same bug twice.
 */
export function contestable(
  lock:
    | {
        readonly status: LockStatus;
        readonly releasedAt: Date | null;
        readonly disputedAt?: Date | null;
        readonly deadline?: Date;
      }
    | undefined,
  disputeWindow: bigint | undefined,
  now: Date = new Date(),
  set?: ContractSet,
): boolean {
  if (!lock) return false;
  if (lock.status === LockStatus.Locked) {
    // A dispute that closed without a ruling puts the lock back to Locked with its dispute time
    // kept, and the registry refuses a second dispute on the same lock.
    if (lock.disputedAt !== undefined && lock.disputedAt !== null) return false;
    const closesAtDeadline = set !== undefined && contractSetAtLeast(set, 'v3');
    return !closesAtDeadline || lock.deadline === undefined || now.getTime() <= lock.deadline.getTime();
  }
  if (lock.status !== LockStatus.Released || lock.releasedAt === null || disputeWindow === undefined) return false;
  return lock.releasedAt.getTime() + Number(disputeWindow) * 1000 > now.getTime();
}

/**
 * Whether the escrow would return this payment to the mandate right now.
 *
 * `Escrow.timeout` is open to anybody once a lock is past its deadline, and it refuses with
 * `TooEarly` at any moment up to and including it. The clock it reads is the chain's, so that is
 * the clock this answers against: a browser running a few seconds fast would otherwise offer a
 * control that costs a refused simulation and nothing else. An unread chain time is not a passed
 * deadline, so it answers no.
 */
export function returnable(
  lock: { readonly status: LockStatus; readonly deadline: Date } | undefined,
  chainTime: Date | undefined,
): boolean {
  if (!lock || chainTime === undefined) return false;
  return lock.status === LockStatus.Locked && chainTime.getTime() > lock.deadline.getTime();
}

/**
 * What a payment past its deadline is doing, which is nothing.
 *
 * `lockWord` answers `Held` for it, and held is what it was before the deadline. The money is
 * still in the escrow and nobody is going to deliver against it, which is a different sentence and
 * the one that tells the payer there is something to do.
 */
export const OVERDUE_WORD = 'Past its deadline';

export const OVERDUE_DETAIL = 'Not delivered in time. The money is yours to take back.';

export function gateWord(gate: MerchantGate): string {
  return gate === MerchantGate.MerkleRoot ? 'Published list' : 'Listed on this mandate';
}

export function gateDetail(gate: MerchantGate): string {
  return gate === MerchantGate.MerkleRoot
    ? 'Payees are checked against a published list. Each payment proves its payee is on it.'
    : 'Payees are checked against the list on this mandate. Anyone else is refused.';
}

/**
 * A window length as a person would say it. The contract holds two arbitrary periods and the
 * product calls them daily and monthly, so a mandate set to eight hours has to read as eight
 * hours. Calling that one "daily" would be a lie about the limit.
 */
export function windowWord(seconds: bigint | number): string {
  const value = Number(seconds);
  if (value === DAY_SECONDS) return 'day';
  if (value === 30 * DAY_SECONDS) return 'month';
  return formatDuration(value);
}
