/**
 * ECIES on secp256k1 to an ERC-6538 viewing key.
 *
 * A sealed box is `0x01 || ephemeral public key (33) || iv (12) || AES-256-GCM ciphertext`. The
 * key is HKDF-SHA256 over the x-coordinate of the ECDH point, salted with the ephemeral key, so
 * two boxes to the same recipient never share a key. Only the holder of the viewing private key
 * can open one; anyone else fetching the bytes gets noise.
 *
 * The recipient's key comes from the ERC-6538 registry on Robinhood Chain
 * (`0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`), scheme 1: the stealth meta-address there is the
 * 33-byte spending key followed by the 33-byte viewing key, and this seals to the viewing half.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, hexToBytes, type Address, type Hex, type PublicClient } from 'viem';

import { InvalidArgumentError } from './errors.js';

export const SEAL_VERSION = 1;
export const ERC6538_REGISTRY: Address = '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538';
export const ERC5564_SCHEME_SECP256K1 = 1n;

const INFO = new TextEncoder().encode('bursar.seal.v1');
const IV_BYTES = 12;
const KEY_BYTES = 33;

export const erc6538Abi = [
  {
    type: 'function',
    name: 'stealthMetaAddressOf',
    stateMutability: 'view',
    inputs: [
      { name: 'registrant', type: 'address' },
      { name: 'schemeId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'registerKeys',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'schemeId', type: 'uint256' },
      { name: 'stealthMetaAddress', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

function subtle() {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error('This runtime has no WebCrypto, so it cannot seal or open a box.');
  return api;
}

const bytes = (value: Hex | Uint8Array): Uint8Array => (typeof value === 'string' ? hexToBytes(value) : value);

async function boxKey(shared: Uint8Array, ephemeral: Uint8Array) {
  const raw = hkdf(sha256, shared.slice(1), ephemeral, INFO, 32);
  return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Seals `plaintext` to a compressed or uncompressed secp256k1 public key. */
export async function seal(recipient: Hex | Uint8Array, plaintext: Uint8Array | string): Promise<Hex> {
  const pub = bytes(recipient);
  try {
    secp256k1.ProjectivePoint.fromHex(pub);
  } catch {
    throw new InvalidArgumentError('recipient', 'That is not a secp256k1 public key.', { recipient: bytesToHex(pub) });
  }
  const ephemeralPrivate = secp256k1.utils.randomPrivateKey();
  const ephemeral = secp256k1.getPublicKey(ephemeralPrivate, true);
  const key = await boxKey(secp256k1.getSharedSecret(ephemeralPrivate, pub, true), ephemeral);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, body));
  return bytesToHex(concatBytes([Uint8Array.of(SEAL_VERSION), ephemeral, iv, ciphertext]));
}

export class SealOpenError extends Error {
  constructor(message = 'This box was not sealed to that key, or it has been altered.') {
    super(message);
    this.name = 'SealOpenError';
  }
}

export async function open(privateKey: Hex | Uint8Array, box: Hex | Uint8Array): Promise<Uint8Array> {
  const raw = bytes(box);
  if (raw.length < 1 + KEY_BYTES + IV_BYTES + 16 || raw[0] !== SEAL_VERSION) throw new SealOpenError('Not a sealed box.');
  const ephemeral = raw.slice(1, 1 + KEY_BYTES);
  const iv = raw.slice(1 + KEY_BYTES, 1 + KEY_BYTES + IV_BYTES);
  const ciphertext = raw.slice(1 + KEY_BYTES + IV_BYTES);
  let shared: Uint8Array;
  try {
    shared = secp256k1.getSharedSecret(bytes(privateKey), ephemeral, true);
  } catch {
    throw new SealOpenError('Not a sealed box.');
  }
  const key = await boxKey(shared, ephemeral);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
  } catch {
    throw new SealOpenError();
  }
}

export async function openText(privateKey: Hex | Uint8Array, box: Hex | Uint8Array): Promise<string> {
  return new TextDecoder().decode(await open(privateKey, box));
}

/** The ERC-6538 scheme-1 meta-address: spending key then viewing key, both compressed. */
export function encodeMetaAddress(spendingPublicKey: Hex | Uint8Array, viewingPublicKey: Hex | Uint8Array): Hex {
  const spend = secp256k1.ProjectivePoint.fromHex(bytes(spendingPublicKey)).toRawBytes(true);
  const view = secp256k1.ProjectivePoint.fromHex(bytes(viewingPublicKey)).toRawBytes(true);
  return bytesToHex(concatBytes([spend, view]));
}

export function viewingKeyOfMetaAddress(meta: Hex | Uint8Array): Hex {
  const raw = bytes(meta);
  if (raw.length !== 2 * KEY_BYTES) {
    throw new InvalidArgumentError('meta', 'A scheme-1 meta-address is 66 bytes.', { length: raw.length });
  }
  return bytesToHex(raw.slice(KEY_BYTES));
}

/** Reads an address's published viewing key from the ERC-6538 registry, or null when it has none. */
export async function publishedViewingKey(
  client: Pick<PublicClient, 'readContract'>,
  registrant: Address,
  registry: Address = ERC6538_REGISTRY,
): Promise<Hex | null> {
  const meta = await client.readContract({
    address: registry,
    abi: erc6538Abi,
    functionName: 'stealthMetaAddressOf',
    args: [registrant, ERC5564_SCHEME_SECP256K1],
  });
  if (!meta || meta === '0x') return null;
  return viewingKeyOfMetaAddress(meta);
}

const SEALED_URI_PREFIX = 'data:application/vnd.bursar.sealed;base64,';

/** A job document sealed to the payee's viewing key, as the lock's `inputURI`. */
export async function sealedURI(recipient: Hex | Uint8Array, plaintext: string): Promise<string> {
  const box = hexToBytes(await seal(recipient, plaintext));
  let binary = '';
  for (const byte of box) binary += String.fromCharCode(byte);
  return SEALED_URI_PREFIX + btoa(binary);
}

export const isSealedURI = (uri: string): boolean =>
  uri.slice(0, SEALED_URI_PREFIX.length).toLowerCase() === SEALED_URI_PREFIX;

export async function openSealedURI(privateKey: Hex | Uint8Array, uri: string): Promise<string> {
  if (!isSealedURI(uri)) throw new SealOpenError('This URI is not a sealed Bursar payload.');
  const binary = atob(uri.slice(SEALED_URI_PREFIX.length));
  return openText(privateKey, Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
