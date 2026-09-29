export declare const TREE_DEPTH: 16;
export declare const MAX_COUNTERPARTIES: number;

export declare const PUBLIC_SIGNALS: readonly [
  'mandate',
  'termsCommitment',
  'oldCounter',
  'newCounter',
  'nullifier',
  'amount',
  'payee',
  'classId',
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
  classMask: Numeric;
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

export declare function termsCommitment(terms: CommittedTerms): bigint;
export declare function counterCommitment(state: CounterState, salt: Numeric): bigint;
export declare function nullifierOf(salt: Numeric, mandate: Numeric, period: Numeric, nonce: Numeric): bigint;
export declare function leafOf(address: Numeric): bigint;
export declare function initialCounter(salt: Numeric): bigint;
export declare function counterpartyTree(addresses: readonly Numeric[]): {
  root: bigint;
  members: bigint[];
  proof(address: Numeric): MerklePath | null;
};

export type SpendInput = Record<string, bigint | bigint[]>;

export declare function spendInput(args: {
  terms: CommittedTerms;
  counterparties: readonly Numeric[];
  state: CounterState;
  mandate: Numeric;
  payee: Numeric;
  amount: Numeric;
  classId: Numeric;
  now: Numeric;
}): {
  input: SpendInput;
  next: { period: bigint; spent: bigint; total: bigint; nonce: bigint };
};

export declare function rootFromPath(
  address: Numeric,
  path: { pathElements: readonly Numeric[]; pathIndices: readonly Numeric[] },
): bigint;
