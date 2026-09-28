import { describe, expect, test } from 'vitest';
import { recoverMessageAddress } from 'viem';
import {
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
  type PaymentBinding,
} from '../src/binding.js';
import { PAYER } from './support.js';

const TX = `0x${'ab'.repeat(32)}`;
const SALT = `0x${'11'.repeat(32)}` as const;

describe('a payment is only good for the request it was signed for', () => {
  test('a payment signed for one request does not verify against another', async () => {
    const paid = '{"invoice":"inv_204","amount":"300000"}';
    const signature = await PAYER.signMessage({ message: bindingMessage(TX, hashRequest(paid)) });

    const honest = await recoverBinding(TX, hashRequest(paid), signature);
    expect(honest).toBe(PAYER.address);

    const swapped = await recoverBinding(TX, hashRequest('{"invoice":"inv_900","amount":"9000000"}'), signature);
    expect(swapped).not.toBe(PAYER.address);
  });

  test('the transaction-only signature does not recover the payer', async () => {
    const signature = await PAYER.signMessage({
      message: bindingMessage(TX, hashRequest('{"invoice":"inv_204"}')),
    });
    const unbound = await recoverMessageAddress({ message: TX, signature });
    expect(unbound).not.toBe(PAYER.address);
  });

  test('a signature for one payment does not carry over to the next', async () => {
    const digest = hashRequest('{"amount":"300000"}');
    const signature = await PAYER.signMessage({ message: bindingMessage(TX, digest) });
    const other = `0x${'cd'.repeat(32)}`;
    expect(await verifyBinding({ paymentRef: other, requestHash: digest, signature, payer: PAYER.address })).toBe(
      false,
    );
    expect(await verifyBinding({ paymentRef: TX, requestHash: digest, signature, payer: PAYER.address })).toBe(
      true,
    );
  });

  test('a payment reference compares case-insensitively, because hashes are quoted both ways', async () => {
    const digest = hashRequest('body');
    const signature = await PAYER.signMessage({ message: bindingMessage(TX.toUpperCase(), digest) });
    expect(await verifyBinding({ paymentRef: TX, requestHash: digest, signature, payer: PAYER.address })).toBe(
      true,
    );
  });

  test('a malformed signature is refused rather than thrown', async () => {
    expect(await recoverBinding(TX, hashRequest('x'), 'not a signature')).toBeNull();
    expect(
      await verifyBinding({ paymentRef: TX, requestHash: hashRequest('x'), signature: '0x00', payer: PAYER.address }),
    ).toBe(false);
  });
});

describe('request digests', () => {
  test('the digest is over the bytes, so re-serialising changes it', () => {
    const sent = '{"amount": "300000", "to": "0xabc"}';
    const reserialised = JSON.stringify(JSON.parse(sent));
    expect(hashRequest(sent)).not.toBe(hashRequest(reserialised));
  });

  test('a string and its utf-8 bytes hash the same', () => {
    const body = '{"prompt":"héllo"}';
    expect(hashRequest(body)).toBe(hashRequest(Buffer.from(body, 'utf8')));
  });

  test('a digest is 32 bytes of lowercase hex', () => {
    expect(isRequestHash(hashRequest('x'))).toBe(true);
    expect(isRequestHash(hashRequest('x').toUpperCase())).toBe(false);
    expect(isRequestHash('0x' + hashRequest('x'))).toBe(false);
  });

  test('the message carries the tag, so a signature cannot be reused off this protocol', async () => {
    expect(bindingMessage(TX, hashRequest('x')).startsWith(`${BINDING_TAG}\n`)).toBe(true);
  });
});

describe('nonce binding', () => {
  const binding: PaymentBinding = { requestHash: hashRequest('{"command":"settle"}'), salt: SALT };

  test('the nonce derives from the request, so the token enforces the binding', () => {
    const nonce = deriveNonce(binding);
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(nonceBindsRequest(nonce, binding)).toBe(true);
  });

  test('another request derives another nonce', () => {
    const other = { ...binding, requestHash: hashRequest('{"command":"drain"}') };
    expect(deriveNonce(other)).not.toBe(deriveNonce(binding));
    expect(nonceBindsRequest(deriveNonce(other), binding)).toBe(false);
  });

  test('the salt lets the same request be paid for twice on purpose', () => {
    const again = { ...binding, salt: randomSalt() };
    expect(deriveNonce(again)).not.toBe(deriveNonce(binding));
  });

  test('a nonce from a malformed binding is never accepted', () => {
    expect(nonceBindsRequest(deriveNonce(binding), { requestHash: 'short', salt: SALT })).toBe(false);
    expect(() => deriveNonce({ requestHash: binding.requestHash, salt: '0x11' })).toThrow();
  });

  test('parseBinding refuses anything it cannot use', () => {
    expect(parseBinding({ requestHash: binding.requestHash, salt: SALT })).toEqual(binding);
    expect(parseBinding({ requestHash: binding.requestHash })).toBeNull();
    expect(parseBinding({ requestHash: 'nope', salt: SALT })).toBeNull();
    expect(parseBinding(null)).toBeNull();
    // Uppercase is a spelling, not a different request.
    expect(parseBinding({ requestHash: binding.requestHash.toUpperCase(), salt: SALT })).toEqual(binding);
  });

  test('a salt is 32 bytes and does not repeat', () => {
    const salts = new Set(Array.from({ length: 64 }, () => randomSalt()));
    expect(salts.size).toBe(64);
    for (const salt of salts) expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
