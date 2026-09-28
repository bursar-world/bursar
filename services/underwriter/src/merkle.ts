import { concatHex, encodeAbiParameters, keccak256 } from 'viem';

import type { Address, Hex32 } from './document.js';

/**
 * The double-hashed leaf `MandateAccount.merchantLeaf` computes. Hashing twice is what makes a
 * proof for an internal node impossible to forge as a leaf, and the second hash has to be taken
 * over the same 32 bytes the contract concatenates or no proof written for one will verify
 * against the other.
 */
export function merchantLeaf(merchant: Address): Hex32 {
  return keccak256(concatHex([keccak256(encodeAbiParameters([{ type: 'address' }], [merchant]))]));
}

/**
 * OpenZeppelin's sorted-pair proof, which is what `MerkleProof.verifyCalldata` runs. Sorting
 * each pair is why the proof carries no direction bits; reproduce it exactly or a valid proof
 * reads as a forgery here and the quote refuses a spend the contract would have paid.
 */
export function processProof(leaf: Hex32, proof: readonly Hex32[]): Hex32 {
  let computed = leaf;
  for (const sibling of proof) {
    computed =
      computed.toLowerCase() <= sibling.toLowerCase()
        ? keccak256(concatHex([computed, sibling]))
        : keccak256(concatHex([sibling, computed]));
  }
  return computed;
}

export function verifyMerchantProof(root: Hex32, merchant: Address, proof: readonly Hex32[]): boolean {
  return processProof(merchantLeaf(merchant), proof).toLowerCase() === root.toLowerCase();
}
