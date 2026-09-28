import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BINDING_TAG,
  bindingMessage,
  deriveNonce,
  hashRequest,
  isRequestHash,
  nonceBindsRequest,
  parseBinding,
  permitBindingMessage,
  randomSalt,
  recoverBinding,
  verifyBinding,
} from '../src/binding.js';

/**
 * The derivation three packages have to agree on: the client that picks the nonce, the scheme that
 * verifies it, and the facilitator that decides whether the payment belongs to the request in
 * front of it. It lives here because a second implementation of it is a payment spent on chain
 * against a receipt nobody will honour.
 */

const payer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const SALT = `0x${'5a'.repeat(32)}` as `0x${string}`;

describe('binding a payment to its request', () => {
  it('hashes the bytes that arrived, not a re-serialisation of them', () => {
    expect(hashRequest(new TextEncoder().encode('{"a":1}'))).toBe(hashRequest('{"a":1}'));
    expect(hashRequest('{"b":2,"a":1}')).not.toBe(hashRequest('{"a":1,"b":2}'));
    expect(isRequestHash(hashRequest('{}'))).toBe(true);
    expect(isRequestHash('ABCD')).toBe(false);
  });

  it('derives a nonce that is stable for one request and salt and different for another', () => {
    const requestHash = hashRequest('{"prompt":"render"}');
    expect(deriveNonce({ requestHash, salt: SALT })).toBe(deriveNonce({ requestHash, salt: SALT }));
    expect(deriveNonce({ requestHash, salt: SALT })).not.toBe(
      deriveNonce({ requestHash: hashRequest('{"prompt":"refund"}'), salt: SALT }),
    );
  });

  it('lets the same request be paid for twice on purpose, through the salt', () => {
    const requestHash = hashRequest('{}');
    expect(deriveNonce({ requestHash, salt: SALT })).not.toBe(
      deriveNonce({ requestHash, salt: randomSalt() }),
    );
  });

  it('recognises the nonce it derived and refuses any other', () => {
    const requestHash = hashRequest('{}');
    const binding = { requestHash, salt: SALT };
    expect(nonceBindsRequest(deriveNonce(binding), binding)).toBe(true);
    expect(nonceBindsRequest(deriveNonce(binding).toUpperCase(), binding)).toBe(true);
    expect(nonceBindsRequest(`0x${'cd'.repeat(32)}`, binding)).toBe(false);
  });

  it('refuses a malformed binding rather than deriving from junk', () => {
    expect(() => deriveNonce({ requestHash: 'nope', salt: SALT })).toThrow(/sha256/);
    expect(() => deriveNonce({ requestHash: hashRequest('{}'), salt: '0x00' as `0x${string}` })).toThrow(/salt/);
    expect(parseBinding({ requestHash: 'nope', salt: SALT })).toBeNull();
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding({ requestHash: hashRequest('{}'), salt: SALT })).toEqual({
      requestHash: hashRequest('{}'),
      salt: SALT,
    });
  });

  it('signs and recovers the permit-rail message, which names the chain', async () => {
    const requestHash = hashRequest('{}');
    const nonce = '0x7';
    const message = permitBindingMessage('EIP155:4663', nonce, requestHash.toUpperCase());
    expect(message).toBe(`${BINDING_TAG}\neip155:4663\n0x7\n${requestHash}`);

    const paymentRef = '0x3600:0xabc:7';
    const signature = await payer.signMessage({ message: bindingMessage(paymentRef, requestHash) });
    expect(await recoverBinding(paymentRef, requestHash, signature)).toBe(payer.address);
    await expect(verifyBinding({ paymentRef, requestHash, signature, payer: payer.address })).resolves.toBe(true);
    await expect(
      verifyBinding({ paymentRef, requestHash, signature, payer: `0x${'22'.repeat(20)}` }),
    ).resolves.toBe(false);
  });

  it('returns null rather than throwing on a signature that recovers to nothing', async () => {
    expect(await recoverBinding('ref', hashRequest('{}'), 'not hex')).toBeNull();
    expect(await recoverBinding('ref', hashRequest('{}'), '0xdead')).toBeNull();
  });
});
