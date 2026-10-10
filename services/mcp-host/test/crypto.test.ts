import { describe, expect, it } from 'vitest';

import { SealError, TOKEN_PATTERN, generateToken, hashToken, hashesMatch, kekId, newAgentKey, openKey, sealKey } from '../src/crypto.js';

const KEK = `0x${'ab'.repeat(32)}` as const;
const OTHER_KEK = `0x${'cd'.repeat(32)}` as const;
const MANDATE = '0x00000000000000000000000000000000000acc01' as const;
const OTHER_MANDATE = '0x00000000000000000000000000000000000acc02' as const;

describe('tokens', () => {
  it('are prefixed, random and matched by hash only', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(TOKEN_PATTERN);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toHaveLength(64);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b));
    expect(hashesMatch(hashToken(a), hashToken(a))).toBe(true);
    expect(hashesMatch(hashToken(a), hashToken(b))).toBe(false);
  });
});

describe('agent keys at rest', () => {
  it('are sealed under the key-encryption key and open only with it, for their own connection', () => {
    const { key, agent } = newAgentKey();
    const binding = { chainId: 4663, mandate: MANDATE, agent };
    const sealed = sealKey(KEK, key, binding);

    expect(Buffer.from(sealed.ciphertext).toString('hex')).not.toContain(key.slice(2));
    expect(sealed.ciphertext).toHaveLength(32);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(sealed.kekId).toBe(kekId(KEK));

    expect(openKey(KEK, sealed, binding)).toBe(key);
    expect(() => openKey(OTHER_KEK, sealed, binding)).toThrow(SealError);
    expect(() => openKey(KEK, sealed, { ...binding, mandate: OTHER_MANDATE })).toThrow(SealError);
    expect(() => openKey(KEK, { ...sealed, kekId: kekId(OTHER_KEK) }, binding)).toThrow(SealError);
  });

  it('seals the same key differently each time', () => {
    const { key, agent } = newAgentKey();
    const binding = { chainId: 4663, mandate: MANDATE, agent };
    const first = sealKey(KEK, key, binding);
    const second = sealKey(KEK, key, binding);
    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(false);
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
  });

  it('refuses a tampered record', () => {
    const { key, agent } = newAgentKey();
    const binding = { chainId: 4663, mandate: MANDATE, agent };
    const sealed = sealKey(KEK, key, binding);
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => openKey(KEK, { ...sealed, ciphertext: tampered }, binding)).toThrow(SealError);
  });
});
