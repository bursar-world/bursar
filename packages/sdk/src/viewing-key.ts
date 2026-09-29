/**
 * The principal's viewing key, derived from one wallet signature.
 *
 * The wallet signs a fixed message naming the account. HKDF-SHA256 over the signature yields two
 * keys: an AES-256-GCM key that seals the mandate terms, and a secp256k1 key pair whose public
 * half can be published through ERC-6538 so counterparties can seal payloads to it. The same
 * wallet signing the same message gives the same keys, so nothing has to be stored: the console
 * asks for the signature again and the terms open.
 *
 * That holds for wallets that sign deterministically (RFC 6979), which covers every EOA wallet.
 * A smart-contract wallet whose signature changes per call cannot re-derive its key and should
 * keep the derived key in its encrypted workspace instead.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, getAddress, hexToBytes, type Address, type Hex } from 'viem';

export const VIEWING_KEY_VERSION = 1;

export function viewingKeyMessage(account: Address): string {
  return [
    'Bursar viewing key',
    '',
    'Sign to open your private mandate terms on this device. This signature does not move funds,',
    'approve a spend or cost gas.',
    '',
    `Account: ${getAddress(account)}`,
    `Version: ${VIEWING_KEY_VERSION}`,
  ].join('\n');
}

export type ViewingKey = {
  /** 32 bytes. Seals and opens the terms. */
  readonly termsKey: Uint8Array;
  /** secp256k1 private key for sealed payloads addressed to this account. */
  readonly privateKey: Hex;
  /** Compressed public key, the viewing half of the ERC-6538 meta-address. */
  readonly publicKey: Hex;
};

const SALT = new TextEncoder().encode('bursar.viewing-key.v1');

export function deriveViewingKey(signature: Hex): ViewingKey {
  const ikm = hexToBytes(signature);
  if (ikm.length < 64) throw new Error('A viewing key needs a full wallet signature.');
  const termsKey = hkdf(sha256, ikm, SALT, 'terms', 32);
  // 48 bytes reduced mod n - 1 leaves a bias of about 2^-128, and the +1 keeps the key off zero.
  const wide = BigInt(bytesToHex(hkdf(sha256, ikm, SALT, 'secp256k1', 48)));
  const scalar = (wide % (secp256k1.CURVE.n - 1n)) + 1n;
  const privateKey: Hex = `0x${scalar.toString(16).padStart(64, '0')}`;
  return {
    termsKey,
    privateKey,
    publicKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKey), true)),
  };
}
