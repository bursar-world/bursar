import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveNonce, permitBindingMessage, randomSalt } from '@bursar/core';
import { hashRequest, verifyBinding } from '../src/x402/binding.js';
import type { PaymentPayload } from '../src/x402/contract.js';

/**
 * The property this file exists for: a payment buys the one request it names and nothing else.
 *
 * An authorisation proves who is paying and how much. Anyone who sees the payment header in flight
 * can put their own request in front of it unless the payment names the request too.
 *
 * On the rails where the payer picks its own nonce, it names the request by deriving the nonce
 * from the request digest. That is what this service checks, and the token's refusal of a spent
 * nonce is what makes it bind on chain. EIP-2612 has no such freedom, so a payer there attaches a
 * separate signature and the scheme judges it; here that is only recognised, not recovered.
 */

const payer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const SALT = `0x${'5a'.repeat(32)}` as `0x${string}`;
const NETWORK = 'eip155:4663';

function payload(nonce: string, binding: unknown): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: 'exact', network: NETWORK },
    payload: { authorization: { nonce }, signature: '0xdead', binding },
  };
}

function bound(body: string, salt = SALT): { nonce: string; requestHash: string; payload: PaymentPayload } {
  const requestHash = hashRequest(body);
  const nonce = deriveNonce({ requestHash, salt });
  return { nonce, requestHash, payload: payload(nonce, { requestHash, salt }) };
}

describe('payment binding', () => {
  it('accepts a payment whose nonce is derived from the request that arrived', () => {
    const { nonce, requestHash, payload: p } = bound(JSON.stringify({ prompt: 'summarise this invoice' }));
    expect(verifyBinding({ payload: p, requestHash, nonce })).toEqual({
      bound: true,
      binding: { requestHash, salt: SALT },
    });
  });

  it('refuses a payment made for one request and redeemed against another', () => {
    const paid = bound(JSON.stringify({ prompt: 'summarise this invoice' }));
    const swapped = hashRequest(JSON.stringify({ prompt: 'transfer everything to me' }));
    expect(verifyBinding({ payload: paid.payload, requestHash: swapped, nonce: paid.nonce })).toEqual({
      bound: false,
      reason: 'wrong_request',
    });
  });

  it('refuses a binding whose salt does not produce the nonce being redeemed', () => {
    const { requestHash, nonce } = bound('{}');
    const lying = payload(nonce, { requestHash, salt: randomSalt() });
    expect(verifyBinding({ payload: lying, requestHash, nonce })).toEqual({
      bound: false,
      reason: 'wrong_request',
    });
  });

  it('refuses a binding reused under a different authorisation nonce', () => {
    const { requestHash, payload: p } = bound('{}');
    const other = `0x${'cd'.repeat(32)}`;
    expect(verifyBinding({ payload: p, requestHash, nonce: other })).toEqual({
      bound: false,
      reason: 'wrong_request',
    });
  });

  it('reports an absent binding separately from a malformed one', () => {
    const nonce = `0x${'ab'.repeat(32)}`;
    const bare: PaymentPayload = { payload: { authorization: { nonce } } };
    expect(verifyBinding({ payload: bare, requestHash: hashRequest('{}'), nonce })).toEqual({
      bound: false,
      reason: 'absent',
    });

    for (const junk of [{ requestHash: 'nope', salt: SALT }, 42, 'not hex', '']) {
      const check = verifyBinding({
        payload: payload(nonce, junk),
        requestHash: hashRequest('{}'),
        nonce,
      });
      expect(check).toEqual({ bound: false, reason: 'malformed' });
    }
  });

  it('recognises the permit rail signature and leaves the verdict to the scheme', async () => {
    const nonce = `0x${'ab'.repeat(32)}`;
    const requestHash = hashRequest('{}');
    const signature = await payer.signMessage({
      message: permitBindingMessage(NETWORK, nonce, requestHash),
    });
    expect(verifyBinding({ payload: payload(nonce, signature), requestHash, nonce })).toEqual({
      bound: true,
      binding: null,
    });
  });

  it('hashes the bytes that arrived, not a re-serialisation of them', () => {
    const bytes = new TextEncoder().encode('{"a":1,"b":2}');
    expect(hashRequest(bytes)).toBe(hashRequest('{"a":1,"b":2}'));
    expect(hashRequest('{"b":2,"a":1}')).not.toBe(hashRequest('{"a":1,"b":2}'));
  });

  it('derives the same nonce on both sides of the wire', () => {
    const requestHash = hashRequest('{"city":"Paris"}');
    expect(deriveNonce({ requestHash, salt: SALT })).toBe(deriveNonce({ requestHash, salt: SALT }));
    expect(deriveNonce({ requestHash, salt: SALT })).not.toBe(
      deriveNonce({ requestHash, salt: randomSalt() }),
    );
  });
});
