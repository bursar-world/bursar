import type { Micro } from '@bursar/core';

/**
 * How a call is funded.
 *
 *   prefund     the principal funded the mandate account up front; the facilitator holds against
 *               that balance per call and merchants are paid net. It carries the least risk and
 *               costs the least gas: it broadcasts once per batch where the direct lane broadcasts
 *               once per call, and every broadcast costs the relayer ETH the payment never
 *               reimburses.
 *   collateral  the call is funded against posted collateral and opens a debt.
 *   direct      the payer's own signed authorisation settles the call. Nothing is held, nothing is
 *               owed, and the facilitator only broadcasts.
 *
 * These are the three names `GET /config` advertises and the three a request may carry. The lane
 * was spelled `none` in the schema until 0006 and nowhere a customer could see it, which left the
 * service rejecting the only name it published.
 *
 * Debt belongs to the collateral lane. No other lane extends credit, in the schema, in this
 * service, or in anything it says to a caller.
 */
export const LANE_MODES = ['prefund', 'collateral', 'direct'] as const;

export type LaneMode = (typeof LANE_MODES)[number];

/** The pre-0006 spelling of `direct`. Accepted on input so an older client keeps working. */
const DEPRECATED_LANE_NAMES: Readonly<Record<string, LaneMode>> = { none: 'direct' };

export function isLaneMode(value: unknown): value is LaneMode {
  return typeof value === 'string' && LANE_MODES.includes(value as LaneMode);
}

/** Reads a lane off a request, resolving the deprecated spelling. Null when it is not a lane. */
export function toLaneMode(value: unknown): LaneMode | null {
  if (isLaneMode(value)) return value;
  if (typeof value !== 'string') return null;
  return DEPRECATED_LANE_NAMES[value] ?? null;
}

/** The one lane that lends. Every credit path in this service checks against it. */
export const CREDIT_LANE: LaneMode = 'collateral';

export function laneExtendsCredit(lane: LaneMode): boolean {
  return lane === CREDIT_LANE;
}

export type AccountStatus = 'active' | 'suspended';
export type ReservationStatus = 'reserved' | 'consumed' | 'released' | 'expired';
export type DebtStatus = 'open' | 'closed' | 'written_off';
export type SettlementStatus = 'authorized' | 'settled' | 'failed';
export type FundingEventType = 'deposit' | 'withdraw';
export type RepaymentSource = 'settlement' | 'transfer' | 'collateral';

export type Account = {
  readonly agentId: string;
  readonly mandateAccount: `0x${string}` | null;
  readonly payerWallet: string;
  readonly repayWallet: string;
  readonly networks: readonly string[];
  readonly perCallCapMicro: Micro | null;
  readonly dailyCapMicro: Micro | null;
  readonly monthlyCapMicro: Micro | null;
  readonly approvalThresholdMicro: Micro | null;
  readonly status: AccountStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type Pool = {
  readonly poolId: string;
  readonly lane: LaneMode;
  readonly status: 'active' | 'paused' | 'frozen';
  readonly ltvCapBps: number;
  readonly minHealthFactor: number;
  readonly maxSingleMicro: Micro;
};

export type PoolReserve = {
  readonly poolId: string;
  readonly lane: LaneMode;
  readonly reservedMicro: Micro;
  readonly outstandingMicro: Micro;
  readonly collateralValueMicro: Micro;
  readonly updatedAt: Date;
};

export type LaneBalance = {
  readonly agentId: string;
  readonly poolId: string;
  readonly availableMicro: Micro;
  readonly reservedMicro: Micro;
  readonly spentMicro: Micro;
  readonly updatedAt: Date;
};

export type FundingEvent = {
  readonly id: string;
  readonly agentId: string;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly referenceId: string;
  readonly eventType: FundingEventType;
  readonly amountMicro: Micro;
  readonly txHash: string | null;
  readonly createdAt: Date;
};

export type AuthorizationRecord = {
  readonly id: string;
  readonly agentId: string;
  readonly payerWallet: string;
  readonly repayWallet: string;
  readonly requestNonce: string;
  readonly network: string;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly requestedMicro: Micro;
  readonly approved: boolean;
  readonly approvedMicro: Micro;
  readonly availableMicro: Micro;
  readonly outstandingMicro: Micro;
  readonly reasonCodes: readonly string[];
  readonly policyId: string | null;
  readonly policyVersion: string | null;
  readonly ltvBps: number | null;
  readonly healthFactor: number | null;
  readonly requestHash: string | null;
  readonly documentHash: string | null;
  readonly createdAt: Date;
};

export type Reservation = {
  readonly id: string;
  readonly authorizationId: string;
  readonly agentId: string;
  readonly payerWallet: string;
  readonly merchantWallet: string;
  readonly requestNonce: string;
  readonly network: string;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly amountMicro: Micro;
  readonly lockedMicro: Micro;
  readonly status: ReservationStatus;
  readonly expiresAt: Date;
  readonly settlementId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type Debt = {
  readonly id: string;
  readonly agentId: string;
  readonly payerWallet: string;
  readonly repayWallet: string;
  readonly network: string;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly settlementId: string;
  readonly authorizationId: string | null;
  readonly reservationId: string | null;
  readonly principalMicro: Micro;
  readonly outstandingMicro: Micro;
  readonly status: DebtStatus;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
};

export type Repayment = {
  readonly id: string;
  readonly agentId: string;
  readonly debtId: string | null;
  /** The pool the caller named, or else the pool of the first debt it met. */
  readonly poolId: string | null;
  readonly referenceId: string;
  readonly source: RepaymentSource;
  readonly amountMicro: Micro;
  readonly appliedMicro: Micro;
  readonly txHash: string | null;
  readonly createdAt: Date;
};

export type Settlement = {
  readonly id: string;
  readonly network: string;
  readonly asset: string;
  readonly payerWallet: string;
  readonly merchantWallet: string;
  readonly amountMicro: Micro;
  readonly feeMicro: Micro;
  readonly status: SettlementStatus;
  readonly txHash: string | null;
  /** The authorisation a direct settlement spent. Null in the lanes that settle net. */
  readonly settleNonce: string | null;
  readonly settledAt: Date | null;
  readonly createdAt: Date;
};

export type CollateralPosition = {
  readonly id: string;
  readonly agentId: string;
  readonly poolId: string;
  readonly collateralAccount: string;
  readonly assetId: string;
  readonly depositedMicro: Micro;
  readonly withdrawnMicro: Micro;
  readonly lockedMicro: Micro;
  readonly status: 'active' | 'frozen' | 'closed';
};

export type CollateralAsset = {
  readonly assetId: string;
  readonly symbol: string;
  readonly chain: string;
  readonly haircutBps: number;
  readonly volatilityBufferBps: number;
  readonly status: 'active' | 'inactive';
};

/**
 * How much backing an agent has and how far it is drawn against it.
 *
 * `healthFactor` is null when nothing is owed. There is no health to
 * measure on a position with no debt, and a number like 9999 reads as a measurement.
 */
export type CollateralSummary = {
  readonly poolId: string;
  readonly totalAvailableMicro: Micro;
  readonly effectiveCollateralMicro: Micro;
  readonly outstandingMicro: Micro;
  readonly ltvBps: number;
  readonly healthFactor: number | null;
  /**
   * `chain` when the figures were read from `CollateralVault` for the account's mandate, `ledger`
   * when they come from this service's own collateral rows.
   */
  readonly source?: 'chain' | 'ledger';
  /** What the vault would lend now. Present only when read from chain. */
  readonly headroomMicro?: Micro;
  readonly mandateAccount?: `0x${string}`;
};

export type LaneStatement = {
  readonly account: Account;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly balance: LaneBalance | null;
  readonly outstandingMicro: Micro;
  readonly collateral: CollateralSummary | null;
};

export type LaneTransaction = {
  readonly type: 'funding' | 'debt' | 'repayment' | 'settlement';
  readonly id: string;
  readonly createdAt: Date;
  readonly lane: LaneMode;
  readonly poolId: string;
  readonly amountMicro: Micro;
  readonly outstandingMicro: Micro | null;
  readonly status: string | null;
  readonly referenceId: string | null;
  readonly txHash: string | null;
};
