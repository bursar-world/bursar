import { ISSUER_REFUSAL } from '@bursar/core';

/**
 * Refusal reasons.
 *
 * A client is expected to branch on these, so the strings the protocol already defines are
 * reproduced verbatim. The block at the bottom covers cases the protocol has no name for: it
 * assumes a facilitator can always read back what it broadcast, and it only
 * describes the EIP-3009 path.
 */
export const REASON = {
  network: 'invalid_network',
  scheme: 'invalid_scheme',
  version: 'invalid_x402_version',
  payload: 'invalid_payload',
  requirements: 'invalid_payment_requirements',
  signature: 'invalid_exact_evm_payload_signature',
  early: 'invalid_exact_evm_payload_authorization_valid_after',
  expired: 'invalid_exact_evm_payload_authorization_valid_before',
  value: 'invalid_exact_evm_payload_authorization_value_mismatch',
  recipient: 'invalid_exact_evm_payload_recipient_mismatch',
  funds: 'insufficient_funds',
  state: 'invalid_transaction_state',

  /** Broadcast, then the receipt could not be read. The transfer may well have landed. */
  unconfirmed: 'settlement_unconfirmed',
  /** The requirements named a transfer method this asset or this facilitator does not serve. */
  method: 'unsupported_asset_transfer_method',
  /** A permit that names someone other than the relayer as spender cannot be settled here. */
  spender: 'invalid_permit_spender',
  /** EIP-2612 nonces are sequential, so a stale or future one is refused before broadcasting. */
  permitNonce: 'invalid_permit_nonce',
  /** Permit2 moves funds through its own allowance, which the payer grants once per token. */
  permit2Allowance: 'permit2_not_approved',
  /** The payment carries no proof that it was signed for this exact request. */
  unbound: 'payment_not_bound_to_request',
  /** The facilitator answered, but not with anything this client can act on. */
  facilitator: 'facilitator_unavailable',

  /**
   * The settlement asset's own controls, which belong to the token issuer.
   *
   * Kept apart from `invalid_transaction_state` because they are the only refusals here that
   * neither the payer nor this facilitator can clear, so a client that reads one knows to stop
   * retrying and take it to the issuer. USDG carries them: `paused()` and `isFrozen(address)`
   * answer on chain 4663, read on 2026-09-22. The words come from `@bursar/core`, where the
   * underwriter and the SDK read the same five.
   */
  ...ISSUER_REFUSAL,
} as const;

export type InvalidReason = (typeof REASON)[keyof typeof REASON];
