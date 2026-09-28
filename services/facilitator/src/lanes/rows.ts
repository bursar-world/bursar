import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { numericToMicro, optionalNumericToMicro } from '../db/numeric.js';
import type {
  Account,
  AccountStatus,
  AuthorizationRecord,
  CollateralAsset,
  CollateralPosition,
  Debt,
  DebtStatus,
  FundingEvent,
  FundingEventType,
  LaneBalance,
  LaneMode,
  Pool,
  PoolReserve,
  Repayment,
  RepaymentSource,
  Reservation,
  ReservationStatus,
  Settlement,
  SettlementStatus,
} from './types.js';

/**
 * Row shapes exactly as the queries below select them, and the mappers that narrow them.
 *
 * Every money column is selected as text and converted here, so there is one place to look when a
 * number does not match what the database holds.
 */

export type AccountRow = {
  agent_id: string;
  mandate_account: string | null;
  payer_wallet: string;
  repay_wallet: string;
  networks: unknown;
  per_call_cap_micro: string | null;
  daily_cap_micro: string | null;
  monthly_cap_micro: string | null;
  approval_threshold_micro: string | null;
  status: AccountStatus;
  created_at: Date;
  updated_at: Date;
};

export type PoolRow = {
  pool_id: string;
  lane: LaneMode;
  status: 'active' | 'paused' | 'frozen';
  ltv_cap_bps: number;
  min_health_factor: string;
  max_single_micro: string;
};

export type PoolReserveRow = {
  pool_id: string;
  lane: LaneMode;
  reserved_micro: string;
  outstanding_micro: string;
  collateral_value_micro: string;
  updated_at: Date;
};

export type LaneBalanceRow = {
  agent_id: string;
  pool_id: string;
  available_micro: string;
  reserved_micro: string;
  spent_micro: string;
  updated_at: Date;
};

export type FundingEventRow = {
  id: string;
  agent_id: string;
  lane: LaneMode;
  pool_id: string;
  reference_id: string;
  event_type: FundingEventType;
  amount_micro: string;
  tx_hash: string | null;
  created_at: Date;
};

export type AuthorizationRow = {
  id: string;
  agent_id: string;
  payer_wallet: string;
  repay_wallet: string;
  request_nonce: string;
  network: string;
  lane: LaneMode;
  pool_id: string;
  requested_micro: string;
  approved: boolean;
  approved_micro: string;
  available_micro: string;
  outstanding_micro: string;
  reason_codes: string[];
  policy_id: string | null;
  policy_version: string | null;
  ltv_bps: number | null;
  health_factor: string | null;
  request_hash: string | null;
  document_hash: string | null;
  created_at: Date;
};

export type ReservationRow = {
  id: string;
  authorization_id: string;
  agent_id: string;
  payer_wallet: string;
  merchant_wallet: string;
  request_nonce: string;
  network: string;
  lane: LaneMode;
  pool_id: string;
  amount_micro: string;
  locked_micro: string;
  status: ReservationStatus;
  expires_at: Date;
  settlement_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type DebtRow = {
  id: string;
  agent_id: string;
  payer_wallet: string;
  repay_wallet: string;
  network: string;
  lane: LaneMode;
  pool_id: string;
  settlement_id: string;
  authorization_id: string | null;
  reservation_id: string | null;
  principal_micro: string;
  outstanding_micro: string;
  status: DebtStatus;
  created_at: Date;
  closed_at: Date | null;
};

export type RepaymentRow = {
  id: string;
  agent_id: string;
  debt_id: string | null;
  pool_id: string | null;
  reference_id: string;
  source: RepaymentSource;
  amount_micro: string;
  applied_micro: string;
  tx_hash: string | null;
  created_at: Date;
};

export type SettlementRow = {
  id: string;
  network: string;
  asset: string;
  payer_wallet: string;
  merchant_wallet: string;
  amount_micro: string;
  fee_micro: string;
  status: SettlementStatus;
  tx_hash: string | null;
  settle_nonce: string | null;
  settled_at: Date | null;
  created_at: Date;
};

export type CollateralPositionRow = {
  id: string;
  agent_id: string;
  pool_id: string;
  collateral_account: string;
  asset_id: string;
  deposited_micro: string;
  withdrawn_micro: string;
  locked_micro: string;
  status: 'active' | 'frozen' | 'closed';
};

export type CollateralAssetRow = {
  asset_id: string;
  symbol: string;
  chain: string;
  haircut_bps: number;
  volatility_buffer_bps: number;
  status: 'active' | 'inactive';
};

function networkList(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** NUMERIC(20,6) rendered as text, read as a float only where the value is a ratio, not money. */
function ratio(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

export function toAccount(row: AccountRow): Account {
  return {
    agentId: row.agent_id,
    mandateAccount: (row.mandate_account as `0x${string}` | null) ?? null,
    payerWallet: row.payer_wallet,
    repayWallet: row.repay_wallet,
    networks: networkList(row.networks),
    perCallCapMicro: optionalNumericToMicro(row.per_call_cap_micro, 'per_call_cap_micro'),
    dailyCapMicro: optionalNumericToMicro(row.daily_cap_micro, 'daily_cap_micro'),
    monthlyCapMicro: optionalNumericToMicro(row.monthly_cap_micro, 'monthly_cap_micro'),
    approvalThresholdMicro: optionalNumericToMicro(
      row.approval_threshold_micro,
      'approval_threshold_micro',
    ),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPool(row: PoolRow): Pool {
  return {
    poolId: row.pool_id,
    lane: row.lane,
    status: row.status,
    ltvCapBps: row.ltv_cap_bps,
    minHealthFactor: ratio(row.min_health_factor) ?? 0,
    maxSingleMicro: numericToMicro(row.max_single_micro, 'max_single_micro'),
  };
}

export function toPoolReserve(row: PoolReserveRow): PoolReserve {
  return {
    poolId: row.pool_id,
    lane: row.lane,
    reservedMicro: numericToMicro(row.reserved_micro, 'reserved_micro'),
    outstandingMicro: numericToMicro(row.outstanding_micro, 'outstanding_micro'),
    collateralValueMicro: numericToMicro(row.collateral_value_micro, 'collateral_value_micro'),
    updatedAt: row.updated_at,
  };
}

export function toLaneBalance(row: LaneBalanceRow): LaneBalance {
  return {
    agentId: row.agent_id,
    poolId: row.pool_id,
    availableMicro: numericToMicro(row.available_micro, 'available_micro'),
    reservedMicro: numericToMicro(row.reserved_micro, 'reserved_micro'),
    spentMicro: numericToMicro(row.spent_micro, 'spent_micro'),
    updatedAt: row.updated_at,
  };
}

export function toFundingEvent(row: FundingEventRow): FundingEvent {
  return {
    id: row.id,
    agentId: row.agent_id,
    lane: row.lane,
    poolId: row.pool_id,
    referenceId: row.reference_id,
    eventType: row.event_type,
    amountMicro: numericToMicro(row.amount_micro, 'amount_micro'),
    txHash: row.tx_hash,
    createdAt: row.created_at,
  };
}

export function toAuthorization(row: AuthorizationRow): AuthorizationRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    payerWallet: row.payer_wallet,
    repayWallet: row.repay_wallet,
    requestNonce: row.request_nonce,
    network: row.network,
    lane: row.lane,
    poolId: row.pool_id,
    requestedMicro: numericToMicro(row.requested_micro, 'requested_micro'),
    approved: row.approved,
    approvedMicro: numericToMicro(row.approved_micro, 'approved_micro'),
    availableMicro: numericToMicro(row.available_micro, 'available_micro'),
    outstandingMicro: numericToMicro(row.outstanding_micro, 'outstanding_micro'),
    reasonCodes: row.reason_codes,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    ltvBps: row.ltv_bps,
    healthFactor: ratio(row.health_factor),
    requestHash: row.request_hash,
    documentHash: row.document_hash,
    createdAt: row.created_at,
  };
}

export function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    authorizationId: row.authorization_id,
    agentId: row.agent_id,
    payerWallet: row.payer_wallet,
    merchantWallet: row.merchant_wallet,
    requestNonce: row.request_nonce,
    network: row.network,
    lane: row.lane,
    poolId: row.pool_id,
    amountMicro: numericToMicro(row.amount_micro, 'amount_micro'),
    lockedMicro: numericToMicro(row.locked_micro, 'locked_micro'),
    status: row.status,
    expiresAt: row.expires_at,
    settlementId: row.settlement_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toDebt(row: DebtRow): Debt {
  return {
    id: row.id,
    agentId: row.agent_id,
    payerWallet: row.payer_wallet,
    repayWallet: row.repay_wallet,
    network: row.network,
    lane: row.lane,
    poolId: row.pool_id,
    settlementId: row.settlement_id,
    authorizationId: row.authorization_id,
    reservationId: row.reservation_id,
    principalMicro: numericToMicro(row.principal_micro, 'principal_micro'),
    outstandingMicro: numericToMicro(row.outstanding_micro, 'outstanding_micro'),
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export function toRepayment(row: RepaymentRow): Repayment {
  return {
    id: row.id,
    agentId: row.agent_id,
    debtId: row.debt_id,
    poolId: row.pool_id ?? null,
    referenceId: row.reference_id,
    source: row.source,
    amountMicro: numericToMicro(row.amount_micro, 'amount_micro'),
    appliedMicro: numericToMicro(row.applied_micro, 'applied_micro'),
    txHash: row.tx_hash,
    createdAt: row.created_at,
  };
}

export function toSettlement(row: SettlementRow): Settlement {
  return {
    id: row.id,
    network: row.network,
    asset: row.asset,
    payerWallet: row.payer_wallet,
    merchantWallet: row.merchant_wallet,
    amountMicro: numericToMicro(row.amount_micro, 'amount_micro'),
    feeMicro: numericToMicro(row.fee_micro, 'fee_micro'),
    status: row.status,
    txHash: row.tx_hash,
    settleNonce: row.settle_nonce,
    settledAt: row.settled_at,
    createdAt: row.created_at,
  };
}

export function toCollateralPosition(row: CollateralPositionRow): CollateralPosition {
  return {
    id: row.id,
    agentId: row.agent_id,
    poolId: row.pool_id,
    collateralAccount: row.collateral_account,
    assetId: row.asset_id,
    depositedMicro: numericToMicro(row.deposited_micro, 'deposited_micro'),
    withdrawnMicro: numericToMicro(row.withdrawn_micro, 'withdrawn_micro'),
    lockedMicro: numericToMicro(row.locked_micro, 'locked_micro'),
    status: row.status,
  };
}

export function toCollateralAsset(row: CollateralAssetRow): CollateralAsset {
  return {
    assetId: row.asset_id,
    symbol: row.symbol,
    chain: row.chain,
    haircutBps: row.haircut_bps,
    volatilityBufferBps: row.volatility_buffer_bps,
    status: row.status,
  };
}

/** Micro amounts summed by an aggregate, which Postgres hands back as text or null. */
export function sumToMicro(raw: string | null | undefined, column: string): Micro {
  return raw === null || raw === undefined ? toMicro(0) : numericToMicro(raw, column);
}
