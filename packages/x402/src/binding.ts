/**
 * Binding a payment to the request it buys.
 *
 * A payment proves who paid. On its own it does not prove what they paid for, and that gap is
 * exploitable: anyone who sees a payment header in flight can put their own request in front of it
 * and spend someone else's authorisation on a different call. A receipt that is valid for any
 * request is a bearer token with the victim's money behind it.
 *
 * The derivation lives in `@bursar/core` because three sides have to agree on it byte for byte:
 * the client that picks the nonce, this scheme when it verifies, and the facilitator when it
 * decides whether the payment it was handed belongs to the request in front of it. Two
 * implementations of the same digest is how a payer ends up with funds spent against a payment
 * nobody will honour.
 */
export {
  BINDING_TAG,
  bindingMessage,
  deriveNonce,
  hashRequest,
  isRequestHash,
  nonceBindsRequest,
  parseBinding,
  randomSalt,
  recoverBinding,
  verifyBinding,
} from '@bursar/core';
export type { PaymentBinding } from '@bursar/core';
