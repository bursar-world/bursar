import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { deriveNonce, hashRequest, nonceBindsRequest, randomSalt } from '../src/binding.js';
import { canonicalStringify, commitCanonical } from '../src/commit.js';
import {
  ESCROW_SETTLEMENT_TAG,
  REQUEST_DOCUMENT_MEDIA_TYPE,
  escrowSettlementNonce,
  isRequestDocumentURI,
  readRequestURI,
  requestCommit,
  requestDocument,
  requestURI,
} from '../src/x402-escrow.js';

/**
 * What an x402 lock commits to and what it settles under. The client, the facilitator and the
 * resolver each compute these on their own, so the vectors here are what they have to agree on.
 */

const ESCROW = '0x4315F8be7C9661345710910577Ec31cb867f3c20' as const;
const SALT = `0x${'5a'.repeat(32)}` as const;
const BODY = '{"prompt":"a koi"}';

const binding = { requestHash: hashRequest(BODY), salt: SALT };
const document = () => requestDocument({ method: 'post', url: 'https://api.provider.dev/render?key=secret#frag', binding });

describe('the request document', () => {
  it('names the method and the endpoint, and binds the body without publishing it', () => {
    const doc = document();
    expect(doc).toEqual({ method: 'POST', resource: 'https://api.provider.dev/render', requestNonce: deriveNonce(binding) });
    expect(requestCommit(doc)).toBe(commitCanonical(doc));

    // Neither the digest nor the salt is in the bytes the chain will carry, and the query is not
    // either. Whoever holds both halves of the binding can still check the lock against them.
    const published = canonicalStringify(doc);
    expect(published).not.toContain(binding.requestHash);
    expect(published).not.toContain(SALT.slice(2));
    expect(published).not.toContain('secret');
    expect(nonceBindsRequest(doc.requestNonce, binding)).toBe(true);
    expect(nonceBindsRequest(doc.requestNonce, { requestHash: hashRequest('{}'), salt: SALT })).toBe(false);
  });

  it('commits differently for the same call paid twice, through the salt', () => {
    const again = requestDocument({ method: 'POST', url: 'https://api.provider.dev/render', binding: { ...binding, salt: randomSalt() } });
    expect(again.resource).toBe(document().resource);
    expect(requestCommit(again)).not.toBe(requestCommit(document()));
  });

  it('publishes inline under its own media type and reads back to the same document', () => {
    const doc = document();
    const uri = requestURI(doc);
    expect(uri.startsWith(`data:${REQUEST_DOCUMENT_MEDIA_TYPE};base64,`)).toBe(true);
    expect(isRequestDocumentURI(uri)).toBe(true);
    expect(readRequestURI(uri)).toEqual(doc);

    const payload = uri.split(',')[1] ?? '';
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(canonicalStringify(doc));
    // Media types are case-blind, so a reader that received one upper-cased still knows it.
    expect(readRequestURI(`DATA:${REQUEST_DOCUMENT_MEDIA_TYPE.toUpperCase()};BASE64,${payload}`)).toEqual(doc);
  });

  it('reads nothing from a URI that is not a request document', () => {
    const doc = document();
    const under = (value: unknown) => `data:${REQUEST_DOCUMENT_MEDIA_TYPE};base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`;

    expect(readRequestURI('')).toBeNull();
    expect(readRequestURI(`data:application/json;base64,${Buffer.from(canonicalStringify(doc)).toString('base64')}`)).toBeNull();
    expect(readRequestURI(`data:${REQUEST_DOCUMENT_MEDIA_TYPE};base64,!!!`)).toBeNull();
    expect(readRequestURI(under([doc]))).toBeNull();
    expect(readRequestURI(under({ ...doc, extra: 1 }))).toBeNull();
    expect(readRequestURI(under({ method: doc.method, resource: doc.resource }))).toBeNull();
    expect(readRequestURI(under({ ...doc, requestNonce: '0x5a' }))).toBeNull();
    expect(readRequestURI(under({ ...doc, requestNonce: 'not hex' }))).toBeNull();
    expect(readRequestURI(under({ ...doc, method: '' }))).toBeNull();
    expect(readRequestURI(under({ ...doc, resource: 7 }))).toBeNull();
  });

  it('refuses a URL it cannot name an endpoint from', () => {
    expect(() => requestDocument({ method: 'GET', url: '/render', binding })).toThrow();
  });
});

describe('the settlement nonce', () => {
  const lock = { chainId: 4663, escrow: ESCROW, lockId: 7n, inputCommit: requestCommit(document()) };

  it('is keccak256 over the tag, chain, escrow, lock id and commitment', () => {
    expect(escrowSettlementNonce(lock)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
          [ESCROW_SETTLEMENT_TAG, 4663n, ESCROW, 7n, lock.inputCommit],
        ),
      ),
    );
    expect(escrowSettlementNonce(lock)).toBe(escrowSettlementNonce({ ...lock, escrow: ESCROW.toLowerCase() as typeof ESCROW }));
  });

  it('changes with every field, so no lock shares a name with another', () => {
    const nonce = escrowSettlementNonce(lock);
    expect(escrowSettlementNonce({ ...lock, chainId: 46630 })).not.toBe(nonce);
    expect(escrowSettlementNonce({ ...lock, escrow: '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4' })).not.toBe(nonce);
    expect(escrowSettlementNonce({ ...lock, lockId: 8n })).not.toBe(nonce);
    expect(escrowSettlementNonce({ ...lock, inputCommit: `0x${'11'.repeat(32)}` })).not.toBe(nonce);
  });
});
