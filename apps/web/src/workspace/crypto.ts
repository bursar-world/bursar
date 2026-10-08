/**
 * The workspace cipher. Everything here runs on WebCrypto in the page, and nothing here sends,
 * stores or logs the passphrase.
 *
 * PBKDF2-SHA256 at 600,000 iterations turns the passphrase and a 16-byte salt into an AES-256-GCM
 * key. The key is created non-extractable, so script on the page can use it and cannot read it out.
 * Every write draws a fresh 12-byte IV: GCM under one key with a repeated IV gives away the XOR of
 * two plaintexts and lets an attacker forge tags, so an IV is never reused, however small the edit.
 */

export const KDF_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export type KdfParams = {
  readonly name: 'PBKDF2';
  readonly hash: 'SHA-256';
  readonly iterations: number;
  /** Base64. */
  readonly salt: string;
};

export type Sealed = {
  /** Base64, 12 bytes, drawn for this write alone. */
  readonly iv: string;
  /** Base64 AES-GCM output, tag included. */
  readonly ciphertext: string;
};

/** The passphrase did not open the workspace. GCM cannot tell a wrong key from a tampered record. */
export class WrongPassphraseError extends Error {
  constructor() {
    super('That passphrase does not open this workspace.');
    this.name = 'WrongPassphraseError';
  }
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error('This browser cannot encrypt a workspace. Try another browser.');
  return api;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function newKdfParams(iterations = KDF_ITERATIONS): KdfParams {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(randomBytes(SALT_BYTES)) };
}

export async function deriveKey(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: params.hash, iterations: params.iterations, salt: fromBase64(params.salt) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealJson(key: CryptoKey, value: unknown, additionalData: string): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(additionalData) },
    key,
    plaintext,
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function openJson(key: CryptoKey, sealed: Sealed, additionalData: string): Promise<unknown> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: new TextEncoder().encode(additionalData) },
      key,
      fromBase64(sealed.ciphertext),
    );
  } catch {
    throw new WrongPassphraseError();
  }
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
