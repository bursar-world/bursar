/**
 * The principal's keys, derived from two wallet signatures that do different jobs.
 *
 * The viewing key. The wallet signs a fixed message naming the account (`viewingKeyMessage`), and
 * HKDF-SHA256 over the signature yields an AES-256-GCM key that seals the mandate terms and a
 * secp256k1 key pair whose public half is published through ERC-6538 so counterparties can seal
 * payloads to it. It reads; it cannot move anything.
 *
 * The funds key. A second signature, over EIP-712 typed data bound to the chain and the shielded
 * pool (`fundsKeyTypedData`), whose type and text tell the wallet's prompt that it controls funds.
 * The shielded note keys and the stealth spending key come from it, and only after the signature
 * is checked to recover to the wallet it is for.
 *
 * The same wallet signing the same message gives the same keys, so nothing has to be stored: the
 * console asks for the signature again. That holds for wallets that sign deterministically
 * (RFC 6979), which covers every EOA wallet. A smart-contract wallet cannot re-derive these keys.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, getAddress, hashTypedData, hexToBytes, isAddressEqual, type Address, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

export const VIEWING_KEY_VERSION = 1;
export const FUNDS_KEY_VERSION = 1;

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

export const FUNDS_KEY_WARNING =
  'This signature controls funds. It creates the keys that spend your shielded USDG and act for the hidden owner and agent of your private mandates. Sign it only in the Bursar console.';

/** Where a funds key is valid: the wallet it belongs to, the chain and the shielded pool. */
export type FundsKeyContext = { readonly account: Address; readonly chainId: number; readonly pool: Address };

/** The EIP-712 request the wallet signs for the funds key, ready for `signTypedData`. */
export function fundsKeyTypedData(context: FundsKeyContext) {
  return {
    domain: { name: 'Bursar', version: '1', chainId: context.chainId, verifyingContract: getAddress(context.pool) },
    types: {
      KeyThatControlsFunds: [
        { name: 'warning', type: 'string' },
        { name: 'wallet', type: 'address' },
        { name: 'version', type: 'uint256' },
      ],
    },
    primaryType: 'KeyThatControlsFunds',
    message: { warning: FUNDS_KEY_WARNING, wallet: getAddress(context.account), version: BigInt(FUNDS_KEY_VERSION) },
  } as const;
}

export class FundsKeySignatureError extends Error {
  constructor() {
    super('This is not the funds-key signature of this wallet for this chain and pool.');
    this.name = 'FundsKeySignatureError';
  }
}

function signer(digest: Hex, signature: Hex): Address {
  const raw = hexToBytes(signature);
  if (raw.length !== 65) throw new FundsKeySignatureError();
  const v = raw[64] as number;
  const bit = v >= 27 ? v - 27 : v;
  if (bit !== 0 && bit !== 1) throw new FundsKeySignatureError();
  try {
    const point = secp256k1.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(bit).recoverPublicKey(hexToBytes(digest));
    return publicKeyToAddress(bytesToHex(point.toRawBytes(false)));
  } catch {
    throw new FundsKeySignatureError();
  }
}

/**
 * The key material behind a funds-key signature. Refuses a signature that does not recover to
 * `context.account` over exactly `fundsKeyTypedData(context)`: a viewing-key signature, one made
 * for another pool or chain, or bytes that are not a signature at all.
 */
export function fundsKeyMaterial(signature: Hex, context: FundsKeyContext): Uint8Array {
  if (!isAddressEqual(signer(hashTypedData(fundsKeyTypedData(context)), signature), context.account)) {
    throw new FundsKeySignatureError();
  }
  return hexToBytes(signature);
}

export type ViewingKey = {
  /** 32 bytes. Seals and opens the terms. */
  readonly termsKey: Uint8Array;
  /** secp256k1 private key for sealed payloads addressed to this account. */
  readonly privateKey: Hex;
  /** Compressed public key, the viewing half of the ERC-6538 meta-address. */
  readonly publicKey: Hex;
};

const VIEWING_SALT = new TextEncoder().encode('bursar.viewing-key.v1');
export const FUNDS_SALT = new TextEncoder().encode('bursar.funds-key.v1');

function signatureBytes(signature: Hex): Uint8Array {
  const ikm = hexToBytes(signature);
  if (ikm.length < 64) throw new Error('A viewing key needs a full wallet signature.');
  return ikm;
}

function scalarKey(ikm: Uint8Array, salt: Uint8Array, info: string): Hex {
  // 48 bytes reduced mod n - 1 leaves a bias of about 2^-128, and the +1 keeps the key off zero.
  const wide = BigInt(bytesToHex(hkdf(sha256, ikm, salt, info, 48)));
  const scalar = (wide % (secp256k1.CURVE.n - 1n)) + 1n;
  return `0x${scalar.toString(16).padStart(64, '0')}`;
}

export function deriveViewingKey(signature: Hex): ViewingKey {
  const ikm = signatureBytes(signature);
  const privateKey = scalarKey(ikm, VIEWING_SALT, 'secp256k1');
  return {
    termsKey: hkdf(sha256, ikm, VIEWING_SALT, 'terms', 32),
    privateKey,
    publicKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKey), true)),
  };
}

/**
 * The spending half of the principal's ERC-5564 keys, from the funds-key signature. Handing someone
 * the viewing key (to scan or to open sealed payloads) does not hand them this one. Every stealth
 * address the principal controls is this key plus a per-address tweak, so it never signs a
 * transaction itself.
 */
export function deriveSpendingKey(
  signature: Hex,
  context: FundsKeyContext,
): { readonly privateKey: Hex; readonly publicKey: Hex } {
  const privateKey = scalarKey(fundsKeyMaterial(signature, context), FUNDS_SALT, 'stealth-spending');
  return { privateKey, publicKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKey), true)) };
}
