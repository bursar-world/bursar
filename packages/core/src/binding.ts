import { createHash, randomBytes } from 'node:crypto';
import { encodeAbiParameters, isHex, keccak256, recoverMessageAddress } from 'viem';

/**
 * Binding a payment to the request it buys.
 *
 * A payment proves who paid. On its own it does not prove what they paid for, and that gap is
 * exploitable: anyone who sees a payment header in flight can put their own request in front of it
 * and spend someone else's authorisation on a different call. A receipt that is valid for any
 * request is a bearer token with the victim's money behind it.
 *
 * Two forms, for the two rails:
 *
 *   - `deriveNonce` folds the request digest into the EIP-3009 nonce. The token already refuses a
 *     reused nonce, so the chain enforces "one request, one payment" with no extra signature and
 *     no extra gas. This is the form to prefer.
 *   - `bindingMessage` is a separate personal-signature over the payment reference and the request
 *     digest, for a rail whose payment identifier is fixed elsewhere, such as a transfer that is
 *     already on chain.
 */
export const BINDING_TAG = 'mandate-x402:v1';

/**
 * The digest both sides compare: the exact bytes of the request.
 *
 * Hashing a parsed and re-serialised object instead of the bytes that arrived is the failure that
 * makes this whole mechanism useless. Two JSON encodings of the same object differ by key order
 * and whitespace, so the payer signs one digest, the server computes another, and a perfectly good
 * payment is refused while the funds sit spent on chain. Hash the body as received.
 */
export function hashRequest(body: string | Uint8Array): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  return createHash('sha256').update(bytes).digest('hex');
}

const REQUEST_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isRequestHash(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_HASH_PATTERN.test(value);
}

/** A payment reference and the request it is good for, in the one form both sides sign. */
export function bindingMessage(paymentRef: string, requestHash: string): string {
  return `${BINDING_TAG}\n${paymentRef.toLowerCase()}\n${requestHash.toLowerCase()}`;
}

/** 32 random bytes, so two identical requests still produce different nonces. */
export function randomSalt(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}`;
}

export type PaymentBinding = {
  readonly requestHash: string;
  readonly salt: `0x${string}`;
};

/**
 * The EIP-3009 nonce for a bound payment.
 *
 * The salt keeps the nonce unguessable and lets a caller pay for the same request twice. Without
 * it, a repeat of an identical request would collide with the spent nonce and be refused as a
 * replay when it is a second, legitimate call.
 */
export function deriveNonce(binding: PaymentBinding): `0x${string}` {
  if (!isRequestHash(binding.requestHash)) {
    throw new TypeError('requestHash must be a 32-byte sha256 digest in lowercase hex');
  }
  if (!isHex(binding.salt) || binding.salt.length !== 66) {
    throw new TypeError('salt must be 32 bytes of hex');
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [BINDING_TAG, `0x${binding.requestHash}`, binding.salt],
    ),
  );
}

/** Whether an authorisation's nonce is the one this request and salt produce. */
export function nonceBindsRequest(nonce: string, binding: PaymentBinding): boolean {
  let expected: `0x${string}`;
  try {
    expected = deriveNonce(binding);
  } catch {
    return false;
  }
  return nonce.toLowerCase() === expected.toLowerCase();
}

/** Narrows the binding a client puts in its payment payload. */
export function parseBinding(value: unknown): PaymentBinding | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const requestHash = typeof record['requestHash'] === 'string' ? record['requestHash'].toLowerCase() : '';
  const salt = typeof record['salt'] === 'string' ? record['salt'].toLowerCase() : '';
  if (!isRequestHash(requestHash)) return null;
  if (!isHex(salt) || salt.length !== 66) return null;
  return { requestHash, salt };
}

/** Who signed a binding message. Returns null rather than throwing on a malformed signature. */
export async function recoverBinding(
  paymentRef: string,
  requestHash: string,
  signature: string,
): Promise<`0x${string}` | null> {
  if (!isHex(signature)) return null;
  try {
    return await recoverMessageAddress({
      message: bindingMessage(paymentRef, requestHash),
      signature,
    });
  } catch {
    return null;
  }
}

/** Whether `payer` signed this payment reference for this exact request. */
export async function verifyBinding(args: {
  readonly paymentRef: string;
  readonly requestHash: string;
  readonly signature: string;
  readonly payer: string;
}): Promise<boolean> {
  const recovered = await recoverBinding(args.paymentRef, args.requestHash, args.signature);
  return recovered !== null && recovered.toLowerCase() === args.payer.toLowerCase();
}

/**
 * The reference spelling of an EIP-2612 attestation, for a scheme that wants one.
 *
 * That rail's nonce is the token's own counter, so it cannot carry a request digest and the payer
 * has to attest separately. The network is in the message because a nonce is unique only within a
 * chain: without it the same signature lifts onto another chain where the counter has not reached
 * that value yet.
 *
 * Nothing in the settlement path calls this. The facilitator hands a permit-rail binding down to
 * the x402 scheme, because the scheme is what knows how that rail spells a payment reference, and
 * two message formats for one property would mean the wrong one fails silently: good payments
 * refused while the funds sit spent on chain. Use it only where the scheme is this one.
 */
export function permitBindingMessage(network: string, nonce: string, requestHash: string): string {
  return `${BINDING_TAG}\n${network.trim().toLowerCase()}\n${nonce.toLowerCase()}\n${requestHash.toLowerCase()}`;
}
