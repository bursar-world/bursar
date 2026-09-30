export declare const TREE_DEPTH: 16;
export declare const MAX_COUNTERPARTIES: number;
export declare const CAPABILITY_TREE_DEPTH: 8;
export declare const MAX_CAPABILITIES: number;

export declare const PUBLIC_SIGNALS: readonly [
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

type Numeric = bigint | number | string;

/** The committed terms. Every field is private to the principal and the agent. */
export type CommittedTerms = {
  perCallCap: Numeric;
  periodCap: Numeric;
  periodLen: Numeric;
  totalCap: Numeric;
  capabilityRoot: Numeric;
  counterpartyRoot: Numeric;
  expiry: Numeric;
  salt: Numeric;
};

/** The confidential counter: spend in the current period, lifetime spend, and how many proofs. */
export type CounterState = {
  period: Numeric;
  spent: Numeric;
  total: Numeric;
  nonce: Numeric;
};

export type MerklePath = { pathElements: bigint[]; pathIndices: number[] };

export type FixedTree = {
  root: bigint;
  members: bigint[];
  proof(value: Numeric): MerklePath | null;
};

export declare function termsCommitment(terms: CommittedTerms): bigint;
export declare function counterCommitment(state: CounterState, salt: Numeric): bigint;
export declare function nullifierOf(salt: Numeric, mandate: Numeric, period: Numeric, nonce: Numeric): bigint;
export declare function leafOf(address: Numeric): bigint;
export declare function capabilityHalves(capabilityId: Numeric): { hi: bigint; lo: bigint };
export declare function capabilityLeafOf(capabilityId: Numeric): bigint;
export declare function initialCounter(salt: Numeric): bigint;
export declare function counterpartyTree(addresses: readonly Numeric[]): FixedTree;
export declare function capabilityTree(capabilityIds: readonly Numeric[]): FixedTree;

export type SpendInput = Record<string, bigint | bigint[]>;

export declare function spendInput(args: {
  terms: CommittedTerms;
  counterparties: readonly Numeric[];
  capabilities: readonly Numeric[];
  state: CounterState;
  mandate: Numeric;
  payee: Numeric;
  amount: Numeric;
  capabilityId: Numeric;
  now: Numeric;
}): {
  input: SpendInput;
  next: { period: bigint; spent: bigint; total: bigint; nonce: bigint };
};

export declare function rootFromPath(
  address: Numeric,
  path: { pathElements: readonly Numeric[]; pathIndices: readonly Numeric[] },
): bigint;

export declare function capabilityRootFromPath(
  capabilityId: Numeric,
  path: { pathElements: readonly Numeric[]; pathIndices: readonly Numeric[] },
): bigint;
