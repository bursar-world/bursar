import type { ContractSet, Micro, SpendClass } from '@bursar/core';
import type { Address, Hex } from 'viem';

/**
 * Mirrors `IEscrow.LockStatus`. The numbers are consensus state, so they never move. A value
 * outside this set means the deployment is ahead of this package.
 */
export const LockStatus = {
  None: 0,
  Locked: 1,
  Released: 2,
  TimedOut: 3,
  Disputed: 4,
  Cancelled: 5,
  Resolved: 6,
} as const;

export type LockStatus = (typeof LockStatus)[keyof typeof LockStatus];

const LOCK_STATUS_VALUES: ReadonlySet<number> = new Set(Object.values(LockStatus));

/**
 * Narrows the raw `uint8` the escrow returns. An unknown value is worth a throw rather than a
 * silently mislabelled lock: the difference between `Released` and `Resolved` is who holds the
 * money.
 */
export function toLockStatus(value: number): LockStatus {
  if (!LOCK_STATUS_VALUES.has(value)) {
    throw new RangeError(
      `Unknown LockStatus ${value}. This deployment is ahead of @bursar/sdk; upgrade the package.`,
    );
  }
  return value as LockStatus;
}

/** Mirrors `IEscrow.Lock`. Amounts carry the settlement asset's six decimals, never the native view. */
export type Lock = {
  payer: Address;
  payee: Address;
  disputer: Address;
  capabilityId: Hex;
  inputCommit: Hex;
  outputCommit: Hex;
  inputURI: string;
  outputURI: string;
  amount: Micro;
  deadline: bigint;
  releasedAt: bigint;
  bond: Micro;
  disputedAt: bigint;
  status: LockStatus;
  counted: boolean;
};

/**
 * True when the escrow holds no record under the id this struct was read with. `getLock` decodes
 * an unknown id to a zeroed struct and never reverts, so this is what tells the two apart.
 */
export function isNoLock(lock: Lock): boolean {
  return lock.status === LockStatus.None;
}

/** Mirrors `IMandateAccount.MerchantGate`. Exactly one gate is live at a time. */
export const MerchantGate = {
  Allowlist: 0,
  MerkleRoot: 1,
} as const;

export type MerchantGate = (typeof MerchantGate)[keyof typeof MerchantGate];

/** Mirrors `IMandateAccount.WindowKind`. Both windows bind at once. */
export const WindowKind = {
  Daily: 0,
  Monthly: 1,
} as const;

export type WindowKind = (typeof WindowKind)[keyof typeof WindowKind];

/**
 * A rolling spend bucket as the account reports it, after the rollover a spend in this block
 * would apply. `resetsAt` is when the live window ends and `spent` returns to zero.
 */
export type SpendWindow = {
  kind: WindowKind;
  cap: Micro;
  spent: Micro;
  remaining: Micro;
  /** Window length in seconds. */
  duration: bigint;
  startsAt: Date;
  resetsAt: Date;
  /** Counts rollovers. A refund can only credit the bucket it was drawn from. */
  epoch: bigint;
};

/** The complete limit set. The account writes it atomically, so it is read and set as a whole. */
export type MandateLimits = {
  perCallCap: Micro;
  dailyCap: Micro;
  monthlyCap: Micro;
  /** Seconds. Named daily and monthly by convention; the contract holds two arbitrary windows. */
  dailyWindow: bigint;
  monthlyWindow: bigint;
  /** Amount at and above which the principal's signature is required. Never zero. */
  approvalThreshold: Micro;
  validFrom: bigint;
  /** Zero means no expiry. */
  validUntil: bigint;
  /**
   * Which spend classes the account allows, one bit each: 1 services, 2 agent hires, 4 eligible
   * stocks. Zero on a v1 account, which holds no mask and keeps classes in the capability namespace.
   */
  classMask: number;
  /** Lifetime ceiling on committed spend, net of refunds. Zero means none, and is all a v1 account holds. */
  totalCap: Micro;
  /** Where funds settle: 0 escrow, 1 treasury, 2 collateral. Always 0 on a v1 account. */
  lane: number;
};

/**
 * Limits as a caller writes them. Time fields take a plain number of seconds, which is how a
 * developer thinks about a window, and are range-checked on the way to the uint64 the account
 * holds them in.
 */
export type MandateLimitsInput = {
  perCallCap: Micro;
  dailyCap: Micro;
  monthlyCap: Micro;
  dailyWindow: number | bigint;
  monthlyWindow: number | bigint;
  approvalThreshold: Micro;
  validFrom?: number | bigint;
  validUntil?: number | bigint;
  /** The classes the mandate allows. Ignored when `classMask` is given. Defaults to services and hires. */
  classes?: readonly SpendClass[];
  /** The raw mask, for a caller that already holds one. See `MandateLimits.classMask`. */
  classMask?: number;
  /** Lifetime ceiling on committed spend. Zero or omitted means none. */
  totalCap?: Micro;
  /** Defaults to 0, the escrow lane, which is the only one with contracts behind it. */
  lane?: number;
};

/** What an agent can still spend right now, with the clock attached to each bucket. */
export type Remaining = {
  perCall: Micro;
  daily: Micro;
  monthly: Micro;
  dailyResetsAt: Date;
  monthlyResetsAt: Date;
};

/** A v2 account's lifetime total, as it counts it. */
export type TotalSpend = {
  cap: Micro;
  spent: Micro;
  remaining: Micro;
};

/** Everything the mandate holds, in one read. */
export type MandateStatus = {
  address: Address;
  /** Which build of the contracts the account runs, known from the escrow it settles through. */
  contractSet: ContractSet;
  principal: Address;
  pendingPrincipal: Address;
  agent: Address;
  escrow: Address;
  settlementAsset: Address;
  balance: Micro;
  paused: boolean;
  revoked: boolean;
  version: bigint;
  limits: MandateLimits;
  remaining: Remaining;
  daily: SpendWindow;
  monthly: SpendWindow;
  merchantGate: MerchantGate;
  merchantRoot: Hex;
  documentHash: Hex;
  /** Next sequential nonce a relayed limit change has to carry. */
  nonce: bigint;
  /** The native lifetime total. Null on a v1 account and on a v2 account with no total cap. */
  total: TotalSpend | null;
};

/** A principal's consent to one spend at or above the approval threshold. */
export type SpendApproval = {
  approvalId: Hex;
  merchant: Address;
  capabilityId: Hex;
  amount: Micro;
  expiry: bigint;
};

/**
 * Consent as `pay` consumes it. An empty signature means the principal already registered the
 * approval on chain with `approveSpend`; otherwise it is an EIP-712 signature, which an EOA, a
 * Safe or any other ERC-1271 signer can produce without sending a transaction.
 */
export type SignedApproval = {
  approval: SpendApproval;
  signature?: Hex;
};
