import { encodeAbiParameters, keccak256, stringToHex } from 'viem';

import type { AccountState } from './chain.js';
import { type Address, type Hex32, type MandateDocument, documentHash } from './document.js';

/**
 * Separates this anchor from any other 32-byte value a principal might be asked to sign. The
 * account stores `documentHash` as opaque bytes and never reads it, so the tag is the only thing
 * stopping a hash minted for some other purpose from being presented as a mandate document.
 */
export const ANCHOR_DOMAIN = keccak256(stringToHex('mandate.document.anchor.v1'));

export type AnchorInput = {
  readonly chainId: number;
  readonly account: Address;
  readonly version: bigint;
  readonly documentHash: Hex32;
};

/**
 * Binds a document to the exact limits that were live when it was written.
 *
 * `version` is in the preimage, and `MandateAccount` bumps it on every `setLimits`. A principal
 * who changes a limit therefore invalidates the anchor, and the document has to be reissued
 * against the new version before it matches again. That is what the anchor buys: a decision log
 * can name the document it was taken under, and nobody can quietly swap the limits underneath it.
 */
export function documentAnchor(input: AnchorInput): Hex32 {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint64' }, { type: 'bytes32' }],
      [ANCHOR_DOMAIN, BigInt(input.chainId), input.account, input.version, input.documentHash],
    ),
  );
}

export type AnchorStatus = {
  readonly documentHash: Hex32;
  /** The anchor this document produces at the version the account reports. */
  readonly expected: Hex32;
  /** What the account is holding. All zeroes means nothing was ever anchored. */
  readonly anchored: Hex32;
  readonly matches: boolean;
  readonly unanchored: boolean;
  readonly documentVersion: bigint | null;
  readonly accountVersion: bigint;
};

const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex32;

export function verifyAnchor(document: MandateDocument, state: AccountState, chainId: number): AnchorStatus {
  const hash = documentHash(document);
  const expected = documentAnchor({ chainId, account: state.account, version: state.version, documentHash: hash });
  const anchored = state.documentHash.toLowerCase() as Hex32;

  return {
    documentHash: hash,
    expected,
    anchored,
    matches: anchored === expected.toLowerCase(),
    unanchored: anchored === ZERO_BYTES32,
    documentVersion: document.version,
    accountVersion: state.version,
  };
}

