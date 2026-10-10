import { createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { keccak256 } from 'viem';
import type { Hex } from 'viem';

type KeystoreV3 = {
  readonly version: number;
  readonly crypto: {
    readonly cipher: string;
    readonly cipherparams: { readonly iv: string };
    readonly ciphertext: string;
    readonly kdf: string;
    readonly kdfparams: { dklen: number; n: number; p: number; r: number; salt: string };
    readonly mac: string;
  };
};

/**
 * Opens a Web3 Secret Storage v3 keystore (scrypt, AES-128-CTR), the format `cast wallet import`
 * writes. The MAC is checked first: a wrong password otherwise decrypts to a valid but wrong key.
 */
export function openKeystore(path: string, passwordFile: string): Hex {
  const password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
  if (password === '') throw new Error('The keystore password file is empty.');
  const store = JSON.parse(readFileSync(path, 'utf8')) as KeystoreV3;
  if (store.version !== 3 || store.crypto.kdf !== 'scrypt' || store.crypto.cipher !== 'aes-128-ctr') {
    throw new Error(`${path} is not a scrypt/aes-128-ctr v3 keystore.`);
  }
  const p = store.crypto.kdfparams;
  const derived = scryptSync(Buffer.from(password, 'utf8'), Buffer.from(p.salt, 'hex'), p.dklen, {
    N: p.n,
    r: p.r,
    p: p.p,
    maxmem: 256 * p.n * p.r + 1_048_576,
  });
  const ciphertext = Buffer.from(store.crypto.ciphertext, 'hex');
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext]));
  if (mac.slice(2).toLowerCase() !== store.crypto.mac.toLowerCase()) {
    throw new Error(`${path} did not open: the password does not match it.`);
  }
  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(store.crypto.cipherparams.iv, 'hex'));
  return `0x${Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('hex')}`;
}

/**
 * The agent key from the environment: `BURSAR_AGENT_KEY` as hex, or `BURSAR_KEYSTORE` with the
 * password in the file `BURSAR_KEYSTORE_PASSWORD_FILE` names. Undefined when neither is set, which
 * opens a read-only toolset.
 */
export function agentKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Hex | undefined {
  const hex = env.BURSAR_AGENT_KEY?.trim();
  if (hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('BURSAR_AGENT_KEY must be a 0x-prefixed 32-byte hex key.');
    return hex as Hex;
  }
  const keystore = env.BURSAR_KEYSTORE?.trim();
  if (!keystore) return undefined;
  const passwordFile = env.BURSAR_KEYSTORE_PASSWORD_FILE?.trim();
  if (!passwordFile) throw new Error('BURSAR_KEYSTORE is set without BURSAR_KEYSTORE_PASSWORD_FILE.');
  return openKeystore(keystore, passwordFile);
}
