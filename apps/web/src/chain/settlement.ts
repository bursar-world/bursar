import { mulBps, subMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';

/**
 * `Escrow._split`, copied so a screen can say what a ruling does to the money before anybody pays
 * for a transaction to find out.
 *
 * The order is the contract's, and it is the part that surprises people. The resolver fee comes
 * off the principal first and the refund divides what is left, so a refund of 10,000 basis points
 * returns the lock less that fee and never the whole lock. The facilitator fee is charged only on
 * what the payee keeps. Both divisions truncate toward the payee, exactly as the contract does.
 */
export type SettlementSplit = {
  /** Taken off the top. Charged whether or not the panel produced anybody to pay it to. */
  readonly resolverFee: Micro;
  /** Back to the payer. */
  readonly refunded: Micro;
  /** The facilitator's cut, charged on the payee's share alone. */
  readonly protocolFee: Micro;
  /** What reaches the payee. */
  readonly paid: Micro;
};

export function splitSettlement(amount: Micro, refundBps: number, resolverFeeBps: number, feeBps: number): SettlementSplit {
  const resolverFee = mulBps(amount, resolverFeeBps);
  const divisible = subMicro(amount, resolverFee);
  const refunded = mulBps(divisible, refundBps);
  const awarded = subMicro(divisible, refunded);
  const protocolFee = mulBps(awarded, feeBps);

  return { resolverFee, refunded, protocolFee, paid: subMicro(awarded, protocolFee) };
}

/**
 * What a release pays the payee: the lock less the facilitator fee, with no resolver in it.
 * `Escrow.release` charges `feeBps` on the whole amount, which is a different base from the one
 * `splitSettlement` uses, so the two are kept apart rather than shared.
 */
export function releasePayout(amount: Micro, feeBps: number): { readonly fee: Micro; readonly paid: Micro } {
  const fee = mulBps(amount, feeBps);
  return { fee, paid: subMicro(amount, fee) };
}
