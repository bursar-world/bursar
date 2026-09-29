import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';

/** One public obligation bucket: what a contract owes, and what it holds to cover it. */
export type Leaf = {
  readonly id: string;
  readonly liabilities: bigint;
  readonly assets: bigint;
};

export type SumNode = {
  readonly hash: Hex;
  readonly liabilities: bigint;
  readonly assets: bigint;
};

export type SumTree = {
  readonly root: Hex;
  readonly liabilities: bigint;
  readonly assets: bigint;
  readonly leaves: readonly Leaf[];
};

const ZERO: SumNode = { hash: `0x${'00'.repeat(32)}`, liabilities: 0n, assets: 0n };
const MAX_UINT128 = (1n << 128n) - 1n;

function uint128(value: bigint, what: string): bigint {
  if (value < 0n || value > MAX_UINT128) throw new Error(`${what} does not fit uint128: ${value}`);
  return value;
}

export function leafHash(leaf: Leaf): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint128' }, { type: 'uint128' }],
      [keccak256(toBytes(leaf.id)), uint128(leaf.liabilities, leaf.id), uint128(leaf.assets, leaf.id)],
    ),
  );
}

function parent(left: SumNode, right: SumNode): SumNode {
  const liabilities = uint128(left.liabilities + right.liabilities, 'liabilities');
  const assets = uint128(left.assets + right.assets, 'assets');
  return {
    hash: keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint128' }, { type: 'uint128' }],
        [left.hash, right.hash, liabilities, assets],
      ),
    ),
    liabilities,
    assets,
  };
}

/**
 * A Merkle-sum tree: every node carries the sums of the leaves under it, so the root commits to
 * the totals as well as the leaves. Leaves are sorted by id, so the root does not depend on the
 * order they were read in. An odd level is padded with a zero node.
 */
export function buildTree(input: readonly Leaf[]): SumTree {
  if (input.length === 0) throw new Error('A solvency tree needs at least one leaf.');
  const leaves = [...input].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < leaves.length; i++) {
    if (leaves[i]!.id === leaves[i - 1]!.id) throw new Error(`Duplicate leaf id ${leaves[i]!.id}.`);
  }

  let level: SumNode[] = leaves.map((leaf) => ({
    hash: leafHash(leaf),
    liabilities: leaf.liabilities,
    assets: leaf.assets,
  }));
  while (level.length > 1) {
    const next: SumNode[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(parent(level[i]!, level[i + 1] ?? ZERO));
    level = next;
  }
  const top = level[0]!;
  return { root: top.hash, liabilities: top.liabilities, assets: top.assets, leaves };
}
