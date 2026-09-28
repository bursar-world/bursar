import { execFileSync } from 'node:child_process';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BursarError } from '@bursar/core';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PrivateKeyAccount } from 'viem';

/**
 * One bonded resolver key, opened in this process.
 *
 * Only the viem account leaves this module. The raw key is decrypted into a local, handed to
 * `privateKeyToAccount` and dropped, so nothing that logs, serialises or reports a `ResolverKey`
 * can reach it. The name is the keystore's file name, which is what an operator reads in an alert.
 */
export type ResolverKey = {
  readonly name: string;
  readonly address: Address;
  readonly account: PrivateKeyAccount;
};

export type KeySource =
  | {
      readonly kind: 'keystore';
      readonly dir: string;
      readonly names: readonly string[];
      /** Read when the keys are opened, never earlier, and never kept. */
      readonly password: () => string;
    }
  | {
      readonly kind: 'raw';
      readonly names: readonly string[];
      readonly keys: readonly Hex[];
    };

type ScryptParams = {
  readonly dklen: number;
  readonly n: number;
  readonly p: number;
  readonly r: number;
  readonly salt: string;
};

type KeystoreV3 = {
  readonly version: number;
  readonly crypto: {
    readonly cipher: string;
    readonly cipherparams: { readonly iv: string };
    readonly ciphertext: string;
    readonly kdf: string;
    readonly kdfparams: ScryptParams;
    readonly mac: string;
  };
};

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export function loadKeys(source: KeySource): readonly ResolverKey[] {
  const keys =
    source.kind === 'raw'
      ? rawKeys(source.names, source.keys)
      : openKeystores(source.dir, source.names, source.password());

  // Two names for one key is one voter under two labels. The quorum would count it twice in this
  // process's head and once on chain, and the dispute that needed a second vote would not get one.
  const seen = new Map<string, string>();
  for (const key of keys) {
    const other = seen.get(key.address.toLowerCase());
    if (other !== undefined) {
      throw new BursarError('resolver_keys_duplicate', `${other} and ${key.name} are the same key (${key.address}).`, {
        address: key.address,
      });
    }
    seen.set(key.address.toLowerCase(), key.name);
  }

  return keys;
}

function rawKeys(names: readonly string[], keys: readonly Hex[]): ResolverKey[] {
  if (names.length !== keys.length) {
    throw new BursarError(
      'resolver_keys_mismatch',
      `RESOLVER_KEYS holds ${keys.length} keys and RESOLVER_KEYS_ORDER names ${names.length}. They pair up in order, so the counts have to match.`,
      { keys: keys.length, names: names.length },
    );
  }

  return keys.map((key, index) => {
    const name = names[index] ?? `key-${index + 1}`;
    // The value is never quoted back. A malformed key in an error message is still most of a key.
    if (!HEX32.test(key)) {
      throw new BursarError('resolver_key_invalid', `The key for ${name} is not a 32-byte 0x private key.`, { name });
    }
    const account = privateKeyToAccount(key);
    return { name, address: account.address, account };
  });
}

function openKeystores(dir: string, names: readonly string[], password: string): ResolverKey[] {
  if (password === '') {
    throw new BursarError('resolver_password_empty', 'The keystore password is empty, so no keystore can be opened.');
  }

  return names.map((name) => {
    const path = [join(dir, name), join(dir, `${name}.json`)].find((candidate) => existsSync(candidate));
    if (path === undefined) {
      throw new BursarError('resolver_keystore_missing', `There is no keystore named ${name} in ${dir}.`, { name, dir });
    }

    const account = privateKeyToAccount(decrypt(name, JSON.parse(readFileSync(path, 'utf8')) as KeystoreV3, password));
    return { name, address: account.address, account };
  });
}

/**
 * Web3 Secret Storage v3 with scrypt and AES-128-CTR, the format `cast wallet import` writes.
 *
 * The MAC is checked before the plaintext is used. A wrong password otherwise yields 32 bytes of
 * noise that is still a valid private key, and the first sign of it would be a vote cast from an
 * address with no bond behind it.
 */
function decrypt(name: string, store: KeystoreV3, password: string): Hex {
  if (store.version !== 3) throw new BursarError('resolver_keystore_format', `${name} is not a version 3 keystore.`, { name });
  if (store.crypto.kdf !== 'scrypt' || store.crypto.cipher !== 'aes-128-ctr') {
    throw new BursarError(
      'resolver_keystore_format',
      `${name} uses ${store.crypto.kdf} and ${store.crypto.cipher}; only scrypt with aes-128-ctr is read here.`,
      { name },
    );
  }

  const params = store.crypto.kdfparams;
  const derived = scryptSync(Buffer.from(password, 'utf8'), Buffer.from(params.salt, 'hex'), params.dklen, {
    N: params.n,
    r: params.r,
    p: params.p,
    // A keystore written with a harder factor than Node's 32 MiB default allows would otherwise
    // refuse to open with an error about memory rather than about the keystore.
    maxmem: 256 * params.n * params.r + 1_048_576,
  });

  const ciphertext = Buffer.from(store.crypto.ciphertext, 'hex');
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext]));
  if (mac.slice(2).toLowerCase() !== store.crypto.mac.toLowerCase()) {
    throw new BursarError('resolver_keystore_password', `${name} did not open: the password does not match it.`, { name });
  }

  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(store.crypto.cipherparams.iv, 'hex'));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return `0x${plaintext.toString('hex')}`;
}

/** A password kept in a file only its owner can read, one line, as `cast` expects it. */
export function passwordFromFile(path: string): () => string {
  return () => readFileSync(path, 'utf8').replace(/\r?\n$/, '');
}

/**
 * A password kept in the macOS Keychain as `service/account`. For the backup runner on an
 * operator's machine, where a password file is one more copy of the secret to look after.
 */
export function passwordFromKeychain(item: string): () => string {
  const [service, account] = item.split('/');
  if (!service || !account) {
    throw new BursarError('resolver_keychain_item', 'RESOLVER_PASSWORD_KEYCHAIN is written as service/account.');
  }

  return () => execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf8' }).trim();
}
