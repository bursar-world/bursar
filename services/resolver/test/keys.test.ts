import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { loadKeys } from '../src/keys.js';

const KEY_1 = `0x${'11'.repeat(32)}` as const;
const KEY_2 = `0x${'22'.repeat(32)}` as const;

/** Written the way `cast wallet import` writes one, at a small work factor so the test is quick. */
function keystore(dir: string, name: string, key: string, password: string): void {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = scryptSync(Buffer.from(password), salt, 32, { N: 1_024, r: 8, p: 1 });
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()]);
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      version: 3,
      id: 'test',
      crypto: {
        cipher: 'aes-128-ctr',
        cipherparams: { iv: iv.toString('hex') },
        ciphertext: ciphertext.toString('hex'),
        kdf: 'scrypt',
        kdfparams: { dklen: 32, n: 1_024, p: 1, r: 8, salt: salt.toString('hex') },
        mac: keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2),
      },
    }),
  );
}

describe('keys', () => {
  it('opens keystores in order, by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolver-keys-'));
    keystore(dir, 'resolver-1', KEY_1, 'pw');
    keystore(dir, 'resolver-2.json', KEY_2, 'pw');

    const keys = loadKeys({ kind: 'keystore', dir, names: ['resolver-2', 'resolver-1'], password: () => 'pw' });
    expect(keys.map((key) => [key.name, key.address])).toEqual([
      ['resolver-2', privateKeyToAccount(KEY_2).address],
      ['resolver-1', privateKeyToAccount(KEY_1).address],
    ]);
  });

  it('refuses a wrong password on the MAC rather than opening noise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolver-keys-'));
    keystore(dir, 'resolver-1', KEY_1, 'pw');

    expect(() => loadKeys({ kind: 'keystore', dir, names: ['resolver-1'], password: () => 'wrong' })).toThrow(/password does not match/);
  });

  it('never quotes a malformed key back', () => {
    const bad = `0x${'zz'.repeat(32)}` as `0x${string}`;
    let message = '';
    try {
      loadKeys({ kind: 'raw', names: ['resolver-1'], keys: [bad] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/resolver-1/);
    expect(message).not.toContain('zz');
  });

  it('refuses the same key under two names', () => {
    expect(() => loadKeys({ kind: 'raw', names: ['a', 'b'], keys: [KEY_1, KEY_1] })).toThrow(/same key/);
  });

  it('refuses a key count that does not match the names', () => {
    expect(() => loadKeys({ kind: 'raw', names: ['a', 'b', 'c'], keys: [KEY_1, KEY_2] })).toThrow(/pair up/);
  });
});
