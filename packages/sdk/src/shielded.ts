/**
 * The shielded USDG pool: Privacy Pools v1.3.0 (0xbow, Apache-2.0) deployed for USDG on Robinhood
 * Chain, with Bursar's association-set provider, relay contract and relayer.
 *
 * A deposit is public: the depositor and the amount are on chain. What it creates is a note, a
 * Poseidon commitment to (value, label, precommitment), where only the depositor knows the
 * nullifier and secret behind the precommitment. Withdrawing proves in zero knowledge that the
 * withdrawer knows the secrets of some note in the pool whose label is in the association set,
 * without saying which. The withdrawal is submitted by the relayer, so the transaction that pays
 * the recipient carries no trace of the depositor's wallet. Whatever is not withdrawn stays in the
 * pool as a new note owned by the same secrets.
 *
 * The note secrets are derived from the funds-key signature (EIP-712, bound to the wallet and the
 * chain; see `viewing-key.ts`), never from the viewing key, so a wallet that signs deterministically
 * recovers every note from chain data alone and a shared viewing key opens no note. Each note's
 * secrets also hash in the pool's scope, so one funds key serves every pool.
 *
 * This module has no Node dependency and no prover. Proving lives in `@bursar/sdk/shielded-prove`
 * so the 17 MB proving key is only loaded where a proof is actually made.
 */

import { LeanIMT } from '@zk-kit/lean-imt';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import {
  bytesToHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hexToBytes,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { FUNDS_SALT, fundsKeyMaterial, type FundsKeyContext } from './viewing-key.js';

export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** The withdrawal circuit is compiled for trees up to this depth; proofs pad their siblings to it. */
export const SHIELDED_TREE_DEPTH = 32;
/** The Robinhood Chain access registry. Its `isBlocked` screens the association set and every payout. */
export const ACCESS_REGISTRY: Address = '0xe10b6f6B275de231345c20D14Ab812db62151b00';

// ---------------------------------------------------------------------------------------------
// ABIs (the subset of the upstream interfaces this SDK calls, plus ShieldedPool and ShieldedRelay)
// ---------------------------------------------------------------------------------------------

const withdrawalTuple = {
  name: 'withdrawal',
  type: 'tuple',
  components: [
    { name: 'processooor', type: 'address' },
    { name: 'data', type: 'bytes' },
  ],
} as const;

const withdrawProofTuple = {
  name: 'proof',
  type: 'tuple',
  components: [
    { name: 'pA', type: 'uint256[2]' },
    { name: 'pB', type: 'uint256[2][2]' },
    { name: 'pC', type: 'uint256[2]' },
    { name: 'pubSignals', type: 'uint256[8]' },
  ],
} as const;

const ragequitProofTuple = {
  name: 'proof',
  type: 'tuple',
  components: [
    { name: 'pA', type: 'uint256[2]' },
    { name: 'pB', type: 'uint256[2][2]' },
    { name: 'pC', type: 'uint256[2]' },
    { name: 'pubSignals', type: 'uint256[4]' },
  ],
} as const;

export const shieldedEntrypointAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_asset', type: 'address' },
      { name: '_value', type: 'uint256' },
      { name: '_precommitment', type: 'uint256' },
    ],
    outputs: [{ name: '_commitment', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'updateRoot',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_root', type: 'uint256' },
      { name: '_ipfsCID', type: 'string' },
    ],
    outputs: [{ name: '_index', type: 'uint256' }],
  },
  { type: 'function', name: 'latestRoot', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'associationSets',
    stateMutability: 'view',
    inputs: [{ name: '_index', type: 'uint256' }],
    outputs: [
      { name: '_root', type: 'uint256' },
      { name: '_ipfsCID', type: 'string' },
      { name: '_timestamp', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'assetConfig',
    stateMutability: 'view',
    inputs: [{ name: '_asset', type: 'address' }],
    outputs: [
      { name: '_pool', type: 'address' },
      { name: '_minimumDepositAmount', type: 'uint256' },
      { name: '_vettingFeeBPS', type: 'uint256' },
      { name: '_maxRelayFeeBPS', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'usedPrecommitments',
    stateMutability: 'view',
    inputs: [{ name: '_precommitment', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'RootUpdated',
    inputs: [
      { name: '_root', type: 'uint256', indexed: false },
      { name: '_ipfsCID', type: 'string', indexed: false },
      { name: '_timestamp', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: '_depositor', type: 'address', indexed: true },
      { name: '_pool', type: 'address', indexed: true },
      { name: '_commitment', type: 'uint256', indexed: false },
      { name: '_amount', type: 'uint256', indexed: false },
    ],
  },
  { type: 'error', name: 'NoRootsAvailable', inputs: [] },
  { type: 'error', name: 'MinimumDepositAmount', inputs: [] },
  { type: 'error', name: 'PrecommitmentAlreadyUsed', inputs: [] },
  { type: 'error', name: 'PoolNotFound', inputs: [] },
  { type: 'error', name: 'InvalidIPFSCIDLength', inputs: [] },
  { type: 'error', name: 'EmptyRoot', inputs: [] },
] as const;

export const shieldedPoolAbi = [
  { type: 'function', name: 'SCOPE', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ASSET', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'ENTRYPOINT', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'MAX_DEPOSIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MAX_TOTAL', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ACCESS_REGISTRY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'poolValue', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'currentRoot', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'currentTreeSize', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'currentTreeDepth', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'dead', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    type: 'function',
    name: 'nullifierHashes',
    stateMutability: 'view',
    inputs: [{ name: '_nullifierHash', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'depositors',
    stateMutability: 'view',
    inputs: [{ name: '_label', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'ragequit',
    stateMutability: 'nonpayable',
    inputs: [ragequitProofTuple],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [withdrawalTuple, withdrawProofTuple],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: '_depositor', type: 'address', indexed: true },
      { name: '_commitment', type: 'uint256', indexed: false },
      { name: '_label', type: 'uint256', indexed: false },
      { name: '_value', type: 'uint256', indexed: false },
      { name: '_precommitmentHash', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { name: '_processooor', type: 'address', indexed: true },
      { name: '_value', type: 'uint256', indexed: false },
      { name: '_spentNullifier', type: 'uint256', indexed: false },
      { name: '_newCommitment', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Ragequit',
    inputs: [
      { name: '_ragequitter', type: 'address', indexed: true },
      { name: '_commitment', type: 'uint256', indexed: false },
      { name: '_label', type: 'uint256', indexed: false },
      { name: '_value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LeafInserted',
    inputs: [
      { name: '_index', type: 'uint256', indexed: false },
      { name: '_leaf', type: 'uint256', indexed: false },
      { name: '_root', type: 'uint256', indexed: false },
    ],
  },
  { type: 'error', name: 'DepositAboveCap', inputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'error', name: 'PoolCapReached', inputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'error', name: 'RecipientBlocked', inputs: [{ name: 'recipient', type: 'address' }] },
  { type: 'error', name: 'RelayThroughShieldedRelay', inputs: [] },
  { type: 'error', name: 'InvalidProof', inputs: [] },
  { type: 'error', name: 'InvalidCommitment', inputs: [] },
  { type: 'error', name: 'InvalidProcessooor', inputs: [] },
  { type: 'error', name: 'InvalidTreeDepth', inputs: [] },
  { type: 'error', name: 'ContextMismatch', inputs: [] },
  { type: 'error', name: 'UnknownStateRoot', inputs: [] },
  { type: 'error', name: 'IncorrectASPRoot', inputs: [] },
  { type: 'error', name: 'OnlyOriginalDepositor', inputs: [] },
  { type: 'error', name: 'NullifierAlreadySpent', inputs: [] },
  { type: 'error', name: 'PoolIsDead', inputs: [] },
] as const;

export const shieldedRelayAbi = [
  { type: 'function', name: 'POOL', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'ENTRYPOINT', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'MAX_FEE_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'relay',
    stateMutability: 'payable',
    inputs: [withdrawalTuple, withdrawProofTuple],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Relayed',
    inputs: [
      { name: 'relayer', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'gasDrop', type: 'uint256', indexed: false },
    ],
  },
  { type: 'error', name: 'RecipientBlocked', inputs: [{ name: 'recipient', type: 'address' }] },
  { type: 'error', name: 'InvalidRecipient', inputs: [{ name: 'recipient', type: 'address' }] },
  { type: 'error', name: 'FeeAboveMax', inputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'error', name: 'InvalidProcessooor', inputs: [] },
  { type: 'error', name: 'InvalidWithdrawalAmount', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'GasDropFailed', inputs: [] },
  ...shieldedPoolAbi.filter((x) => x.type === 'error' && x.name !== 'RecipientBlocked'),
] as const;

export const accessRegistryAbi = [
  {
    type: 'function',
    name: 'isBlocked',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

/** `keccak256('ASP_POSTMAN')`, the Entrypoint role allowed to post association-set roots. */
export const ASP_POSTMAN_ROLE: Hex = '0xfc84ade01695dae2ade01aa4226dc40bdceaf9d5dbd3bf8630b1dd5af195bbc5';

// ---------------------------------------------------------------------------------------------
// Keys and notes
// ---------------------------------------------------------------------------------------------

export type ShieldedKeys = { readonly masterNullifier: bigint; readonly masterSecret: bigint };

function fieldKey(ikm: Uint8Array, salt: Uint8Array, info: string): bigint {
  // 48 bytes reduced mod p leaves a bias of about 2^-130; hashing once more matches upstream,
  // which keeps its master keys as Poseidon images of a wallet-derived scalar.
  const wide = BigInt(bytesToHex(hkdf(sha256, ikm, salt, info, 48)));
  return poseidon1([wide % SNARK_SCALAR_FIELD]);
}

/**
 * The note master keys, from the funds-key signature (`fundsKeyTypedData`). A signature that does
 * not recover to `context.account` over that typed data is refused, the viewing-key signature
 * included. They are separate HKDF outputs from the stealth spending key.
 */
export function deriveShieldedKeys(signature: Hex, context: FundsKeyContext): ShieldedKeys {
  const ikm = fundsKeyMaterial(signature, context);
  return {
    masterNullifier: fieldKey(ikm, FUNDS_SALT, 'shielded-nullifier'),
    masterSecret: fieldKey(ikm, FUNDS_SALT, 'shielded-secret'),
  };
}

const LEGACY_SALT = new TextEncoder().encode('bursar.viewing-key.v1');

/**
 * The note keys of the first pool, which came from the viewing-key signature. Only for taking
 * those notes back out (scripts/migrate-shielded-notes.ts); nothing new is deposited under them.
 */
export function deriveLegacyShieldedKeys(viewingSignature: Hex): ShieldedKeys {
  const ikm = hexToBytes(viewingSignature);
  if (ikm.length < 64) throw new Error('Shielded keys need a full wallet signature.');
  return {
    masterNullifier: fieldKey(ikm, LEGACY_SALT, 'shielded-nullifier'),
    masterSecret: fieldKey(ikm, LEGACY_SALT, 'shielded-secret'),
  };
}

export type NoteSecrets = { readonly nullifier: bigint; readonly secret: bigint };

/** Secrets for the `index`-th deposit into a pool. Same derivation as the upstream SDK. */
export function depositSecrets(keys: ShieldedKeys, scope: bigint, index: bigint): NoteSecrets {
  return {
    nullifier: poseidon3([keys.masterNullifier, scope, index]),
    secret: poseidon3([keys.masterSecret, scope, index]),
  };
}

/** Secrets for the note left behind by the `index`-th withdrawal from a deposit's lineage. */
export function changeSecrets(keys: ShieldedKeys, label: bigint, index: bigint): NoteSecrets {
  return {
    nullifier: poseidon3([keys.masterNullifier, label, index]),
    secret: poseidon3([keys.masterSecret, label, index]),
  };
}

export const precommitmentOf = (s: NoteSecrets): bigint => poseidon2([s.nullifier, s.secret]);
export const nullifierHashOf = (nullifier: bigint): bigint => poseidon1([nullifier]);
export const commitmentOf = (value: bigint, label: bigint, precommitment: bigint): bigint =>
  poseidon3([value, label, precommitment]);

/** The label the pool assigns to its `nonce`-th deposit: keccak256(scope, nonce) mod p. */
export function labelOf(scope: bigint, nonce: bigint): bigint {
  return BigInt(keccak256(encodePacked(['uint256', 'uint256'], [scope, nonce]))) % SNARK_SCALAR_FIELD;
}

/** The pool scope: keccak256(pool, chainId, asset) mod p. */
export function scopeOf(pool: Address, chainId: number, asset: Address): bigint {
  return (
    BigInt(keccak256(encodePacked(['address', 'uint256', 'address'], [pool, BigInt(chainId), asset]))) %
    SNARK_SCALAR_FIELD
  );
}

export type Note = NoteSecrets & {
  readonly value: bigint;
  readonly label: bigint;
  readonly commitment: bigint;
};

export function noteOf(value: bigint, label: bigint, secrets: NoteSecrets): Note {
  return { ...secrets, value, label, commitment: commitmentOf(value, label, precommitmentOf(secrets)) };
}

// ---------------------------------------------------------------------------------------------
// Lean incremental Merkle trees (the pool's state tree and the association set)
// ---------------------------------------------------------------------------------------------

export type LeanProof = {
  readonly root: bigint;
  readonly depth: number;
  readonly index: number;
  /** Padded with zeros to SHIELDED_TREE_DEPTH, as the circuit expects. */
  readonly siblings: readonly bigint[];
};

const hash2 = (a: bigint, b: bigint): bigint => poseidon2([a, b]);

export function leanTree(leaves: readonly bigint[]): LeanIMT<bigint> {
  const tree = new LeanIMT<bigint>(hash2);
  if (leaves.length > 0) tree.insertMany([...leaves]);
  return tree;
}

export function leanRoot(leaves: readonly bigint[]): bigint {
  return leaves.length === 0 ? 0n : leanTree(leaves).root;
}

export function leanProof(leaves: readonly bigint[], leaf: bigint): LeanProof {
  const tree = leanTree(leaves);
  const index = tree.indexOf(leaf);
  if (index < 0) throw new Error('The leaf is not in the tree.');
  const proof = tree.generateProof(index);
  const siblings = [...proof.siblings];
  while (siblings.length < SHIELDED_TREE_DEPTH) siblings.push(0n);
  return { root: proof.root, depth: tree.depth, index: proof.index, siblings };
}

// ---------------------------------------------------------------------------------------------
// Withdrawal data and context
// ---------------------------------------------------------------------------------------------

export type Withdrawal = { readonly processooor: Address; readonly data: Hex };
export type RelayData = { readonly recipient: Address; readonly feeRecipient: Address; readonly relayFeeBPS: bigint };

const relayDataParams = [
  {
    type: 'tuple',
    components: [
      { name: 'recipient', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'relayFeeBPS', type: 'uint256' },
    ],
  },
] as const;

export function encodeRelayData(data: RelayData): Hex {
  return encodeAbiParameters(relayDataParams, [data]);
}

export function decodeRelayData(data: Hex): RelayData {
  const [d] = decodeAbiParameters(relayDataParams, data);
  return { recipient: getAddress(d.recipient), feeRecipient: getAddress(d.feeRecipient), relayFeeBPS: d.relayFeeBPS };
}

/** keccak256(abi.encode(withdrawal, scope)) mod p, the value the proof binds the payout to. */
export function withdrawalContext(withdrawal: Withdrawal, scope: bigint): bigint {
  return (
    BigInt(
      keccak256(
        encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [
                { name: 'processooor', type: 'address' },
                { name: 'data', type: 'bytes' },
              ],
            },
            { type: 'uint256' },
          ],
          [withdrawal, scope],
        ),
      ),
    ) % SNARK_SCALAR_FIELD
  );
}

/** Circuit inputs for spending `amount` from `note`; the rest stays in the pool as `change`. */
export function withdrawInput(args: {
  note: Note;
  amount: bigint;
  change: NoteSecrets;
  stateLeaves: readonly bigint[];
  aspLabels: readonly bigint[];
  context: bigint;
}): { input: Record<string, string | string[]>; change: Note } {
  const { note, amount, change } = args;
  if (amount <= 0n) throw new Error('A withdrawal needs a positive amount.');
  if (amount > note.value) throw new Error(`The note holds ${note.value}; cannot withdraw ${amount}.`);
  if (change.nullifier === note.nullifier) throw new Error('The change note needs a fresh nullifier.');
  const state = leanProof(args.stateLeaves, note.commitment);
  let asp: LeanProof;
  try {
    asp = leanProof(args.aspLabels, note.label);
  } catch {
    throw new Error('This deposit is not in the association set yet, so it can only be ragequit for now.');
  }
  const s = (v: bigint) => v.toString();
  return {
    input: {
      withdrawnValue: s(amount),
      stateRoot: s(state.root),
      stateTreeDepth: s(BigInt(state.depth)),
      ASPRoot: s(asp.root),
      ASPTreeDepth: s(BigInt(asp.depth)),
      context: s(args.context),
      label: s(note.label),
      existingValue: s(note.value),
      existingNullifier: s(note.nullifier),
      existingSecret: s(note.secret),
      newNullifier: s(change.nullifier),
      newSecret: s(change.secret),
      stateSiblings: state.siblings.map(s),
      stateIndex: s(BigInt(state.index)),
      ASPSiblings: asp.siblings.map(s),
      ASPIndex: s(BigInt(asp.index)),
    },
    change: noteOf(note.value - amount, note.label, change),
  };
}

export function ragequitInput(note: Note): Record<string, string> {
  return {
    value: note.value.toString(),
    label: note.label.toString(),
    nullifier: note.nullifier.toString(),
    secret: note.secret.toString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Proofs in the shape the contracts take
// ---------------------------------------------------------------------------------------------

export type SolidityProof<N extends number = number> = {
  readonly pA: readonly [bigint, bigint];
  readonly pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  readonly pC: readonly [bigint, bigint];
  readonly pubSignals: readonly bigint[] & { length: N };
};

export type SnarkjsProof = {
  pi_a: readonly string[];
  pi_b: readonly (readonly string[])[];
  pi_c: readonly string[];
};

/** snarkjs output to the verifier's calldata layout (G2 coordinates in imaginary, real order). */
export function toSolidityProof(proof: SnarkjsProof, publicSignals: readonly string[]): SolidityProof {
  const n = (v: string | undefined) => BigInt(v ?? 0);
  return {
    pA: [n(proof.pi_a[0]), n(proof.pi_a[1])],
    pB: [
      [n(proof.pi_b[0]?.[1]), n(proof.pi_b[0]?.[0])],
      [n(proof.pi_b[1]?.[1]), n(proof.pi_b[1]?.[0])],
    ],
    pC: [n(proof.pi_c[0]), n(proof.pi_c[1])],
    pubSignals: publicSignals.map(n),
  };
}

/** JSON-safe form, for the relayer API. */
export type WireProof = { pA: string[]; pB: string[][]; pC: string[]; pubSignals: string[] };

export function proofToWire(p: SolidityProof): WireProof {
  const s = (v: bigint) => v.toString();
  return { pA: p.pA.map(s), pB: p.pB.map((r) => r.map(s)), pC: p.pC.map(s), pubSignals: p.pubSignals.map(s) };
}

export function proofFromWire(w: WireProof): SolidityProof {
  const b = (v: unknown) => {
    if (typeof v !== 'string' || !/^\d{1,78}$/.test(v)) throw new Error('A proof element is not a decimal field element.');
    const n = BigInt(v);
    if (n >= SNARK_SCALAR_FIELD * 8n) throw new Error('A proof element is out of range.');
    return n;
  };
  if (!Array.isArray(w?.pA) || w.pA.length !== 2) throw new Error('pA must hold two elements.');
  if (!Array.isArray(w.pB) || w.pB.length !== 2 || w.pB.some((r) => !Array.isArray(r) || r.length !== 2)) {
    throw new Error('pB must be 2 by 2.');
  }
  if (!Array.isArray(w.pC) || w.pC.length !== 2) throw new Error('pC must hold two elements.');
  if (!Array.isArray(w.pubSignals)) throw new Error('pubSignals must be a list.');
  return {
    pA: [b(w.pA[0]), b(w.pA[1])],
    pB: [
      [b(w.pB[0]![0]), b(w.pB[0]![1])],
      [b(w.pB[1]![0]), b(w.pB[1]![1])],
    ],
    pC: [b(w.pC[0]), b(w.pC[1])],
    pubSignals: w.pubSignals.map(b),
  };
}

/** Public signals of a withdrawal proof, by name. */
export function withdrawSignals(p: SolidityProof) {
  const s = p.pubSignals;
  if (s.length !== 8) throw new Error('A withdrawal proof has eight public signals.');
  return {
    newCommitmentHash: s[0]!,
    existingNullifierHash: s[1]!,
    withdrawnValue: s[2]!,
    stateRoot: s[3]!,
    stateTreeDepth: s[4]!,
    ASPRoot: s[5]!,
    ASPTreeDepth: s[6]!,
    context: s[7]!,
  };
}

// ---------------------------------------------------------------------------------------------
// Chain data
// ---------------------------------------------------------------------------------------------

export type PoolDeposit = {
  readonly depositor: Address;
  readonly commitment: bigint;
  readonly label: bigint;
  readonly value: bigint;
  readonly precommitment: bigint;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
};
export type PoolWithdrawal = {
  readonly processooor: Address;
  readonly value: bigint;
  readonly spentNullifier: bigint;
  readonly newCommitment: bigint;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
};
export type PoolRagequit = {
  readonly ragequitter: Address;
  readonly commitment: bigint;
  readonly label: bigint;
  readonly value: bigint;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
};
export type PoolEvents = {
  readonly deposits: readonly PoolDeposit[];
  readonly withdrawals: readonly PoolWithdrawal[];
  readonly ragequits: readonly PoolRagequit[];
  /** Every commitment in the state tree, in insertion order. */
  readonly leaves: readonly bigint[];
  readonly toBlock: bigint;
};

type LogClient = Pick<PublicClient, 'getLogs' | 'getBlockNumber'>;

/**
 * Every pool event between two blocks. Public endpoints cap the range of one log query, so this
 * walks in chunks and halves a chunk the endpoint refuses.
 */
export async function fetchPoolEvents(
  client: LogClient,
  options: { pool: Address; fromBlock: bigint; toBlock?: bigint; chunk?: bigint },
): Promise<PoolEvents> {
  const last = options.toBlock ?? (await client.getBlockNumber());
  let chunk = options.chunk ?? 5_000_000n;
  const logs: Awaited<ReturnType<LogClient['getLogs']>> = [];
  let from = options.fromBlock;
  while (from <= last) {
    const to = from + chunk - 1n < last ? from + chunk - 1n : last;
    try {
      logs.push(...(await client.getLogs({ address: options.pool, fromBlock: from, toBlock: to })));
    } catch (error) {
      if (chunk <= 1_000n) throw error;
      chunk /= 2n;
      continue;
    }
    from = to + 1n;
  }
  const parsed = parseEventLogs({ abi: shieldedPoolAbi, logs: logs as never, strict: true }).sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  const deposits: PoolDeposit[] = [];
  const withdrawals: PoolWithdrawal[] = [];
  const ragequits: PoolRagequit[] = [];
  const leaves: bigint[] = [];
  for (const log of parsed) {
    if (log.eventName === 'Deposited') {
      deposits.push({
        depositor: getAddress(log.args._depositor),
        commitment: log.args._commitment,
        label: log.args._label,
        value: log.args._value,
        precommitment: log.args._precommitmentHash,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      });
    } else if (log.eventName === 'Withdrawn') {
      withdrawals.push({
        processooor: getAddress(log.args._processooor),
        value: log.args._value,
        spentNullifier: log.args._spentNullifier,
        newCommitment: log.args._newCommitment,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      });
    } else if (log.eventName === 'Ragequit') {
      ragequits.push({
        ragequitter: getAddress(log.args._ragequitter),
        commitment: log.args._commitment,
        label: log.args._label,
        value: log.args._value,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      });
    } else if (log.eventName === 'LeafInserted') {
      const index = Number(log.args._index);
      if (index !== leaves.length + 1) {
        throw new Error(`Pool leaf ${index} arrived after ${leaves.length}; the log range has a gap.`);
      }
      leaves.push(log.args._leaf);
    }
  }
  return { deposits, withdrawals, ragequits, leaves, toBlock: last };
}

// ---------------------------------------------------------------------------------------------
// The association set
// ---------------------------------------------------------------------------------------------

export type AssociationSet = {
  readonly version: 1;
  readonly chainId: number;
  readonly pool: Address;
  readonly scope: string;
  /** Deposit labels admitted, in deposit order, as decimal strings. */
  readonly labels: readonly string[];
  /** Deposits left out, with the reason. */
  readonly excluded: readonly { readonly label: string; readonly reason: 'blocked' }[];
  readonly root: string;
  readonly depth: number;
  /** The last block whose deposits were considered. */
  readonly throughBlock: string;
};

/**
 * Bursar's association-set rule: every deposit whose depositor the Robinhood access registry does
 * not block, in deposit order. The ASP service posts this root; anyone can recompute it from the
 * pool's events and the registry and compare.
 */
export function buildAssociationSet(args: {
  chainId: number;
  pool: Address;
  scope: bigint;
  deposits: readonly PoolDeposit[];
  blocked: ReadonlySet<Address>;
  throughBlock: bigint;
}): AssociationSet {
  const labels: bigint[] = [];
  const excluded: { label: string; reason: 'blocked' }[] = [];
  for (const d of args.deposits) {
    if (args.blocked.has(getAddress(d.depositor))) excluded.push({ label: d.label.toString(), reason: 'blocked' });
    else labels.push(d.label);
  }
  return {
    version: 1,
    chainId: args.chainId,
    pool: getAddress(args.pool),
    scope: args.scope.toString(),
    labels: labels.map(String),
    excluded,
    root: leanRoot(labels).toString(),
    depth: labels.length === 0 ? 0 : leanTree(labels).depth,
    throughBlock: args.throughBlock.toString(),
  };
}

/** Which depositors the registry blocks right now. One call per distinct depositor. */
export async function blockedDepositors(
  client: Pick<PublicClient, 'readContract'>,
  depositors: Iterable<Address>,
  registry: Address = ACCESS_REGISTRY,
): Promise<Set<Address>> {
  const unique = [...new Set([...depositors].map((a) => getAddress(a)))];
  const flags = await Promise.all(
    unique.map((account) => client.readContract({ address: registry, abi: accessRegistryAbi, functionName: 'isBlocked', args: [account] })),
  );
  return new Set(unique.filter((_, i) => flags[i]));
}

/** The canonical bytes of a set document: sorted keys, no whitespace. */
export function associationSetBytes(set: AssociationSet): Uint8Array {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
        : v;
  return new TextEncoder().encode(JSON.stringify(canonical(set)));
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The CIDv1 (raw codec, sha2-256) of a set document, base32. It is the content address of exactly
 * those bytes, so it can be pinned to IPFS as is, and it is what the Entrypoint stores beside the
 * root (the upstream contract takes a 32 to 64 character CID).
 */
export function associationSetCid(set: AssociationSet): string {
  const digest = sha256(associationSetBytes(set));
  return `b${base32(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}

// ---------------------------------------------------------------------------------------------
// Recovering notes from chain data
// ---------------------------------------------------------------------------------------------

export type OwnedNote = Note & {
  /** The deposit this lineage started from. */
  readonly deposit: PoolDeposit;
  readonly depositIndex: bigint;
  /** Withdrawals made from this lineage so far; the next change note uses this index. */
  readonly withdrawals: number;
  readonly status: 'spendable' | 'empty' | 'ragequit';
};

/**
 * Every deposit made with these keys and the note each lineage now holds. Stops at `gap`
 * consecutive unused deposit indices.
 */
export function recoverNotes(args: { keys: ShieldedKeys; scope: bigint; events: PoolEvents; gap?: number }): {
  notes: OwnedNote[];
  nextDepositIndex: bigint;
} {
  const { keys, scope, events } = args;
  const gap = args.gap ?? 5;
  const byPrecommitment = new Map(events.deposits.map((d) => [d.precommitment, d]));
  const bySpent = new Map(events.withdrawals.map((w) => [w.spentNullifier, w]));
  const ragequitByLabel = new Map(events.ragequits.map((r) => [r.label, r]));
  const notes: OwnedNote[] = [];
  let misses = 0;
  let nextDepositIndex = -1n;
  for (let i = 0n; misses < gap; i++) {
    const secrets = depositSecrets(keys, scope, i);
    const deposit = byPrecommitment.get(precommitmentOf(secrets));
    if (!deposit) {
      if (nextDepositIndex < 0n) nextDepositIndex = i;
      misses++;
      continue;
    }
    misses = 0;
    let note = noteOf(deposit.value, deposit.label, secrets);
    if (note.commitment !== deposit.commitment) continue;
    let count = 0;
    for (;;) {
      const w = bySpent.get(nullifierHashOf(note.nullifier));
      if (!w) break;
      const next = noteOf(note.value - w.value, note.label, changeSecrets(keys, note.label, BigInt(count)));
      if (next.commitment !== w.newCommitment) break;
      note = next;
      count++;
    }
    const rq = ragequitByLabel.get(note.label);
    const status = rq && rq.commitment === note.commitment ? 'ragequit' : note.value === 0n ? 'empty' : 'spendable';
    notes.push({ ...note, deposit, depositIndex: i, withdrawals: count, status });
  }
  return { notes, nextDepositIndex: nextDepositIndex < 0n ? 0n : nextDepositIndex };
}

// ---------------------------------------------------------------------------------------------
// Service APIs (services/asp and services/relayer)
// ---------------------------------------------------------------------------------------------

export type RelayQuote = {
  readonly relay: Address;
  readonly feeRecipient: Address;
  readonly feeBps: number;
  /** Wei the relayer sends the recipient with the withdrawal, when asked for gas and it is an EOA. */
  readonly gasDropWei: string;
  readonly chainId: number;
};

export type RelayRequest = {
  readonly withdrawal: Withdrawal;
  readonly proof: WireProof;
  /** Ask the relayer to send gas along to the recipient. */
  readonly gasDrop?: boolean;
};

export type RelayResult = { readonly transactionHash: Hex; readonly gasDropWei: string };

/** A refusal from the relayer or the association-set provider, with the code it answered with. */
export class ShieldedServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ShieldedServiceError';
  }
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
  if (!response.ok) {
    throw new ShieldedServiceError(response.status, body.error ?? 'http_error', body.detail ?? body.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

/**
 * Whether a relayer turned a withdrawal away because a root its proof was made against has moved:
 * the association set is no longer the newest, or the pool's state root has aged out of the recent
 * roots it keeps. Nothing was spent, and a proof made against the roots as they stand now can go
 * through.
 */
export function isStaleSetRefusal(error: unknown): boolean {
  return (
    error instanceof ShieldedServiceError &&
    (error.code === 'stale_association_set' ||
      (error.code === 'would_revert' && /\b(IncorrectASPRoot|UnknownStateRoot)\b/u.test(error.message)))
  );
}

export async function fetchRelayQuote(relayerUrl: string, init?: RequestInit): Promise<RelayQuote> {
  return json(await fetch(new URL('/v1/quote', relayerUrl), init));
}

export async function submitRelay(relayerUrl: string, request: RelayRequest): Promise<RelayResult> {
  return json(
    await fetch(new URL('/v1/relay', relayerUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
}

export async function fetchAssociationSet(aspUrl: string): Promise<AssociationSet & { cid: string }> {
  return json(await fetch(new URL('/v1/association-set', aspUrl)));
}

/**
 * Proves a withdrawal and hands it to the relayer. The provider posts new roots on its own cadence
 * and deposits move the pool's own root, and a root that moves between the proof and the submission
 * makes the pool refuse the proof, so on that refusal `prove` runs again (it should read the pool
 * and the set afresh) and the new proof is submitted, up to `attempts` times in all. Nothing is
 * spent by a refused submission.
 */
export async function relayWithFreshProof(args: {
  readonly relayerUrl: string;
  readonly withdrawal: Withdrawal;
  readonly gasDrop?: boolean;
  readonly prove: (attempt: number) => Promise<SolidityProof>;
  readonly attempts?: number;
}): Promise<RelayResult> {
  const attempts = args.attempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const proof = await args.prove(attempt);
    try {
      return await submitRelay(args.relayerUrl, {
        withdrawal: args.withdrawal,
        proof: proofToWire(proof),
        ...(args.gasDrop === undefined ? {} : { gasDrop: args.gasDrop }),
      });
    } catch (error) {
      if (!isStaleSetRefusal(error) || attempt >= attempts) throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// A shielded balance handed to an agent
// ---------------------------------------------------------------------------------------------

export const SHIELDED_KEYS_KIND = 'bursar-shielded-keys';

export type ShieldedKeyFile = {
  readonly kind: typeof SHIELDED_KEYS_KIND;
  readonly version: 1;
  readonly chainId: number;
  readonly pool: Address;
  readonly masterNullifier: string;
  readonly masterSecret: string;
};

/**
 * Fresh random note keys for a float of its own. Deposit into the pool with them from the owner's
 * wallet (`depositSecrets(keys, scope, i)`), then hand the agent the file: it can spend exactly
 * those deposits, and only the depositing wallet can ragequit them.
 */
export function randomShieldedKeys(): ShieldedKeys {
  const field = () => {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(48));
    return poseidon1([BigInt(bytesToHex(bytes)) % SNARK_SCALAR_FIELD]);
  };
  return { masterNullifier: field(), masterSecret: field() };
}

/** The file `@bursar/mcp` reads from BURSAR_SHIELDED_KEY_FILE. Whoever holds it can spend the balance. */
export function shieldedKeyFile(keys: ShieldedKeys, pool: Address, chainId: number): ShieldedKeyFile {
  return {
    kind: SHIELDED_KEYS_KIND,
    version: 1,
    chainId,
    pool: getAddress(pool),
    masterNullifier: keys.masterNullifier.toString(),
    masterSecret: keys.masterSecret.toString(),
  };
}
