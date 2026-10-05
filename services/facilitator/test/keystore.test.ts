import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { KeystoreError, decryptKeystore, loadKeeperKey } from '../src/collateral/keystore.js';

const KEY: Hex = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const PASSWORD = 'correct horse battery staple';

/** Writes a keystore the way cast and geth do, with small kdf parameters so the suite stays quick. */
function encrypt(key: Hex, password: string, kdf: 'scrypt' | 'pbkdf2', extra: Record<string, unknown> = {}): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const kdfparams = kdf === 'scrypt' ? { dklen: 32, n: 1024, p: 1, r: 8, salt: salt.toString('hex') } : { c: 2048, dklen: 32, prf: 'hmac-sha256', salt: salt.toString('hex') };
  const derived = kdf === 'scrypt' ? scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 }) : pbkdf2Sync(password, salt, 2048, 32, 'sha256');
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()]);
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);
  return JSON.stringify({
    crypto: { cipher: 'aes-128-ctr', cipherparams: { iv: iv.toString('hex') }, ciphertext: ciphertext.toString('hex'), kdf, kdfparams, mac },
    id: 'b1e7c0ee-8d5a-4b3e-9f8d-2b2d6c3a1f00',
    version: 3,
    ...extra,
  });
}

describe('reading a version 3 keystore', () => {
  it('opens a scrypt keystore with its password', () => {
    expect(decryptKeystore(encrypt(KEY, PASSWORD, 'scrypt'), PASSWORD)).toBe(KEY);
  });

  it('opens a pbkdf2 keystore with its password', () => {
    expect(decryptKeystore(encrypt(KEY, PASSWORD, 'pbkdf2'), PASSWORD)).toBe(KEY);
  });

  it('checks the address the keystore names against the key it holds', () => {
    const address = privateKeyToAccount(KEY).address.slice(2).toLowerCase();
    expect(decryptKeystore(encrypt(KEY, PASSWORD, 'scrypt', { address }), PASSWORD)).toBe(KEY);
    expect(() => decryptKeystore(encrypt(KEY, PASSWORD, 'scrypt', { address: '0'.repeat(40) }), PASSWORD)).toThrow('names an address its key does not have');
  });

  it('refuses a wrong password before it decrypts anything', () => {
    expect(() => decryptKeystore(encrypt(KEY, PASSWORD, 'scrypt'), 'wrong')).toThrow(KeystoreError);
    expect(() => decryptKeystore(encrypt(KEY, PASSWORD, 'pbkdf2'), 'wrong')).toThrow('the password does not open this keystore');
  });

  it('refuses what it is not written to read', () => {
    expect(() => decryptKeystore('not json', PASSWORD)).toThrow('not JSON');
    expect(() => decryptKeystore(JSON.stringify({ version: 2, crypto: {} }), PASSWORD)).toThrow('version 2');
    const other = JSON.parse(encrypt(KEY, PASSWORD, 'scrypt')) as { crypto: { kdf: string } };
    other.crypto.kdf = 'argon2';
    expect(() => decryptKeystore(JSON.stringify(other), PASSWORD)).toThrow('argon2');
  });
});

describe('the keeper’s key from the environment', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function dir(): string {
    const made = mkdtempSync(join(tmpdir(), 'bursar-keeper-'));
    dirs.push(made);
    return made;
  }

  it('reads the keystore named, with the password named', () => {
    const path = join(dir(), 'keeper');
    writeFileSync(path, encrypt(KEY, PASSWORD, 'scrypt'));
    const warnings: string[] = [];

    expect(loadKeeperKey({ BURSAR_KEEPER_KEYSTORE: path, BURSAR_KEEPER_KEYSTORE_PASSWORD: PASSWORD }, (line) => warnings.push(line))).toBe(KEY);
    expect(warnings).toEqual([]);
  });

  it('reads the password from a file, less its trailing line end', () => {
    const at = dir();
    writeFileSync(join(at, 'keeper'), encrypt(KEY, PASSWORD, 'pbkdf2'));
    writeFileSync(join(at, 'password'), `${PASSWORD}\n`);

    expect(loadKeeperKey({ BURSAR_KEEPER_KEYSTORE: join(at, 'keeper'), BURSAR_KEEPER_KEYSTORE_PASSWORD_FILE: join(at, 'password') }, () => {})).toBe(KEY);
  });

  it('prefers the keystore over a raw key, and names what a keystore is missing', () => {
    const path = join(dir(), 'keeper');
    writeFileSync(path, encrypt(KEY, PASSWORD, 'scrypt'));

    expect(loadKeeperKey({ BURSAR_KEEPER_KEYSTORE: path, BURSAR_KEEPER_KEYSTORE_PASSWORD: PASSWORD, BURSAR_KEEPER_KEY: '0x' + '11'.repeat(32) }, () => {})).toBe(KEY);
    expect(() => loadKeeperKey({ BURSAR_KEEPER_KEYSTORE: path }, () => {})).toThrow('needs BURSAR_KEEPER_KEYSTORE_PASSWORD');
    expect(() => loadKeeperKey({ BURSAR_KEEPER_KEYSTORE: join(path, 'missing'), BURSAR_KEEPER_KEYSTORE_PASSWORD: PASSWORD }, () => {})).toThrow('could not be read');
  });

  it('falls back to a raw key with one warning, and refuses one that is not a key', () => {
    const warnings: string[] = [];

    expect(loadKeeperKey({ BURSAR_KEEPER_KEY: KEY }, (line) => warnings.push(line))).toBe(KEY);
    expect(warnings).toEqual(['keeper: BURSAR_KEEPER_KEY is a raw hex key in the environment; prefer BURSAR_KEEPER_KEYSTORE']);
    expect(() => loadKeeperKey({ BURSAR_KEEPER_KEY: '0xabc' }, () => {})).toThrow('not a 32-byte hex key');
  });

  it('holds no key when nothing names one', () => {
    expect(loadKeeperKey({}, () => {})).toBeUndefined();
    expect(loadKeeperKey({ BURSAR_KEEPER_KEYSTORE: '  ', BURSAR_KEEPER_KEY: '' }, () => {})).toBeUndefined();
  });
});
