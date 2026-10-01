/**
 * The escrow lane: an x402 call paid for by the mandate account's own `spend`, which opens an
 * escrow lock payable to the provider instead of signing a transfer.
 *
 * Two derivations make that lane safe to settle, and both live in `@bursar/core` because three
 * sides compute them on their own: the client that opens the lock, the facilitator that verifies
 * it, and the resolver that reads it in a dispute.
 *
 *   - The request document is what the lock commits to: the method, the endpoint and the
 *     request-bound nonce (`deriveNonce` over the sha256 of the body and the payer's salt), as
 *     canonical JSON, published inline as the lock's `inputURI` and hashed into its `inputCommit`.
 *     The facilitator recomputes the nonce from the body that reached the provider and the salt in
 *     the payment header, so a lock cannot be redeemed against a request it was not opened for,
 *     and nobody reading the chain learns enough to present it.
 *
 *   - The settlement nonce is the name a facilitator records the redemption under, derived from the
 *     lock alone: keccak256 of `(string tag, uint256 chainId, address escrow, uint256 lockId,
 *     bytes32 inputCommit)` with the tag `bursar-x402-escrow:v1`. Nothing in it comes from the
 *     payload, so one lock has one name however it is presented, and a settle that carries any
 *     other nonce for it is refused.
 */
export {
  ESCROW_SETTLEMENT_TAG,
  REQUEST_DOCUMENT_MEDIA_TYPE,
  escrowSettlementNonce,
  isRequestDocumentURI,
  readRequestURI,
  requestCommit,
  requestDocument,
  requestURI,
} from '@bursar/core';
export type { EscrowLockIdentity, RequestDocument } from '@bursar/core';
