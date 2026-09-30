import { poseidon1, poseidon2, poseidon4, poseidon5, poseidon8 } from 'poseidon-lite';

export const TREE_DEPTH = 16;
export const MAX_COUNTERPARTIES = 2 ** TREE_DEPTH;
export const CAPABILITY_TREE_DEPTH = 8;
export const MAX_CAPABILITIES = 2 ** CAPABILITY_TREE_DEPTH;

/** The order of the circuit's public inputs, which is the order the verifier takes them in. */
export const PUBLIC_SIGNALS = [
  'mandate',
  'termsCommitment',
  'oldCounter',
  'newCounter',
  'nullifier',
  'amount',
  'payee',
  'capabilityHi',
  'capabilityLo',
  'now',
  'nonce',
];

const big = (value) => BigInt(value);
const HALF = (1n << 128n) - 1n;

export function termsCommitment(terms) {
  return poseidon8([
    big(terms.perCallCap),
    big(terms.periodCap),
    big(terms.periodLen),
    big(terms.totalCap),
    big(terms.capabilityRoot),
    big(terms.counterpartyRoot),
    big(terms.expiry),
    big(terms.salt),
  ]);
}

export function counterCommitment(state, salt) {
  return poseidon5([big(state.period), big(state.spent), big(state.total), big(salt), big(state.nonce)]);
}

export function nullifierOf(salt, mandate, period, nonce) {
  return poseidon4([big(salt), big(mandate), big(period), big(nonce)]);
}

export const leafOf = (address) => poseidon1([big(address)]);

/** A 32-byte capability id as the two 128-bit halves the circuit takes it in. */
export function capabilityHalves(capabilityId) {
  const id = big(capabilityId);
  if (id < 0n || id >= 1n << 256n) throw new Error('a capability id is 32 bytes');
  return { hi: id >> 128n, lo: id & HALF };
}

export function capabilityLeafOf(capabilityId) {
  const { hi, lo } = capabilityHalves(capabilityId);
  return poseidon2([hi, lo]);
}

const zeroes = (() => {
  const levels = [0n];
  for (let i = 0; i < TREE_DEPTH; i++) levels.push(poseidon2([levels[i], levels[i]]));
  return levels;
})();

/**
 * A fixed-depth Poseidon tree over `values`, padded with zero leaves. Values are deduplicated and
 * sorted, so the root does not depend on the order a principal typed them in.
 */
function fixedTree(values, depth, leaf, [one, many]) {
  if (values.length === 0) throw new Error(`a committed mandate needs at least one ${one}`);
  const members = [...new Set(values.map((v) => big(v)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (members.length > 2 ** depth) throw new Error(`too many ${many}`);
  const layers = [members.map(leaf)];
  for (let level = 0; level < depth; level++) {
    const below = layers[level];
    const above = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(poseidon2([below[i], i + 1 < below.length ? below[i + 1] : zeroes[level]]));
    }
    layers.push(above);
  }
  const root = layers[depth][0];

  function proof(value) {
    let index = members.indexOf(big(value));
    if (index < 0) return null;
    const pathElements = [];
    const pathIndices = [];
    for (let level = 0; level < depth; level++) {
      const sibling = index ^ 1;
      const layer = layers[level];
      pathElements.push(sibling < layer.length ? layer[sibling] : zeroes[level]);
      pathIndices.push(index & 1);
      index >>= 1;
    }
    return { pathElements, pathIndices };
  }

  return { root, members, proof };
}

/** The counterparty tree: one leaf per payee address, Poseidon(address). */
export function counterpartyTree(addresses) {
  return fixedTree(addresses, TREE_DEPTH, (m) => poseidon1([m]), ['counterparty', 'counterparties']);
}

/** The capability tree: one leaf per 32-byte capability id, Poseidon(hi, lo). */
export function capabilityTree(capabilityIds) {
  return fixedTree(capabilityIds, CAPABILITY_TREE_DEPTH, capabilityLeafOf, ['capability', 'capabilities']);
}

export const initialCounter = (salt) => counterCommitment({ period: 0n, spent: 0n, total: 0n, nonce: 0n }, salt);

/**
 * Builds the full witness input for one spend and the state it leaves behind. Throws with a
 * reason when the spend cannot be proven, so a caller learns why before paying for a prover run.
 */
export function spendInput({ terms, counterparties, capabilities, state, mandate, payee, amount, capabilityId, now }) {
  const tree = counterpartyTree(counterparties);
  if (tree.root !== big(terms.counterpartyRoot)) throw new Error('counterparties do not match the committed root');
  const capabilityPaths = capabilityTree(capabilities);
  if (capabilityPaths.root !== big(terms.capabilityRoot)) throw new Error('capabilities do not match the committed root');
  const path = tree.proof(payee);
  if (!path) throw new Error('payee is not an allowed counterparty');
  const capabilityPath = capabilityPaths.proof(capabilityId);
  if (!capabilityPath) throw new Error('capability not allowed');

  const amt = big(amount);
  const at = big(now);
  const period = at / big(terms.periodLen);
  if (period < big(state.period)) throw new Error('time runs backwards');
  const carried = period === big(state.period) ? big(state.spent) : 0n;
  const next = { period, spent: carried + amt, total: big(state.total) + amt, nonce: big(state.nonce) + 1n };

  if (amt > big(terms.perCallCap)) throw new Error('over the per-call cap');
  if (next.spent > big(terms.periodCap)) throw new Error('over the period cap');
  if (next.total > big(terms.totalCap)) throw new Error('over the total budget');
  if (at > big(terms.expiry)) throw new Error('mandate expired');

  const { hi, lo } = capabilityHalves(capabilityId);
  const input = {
    mandate: big(mandate),
    termsCommitment: termsCommitment(terms),
    oldCounter: counterCommitment(state, terms.salt),
    newCounter: counterCommitment(next, terms.salt),
    nullifier: nullifierOf(terms.salt, mandate, period, state.nonce),
    amount: amt,
    payee: big(payee),
    capabilityHi: hi,
    capabilityLo: lo,
    now: at,
    nonce: big(state.nonce),
    perCallCap: big(terms.perCallCap),
    periodCap: big(terms.periodCap),
    periodLen: big(terms.periodLen),
    totalCap: big(terms.totalCap),
    capabilityRoot: big(terms.capabilityRoot),
    counterpartyRoot: big(terms.counterpartyRoot),
    expiry: big(terms.expiry),
    salt: big(terms.salt),
    oldPeriod: big(state.period),
    oldSpent: big(state.spent),
    oldTotal: big(state.total),
    pathElements: path.pathElements,
    pathIndices: path.pathIndices.map(big),
    capabilityPathElements: capabilityPath.pathElements,
    capabilityPathIndices: capabilityPath.pathIndices.map(big),
  };
  return { input, next };
}

function walk(leaf, path, depth) {
  let node = leaf;
  for (let i = 0; i < depth; i++) {
    const sibling = big(path.pathElements[i]);
    node = Number(path.pathIndices[i]) === 1 ? poseidon2([sibling, node]) : poseidon2([node, sibling]);
  }
  return node;
}

export function rootFromPath(address, path) {
  return walk(leafOf(address), path, TREE_DEPTH);
}

export function capabilityRootFromPath(capabilityId, path) {
  return walk(capabilityLeafOf(capabilityId), path, CAPABILITY_TREE_DEPTH);
}
