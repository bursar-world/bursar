import type { ContractSet, Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';

/**
 * Every amount crosses this boundary twice: `micro` is the exact six-decimal atomic value the
 * contracts and x402 payloads use, `usdg` is the same number for a human to read. Nothing is ever
 * rounded into `micro`, and nothing is ever computed from `usdg`.
 */
export type MoneyView = {
  readonly micro: string;
  readonly usdg: string;
};

/**
 * BRSR, at its own eighteen decimals, and never through the same path as money.
 *
 * Bonds are posted in it and resolver rewards are paid in USDG, so the two appear side by side in
 * a single reply and a reader has to be able to tell them apart at a glance. `atomic` is the exact
 * value the contract holds; `brsr` is the same figure for a person.
 */
export type BondView = {
  readonly atomic: string;
  readonly brsr: string;
};

export type WindowView = {
  readonly cap: MoneyView;
  readonly spent: MoneyView;
  readonly remaining: MoneyView;
  readonly windowSeconds: number;
  readonly startedAt: string;
  readonly resetsAt: string;
  readonly resetsInSeconds: number;
};

export type MandateStatus = 'active' | 'paused' | 'revoked' | 'not_yet_valid' | 'expired';

export type ProviderGate = 'allowlist' | 'roster';

export type EscrowTermsView = {
  readonly address: Address;
  readonly minTtlSeconds: number;
  readonly maxTtlSeconds: number;
  readonly disputeWindowSeconds: number;
  /**
   * The smallest payment the escrow locks, sized so that contesting one always costs a bond. An
   * escrow before v3 refuses only an empty lock, so its floor reads as one micro-USDG.
   */
  readonly minLock: MoneyView;
  readonly disputeBondBps: number;
  readonly feeBps: number;
};

export type MandateView = {
  readonly account: Address;
  readonly chainId: number;
  readonly status: MandateStatus;
  readonly summary: string;
  readonly principal: Address;
  readonly agent: Address;
  readonly version: string;
  readonly balance: MoneyView;
  readonly settlementAsset: Address;
  readonly perCallCap: MoneyView;
  readonly approvalThreshold: MoneyView;
  readonly daily: WindowView;
  readonly monthly: WindowView;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly providerGate: ProviderGate;
  readonly providerRoster: Hex | null;
  readonly documentHash: Hex | null;
  /**
   * Which build of the contracts the mandate runs. v1 holds its classes in the capability namespace.
   * Accounts from v2 on share one shape; from v3 the escrow floors the lock size.
   */
  readonly contractSet: ContractSet;
  /** The spend classes the account allows natively. Null on v1, where no mask is held. */
  readonly classes: readonly string[] | null;
  /** The native lifetime total. Null when there is none, and always on v1. */
  readonly totalCap: MoneyView | null;
  readonly escrow: EscrowTermsView;
  readonly observedAt: string;
  readonly blockNumber: string;
};

export type RefusalView = {
  /** The contract error, carried verbatim so a support conversation has one shared word for it. */
  readonly code: string;
  readonly subject: string;
  readonly message: string;
  /** When the bucket that stopped the spend refills. Absent when nothing about it is on a clock. */
  readonly resetsAt?: string;
  readonly resetsInSeconds?: number;
};

export type QuoteRequest = {
  readonly provider: Address;
  readonly capability: string;
  readonly amount: Micro;
  /** The class a bare label is quoted under: `service` for a payment, `hire` for a hire. */
  readonly spendClass?: 'service' | 'hire';
};

export type QuoteView = {
  readonly provider: Address;
  readonly capability: string;
  readonly capabilityId: Hex;
  readonly amount: MoneyView;
  readonly allowed: boolean;
  readonly approvalRequired: boolean;
  readonly funded: boolean;
  readonly refusal: RefusalView | null;
  readonly remaining: {
    readonly perCall: MoneyView;
    readonly daily: MoneyView;
    readonly monthly: MoneyView;
    readonly balance: MoneyView;
  };
  readonly next: string;
  readonly observedAt: string;
};

/** The principal's consent to one above-threshold spend, signed out of band and passed through here. */
export type ApprovalInput = {
  readonly approvalId: Hex;
  readonly amount: Micro;
  readonly expiry: number;
  readonly signature: Hex | null;
};

export type PayOrder = {
  readonly provider: Address;
  readonly capability: string;
  readonly input: Record<string, unknown>;
  readonly amount: Micro;
  readonly ttlSeconds: number;
  readonly providerProof: readonly Hex[];
  readonly approval: ApprovalInput | null;
};

export type BuyStockOrder = {
  /** A registry symbol ("SPY") or the token address. */
  readonly asset: string;
  readonly amount: Micro;
};

export type BuyStockView = {
  readonly txHash: Hex;
  readonly asset: Address;
  readonly symbol: string;
  readonly amount: MoneyView;
  /** Raw token units delivered to the mandate. */
  readonly received: string;
  /** Reference price, USD per whole token. */
  readonly referencePrice: string;
  /** received × reference price. */
  readonly valueAtReference: MoneyView;
  readonly next: string;
};

export type PayView = {
  readonly settlementId: string;
  readonly txHash: Hex;
  readonly provider: Address;
  readonly capability: string;
  readonly capabilityId: Hex;
  readonly amount: MoneyView;
  readonly inputCommit: Hex;
  readonly inputURI: string;
  readonly deliverBy: string;
  readonly status: SettlementStatus;
  readonly next: string;
};

export type SettlementStatus = 'held' | 'paid' | 'refunded' | 'returned' | 'disputed' | 'resolved' | 'unknown';

export type SettlementView = {
  readonly settlementId: string;
  readonly provider: Address;
  readonly capabilityId: Hex;
  readonly amount: MoneyView;
  readonly status: SettlementStatus;
  readonly funds: string;
  readonly deliverBy: string;
  readonly paidAtBlock: string;
  readonly txHash: Hex;
};

export type SettlementsView = {
  readonly settlements: readonly SettlementView[];
  /** The block range this reply covers in full. `0` means it reaches the account's first payment. */
  readonly scannedFromBlock: string;
  readonly scannedToBlock: string;
  /** Pass back as `beforeBlock` to keep reading further back. Null when there is nothing behind it. */
  readonly cursor: string | null;
  readonly observedAt: string;
};

export type DisputeView = {
  readonly openedAt: string;
  readonly openedBy: Address;
  readonly bond: MoneyView;
  /** When the vote closes and anyone can settle it. Null when no resolver was asked. */
  readonly resolveBy: string | null;
  readonly note: string;
};

/**
 * A detail read answers from the escrow's own record, which does not carry the transaction that
 * opened the lock. That hash comes back from the payment and from a listing.
 */
export type SettlementDetailView = Omit<SettlementView, 'paidAtBlock' | 'txHash'> & {
  readonly payer: Address;
  readonly inputCommit: Hex;
  readonly inputURI: string;
  readonly outputCommit: Hex | null;
  readonly outputURI: string | null;
  readonly deliveredAt: string | null;
  readonly disputableUntil: string | null;
  readonly refundableFrom: string | null;
  /**
   * What would come back to the mandate if this settlement ended in its favour. Zero once the
   * escrow has moved the funds, whichever way they went.
   */
  readonly refundableToMandate: MoneyView;
  readonly dispute: DisputeView | null;
  readonly next: string;
  readonly observedAt: string;
};

export type DisputeReceiptView = {
  readonly settlementId: string;
  readonly txHash: Hex;
  readonly status: SettlementStatus;
  readonly next: string;
};

export type SettlementsQuery = {
  readonly limit: number;
  readonly beforeBlock: bigint | null;
};

/** A job as one agent writes it for another. Committed with the payment, and never rewritten. */
export type JobSpecInput = {
  readonly task: string;
  readonly input: Record<string, unknown> | null;
  readonly acceptance: readonly string[];
};

export type HireOrder = {
  readonly provider: Address;
  readonly capability: string;
  readonly spec: JobSpecInput;
  readonly budget: Micro;
  readonly ttlSeconds: number;
  readonly providerProof: readonly Hex[];
  readonly approval: ApprovalInput | null;
};

export type HireView = PayView & {
  /** The same number the escrow calls a settlement id. A hire is a payment with a brief on it. */
  readonly jobId: string;
  readonly task: string;
  /** The hash of the brief the provider is bound to, which is the lock's own input commitment. */
  readonly specCommit: Hex;
};

export type DisputePhaseName = 'none' | 'committing' | 'revealing' | 'finalized' | 'failed';

/** How a ruling cut the settlement. Every figure is derived the way the escrow derives it. */
export type DisputeRulingView = {
  readonly medianScore: number;
  readonly refundBps: number;
  readonly refundedToMandate: MoneyView;
  readonly paidToProvider: MoneyView;
  readonly resolverFee: MoneyView;
  /** The settlement fee, charged on the provider's share alone. */
  readonly protocolFee: MoneyView;
  readonly bondReturned: boolean;
};

export type DisputeDetailView = {
  readonly settlementId: string;
  /** The dispute layer's own id for the vote. Zero when no resolver was ever asked. */
  readonly disputeId: string;
  readonly phase: DisputePhaseName;
  readonly openedAt: string;
  readonly openedBy: Address;
  readonly bond: MoneyView;
  readonly amount: MoneyView;
  readonly provider: Address;
  /** True when the provider had already been paid, so there is a record and no ruling. */
  readonly recordOnly: boolean;
  readonly commitEndsAt: string | null;
  readonly revealEndsAt: string | null;
  readonly commitCount: number;
  readonly revealCount: number;
  readonly quorum: number;
  /** When the vote closes and anyone can settle it: the end of the reveal window. */
  readonly resolveBy: string | null;
  readonly ruling: DisputeRulingView | null;
  readonly settlementStatus: SettlementStatus;
  readonly next: string;
  readonly observedAt: string;
};

export type ResolverStanding = 'none' | 'active' | 'unbonding' | 'exited';

export type ResolverStatusView = {
  readonly resolver: Address;
  readonly registry: Address;
  readonly standing: ResolverStanding;
  /** BRSR at risk. It is collateral taking first loss, not a deposit, and it earns no return. */
  readonly bond: BondView;
  readonly bondFloor: BondView;
  readonly bondable: boolean;
  readonly ruled: number;
  readonly slashes: number;
  /** Votes still open against this bond. It cannot leave while any stand. */
  readonly openVotes: number;
  readonly unbondsAt: string | null;
  /** Rewards waiting to be claimed, in USDG. Bonds and rewards are different tokens. */
  readonly rewards: MoneyView;
  readonly commitWindowSeconds: number;
  readonly revealWindowSeconds: number;
  readonly quorum: number;
  readonly maxVoters: number;
  readonly maxDeviation: number;
  readonly slashBps: number;
  readonly next: string;
  readonly observedAt: string;
};

/** A dispute still open to a vote, with the facts a score is formed from. */
export type OpenDisputeView = {
  readonly disputeId: string;
  readonly settlementId: string;
  readonly phase: 'committing' | 'revealing';
  readonly commitEndsAt: string;
  readonly revealEndsAt: string;
  readonly commitCount: number;
  readonly revealCount: number;
  readonly quorum: number;
  readonly maxVoters: number;
  readonly committed: boolean;
  readonly revealed: boolean;
  readonly job: {
    readonly payer: Address;
    readonly provider: Address;
    readonly amount: MoneyView;
    readonly capabilityId: Hex;
    readonly inputCommit: Hex;
    readonly inputURI: string;
    readonly outputCommit: Hex | null;
    readonly outputURI: string | null;
    readonly deliverBy: string;
    readonly deliveredAt: string | null;
    readonly contestedBy: Address;
  };
  readonly next: string;
};

export type OpenDisputesView = {
  readonly disputes: readonly OpenDisputeView[];
  readonly observedAt: string;
};

/** A sealed score, and the salt that is the only thing that opens it. */
export type CommitView = {
  readonly disputeId: string;
  readonly score: number;
  /** Keep this. Revealing takes the same score and the same salt, and accepts no other pair. */
  readonly salt: Hex;
  readonly commitment: Hex;
  readonly txHash: Hex;
  readonly revealFrom: string;
  readonly revealUntil: string;
  readonly revealWindowSeconds: number;
  /** The same thing in words, because a field called `salt` does not say what losing it costs. */
  readonly warning: string;
  readonly next: string;
};

/** A transaction the relay sent on a role's behalf, with what it changed and what is next. */
export type ActionView = {
  readonly txHash: Hex;
  readonly action: string;
  readonly next: string;
};

export type PendingWithdrawalView = {
  readonly amount: MoneyView;
  readonly requestedAt: string;
  readonly maturesAt: string;
  readonly matured: boolean;
};

export type ProviderStatusView = {
  readonly provider: Address;
  readonly registry: Address;
  readonly registered: boolean;
  /** Listed, live, funded to the floor and not barred. The one question a principal asks. */
  readonly active: boolean;
  readonly blacklisted: boolean;
  readonly name: string;
  /** Collateral posted, in USDG. A ruling against a job can take part of it. */
  readonly stake: MoneyView;
  readonly minStake: MoneyView;
  readonly maxSlash: MoneyView;
  readonly withdrawal: PendingWithdrawalView | null;
  readonly withdrawalDelaySeconds: number;
  readonly registryPaused: boolean;
  readonly next: string;
  readonly observedAt: string;
};

export type ProviderReputationView = {
  readonly provider: Address;
  readonly score: number;
  readonly released: string;
  readonly timedOut: string;
  readonly disputed: string;
  readonly settled: string;
  /** The largest single payment the escrow will hold for this provider right now. */
  readonly cap: MoneyView;
  readonly maxCap: MoneyView;
  readonly next: string;
  readonly observedAt: string;
};

/**
 * The one surface the tools drive. The server binds it to the chain and the operator's relay; a test
 * binds it to a double. Nothing behind it holds a key.
 */
export type MandateGateway = {
  inspect(): Promise<MandateView>;
  quote(request: QuoteRequest): Promise<QuoteView>;
  pay(order: PayOrder): Promise<PayView>;
  hire(order: HireOrder): Promise<HireView>;
  buyStock(order: BuyStockOrder): Promise<BuyStockView>;
  settlements(query: SettlementsQuery): Promise<SettlementsView>;
  settlement(settlementId: bigint): Promise<SettlementDetailView>;
  openDispute(settlementId: bigint): Promise<DisputeReceiptView>;
  dispute(settlementId: bigint): Promise<DisputeDetailView>;
};

/** The same seam for a resolver running headless, bound to the address its signer holds. */
export type ResolverGateway = {
  status(): Promise<ResolverStatusView>;
  openDisputes(limit: number): Promise<OpenDisputesView>;
  bond(amount: bigint): Promise<ActionView>;
  addBond(amount: bigint): Promise<ActionView>;
  commit(request: { disputeId: bigint; score: number }): Promise<CommitView>;
  reveal(request: { disputeId: bigint; score: number; salt: Hex }): Promise<ActionView>;
  finalize(disputeId: bigint): Promise<ActionView>;
  fail(disputeId: bigint): Promise<ActionView>;
  claimRewards(): Promise<ActionView>;
  requestUnbond(): Promise<ActionView>;
  completeUnbond(): Promise<ActionView>;
  cancelUnbond(): Promise<ActionView>;
};

/** And for a provider selling capability through the registry the escrow reads. */
export type ProviderGateway = {
  status(): Promise<ProviderStatusView>;
  reputation(): Promise<ProviderReputationView>;
  register(request: { name: string; stake: Micro }): Promise<ActionView>;
  addStake(amount: Micro): Promise<ActionView>;
  requestWithdrawal(amount: Micro): Promise<ActionView>;
  executeWithdrawal(): Promise<ActionView>;
  cancelWithdrawal(): Promise<ActionView>;
  deactivate(): Promise<ActionView>;
  reactivate(): Promise<ActionView>;
};
