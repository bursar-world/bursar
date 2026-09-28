import { concatHex, keccak256 } from 'viem';
import { describe, expect, test } from 'vitest';

import type { Address, Hex32 } from '../src/document.js';
import { merchantLeaf, processProof, verifyMerchantProof } from '../src/merkle.js';

const MERCHANTS: Address[] = [
  '0x4444444444444444444444444444444444444444',
  '0x5555555555555555555555555555555555555555',
  '0x6666666666666666666666666666666666666666',
  '0x7777777777777777777777777777777777777777',
];

function pair(a: Hex32, b: Hex32): Hex32 {
  return a.toLowerCase() <= b.toLowerCase() ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));
}

/** A four-leaf tree, built the way a principal's tooling would build one. */
function tree(): { root: Hex32; proofs: Map<Address, Hex32[]> } {
  const leaves = MERCHANTS.map(merchantLeaf);
  const [l0, l1, l2, l3] = leaves as [Hex32, Hex32, Hex32, Hex32];
  const left = pair(l0, l1);
  const right = pair(l2, l3);

  return {
    root: pair(left, right),
    proofs: new Map<Address, Hex32[]>([
      [MERCHANTS[0] as Address, [l1, right]],
      [MERCHANTS[1] as Address, [l0, right]],
      [MERCHANTS[2] as Address, [l3, left]],
      [MERCHANTS[3] as Address, [l2, left]],
    ]),
  };
}

describe('merchantLeaf', () => {
  test('matches the double hash MandateAccount.merchantLeaf computes', () => {
    // Cross-checked against `cast keccak $(cast keccak $(cast abi-encode "f(address)" <merchant>))`.
    expect(merchantLeaf('0x4444444444444444444444444444444444444444')).toBe(
      '0x1ede693ef734e17c8e0812c5ae5379839975b77cefe7b9eec7592c998b7fd2a2',
    );
  });

  test('hashing twice is what stops an internal node being presented as a leaf', () => {
    const single = keccak256('0x0000000000000000000000004444444444444444444444444444444444444444');
    expect(merchantLeaf('0x4444444444444444444444444444444444444444')).not.toBe(single);
    expect(merchantLeaf('0x4444444444444444444444444444444444444444')).toBe(keccak256(single));
  });
});

describe('verifyMerchantProof', () => {
  const { root, proofs } = tree();

  test.each(MERCHANTS)('%s verifies against the root', (merchant) => {
    expect(verifyMerchantProof(root, merchant, proofs.get(merchant) as Hex32[])).toBe(true);
  });

  test('a merchant outside the tree does not verify', () => {
    expect(verifyMerchantProof(root, '0x8888888888888888888888888888888888888888', proofs.get(MERCHANTS[0] as Address) as Hex32[])).toBe(
      false,
    );
  });

  test('a proof for one merchant does not carry another', () => {
    expect(verifyMerchantProof(root, MERCHANTS[0] as Address, proofs.get(MERCHANTS[2] as Address) as Hex32[])).toBe(false);
  });

  test('an empty proof only verifies a single-leaf tree', () => {
    const only = MERCHANTS[0] as Address;
    expect(verifyMerchantProof(merchantLeaf(only), only, [])).toBe(true);
    expect(verifyMerchantProof(root, only, [])).toBe(false);
  });

  test('the root is matched case-insensitively', () => {
    expect(verifyMerchantProof(root.toUpperCase().replace('0X', '0x') as Hex32, MERCHANTS[0] as Address, proofs.get(MERCHANTS[0] as Address) as Hex32[])).toBe(
      true,
    );
  });

  test('sorting each pair is what removes the direction bits', () => {
    const [a, b] = [merchantLeaf(MERCHANTS[0] as Address), merchantLeaf(MERCHANTS[1] as Address)];
    expect(processProof(a, [b])).toBe(processProof(b, [a]));
  });
});
