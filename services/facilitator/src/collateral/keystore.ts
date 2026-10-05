import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { keccak256 } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The keeper's key, read from a Web3 Secret Storage keystore (version 3): the file `cast wallet
 * import` and geth write, encrypted under a password with scrypt or PBKDF2 and AES-128-CTR. The
 * key exists in memory for the pass and nowhere else; the environment carries a path and a
 * password, or a path to a file holding the password, and never the key itself.
 */

type Keystore = {
  readonly version: number;
  readonly address?: string;
  readonly crypto: {
    readonly cipher: string;
    readonly cipherparams: { readonly iv: string };
    readonly ciphertext: string;
    readonly kdf: string;
    readonly kdfparams: Record<string, unknown>;
    readonly mac: string;
  };
};

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}

/** Decrypts a keystore's text with `password`, and answers the private key it holds. */
export function decryptKeystore(text: string, password: string): Hex {
  const store = parse(text);
  const { cipher, cipherparams, kdf, kdfparams } = store.crypto;
  if (cipher !== 'aes-128-ctr') throw new KeystoreError(`the keystore's cipher is ${cipher}; only aes-128-ctr is read`);
  const ciphertext = bytes(store.crypto.ciphertext, 'ciphertext');
  const iv = bytes(cipherparams.iv, 'cipherparams.iv');
  if (iv.length !== 16) throw new KeystoreError('the keystore’s iv is not 16 bytes');
  const derived = derive(kdf, kdfparams, Buffer.from(password, 'utf8'));

  // The mac covers the second half of the derived key and the ciphertext, so a wrong password is
  // found here, before anything is decrypted.
  const mac = bytes(store.crypto.mac, 'mac');
  const expected = Buffer.from(keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2), 'hex');
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new KeystoreError('the password does not open this keystore');
  }

  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (key.length !== 32) throw new KeystoreError(`the keystore holds ${key.length} bytes, and a key is 32`);
  const hex: Hex = `0x${key.toString('hex')}`;

  // A keystore that names its address names the key's; anything else is a file that was edited.
  if (store.address !== undefined) {
    const named = store.address.toLowerCase().replace(/^0x/, '');
    const actual = privateKeyToAccount(hex).address.toLowerCase().replace(/^0x/, '');
    if (named !== actual) throw new KeystoreError('the keystore names an address its key does not have');
  }
  return hex;
}

/** The variables the keeper's key can come from. */
export type KeeperKeyEnv = {
  readonly BURSAR_KEEPER_KEYSTORE?: string | undefined;
  readonly BURSAR_KEEPER_KEYSTORE_PASSWORD?: string | undefined;
  readonly BURSAR_KEEPER_KEYSTORE_PASSWORD_FILE?: string | undefined;
  readonly BURSAR_KEEPER_KEY?: string | undefined;
};

/**
 * The keeper's key from the environment, or undefined when it holds none. A keystore path is read
 * first; a raw key is accepted behind it, with one line to `warn` saying the keystore is the way.
 */
export function loadKeeperKey(env: KeeperKeyEnv, warn: (line: string) => void): Hex | undefined {
  const path = env.BURSAR_KEEPER_KEYSTORE?.trim();
  if (path) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new KeystoreError(`BURSAR_KEEPER_KEYSTORE could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return decryptKeystore(text, keystorePassword(env));
  }
  const raw = env.BURSAR_KEEPER_KEY?.trim();
  if (raw) {
    warn('keeper: BURSAR_KEEPER_KEY is a raw hex key in the environment; prefer BURSAR_KEEPER_KEYSTORE');
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new KeystoreError('BURSAR_KEEPER_KEY is not a 32-byte hex key');
    return raw as Hex;
  }
  return undefined;
}

/** The password named directly, or the contents of the file named, less a trailing line end. */
function keystorePassword(env: KeeperKeyEnv): string {
  const direct = env.BURSAR_KEEPER_KEYSTORE_PASSWORD;
  if (direct !== undefined && direct !== '') return direct;
  const file = env.BURSAR_KEEPER_KEYSTORE_PASSWORD_FILE?.trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (error) {
      throw new KeystoreError(`BURSAR_KEEPER_KEYSTORE_PASSWORD_FILE could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new KeystoreError('BURSAR_KEEPER_KEYSTORE needs BURSAR_KEEPER_KEYSTORE_PASSWORD or BURSAR_KEEPER_KEYSTORE_PASSWORD_FILE');
}

function parse(text: string): Keystore {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KeystoreError('the keystore is not JSON');
  }
  if (typeof value !== 'object' || value === null) throw new KeystoreError('the keystore is not an object');
  const store = value as Partial<Keystore>;
  if (store.version !== 3) throw new KeystoreError(`the keystore is version ${String(store.version)}; only version 3 is read`);
  const c = store.crypto;
  if (
    typeof c !== 'object' || c === null || typeof c.cipher !== 'string' || typeof c.ciphertext !== 'string' || typeof c.kdf !== 'string'
    || typeof c.mac !== 'string' || typeof c.cipherparams?.iv !== 'string' || typeof c.kdfparams !== 'object' || c.kdfparams === null
  ) {
    throw new KeystoreError('the keystore’s crypto block is incomplete');
  }
  if (store.address !== undefined && typeof store.address !== 'string') throw new KeystoreError('the keystore’s address is not a string');
  return store as Keystore;
}

function derive(kdf: string, params: Record<string, unknown>, password: Buffer): Buffer {
  const dklen = integer(params, 'dklen');
  if (dklen !== 32) throw new KeystoreError(`the keystore derives ${dklen} bytes, and the cipher and mac need 32`);
  const salt = bytes(string(params, 'salt'), 'kdfparams.salt');
  if (kdf === 'scrypt') {
    const n = integer(params, 'n');
    const r = integer(params, 'r');
    const p = integer(params, 'p');
    // Node refuses a derivation over its default 32 MiB; geth's default parameters need 256 MiB.
    return scryptSync(password, salt, dklen, { N: n, r, p, maxmem: 128 * n * r * p + 2 ** 20 });
  }
  if (kdf === 'pbkdf2') {
    const prf = params['prf'];
    if (prf !== 'hmac-sha256') throw new KeystoreError(`the keystore's pbkdf2 prf is ${String(prf)}; only hmac-sha256 is read`);
    return pbkdf2Sync(password, salt, integer(params, 'c'), dklen, 'sha256');
  }
  throw new KeystoreError(`the keystore's kdf is ${kdf}; scrypt and pbkdf2 are read`);
}

function integer(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new KeystoreError(`the keystore's kdfparams.${key} is not a positive integer`);
  return value;
}

function string(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string') throw new KeystoreError(`the keystore's kdfparams.${key} is not a string`);
  return value;
}

function bytes(hex: string, field: string): Buffer {
  const clean = hex.replace(/^0x/, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) throw new KeystoreError(`the keystore's ${field} is not hex`);
  return Buffer.from(clean, 'hex');
}
