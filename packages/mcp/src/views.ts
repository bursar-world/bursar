/**
 * What the mandate and the escrow say, turned into what a principal or an agent reads. Every line
 * an agent is shown lives here. The copy is reviewed in one place, never hunted through the call
 * sites.
 */

import { isTotalBudgetWindow } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { duration, instant, money, moneyFromUint, secondsUntil } from './format.js';
import type { Refusal } from './reasons.js';
import type {
  DisputePhaseName,
  DisputeRulingView,
  MandateStatus,
  RefusalView,
  SettlementStatus,
  WindowView,
} from './types.js';

/** IEscrow.LockStatus, in declaration order. */
const LOCK_STATUS: readonly SettlementStatus[] = [
  'unknown',
  'held',
  'paid',
  'refunded',
  'disputed',
  'returned',
  'resolved',
];

export const FUNDS: Readonly<Record<SettlementStatus, string>> = {
  unknown: 'No settlement carries this id.',
  held: 'Held by the escrow until the provider delivers or the delivery deadline passes.',
  paid: 'Paid to the provider.',
  refunded: 'Returned to the mandate after the delivery deadline passed with nothing delivered.',
  returned: 'Returned to the mandate. The provider declined the job.',
  disputed: 'Held by the escrow while the dispute is open.',
  resolved: 'Split between the mandate and the provider by the resolver.',
};

export function mandateStatus(
  paused: boolean,
  revoked: boolean,
  validFrom: bigint,
  validUntil: bigint,
  now: bigint,
): MandateStatus {
  if (revoked) return 'revoked';
  if (paused) return 'paused';
  if (now < validFrom) return 'not_yet_valid';
  if (validUntil !== 0n && now > validUntil) return 'expired';

  return 'active';
}

type OnChainWindow = { cap: bigint; spent: bigint; duration: bigint; start: bigint; epoch: bigint };

/**
 * The account reports each window after the rollover a spend in this block would apply, so `start`
 * is already the live period and the reset is one duration past it.
 */
export function windowView(w: OnChainWindow, now: bigint): WindowView {
  const resets = w.start + w.duration;

  return {
    cap: moneyFromUint(w.cap),
    spent: moneyFromUint(w.spent),
    remaining: moneyFromUint(w.cap > w.spent ? w.cap - w.spent : 0n),
    windowSeconds: Number(w.duration),
    startedAt: instant(w.start),
    resetsAt: instant(resets),
    resetsInSeconds: secondsUntil(resets, now),
  };
}

export function summarize(status: MandateStatus, daily: WindowView, monthly: WindowView, balance: string): string {
  switch (status) {
    case 'revoked':
      return 'The agent on this mandate was revoked, so nothing settles against it. The principal can seat one again.';
    case 'paused':
      return 'The principal has paused this mandate. Limits are unchanged and nothing settles until the pause lifts.';
    case 'not_yet_valid':
      return 'This mandate has not opened yet. Nothing settles before its start time.';
    case 'expired':
      return 'This mandate has passed its end time. Nothing further settles against it.';
    default:
      return (
        `${daily.remaining.usdg} USDG left today and ${monthly.remaining.usdg} USDG ` +
        `${isTotalBudgetWindow(monthly.windowSeconds) ? 'left in the total budget' : 'left this month'}, ` +
        `against ${balance} USDG held in the mandate. The daily budget resets in ${duration(daily.resetsInSeconds)}.`
      );
  }
}

/**
 * A refusal with the clock on it.
 *
 * `daily` and `monthly` name a bucket that refills, and an agent told only which bucket stopped it
 * has to make a second call to learn when to try again. The mandate reported the window in the
 * same read, so the answer is carried here instead.
 */
export function refusalView(
  refusal: Refusal | null,
  daily: WindowView,
  monthly: WindowView,
): RefusalView | null {
  if (refusal === null) return null;

  // The second window on a mandate with a total budget never rolls, so running it out is the total
  // being spent. It is named that way and carries no reset, because none is coming.
  if (refusal.code === 'MonthlyCapExceeded' && isTotalBudgetWindow(monthly.windowSeconds)) {
    return {
      code: refusal.code,
      subject: 'total_budget',
      message:
        `The total budget does not have room for this spend: ${monthly.remaining.usdg} USDG is left of ` +
        `${monthly.cap.usdg} USDG. It does not refill. The principal can raise it.`,
    };
  }

  const view: RefusalView = { code: refusal.code, subject: refusal.subject, message: refusal.message };
  const window = refusal.subject === 'daily' ? daily : refusal.subject === 'monthly' ? monthly : null;

  if (window === null || window.resetsInSeconds === 0) return view;

  return {
    ...view,
    message: `${refusal.message} That reset lands at ${window.resetsAt}.`,
    resetsAt: window.resetsAt,
    resetsInSeconds: window.resetsInSeconds,
  };
}

export function quoteNext(
  allowed: boolean,
  refusal: RefusalView | null,
  approvalRequired: boolean,
  funded: boolean,
  amount: Micro,
  balance: Micro,
): string {
  if (allowed && !funded) {
    return (
      `The limits allow this spend, but the mandate holds ${money(balance).usdg} USDG and the spend needs ` +
      `${money(amount).usdg}. Ask the principal to fund the mandate before you pay.`
    );
  }

  if (allowed) return 'Pay it with mandate_pay_provider.';

  if (refusal?.code === 'ApprovalRequired') {
    return (
      'Ask the principal to sign an approval for this provider, capability and amount, then pass it to ' +
      'mandate_pay_provider. Nothing settles without it.'
    );
  }

  if (refusal?.code === 'MerkleGateActive') {
    return 'Pass the provider proof to mandate_pay_provider. Every limit this quote can judge is clear.';
  }

  if (approvalRequired && refusal !== null) {
    return `${refusal.message} This spend would also need the principal to sign for it.`;
  }

  return refusal?.message ?? 'The mandate refused this spend.';
}

export function settlementNext(
  status: SettlementStatus,
  deadline: bigint,
  disputableUntil: bigint | null,
  now: bigint,
): string {
  switch (status) {
    case 'held':
      return now < deadline
        ? `Waiting on the provider until ${instant(deadline)}. Nothing to decide yet.`
        : 'The delivery deadline has passed with nothing delivered. The held funds can now be returned to the ' +
            'mandate, which also gives the daily and monthly budgets back what this spend took.';
    case 'paid':
      return disputableUntil !== null && now < disputableUntil
        ? `Delivered and paid. If the work is wrong, open a dispute before ${instant(disputableUntil)}.`
        : 'Delivered and paid. The window to contest it has closed.';
    case 'disputed':
      return 'The resolver rules on the split. Read this settlement again for the ruling.';
    case 'resolved':
      return 'The resolver has ruled and the funds have moved. Nothing further to decide.';
    case 'refunded':
    case 'returned':
      return 'The funds are back in the mandate and the budgets this spend took from have been credited back.';
    default:
      return 'No settlement carries this id.';
  }
}

/** The line a settlement read carries about the dispute on it. */
export function disputeNote(state: { recordOnly: boolean; status: SettlementStatus; reopens: boolean }): string {
  if (state.recordOnly) {
    return (
      'The provider had already been paid, so this is a complaint on its record and no resolver rules ' +
      'on it.'
    );
  }

  switch (state.status) {
    case 'disputed':
      return (
        'Resolvers vote on the split until resolveBy. From then anyone can settle it: the escrow moves ' +
        `the money on the ruling, or ${unheard(state.reopens)} when too few resolvers voted.`
      );
    case 'resolved':
      return 'The dispute is closed and the escrow has moved the money. mandate_get_dispute reports the split.';
    default:
      // Only a vote with no result sends a contested payment back to a status it had before.
      return `${REOPENED} ${FUNDS[state.status]}`;
  }
}

export function statusOf(status: number): SettlementStatus {
  return LOCK_STATUS[status] ?? 'unknown';
}

/** IOracleRegistry.DisputeStatus, in declaration order. */
const DISPUTE_PHASES: readonly DisputePhaseName[] = ['none', 'committing', 'revealing', 'finalized', 'failed'];

export function phaseName(status: number): DisputePhaseName {
  return DISPUTE_PHASES[status] ?? 'none';
}

const BPS = 10_000n;

/**
 * The four legs a ruling cuts a settlement into, derived the way `Escrow._split` derives them.
 * Both divisions truncate toward the provider, so the legs add back up to the locked amount with
 * nothing left over.
 */
export function splitOf(
  amount: bigint,
  refundBps: number,
  rates: { feeBps: number; resolverFeeBps: number },
): { refunded: bigint; paid: bigint; protocolFee: bigint; resolverFee: bigint } {
  const resolverFee = (amount * BigInt(rates.resolverFeeBps)) / BPS;
  const divisible = amount - resolverFee;
  const refunded = (divisible * BigInt(refundBps)) / BPS;
  const awarded = divisible - refunded;
  const protocolFee = (awarded * BigInt(rates.feeBps)) / BPS;

  return { refunded, paid: awarded - protocolFee, protocolFee, resolverFee };
}

const REOPENED =
  'The vote produced no usable result, so the escrow put the payment back on hold with a new deadline ' +
  'and returned the bond.';

/**
 * What a vote that produced no result does to the payment. v1 refunds the mandate in full; later
 * sets put the payment back on hold with a new deadline, so an unheard dispute is never a refund.
 */
function unheard(reopens: boolean): string {
  return reopens
    ? 'puts the payment back on hold with a new deadline and returns the bond'
    : 'refunds the mandate in full';
}

export function disputeNext(state: {
  phase: DisputePhaseName;
  recordOnly: boolean;
  ruling: DisputeRulingView | null;
  status: SettlementStatus;
  hasResolver: boolean;
  /** The reveal window has shut, so anyone can settle the vote now. */
  closed: boolean;
  /** Whether a vote with no result reopens the payment rather than refunding it. False on v1. */
  reopens: boolean;
}): string {
  if (state.recordOnly) {
    return (
      'The provider had already been paid, so there is nothing left to split and no resolver rules on ' +
      "this. The complaint counts against the provider's settlement history, which lowers the ceiling " +
      'on the next payment the escrow will hold for it. Nothing further to decide.'
    );
  }

  if (state.ruling) {
    return (
      `The resolvers scored the delivery ${state.ruling.medianScore} out of 100 and the escrow has ` +
      `moved the money on that ruling: ${state.ruling.refundedToMandate.usdg} USDG back to the ` +
      `mandate and ${state.ruling.paidToProvider.usdg} to the provider. Nothing further to decide.`
    );
  }

  if ((state.phase === 'committing' || state.phase === 'revealing') && state.closed) {
    return (
      'The vote has closed. Anyone can settle it now: the escrow moves the money on the ruling when ' +
      `enough resolvers published a score, and otherwise ${unheard(state.reopens)}. Read this again ` +
      'for the result.'
    );
  }

  switch (state.phase) {
    case 'committing':
      return 'Resolvers are sealing their scores. Nothing to decide until the vote closes.';
    case 'revealing':
      return 'Resolvers are publishing the scores they sealed. Read this again for the ruling.';
    case 'failed':
      if (state.reopens) {
        return (
          `${REOPENED} ` +
          (state.status === 'held'
            ? 'The provider can still deliver, and the funds come back to the mandate if that deadline ' +
              'passes with nothing delivered.'
            : FUNDS[state.status])
        );
      }
      return state.status === 'resolved'
        ? 'The vote produced no usable result, so the escrow refunded the mandate in full and the ' +
            'provider was paid nothing. Nothing further to decide.'
        : 'The vote produced no usable result. The escrow refunds the mandate in full when the dispute ' +
            'is closed, and anyone can close it.';
    default:
      return state.hasResolver
        ? 'The escrow is holding the funds and no vote is open on them. They return to the mandate, ' +
            'with the bond, once the dispute deadline passes.'
        : 'This escrow has no dispute layer, so nobody can rule on this. The funds return to the ' +
            'mandate once the dispute deadline passes.';
  }
}
