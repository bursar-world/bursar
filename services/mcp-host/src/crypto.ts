import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';

/**
 * Tokens and the sealing of agent keys.
 *
 * A bearer token is 32 random bytes, shown to the owner once and stored only as its SHA-256. A
 * leaked table therefore opens nothing, and a presented token is matched by hashing it and
 * comparing the hashes, which takes the same time whatever was presented.
 *
 * An agent key is sealed with AES-256-GCM under the operator's key-encryption key, with the
 * connection's chain, mandate and agent address bound in as associated data: a ciphertext moved
 * to another row does not open. The key exists in the clear only in the memory of a process that
 * is about to sign with it.
 */

export const TOKEN_PREFIX = 'bmcp_';
const TOKEN_BYTES = 32;

/** What a token looks like, so a path or header that cannot be one is refused without a lookup. */
export const TOKEN_PATTERN = /^bmcp_[A-Za-z0-9_-]{43}$/u;

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export type SealedKey = {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
  readonly kekId: string;
};

export type KeyBinding = {
  readonly chainId: number;
  readonly mandate: Address;
  readonly agent: Address;
};

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

export function kekBytes(kek: Hex): Buffer {
  const bytes = Buffer.from(kek.slice(2), 'hex');
  if (bytes.length !== 32) throw new SealError('MCP_HOST_KEK is 32 bytes of hex.');
  return bytes;
}

/** Enough of a fingerprint to tell two keys apart in a row, and nothing that helps recover either. */
export function kekId(kek: Hex): string {
  return createHash('sha256').update(kekBytes(kek)).digest('hex').slice(0, 16);
}

function associated(binding: KeyBinding): Buffer {
  return Buffer.from(`${binding.chainId}:${binding.mandate.toLowerCase()}:${binding.agent.toLowerCase()}`, 'utf8');
}

export function sealKey(kek: Hex, key: Hex, binding: KeyBinding): SealedKey {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kekBytes(kek), nonce);
  cipher.setAAD(associated(binding));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag(), kekId: kekId(kek) };
}

export function openKey(kek: Hex, sealed: SealedKey, binding: KeyBinding): Hex {
  if (sealed.kekId !== kekId(kek)) {
    throw new SealError('This connection was sealed under a different key-encryption key than the one this process holds.');
  }
  const decipher = createDecipheriv('aes-256-gcm', kekBytes(kek), Buffer.from(sealed.nonce));
  decipher.setAAD(associated(binding));
  decipher.setAuthTag(Buffer.from(sealed.tag));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext)), decipher.final()]);
  } catch {
    throw new SealError('The sealed key did not open: it was sealed for another connection, or the record was altered.');
  }
  if (plain.length !== 32) throw new SealError('The sealed key is not 32 bytes.');
  return `0x${plain.toString('hex')}`;
}

/** A fresh agent key and the address it signs as. The key is returned once and never logged. */
export function newAgentKey(): { readonly key: Hex; readonly agent: Address } {
  const key = generatePrivateKey();
  return { key, agent: privateKeyToAccount(key).address };
}
