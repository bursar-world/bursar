import { hashRequest, nonceBindsRequest } from '@bursar/core';
import { payloadBinding, payloadBindingSignature } from './contract.js';
import type { PaymentPayload, RequestBinding } from './contract.js';

/**
 * Binding a payment to the request it buys.
 *
 * An authorisation on its own proves who is paying and how much. It does not prove what they are
 * paying for. Anyone who sees the payment header in flight can put their own request in front of
 * it and spend someone else's authorisation on something they chose.
 *
 * This service is the only party holding both halves: the request digest the resource server
 * computed from the bytes that actually arrived, and the payload the payer signed. So it checks
 * the half that needs both. On the rails where the payer picks its own nonce, the nonce is
 * derived from the request digest and a salt, and recomputing that derivation is the whole check.
 * The token refuses a spent nonce, so the binding holds on chain and not only here.
 *
 * EIP-2612 cannot do that: its nonce is the token's own counter. A payer there signs a separate
 * message naming the permit, and the scheme verifies it, because the scheme is what knows how a
 * permit's payment reference is spelled. Duplicating that recovery here would mean two message
 * formats for one property, and the one this service got wrong would fail silently: perfectly
 * good payments refused while the funds sit spent on chain.
 *
 * The digest is taken over the raw body, never over a field parsed out of it. Two sides that hash
 * different things is the failure that makes the whole mechanism useless.
 */

export { hashRequest };

export type BindingCheck =
  | { readonly bound: true; readonly binding: RequestBinding | null }
  | { readonly bound: false; readonly reason: 'absent' | 'malformed' | 'wrong_request' };

export type BindingInput = {
  readonly payload: PaymentPayload;
  /** sha256 of the exact bytes the resource server served this payment against. */
  readonly requestHash: string;
  readonly nonce: string;
};

/**
 * Whether this payment names this request.
 *
 * A `true` result carrying a binding means the derivation checked out here. A `true` result
 * carrying null means the payload is on the permit rail and the scheme has the remaining say;
 * `checkBinding` hands the digest down for exactly that reason.
 *
 * Every outcome is a 402 a client can act on, so this returns a reason and never throws.
 */
export function verifyBinding(input: BindingInput): BindingCheck {
  const expected = input.requestHash.toLowerCase();
  const derived = payloadBinding(input.payload);

  if (derived) {
    if (derived.requestHash !== expected) return { bound: false, reason: 'wrong_request' };
    if (!nonceBindsRequest(input.nonce, derived)) return { bound: false, reason: 'wrong_request' };
    return { bound: true, binding: derived };
  }

  if (payloadBindingSignature(input.payload) !== null) return { bound: true, binding: null };

  const raw = input.payload.payload;
  const carried = raw?.binding !== undefined || raw?.bindingSignature !== undefined;
  // A client that sent something is debugging its encoding. One that sent nothing has not
  // implemented binding at all. Those are different conversations, so they get different reasons.
  return { bound: false, reason: carried ? 'malformed' : 'absent' };
}
