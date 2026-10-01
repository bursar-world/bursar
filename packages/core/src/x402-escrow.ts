import { Buffer } from 'node:buffer';
import { encodeAbiParameters, isHex, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';

import { deriveNonce } from './binding.js';
import type { PaymentBinding } from './binding.js';
import { canonicalStringify, commitCanonical } from './commit.js';

/**
 * The x402 escrow lane: an HTTP call paid for by the mandate account's own `spend`, which opens an
 * escrow lock payable to the provider. The lock has to say what it pays for, and the facilitator
 * has to record it under a name nobody but the chain can choose. Both are defined here, because
 * the client that opens the lock, the facilitator that verifies it and the resolver that reads it
 * in a dispute have to agree on each of them byte for byte.
 *
 * The request document is the lock's input: the method, the endpoint and the request-bound nonce,
 * as canonical JSON, published inline in `inputURI` and hashed into `inputCommit`. A resolver reads
 * it off the chain the way it reads any committed job. The nonce is `deriveNonce` over the digest
 * of the body and a salt, the same value the wallet lane signs into its authorisation, so the
 * facilitator can hold the lock to the body that reached the provider while the chain shows neither
 * the digest nor the salt. Publishing them would let anyone who can reproduce the body, and every
 * call without one, present the lock ahead of the payer that opened it.
 *
 * The settlement nonce is the identity the facilitator records a redemption under. Every input to
 * it is read off the lock, so the same lock cannot be presented twice under two names. A nonce
 * read off the payload is a nonce the payer can vary.
 */

export const REQUEST_DOCUMENT_MEDIA_TYPE = 'application/vnd.bursar.x402-request+json';

const REQUEST_URI_PREFIX = `data:${REQUEST_DOCUMENT_MEDIA_TYPE};base64,`;

export type RequestDocument = {
  readonly method: string;
  /**
   * The endpoint the call went to: the URL without its query or fragment, which can carry what the
   * caller would not write to a public chain.
   */
  readonly resource: string;
  /** `deriveNonce` over the body digest and the payer's salt. Binds the lock to the request. */
  readonly requestNonce: Hex;
};

export function requestDocument(input: {
  readonly method: string;
  readonly url: string;
  readonly binding: PaymentBinding;
}): RequestDocument {
  const { origin, pathname } = new URL(input.url);
  return {
    method: input.method.toUpperCase(),
    resource: `${origin}${pathname}`,
    requestNonce: deriveNonce(input.binding),
  };
}

/** The hash the lock carries. Whoever reads the published document recomputes it from these bytes. */
export function requestCommit(document: RequestDocument): Hex {
  return commitCanonical(document);
}

/** The document inline, as the lock's `inputURI`, under a media type that says what it is. */
export function requestURI(document: RequestDocument): string {
  return `${REQUEST_URI_PREFIX}${Buffer.from(canonicalStringify(document), 'utf8').toString('base64')}`;
}

export function isRequestDocumentURI(uri: string): boolean {
  return uri.slice(0, REQUEST_URI_PREFIX.length).toLowerCase() === REQUEST_URI_PREFIX;
}

/**
 * The document a lock published, or null when the URI is not one, does not decode, or does not
 * hold exactly the three members above. Strict on purpose: the commitment covers every byte, and a
 * reader that tolerated extra members would verify a document the writer never meant.
 */
export function readRequestURI(uri: string): RequestDocument | null {
  if (!isRequestDocumentURI(uri)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(uri.slice(REQUEST_URI_PREFIX.length), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'method,requestNonce,resource') return null;

  const { method, resource, requestNonce } = record;
  if (typeof method !== 'string' || method === '' || typeof resource !== 'string' || resource === '') return null;
  if (!isHex(requestNonce) || requestNonce.length !== 66) return null;

  return { method, resource, requestNonce };
}

/** Leads the settlement nonce, so it collides with no EIP-3009 nonce a payer derives. */
export const ESCROW_SETTLEMENT_TAG = 'bursar-x402-escrow:v1';

/** A lock as the chain identifies it, with the commitment it was opened under. */
export type EscrowLockIdentity = {
  readonly chainId: number;
  readonly escrow: Address;
  readonly lockId: bigint;
  readonly inputCommit: Hex;
};

/**
 * The nonce a mandate-lane settlement is recorded under.
 *
 * keccak256 over the ABI encoding of the tag, the chain id, the escrow address, the lock id and the
 * lock's input commitment: `(string, uint256, address, uint256, bytes32)`. The commitment is in it
 * so the identity names the request the lock was opened for, and the chain and escrow so a lock on
 * one deployment names nothing on another. An honest client computes it before it pays, and a
 * facilitator recomputes it from the lock it reads and refuses any other name for the payment.
 */
export function escrowSettlementNonce(lock: EscrowLockIdentity): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [ESCROW_SETTLEMENT_TAG, BigInt(lock.chainId), lock.escrow, lock.lockId, lock.inputCommit],
    ),
  );
}
