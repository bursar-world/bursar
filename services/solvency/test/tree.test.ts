import { encodeAbiParameters, keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';

import { buildTree, leafHash } from '../src/tree.js';

const a = { id: 'a:Escrow', liabilities: 10n, assets: 12n };
const b = { id: 'b:Escrow', liabilities: 5n, assets: 5n };
const c = { id: 'c:OracleRegistry', liabilities: 1n, assets: 3n };

describe('buildTree', () => {
  it('commits to the leaves and their sums, in any input order', () => {
    const one = buildTree([a, b, c]);
    const two = buildTree([c, a, b]);
    expect(one.root).toBe(two.root);
    expect(one.liabilities).toBe(16n);
    expect(one.assets).toBe(20n);
    expect(buildTree([a, b, { ...c, assets: 4n }]).root).not.toBe(one.root);
  });

  it('hashes a leaf as abi.encode(keccak(id), liabilities, assets)', () => {
    const expected = keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint128' }, { type: 'uint128' }], [keccak256(toBytes(a.id)), 10n, 12n]),
    );
    expect(leafHash(a)).toBe(expected);
    expect(buildTree([a]).root).toBe(expected);
  });

  it('pads an odd level with a zero node', () => {
    const ab = buildTree([a, b]);
    const zero = `0x${'00'.repeat(32)}` as const;
    const right = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint128' }, { type: 'uint128' }],
        [leafHash(c), zero, 1n, 3n],
      ),
    );
    const root = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint128' }, { type: 'uint128' }],
        [ab.root, right, 16n, 20n],
      ),
    );
    expect(buildTree([a, b, c]).root).toBe(root);
  });

  it('refuses an empty tree, duplicate ids and negative figures', () => {
    expect(() => buildTree([])).toThrow();
    expect(() => buildTree([a, a])).toThrow('Duplicate');
    expect(() => buildTree([{ ...a, liabilities: -1n }])).toThrow('uint128');
  });
});
