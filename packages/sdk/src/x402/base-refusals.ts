import type { Refusal, RefusalOwner } from '../refusals.js';

/**
 * What the Base lane says no for, in sentences.
 *
 * Keyed by the facilitator's own reason codes, so a support conversation has one shared word. Each
 * entry names the condition, whose it is, and what to do now. A code this build has no sentence for
 * reaches the caller as the code alone, which is never a claim that the caller can fix it.
 */
type Written = { readonly owner: RefusalOwner; readonly message: string };

const BASE: Readonly<Record<string, Written>> = {
  base_lane_off: {
    owner: 'counterparty',
    message:
      'This facilitator holds no USDC float on Base, so it cannot pay Base services. Nothing was locked. ' +
      'Point `facilitator` at one that runs the Base lane, or pay from a wallet that holds USDC on Base.',
  },
  base_facilitator_unreachable: {
    owner: 'counterparty',
    message: 'The facilitator did not answer, so nothing was quoted or locked. Try again in a moment.',
  },
  base_float_insufficient: {
    owner: 'counterparty',
    message:
      "The facilitator's Base float cannot cover this payment on top of what it has already promised. " +
      'Nothing was locked. Try a smaller payment or try again later; the operator refills the float from the locks it settles.',
  },
  base_amount_too_large: {
    owner: 'counterparty',
    message:
      'This payment is above what the facilitator pays on Base in one call. Nothing was locked. ' +
      'Split the call if the service allows it, or pay it from a wallet that holds USDC on Base.',
  },
  base_offer_unsupported: {
    owner: 'counterparty',
    message:
      'The service asked to be paid in a way the Base lane does not pay: it pays the exact scheme in USDC on Base only. Nothing was locked.',
  },
  base_payload_invalid: {
    owner: 'caller',
    message: 'The request to the facilitator was malformed. This is a client fault; nothing was signed.',
  },
  base_lock_not_open: {
    owner: 'caller',
    message:
      'The facilitator could not find the lock open on Robinhood Chain. The lock is the mandate’s: if it is still open it can be reclaimed with timeout() after its deadline.',
  },
  base_lock_payee_mismatch: {
    owner: 'caller',
    message:
      "The lock is not payable to the facilitator's Base lane address, so the facilitator cannot settle or return it. Reclaim it with timeout() after its deadline.",
  },
  base_lock_amount_mismatch: {
    owner: 'caller',
    message:
      'The lock does not hold the amount the facilitator quoted for this payment, so it was not paid. The quote changes with the float and the fee; ask for a fresh one.',
  },
  base_lock_not_bound: {
    owner: 'caller',
    message:
      'The lock was not opened for this request. A lock pays for exactly the call it commits to; open a new one for this call.',
  },
  base_lock_deadline_too_close: {
    owner: 'clock',
    message:
      "The lock runs out before the service's work budget and the facilitator's settlement would finish. Open it with a longer ttl.",
  },
  base_lock_already_paid: {
    owner: 'caller',
    message:
      'This lock already paid for one Base authorization, and one lock buys one. Open a new lock for a new call.',
  },
  base_payer_not_a_mandate: {
    owner: 'caller',
    message:
      'The lock was not opened by a mandate account this facilitator settles for, so nothing on it counts against a mandate and it was not paid.',
  },
  base_lock_unreadable: {
    owner: 'counterparty',
    message: 'The facilitator could not read the lock from Robinhood Chain just now. Nothing was signed. Try again in a moment.',
  },
  base_payment_not_found: {
    owner: 'caller',
    message: 'The facilitator has no record of this Base payment.',
  },
};

export function baseRefusal(code: string): Refusal | null {
  const written = BASE[code];
  return written ? { code, ...written } : null;
}

export const BASE_REFUSALS: readonly string[] = Object.keys(BASE);
