import { ZERO_MICRO, addMicro, minMicro, mulBps, negMicro, subMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { canonicalNetwork } from '@bursar/x402';
import { isUniqueViolation } from '../db/errors.js';
import { microToNumeric } from '../db/numeric.js';
import type { Database, Queryable } from '../db/sql.js';
import { many, one } from '../db/sql.js';
import { LaneDoesNotExtendCredit, LedgerError } from '../errors.js';
import type { TrustStore } from '../trust/store.js';
import {
  allocateRepayment,
  borrowingHeadroom,
  effectiveCollateral,
  grossedUpCollateral,
  healthFactor,
  ltvBps,
} from './allocate.js';
import type {
  AccountRow,
  AuthorizationRow,
  CollateralAssetRow,
  CollateralPositionRow,
  DebtRow,
  FundingEventRow,
  LaneBalanceRow,
  PoolReserveRow,
  PoolRow,
  RepaymentRow,
  ReservationRow,
  SettlementRow,
} from './rows.js';
import {
  sumToMicro,
  toAccount,
  toAuthorization,
  toCollateralAsset,
  toCollateralPosition,
  toDebt,
  toFundingEvent,
  toLaneBalance,
  toPool,
  toPoolReserve,
  toRepayment,
  toReservation,
  toSettlement,
} from './rows.js';
import type {
  Account,
  AuthorizationRecord,
  CollateralPosition,
  CollateralSummary,
  Debt,
  FundingEvent,
  LaneBalance,
  LaneMode,
  LaneStatement,
  LaneTransaction,
  Pool,
  PoolReserve,
  Repayment,
  Reservation,
  RepaymentSource,
  Settlement,
} from './types.js';
import { laneExtendsCredit } from './types.js';

/**
 * The lane ledger.
 *
 * Everything that moves money goes through one of the methods here, inside one transaction, with
 * the rows it touches locked before it reads them. Three properties hold across all of it:
 *
 *   Idempotent. Every mutation takes a caller-supplied reference, and replaying it returns the
 *   original result. A facilitator is retried by clients it does not control, so this is not
 *   optional.
 *
 *   Conserving. Prefunded balance only moves between available, reserved and spent. A funding
 *   event is the only thing that changes their sum. A withdrawal that would take the balance
 *   negative fails the guard inside the UPDATE, so there is no window between the check and the
 *   write.
 *
 *   Lane-bound. Debt is opened only in the collateral lane. That is checked here and again by a
 *   CHECK constraint on the debts table, because the rule is a product commitment.
 */

const ACCOUNT_COLUMNS = `
  agent_id, mandate_account, payer_wallet, repay_wallet, networks,
  per_call_cap_micro::text, daily_cap_micro::text, monthly_cap_micro::text,
  approval_threshold_micro::text, status, created_at, updated_at`;

const POOL_COLUMNS = `
  pool_id, lane, status, ltv_cap_bps, min_health_factor::text, max_single_micro::text`;

const RESERVE_COLUMNS = `
  pool_id, lane, reserved_micro::text, outstanding_micro::text,
  collateral_value_micro::text, updated_at`;

const BALANCE_COLUMNS = `
  agent_id, pool_id, available_micro::text, reserved_micro::text, spent_micro::text, updated_at`;

const FUNDING_COLUMNS = `
  id::text, agent_id, lane, pool_id, reference_id, event_type,
  amount_micro::text, tx_hash, created_at`;

const AUTHORIZATION_COLUMNS = `
  id::text, agent_id, payer_wallet, repay_wallet, request_nonce, network, lane, pool_id,
  requested_micro::text, approved, approved_micro::text, available_micro::text,
  outstanding_micro::text, reason_codes, policy_id, policy_version, ltv_bps,
  health_factor::text, request_hash, document_hash, created_at`;

const RESERVATION_COLUMNS = `
  id::text, authorization_id::text, agent_id, payer_wallet, merchant_wallet, request_nonce,
  network, lane, pool_id, amount_micro::text, locked_micro::text, status, expires_at,
  settlement_id::text, created_at, updated_at`;

const DEBT_COLUMNS = `
  id::text, agent_id, payer_wallet, repay_wallet, network, lane, pool_id,
  settlement_id::text, authorization_id::text, reservation_id::text,
  principal_micro::text, outstanding_micro::text, status, created_at, closed_at`;

const REPAYMENT_COLUMNS = `
  id::text, agent_id, debt_id::text, pool_id, reference_id, source,
  amount_micro::text, applied_micro::text, tx_hash, created_at`;

const SETTLEMENT_COLUMNS = `
  id::text, network, asset, payer_wallet, merchant_wallet,
  amount_micro::text, fee_micro::text, status, tx_hash, settle_nonce, settled_at, created_at`;

const POSITION_COLUMNS = `
  id::text, agent_id, pool_id, collateral_account, asset_id,
  deposited_micro::text, withdrawn_micro::text, locked_micro::text, status`;

export type LaneLedgerOptions = {
  readonly db: Database;
  readonly trust: TrustStore;
  /** The settlement asset's ticker, carried on trust events so a consumer knows the units. */
  readonly currency: string;
  readonly now?: () => Date;
};

export type UpsertAccountInput = {
  readonly agentId: string;
  readonly payerWallet: string;
  readonly repayWallet: string;
  readonly mandateAccount?: `0x${string}` | null;
  readonly networks?: readonly string[];
  readonly perCallCapMicro?: Micro | null;
  readonly dailyCapMicro?: Micro | null;
  readonly monthlyCapMicro?: Micro | null;
  readonly approvalThresholdMicro?: Micro | null;
};

export type RecordAuthorizationInput = {
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
  readonly reasonCodes?: readonly string[];
  readonly policyId?: string | null;
  readonly policyVersion?: string | null;
  readonly ltvBps?: number | null;
  readonly healthFactor?: number | null;
  readonly requestHash?: string | null;
  readonly documentHash?: string | null;
};

export type OpenReservationInput = {
  readonly authorizationId: string;
  readonly merchantWallet: string;
  readonly amountMicro: Micro;
  readonly ttlMs: number;
};

/** What a payment says it moved, as the party that verified it saw it. */
export type PaymentTerms = {
  readonly amountMicro: Micro;
  readonly payerWallet: string;
  readonly merchantWallet: string;
};

export type ConsumeReservationInput = {
  readonly reservationId: string;
  readonly asset: string;
  readonly feeMicro: Micro;
  /**
   * The payment closing the hold, when one is.
   *
   * Everything the settlement records is taken from the reservation, so without this a payment for
   * a different amount, from a different payer or to a different merchant consumes the hold and is
   * written down as having paid it. Checked against the locked row, never against the copy the
   * caller read before it queued.
   */
  readonly payment?: PaymentTerms;
  /**
   * The claim a settle took on the hold before broadcasting, from `claimReservation`.
   *
   * A claimed hold consumes only for the claim it carries, and an unclaimed one only without one.
   */
  readonly claim?: string;
};

export type ClaimReservationInput = {
  readonly reservationId: string;
  readonly network: string;
  readonly payerWallet: string;
  readonly nonce: string;
  /** How long the hold still has to run for the claim to be worth taking. */
  readonly minRemainingMs: number;
};

export type SettleReservationInput = ConsumeReservationInput & {
  readonly claim: string;
  readonly txHash: string;
  readonly treasury: string;
};

/** What the replay guard knows about one authorisation. */
export type PaymentRecord = {
  readonly settlement: Settlement | null;
  readonly txHash: string | null;
  readonly reservationId: string | null;
};

/** A settle claim nothing has closed, as reconciliation finds it. */
export type UnsettledPayment = {
  readonly claim: string;
  readonly network: string;
  readonly payerWallet: `0x${string}`;
  readonly nonce: `0x${string}`;
  readonly amountMicro: Micro;
  readonly txHash: string | null;
  readonly reservationId: string | null;
};

export type ConsumeResult = {
  readonly reservation: Reservation;
  readonly settlement: Settlement;
  /** Present in the collateral lane, which is the only lane that lends. Null everywhere else. */
  readonly debt: Debt | null;
};

export type DirectSettlementInput = {
  readonly network: string;
  readonly asset: string;
  readonly payerWallet: string;
  readonly merchantWallet: string;
  readonly amountMicro: Micro;
  readonly feeMicro: Micro;
  readonly txHash: string;
  readonly nonce: string;
  /** Where the fee is owed. Recorded on the same transaction as the settlement it comes out of. */
  readonly treasury: string;
};

export type FundingInput = {
  readonly agentId: string;
  readonly poolId: string;
  readonly referenceId: string;
  readonly amountMicro: Micro;
  readonly eventType: 'deposit' | 'withdraw';
  readonly txHash?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type RepaymentInput = {
  readonly agentId: string;
  readonly referenceId: string;
  readonly amountMicro: Micro;
  readonly source: RepaymentSource;
  readonly txHash?: string | null;
  readonly poolId?: string;
};

export type RepaymentResult = {
  readonly repayment: Repayment;
  readonly idempotent: boolean;
  readonly outstandingMicro: Micro;
};

export type CollateralInput = {
  readonly agentId: string;
  readonly poolId: string;
  readonly collateralAccount: string;
  readonly assetId: string;
  readonly referenceId: string;
  readonly amountMicro: Micro;
  readonly eventType: 'deposit' | 'withdraw';
  readonly txHash?: string | null;
};

export type CollateralResult = {
  readonly idempotent: boolean;
  readonly position: CollateralPosition;
  readonly summary: CollateralSummary;
};

export class LaneLedger {
  private readonly db: Database;
  private readonly trust: TrustStore;
  private readonly currency: string;
  private readonly now: () => Date;

  constructor(options: LaneLedgerOptions) {
    this.db = options.db;
    this.trust = options.trust;
    this.currency = options.currency;
    this.now = options.now ?? (() => new Date());
  }


  async upsertAccount(input: UpsertAccountInput): Promise<Account> {
    const row = await one<AccountRow>(
      this.db,
      `INSERT INTO bursar_accounts (
         agent_id, mandate_account, payer_wallet, repay_wallet, networks,
         per_call_cap_micro, daily_cap_micro, monthly_cap_micro, approval_threshold_micro
       )
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (agent_id) DO UPDATE
       SET mandate_account = EXCLUDED.mandate_account,
           payer_wallet = EXCLUDED.payer_wallet,
           repay_wallet = EXCLUDED.repay_wallet,
           networks = EXCLUDED.networks,
           per_call_cap_micro = EXCLUDED.per_call_cap_micro,
           daily_cap_micro = EXCLUDED.daily_cap_micro,
           monthly_cap_micro = EXCLUDED.monthly_cap_micro,
           approval_threshold_micro = EXCLUDED.approval_threshold_micro,
           updated_at = $10
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        input.agentId,
        input.mandateAccount ?? null,
        input.payerWallet,
        input.repayWallet,
        JSON.stringify(input.networks ?? []),
        optionalAmount(input.perCallCapMicro),
        optionalAmount(input.dailyCapMicro),
        optionalAmount(input.monthlyCapMicro),
        optionalAmount(input.approvalThresholdMicro),
        this.now(),
      ],
    );
    if (!row) throw new LedgerError('account_upsert_failed', `could not write account ${input.agentId}`);
    return toAccount(row);
  }

  async getAccount(agentId: string): Promise<Account | null> {
    const row = await one<AccountRow>(
      this.db,
      `SELECT ${ACCOUNT_COLUMNS} FROM bursar_accounts WHERE agent_id = $1`,
      [agentId],
    );
    return row ? toAccount(row) : null;
  }

  async setAccountStatus(agentId: string, status: 'active' | 'suspended'): Promise<void> {
    await this.db.query(
      'UPDATE bursar_accounts SET status = $2, updated_at = $3 WHERE agent_id = $1',
      [agentId, status, this.now()],
    );
  }

  async upsertPool(pool: Pool): Promise<Pool> {
    if (!laneExtendsCredit(pool.lane) && pool.ltvCapBps !== 0) {
      throw new LaneDoesNotExtendCredit(pool.lane);
    }

    return this.db.transaction(async (client) => {
      const row = await one<PoolRow>(
        client,
        `INSERT INTO bursar_pools (pool_id, lane, status, ltv_cap_bps, min_health_factor, max_single_micro)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (pool_id) DO UPDATE
         SET status = EXCLUDED.status,
             ltv_cap_bps = EXCLUDED.ltv_cap_bps,
             min_health_factor = EXCLUDED.min_health_factor,
             max_single_micro = EXCLUDED.max_single_micro,
             updated_at = $7
         RETURNING ${POOL_COLUMNS}`,
        [
          pool.poolId,
          pool.lane,
          pool.status,
          pool.ltvCapBps,
          pool.minHealthFactor.toFixed(6),
          microToNumeric(pool.maxSingleMicro),
          this.now(),
        ],
      );
      if (!row) throw new LedgerError('pool_upsert_failed', `could not write pool ${pool.poolId}`);
      await ensureReserve(client, pool.poolId, pool.lane);
      return toPool(row);
    });
  }

  async getPool(poolId: string): Promise<Pool | null> {
    const row = await one<PoolRow>(this.db, `SELECT ${POOL_COLUMNS} FROM bursar_pools WHERE pool_id = $1`, [
      poolId,
    ]);
    return row ? toPool(row) : null;
  }

  async getPoolReserve(poolId: string): Promise<PoolReserve | null> {
    const row = await one<PoolReserveRow>(
      this.db,
      `SELECT ${RESERVE_COLUMNS} FROM bursar_pool_reserves WHERE pool_id = $1`,
      [poolId],
    );
    return row ? toPoolReserve(row) : null;
  }

  async getBalance(agentId: string, poolId: string): Promise<LaneBalance | null> {
    const row = await one<LaneBalanceRow>(
      this.db,
      `SELECT ${BALANCE_COLUMNS} FROM bursar_lane_balances WHERE agent_id = $1 AND pool_id = $2`,
      [agentId, poolId],
    );
    return row ? toLaneBalance(row) : null;
  }


  /**
   * Records a confirmed movement of prefunded USDG and moves the balance with it.
   *
   * The caller supplies `referenceId`, normally the transaction hash of the deposit. Replaying it
   * returns the original event, because a client that retries after a timeout must not credit
   * twice. A retry carrying a different amount under the same reference is reporting two different
   * things about one transaction, and is refused.
   */
  async applyFunding(
    input: FundingInput,
  ): Promise<{ readonly idempotent: boolean; readonly event: FundingEvent; readonly balance: LaneBalance }> {
    if (input.amountMicro <= ZERO_MICRO) {
      throw new LedgerError('funding_amount_invalid', 'a funding event must move a positive amount', {
        amountMicro: input.amountMicro.toString(),
      });
    }

    try {
      return await this.fundingTransaction(input);
    } catch (error) {
      // Another request carrying the same reference committed first. Its result is the answer.
      if (!isUniqueViolation(error, 'uq_funding_reference')) throw error;
      return this.fundingTransaction(input);
    }
  }

  private async fundingTransaction(
    input: FundingInput,
  ): Promise<{ readonly idempotent: boolean; readonly event: FundingEvent; readonly balance: LaneBalance }> {
    return this.db.transaction(async (client) => {
      const pool = await lockedPool(client, input.poolId);
      if (pool.lane !== 'prefund') {
        throw new LedgerError(
          'funding_lane_invalid',
          `pool ${input.poolId} is the ${pool.lane} lane; only a prefund pool holds a balance to fund`,
          { poolId: input.poolId, lane: pool.lane },
        );
      }

      const existing = await one<FundingEventRow>(
        client,
        `SELECT ${FUNDING_COLUMNS}
         FROM bursar_funding_events
         WHERE agent_id = $1 AND pool_id = $2 AND reference_id = $3
         FOR UPDATE`,
        [input.agentId, input.poolId, input.referenceId],
      );

      if (existing) {
        const event = toFundingEvent(existing);
        if (event.eventType !== input.eventType || event.amountMicro !== input.amountMicro) {
          throw new LedgerError(
            'funding_reference_conflict',
            `reference ${input.referenceId} already recorded a different ${event.eventType} of ${event.amountMicro} micro-USD`,
            { referenceId: input.referenceId },
          );
        }
        const balance = await readBalance(client, input.agentId, input.poolId);
        return { idempotent: true, event, balance };
      }

      const deposit = input.eventType === 'deposit';
      const balance = await mutateBalance(client, this.now(), {
        agentId: input.agentId,
        poolId: input.poolId,
        availableDelta: deposit ? input.amountMicro : negMicro(input.amountMicro),
        minAvailable: deposit ? undefined : input.amountMicro,
      });
      if (!balance) {
        throw new LedgerError(
          'funding_insufficient_available',
          `${input.agentId} does not hold ${input.amountMicro} micro-USD available in ${input.poolId}`,
          { agentId: input.agentId, poolId: input.poolId, amountMicro: input.amountMicro.toString() },
        );
      }

      const inserted = await one<FundingEventRow>(
        client,
        `INSERT INTO bursar_funding_events (
           agent_id, lane, pool_id, reference_id, event_type, amount_micro, tx_hash, metadata
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         RETURNING ${FUNDING_COLUMNS}`,
        [
          input.agentId,
          pool.lane,
          input.poolId,
          input.referenceId,
          input.eventType,
          microToNumeric(input.amountMicro),
          input.txHash ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      if (!inserted) throw new LedgerError('funding_insert_failed', 'could not record the funding event');

      await this.trust.queue(client, {
        eventType: deposit ? 'prefund_deposited' : 'prefund_withdrawn',
        subject: input.agentId,
        idempotencyKey: `funding:${input.agentId}:${input.poolId}:${input.referenceId}`,
        occurredAt: this.now(),
        lane: pool.lane,
        poolId: input.poolId,
        amountMicro: input.amountMicro,
        currency: this.currency,
        txHash: input.txHash ?? null,
        referenceId: input.referenceId,
        metadata: { availableMicro: balance.availableMicro.toString() },
      });

      return { idempotent: false, event: toFundingEvent(inserted), balance };
    });
  }

  async listFunding(agentId: string, limit = 50, poolId?: string): Promise<readonly FundingEvent[]> {
    const size = Math.max(1, Math.min(limit, 200));
    const rows = await many<FundingEventRow>(
      this.db,
      `SELECT ${FUNDING_COLUMNS}
       FROM bursar_funding_events
       WHERE agent_id = $1 AND ($2::text IS NULL OR pool_id = $2)
       ORDER BY created_at DESC
       LIMIT $3`,
      [agentId, poolId ?? null, size],
    );
    return rows.map(toFundingEvent);
  }


  async recordAuthorization(input: RecordAuthorizationInput): Promise<AuthorizationRecord> {
    const row = await one<AuthorizationRow>(
      this.db,
      `INSERT INTO bursar_authorizations (
         agent_id, payer_wallet, repay_wallet, request_nonce, network, lane, pool_id,
         requested_micro, approved, approved_micro, available_micro, outstanding_micro,
         reason_codes, policy_id, policy_version, ltv_bps, health_factor, request_hash, document_hash
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14,$15,$16,$17,$18,$19)
       ON CONFLICT (payer_wallet, request_nonce) DO NOTHING
       RETURNING ${AUTHORIZATION_COLUMNS}`,
      [
        input.agentId,
        input.payerWallet,
        input.repayWallet,
        input.requestNonce,
        input.network,
        input.lane,
        input.poolId,
        microToNumeric(input.requestedMicro),
        input.approved,
        microToNumeric(input.approvedMicro),
        microToNumeric(input.availableMicro),
        microToNumeric(input.outstandingMicro),
        [...(input.reasonCodes ?? [])],
        input.policyId ?? null,
        input.policyVersion ?? null,
        input.ltvBps ?? null,
        input.healthFactor === null || input.healthFactor === undefined
          ? null
          : input.healthFactor.toFixed(6),
        input.requestHash ?? null,
        input.documentHash ?? null,
      ],
    );

    if (row) return toAuthorization(row);

    // The nonce is already on record. Returning the original decision keeps a retried request
    // pointing at the terms it was actually granted under.
    const existing = await one<AuthorizationRow>(
      this.db,
      `SELECT ${AUTHORIZATION_COLUMNS}
       FROM bursar_authorizations
       WHERE payer_wallet = $1 AND request_nonce = $2`,
      [input.payerWallet, input.requestNonce],
    );
    if (!existing) throw new LedgerError('authorization_write_failed', 'could not record the decision');
    return toAuthorization(existing);
  }

  /**
   * Holds funding for a call that is about to happen.
   *
   * In the prefund lane this moves the amount from available to reserved, and the guard on the
   * UPDATE is what makes two concurrent calls against the same balance safe: the second one finds
   * the available balance already reduced, and fails before it can overdraw.
   *
   * In the collateral lane nothing is held, so the refusals are the risk ones: a suspended account,
   * a draw past what the posted collateral supports at the pool's cap, and a draw that would take
   * the position below the pool's minimum health factor. Holds already open count against both,
   * because each of them becomes a debt the moment its call reports back.
   */
  async openReservation(input: OpenReservationInput): Promise<Reservation> {
    if (input.amountMicro <= ZERO_MICRO) {
      throw new LedgerError('reservation_amount_invalid', 'a reservation must hold a positive amount');
    }

    return this.db.transaction(async (client) => {
      const authorization = await one<AuthorizationRow>(
        client,
        `SELECT ${AUTHORIZATION_COLUMNS} FROM bursar_authorizations WHERE id = $1::uuid FOR UPDATE`,
        [input.authorizationId],
      );
      if (!authorization) {
        throw new LedgerError('authorization_not_found', `no decision ${input.authorizationId}`);
      }

      const decision = toAuthorization(authorization);
      const account = await one<{ status: string; payer_wallet: string; networks: unknown }>(
        client,
        'SELECT status, payer_wallet, networks FROM bursar_accounts WHERE agent_id = $1 FOR UPDATE',
        [decision.agentId],
      );
      if (account?.status !== 'active') {
        throw new LedgerError(
          'account_not_active',
          `${decision.agentId} is ${account?.status ?? 'unknown'} and cannot open a call`,
          { agentId: decision.agentId },
        );
      }
      assertDecisionFitsAccount(decision, account.payer_wallet, account.networks);
      if (!decision.approved) {
        throw new LedgerError('authorization_refused', 'the decision this reservation cites was a refusal', {
          reasonCodes: decision.reasonCodes,
        });
      }
      if (input.amountMicro > decision.approvedMicro) {
        throw new LedgerError(
          'reservation_exceeds_authorization',
          `the decision approved ${decision.approvedMicro} micro-USD, not ${input.amountMicro}`,
          { approvedMicro: decision.approvedMicro.toString(), amountMicro: input.amountMicro.toString() },
        );
      }

      const pool = await lockedPool(client, decision.poolId);
      if (pool.status !== 'active') {
        throw new LedgerError('pool_not_active', `pool ${pool.poolId} is ${pool.status}`, {
          poolId: pool.poolId,
        });
      }
      if (input.amountMicro > pool.maxSingleMicro) {
        throw new LedgerError(
          'reservation_exceeds_pool_limit',
          `pool ${pool.poolId} caps a single call at ${pool.maxSingleMicro} micro-USD`,
          { maxSingleMicro: pool.maxSingleMicro.toString() },
        );
      }

      if (pool.lane === 'collateral') {
        await this.assertBorrowable(client, decision.agentId, pool, input.amountMicro);
      }

      const locked = pool.lane === 'prefund' ? input.amountMicro : ZERO_MICRO;
      const expiresAt = new Date(this.now().getTime() + Math.max(1_000, input.ttlMs));

      const row = await one<ReservationRow>(
        client,
        `INSERT INTO bursar_reservations (
           authorization_id, agent_id, payer_wallet, merchant_wallet, request_nonce,
           network, lane, pool_id, amount_micro, locked_micro, expires_at
         )
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (payer_wallet, request_nonce) DO NOTHING
         RETURNING ${RESERVATION_COLUMNS}`,
        [
          decision.id,
          decision.agentId,
          decision.payerWallet,
          input.merchantWallet,
          decision.requestNonce,
          decision.network,
          pool.lane,
          pool.poolId,
          microToNumeric(input.amountMicro),
          microToNumeric(locked),
          expiresAt,
        ],
      );
      // The nonce already has a hold. Returning it leaves the funds locked once, which is what
      // makes a retried open safe.
      if (!row) {
        const existing = await one<ReservationRow>(
          client,
          `SELECT ${RESERVATION_COLUMNS}
           FROM bursar_reservations
           WHERE payer_wallet = $1 AND request_nonce = $2`,
          [decision.payerWallet, decision.requestNonce],
        );
        if (!existing) throw new LedgerError('reservation_insert_failed', 'could not open the reservation');
        return toReservation(existing);
      }

      await bumpReserve(client, this.now(), {
        poolId: pool.poolId,
        lane: pool.lane,
        reservedDelta: input.amountMicro,
      });

      if (pool.lane === 'prefund') {
        const balance = await mutateBalance(client, this.now(), {
          agentId: decision.agentId,
          poolId: pool.poolId,
          availableDelta: negMicro(locked),
          reservedDelta: locked,
          minAvailable: locked,
        });
        if (!balance) {
          throw new LedgerError(
            'prefund_insufficient',
            `${decision.agentId} does not hold ${locked} micro-USD available in ${pool.poolId}`,
            { agentId: decision.agentId, poolId: pool.poolId, requiredMicro: locked.toString() },
          );
        }
      }

      return toReservation(row);
    });
  }

  /**
   * Whether the collateral behind an agent can carry one more draw of this size.
   *
   * Measured against debt already open plus every hold still outstanding, since a hold is a debt
   * that has not reported back yet. The pool row is locked by the caller, so two draws arriving
   * together queue and each sees the headroom the other left.
   */
  private async assertBorrowable(
    client: Queryable,
    agentId: string,
    pool: Pool,
    amountMicro: Micro,
  ): Promise<void> {
    const summary = await this.collateralSummary(client, agentId, pool.poolId);
    const held = await sumOpenHolds(client, agentId, pool.poolId);
    const committed = addMicro(summary.outstandingMicro, held);

    const headroom = borrowingHeadroom(summary.effectiveCollateralMicro, committed, pool.ltvCapBps);
    if (amountMicro > headroom) {
      throw new LedgerError(
        'collateral_headroom_exceeded',
        `${agentId} can draw ${headroom} micro-USD more against its collateral in ${pool.poolId}, not ${amountMicro}`,
        {
          agentId,
          poolId: pool.poolId,
          headroomMicro: headroom.toString(),
          amountMicro: amountMicro.toString(),
          effectiveCollateralMicro: summary.effectiveCollateralMicro.toString(),
          committedMicro: committed.toString(),
        },
      );
    }

    const projected = healthFactor(
      addMicro(committed, amountMicro),
      summary.effectiveCollateralMicro,
      pool.ltvCapBps,
    );
    if (projected !== null && projected < pool.minHealthFactor) {
      throw new LedgerError(
        'health_factor_below_minimum',
        `this draw would leave ${agentId} at a health factor of ${projected.toFixed(6)}, under the ${pool.minHealthFactor} ${pool.poolId} requires`,
        {
          agentId,
          poolId: pool.poolId,
          healthFactor: projected,
          minHealthFactor: pool.minHealthFactor,
        },
      );
    }
  }

  async getReservation(id: string): Promise<Reservation | null> {
    const row = await one<ReservationRow>(
      this.db,
      `SELECT ${RESERVATION_COLUMNS} FROM bursar_reservations WHERE id = $1::uuid`,
      [id],
    );
    return row ? toReservation(row) : null;
  }

  /**
   * Gives a hold back. A reservation that was never consumed costs the principal nothing.
   *
   * A claimed hold is not given back: a settle has already committed to broadcasting against it,
   * and releasing the funds while that transfer may land pays the merchant from a balance the
   * ledger has just returned to the payer. The claim clears itself if nothing was broadcast.
   */
  async releaseReservation(id: string, status: 'released' | 'expired' = 'released'): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const row = await one<ReservationRow>(
        client,
        `UPDATE bursar_reservations
         SET status = $2, updated_at = $3
         WHERE id = $1::uuid AND status = 'reserved' AND settle_claim IS NULL
         RETURNING ${RESERVATION_COLUMNS}`,
        [id, status, this.now()],
      );
      if (!row) return false;
      await this.unwind(client, toReservation(row));
      return true;
    });
  }

  /**
   * Releases every hold that has outlasted its window, except those a settle has claimed.
   *
   * A call that never reports back would otherwise keep a principal's balance locked for ever. A
   * claimed hold is waiting on a receipt, and expiring it mid-wait hands the balance back while the
   * transfer lands; reconciliation settles or unclaims it instead.
   * `FacilitatorService.start` runs this on a timer; `POST /reservations/expire` is the same sweep
   * for an operator or a cron entry driving it from outside.
   */
  async expireReservations(limit = 200): Promise<number> {
    const size = Math.max(1, Math.min(limit, 1_000));
    return this.db.transaction(async (client) => {
      const rows = await many<ReservationRow>(
        client,
        `WITH stale AS (
           SELECT id FROM bursar_reservations
           WHERE status = 'reserved' AND expires_at <= $1 AND settle_claim IS NULL
           ORDER BY expires_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE bursar_reservations
         SET status = 'expired', updated_at = $1
         WHERE id IN (SELECT id FROM stale)
         RETURNING ${RESERVATION_COLUMNS}`,
        [this.now(), size],
      );

      for (const row of rows) {
        await this.unwind(client, toReservation(row));
      }
      return rows.length;
    });
  }

  /** Returns a released or expired hold to whatever it came from. */
  private async unwind(client: Queryable, reservation: Reservation): Promise<void> {
    await bumpReserve(client, this.now(), {
      poolId: reservation.poolId,
      lane: reservation.lane,
      reservedDelta: negMicro(reservation.amountMicro),
    });

    if (reservation.lane !== 'prefund' || reservation.lockedMicro <= ZERO_MICRO) return;

    const balance = await mutateBalance(client, this.now(), {
      agentId: reservation.agentId,
      poolId: reservation.poolId,
      availableDelta: reservation.lockedMicro,
      reservedDelta: negMicro(reservation.lockedMicro),
      minReserved: reservation.lockedMicro,
    });
    if (!balance) {
      throw new LedgerError(
        'prefund_release_failed',
        `reservation ${reservation.id} holds ${reservation.lockedMicro} micro-USD that the balance does not show as reserved`,
        { reservationId: reservation.id },
      );
    }
  }


  /**
   * Turns a hold into an obligation.
   *
   * The settlement is recorded as `authorized`, not `settled`. In the prefund and collateral lanes
   * nothing has moved on chain at this point: the principal's balance has been spent against, or a
   * debt has been opened, and the merchant is paid net later. Calling that "settled" would make
   * the ledger claim a transfer that does not exist.
   */
  async consumeReservation(input: ConsumeReservationInput): Promise<ConsumeResult> {
    try {
      return await this.db.transaction((client) => this.consumeLocked(client, input));
    } catch (error) {
      if (!(error instanceof ReservationExpired)) throw error;
      await this.releaseReservation(error.reservation.id, 'expired');
      throw new LedgerError(
        'reservation_expired',
        `reservation ${error.reservation.id} expired before it was used`,
        { expiresAt: error.reservation.expiresAt.toISOString() },
      );
    }
  }

  /**
   * Claims a hold for the settle that is about to broadcast against it.
   *
   * The settle's replay-guard row goes onto the reservation in one conditional UPDATE, so of two
   * settles naming the same hold exactly one gets a row back and the other is refused before it
   * spends anything. The hold has to outlast `minRemainingMs` as well: a settle waits on its receipt
   * for up to that long, and a claim taken on a hold about to lapse would keep the balance locked
   * past the window the payer agreed to. Null when the hold cannot be claimed.
   */
  async claimReservation(input: ClaimReservationInput): Promise<string | null> {
    const now = this.now();
    const row = await one<{ claim: string }>(
      this.db,
      `UPDATE bursar_reservations r
       SET settle_claim = g.id, updated_at = $5
       FROM bursar_payment_guard g
       WHERE r.id = $1::uuid
         AND r.status = 'reserved'
         AND r.settle_claim IS NULL
         AND r.expires_at > $6
         AND g.network = $2 AND g.payer_wallet = $3 AND g.nonce = $4
         AND g.settlement_id IS NULL
       RETURNING g.id::text AS claim`,
      [
        input.reservationId,
        input.network,
        input.payerWallet.toLowerCase(),
        input.nonce.toLowerCase(),
        now,
        new Date(now.getTime() + Math.max(0, input.minRemainingMs)),
      ],
    );
    return row?.claim ?? null;
  }

  /**
   * Consumes a claimed hold and marks the settlement paid, for a transfer that is on chain.
   *
   * One transaction. Consuming and marking separately left a window in which the settlement sat
   * `authorized` with its transfer already landed, and `/settlements/net` pays out exactly those
   * rows: a netting run in the gap paid the merchant a second time. The fee row, the trust event
   * and the guard row's link to the settlement commit with it.
   */
  async settleReservation(input: SettleReservationInput): Promise<ConsumeResult> {
    return this.db.transaction(async (client) => {
      const consumed = await this.consumeLocked(client, input);

      // A consume that found the hold already closed hands back the settlement it was closed with,
      // and that one has been paid. Marking it again would refuse the whole batch.
      const [settled] =
        consumed.settlement.status === 'authorized'
          ? await this.markSettledIn(client, {
              settlementIds: [consumed.settlement.id],
              txHash: input.txHash,
              treasury: input.treasury,
            })
          : [consumed.settlement];
      const settlement = settled ?? consumed.settlement;

      await client.query(
        `UPDATE bursar_payment_guard SET settlement_id = $2::uuid, tx_hash = $3 WHERE id = $1::uuid`,
        [input.claim, settlement.id, input.txHash],
      );
      return { ...consumed, settlement };
    });
  }

  private async consumeLocked(client: Queryable, input: ConsumeReservationInput): Promise<ConsumeResult> {
    const row = await one<ReservationRow & { settle_claim: string | null }>(
      client,
      `SELECT ${RESERVATION_COLUMNS}, settle_claim::text AS settle_claim
       FROM bursar_reservations WHERE id = $1::uuid FOR UPDATE`,
      [input.reservationId],
    );
    if (!row) throw new LedgerError('reservation_not_found', `no reservation ${input.reservationId}`);

    const reservation = toReservation(row);
    assertPaysTheHold(reservation, input.payment);

    // Only the settle holding the claim closes a claimed hold. Anyone else consuming it, the net
    // lane's consume route included, would record a second settlement for the one transfer the
    // claimant is broadcasting. A claim that no longer matches is one reconciliation released.
    const claim = input.claim ?? null;
    if (row.settle_claim !== claim) {
      throw new LedgerError(
        'reservation_claimed',
        row.settle_claim === null
          ? `reservation ${reservation.id} is not claimed by this settlement`
          : `reservation ${reservation.id} is being settled by another payment`,
        { reservationId: reservation.id },
      );
    }

    if (reservation.status === 'consumed' && reservation.settlementId) {
      // Already done. Handing back the same settlement makes a retried consume a no-op.
      const settlement = await readSettlement(client, reservation.settlementId);
      const debt = await readDebtBySettlement(client, reservation.settlementId);
      return { reservation, settlement, debt };
    }
    if (reservation.status !== 'reserved') {
      throw new LedgerError(`reservation_${reservation.status}`, `reservation ${reservation.id} is ${reservation.status}`);
    }

    // Releasing the hold here would be undone by the rollback the throw below causes, so the
    // caller does it once this transaction has ended. A claimed hold is exempt: its settle had
    // the time it needed when it claimed, and the transfer may already have landed.
    if (claim === null && reservation.expiresAt.getTime() <= this.now().getTime()) {
      throw new ReservationExpired(reservation);
    }

    // A fee equal to the payment is a call the merchant was paid nothing for. The floor that
    // produces one belongs to the direct lane, where a broadcast is paid for per call; reaching
    // this with the whole amount as fee means it was applied where it does not belong.
    if (input.feeMicro >= reservation.amountMicro) {
      throw new LedgerError('fee_exceeds_amount', 'the facilitator fee cannot take the whole payment', {
        feeMicro: input.feeMicro.toString(),
        amountMicro: reservation.amountMicro.toString(),
      });
    }

    const settlementRow = await one<SettlementRow>(
      client,
      `INSERT INTO bursar_settlements (
         network, asset, payer_wallet, merchant_wallet, amount_micro, fee_micro, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,'authorized')
       RETURNING ${SETTLEMENT_COLUMNS}`,
      [
        reservation.network,
        input.asset,
        reservation.payerWallet,
        reservation.merchantWallet,
        microToNumeric(reservation.amountMicro),
        microToNumeric(input.feeMicro),
      ],
    );
    if (!settlementRow) throw new LedgerError('settlement_insert_failed', 'could not record the settlement');
    const settlement = toSettlement(settlementRow);

    // One order for the tables every path here shares: collateral positions, then the pool
    // aggregate, then lane balances. `applyCollateral` takes positions before the aggregate and
    // `openReservation` takes the aggregate before balances, so a consume that bumped the
    // aggregate first, or balances first, deadlocks against one of them for the same agent. Only
    // one of the two lane branches runs, which is what lets the aggregate sit between them.
    let debt: Debt | null = null;
    if (reservation.lane === 'collateral') {
      debt = await this.openDebt(client, reservation, settlement.id);
    }

    await bumpReserve(client, this.now(), {
      poolId: reservation.poolId,
      lane: reservation.lane,
      reservedDelta: negMicro(reservation.amountMicro),
      outstandingDelta: debt ? reservation.amountMicro : ZERO_MICRO,
    });

    if (reservation.lane === 'prefund') {
      const balance = await mutateBalance(client, this.now(), {
        agentId: reservation.agentId,
        poolId: reservation.poolId,
        reservedDelta: negMicro(reservation.lockedMicro),
        spentDelta: reservation.lockedMicro,
        minReserved: reservation.lockedMicro,
      });
      if (!balance) {
        throw new LedgerError(
          'prefund_consume_failed',
          `reservation ${reservation.id} holds ${reservation.lockedMicro} micro-USD that the balance does not show as reserved`,
        );
      }
    }
    // The direct lane consumes nothing: the payer's own authorisation carries the money.

    await client.query(
      `UPDATE bursar_reservations
       SET status = 'consumed', settlement_id = $2::uuid, updated_at = $3
       WHERE id = $1::uuid`,
      [reservation.id, settlement.id, this.now()],
    );

    await client.query(
      `INSERT INTO bursar_billable_events (
         reservation_id, settlement_id, debt_id, agent_id, payer_wallet, merchant_wallet,
         network, lane, pool_id, amount_micro, idempotency_key, payload
       )
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (reservation_id, settlement_id) DO NOTHING`,
      [
        reservation.id,
        settlement.id,
        debt?.id ?? null,
        reservation.agentId,
        reservation.payerWallet,
        reservation.merchantWallet,
        reservation.network,
        reservation.lane,
        reservation.poolId,
        microToNumeric(reservation.amountMicro),
        `${reservation.id}:${settlement.id}`,
        JSON.stringify({
          reservationId: reservation.id,
          settlementId: settlement.id,
          debtId: debt?.id ?? null,
          authorizationId: reservation.authorizationId,
          lane: reservation.lane,
          poolId: reservation.poolId,
          amountMicro: reservation.amountMicro.toString(),
          feeMicro: input.feeMicro.toString(),
        }),
      ],
    );

    return {
      reservation: { ...reservation, status: 'consumed', settlementId: settlement.id },
      settlement,
      debt,
    };
  }

  /**
   * Opens the debt and locks the collateral that backs it, in the one transaction.
   *
   * Without the lock the withdrawal guard in `applyCollateral` reads `deposited - withdrawn`, which
   * lets an agent take back every unit of collateral while still owing on it. The amount locked is
   * the principal grossed up by each asset's haircut, so what is held back is the posted value that
   * the debt consumes.
   */
  private async openDebt(client: Queryable, reservation: Reservation, settlementId: string): Promise<Debt> {
    if (!laneExtendsCredit(reservation.lane)) throw new LaneDoesNotExtendCredit(reservation.lane);

    const authorization = await one<{ repay_wallet: string }>(
      client,
      'SELECT repay_wallet FROM bursar_authorizations WHERE id = $1::uuid',
      [reservation.authorizationId],
    );

    const row = await one<DebtRow>(
      client,
      `INSERT INTO bursar_debts (
         agent_id, payer_wallet, repay_wallet, network, lane, pool_id,
         settlement_id, authorization_id, reservation_id, principal_micro, outstanding_micro
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9::uuid,$10,$10)
       ON CONFLICT (settlement_id) DO UPDATE SET updated_at = NOW()
       RETURNING ${DEBT_COLUMNS}`,
      [
        reservation.agentId,
        reservation.payerWallet,
        authorization?.repay_wallet ?? reservation.payerWallet,
        reservation.network,
        reservation.lane,
        reservation.poolId,
        settlementId,
        reservation.authorizationId,
        reservation.id,
        microToNumeric(reservation.amountMicro),
      ],
    );
    if (!row) throw new LedgerError('debt_insert_failed', 'could not open the debt');

    const debt = toDebt(row);
    await lockCollateral(client, this.now(), debt);
    return debt;
  }

  /**
   * Records a call that settled on chain in one transaction, with no hold behind it.
   *
   * This is the direct lane: the payer signed an authorisation, the facilitator broadcast it, and
   * the money has already moved. Nothing is owed and nothing is held.
   */
  async recordDirectSettlement(input: DirectSettlementInput): Promise<Settlement> {
    if (input.feeMicro >= input.amountMicro) {
      throw new LedgerError('fee_exceeds_amount', 'the facilitator fee cannot take the whole payment', {
        feeMicro: input.feeMicro.toString(),
        amountMicro: input.amountMicro.toString(),
      });
    }

    return this.db.transaction(async (client) => {
      const now = this.now();
      const row = await one<SettlementRow>(
        client,
        `INSERT INTO bursar_settlements (
           network, asset, payer_wallet, merchant_wallet, amount_micro, fee_micro,
           status, tx_hash, settle_nonce, settled_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,'settled',$7,$8,$9)
         ON CONFLICT (network, lower(payer_wallet), settle_nonce) WHERE settle_nonce IS NOT NULL DO NOTHING
         RETURNING ${SETTLEMENT_COLUMNS}`,
        [
          input.network,
          input.asset,
          input.payerWallet,
          input.merchantWallet,
          microToNumeric(input.amountMicro),
          microToNumeric(input.feeMicro),
          input.txHash,
          input.nonce.toLowerCase(),
          now,
        ],
      );

      if (!row) {
        // The authorisation is already spent, which means this settle was retried. Matched on the
        // payer too, since a nonce is only unique to the wallet that signed it.
        const existing = await one<SettlementRow>(
          client,
          `SELECT ${SETTLEMENT_COLUMNS} FROM bursar_settlements
           WHERE network = $1 AND lower(payer_wallet) = $2 AND settle_nonce = $3`,
          [input.network, input.payerWallet.toLowerCase(), input.nonce.toLowerCase()],
        );
        if (!existing) throw new LedgerError('settlement_insert_failed', 'could not record the settlement');
        return toSettlement(existing);
      }

      const settlement = toSettlement(row);
      // Keyed on all three columns the claim was made under. A nonce is unique to a payer, not to a
      // network: two payers can hold one, because a payload carrying no binding object derives its
      // nonce from the request digest and an all-zero salt. Stamping on (network, nonce) alone puts
      // this settlement on the other payer's row, which `releasePaymentNonce` then refuses to
      // release and which locks that payer out of the nonce for good. The guard row was written
      // with a lowercased wallet and nonce, so this matches on the same spelling.
      await client.query(
        `UPDATE bursar_payment_guard
         SET settlement_id = $4::uuid, tx_hash = $5
         WHERE network = $1 AND payer_wallet = $2 AND nonce = $3`,
        [
          input.network,
          input.payerWallet.toLowerCase(),
          input.nonce.toLowerCase(),
          settlement.id,
          input.txHash,
        ],
      );

      // On this transaction, not a later one. `TrustStore.queue` exists so that a settlement and
      // the event announcing it commit together; announcing afterwards leaves a payment that
      // landed with no event and no fee row whenever the process dies in between.
      await this.announce(client, settlement, input.treasury);
      return settlement;
    });
  }


  /**
   * Marks authorised settlements as paid, once the transfer that covers them is on chain.
   *
   * One transaction can cover many calls. That is what the prefund lane buys: one broadcast, and
   * the ETH it costs the relayer, for the whole batch. The trust event is emitted here and not at
   * consume time, because this is the moment the merchant actually has the money.
   */
  async markSettled(input: {
    readonly settlementIds: readonly string[];
    readonly txHash: string;
    readonly treasury: string;
  }): Promise<readonly Settlement[]> {
    if (input.settlementIds.length === 0) return [];
    return this.db.transaction((client) => this.markSettledIn(client, input));
  }

  private async markSettledIn(
    client: Queryable,
    input: { readonly settlementIds: readonly string[]; readonly txHash: string; readonly treasury: string },
  ): Promise<readonly Settlement[]> {
    const wanted = new Set(input.settlementIds);
    const now = this.now();
    const rows = await many<SettlementRow>(
      client,
      `UPDATE bursar_settlements
       SET status = 'settled', tx_hash = $2, settled_at = $3, updated_at = $3
       WHERE id = ANY($1::uuid[]) AND status = 'authorized'
       RETURNING ${SETTLEMENT_COLUMNS}`,
      [[...wanted], input.txHash, now],
    );

    // Every id or none. An id the UPDATE missed is either one another transfer already settled,
    // which this batch is about to pay a second time, or one this transfer never covered, which
    // would be stamped paid and leave the merchant waiting on money that is not coming. Both
    // directions lose somebody's money, and the batch is the only place either is visible.
    if (rows.length !== wanted.size) {
      const matched = new Set(rows.map((row) => row.id));
      const unmatched = [...wanted].filter((id) => !matched.has(id));
      throw new LedgerError(
        'settlement_not_authorized',
        `${unmatched.length} of ${wanted.size} settlements in this batch are not awaiting payment: ${unmatched.join(', ')}. GET /settlements/pending/{merchant} lists what is authorised and unpaid.`,
        { settlementIds: unmatched, txHash: input.txHash },
      );
    }

    const settled = rows.map(toSettlement);
    for (const settlement of settled) {
      await this.announce(client, settlement, input.treasury, input.txHash);
    }
    return settled;
  }

  /** The fee owed on a settled payment and the event announcing it, on the caller's transaction. */
  private async announce(
    client: Queryable,
    settlement: Settlement,
    treasury: string,
    txHash: string | null = settlement.txHash,
  ): Promise<void> {
    if (settlement.feeMicro > ZERO_MICRO) {
      await client.query(
        `INSERT INTO bursar_fee_ledger (settlement_id, fee_type, amount_micro, treasury, treasury_tx)
         VALUES ($1::uuid, 'settlement', $2, $3, $4)
         ON CONFLICT (settlement_id, fee_type) DO NOTHING`,
        [settlement.id, microToNumeric(settlement.feeMicro), treasury, txHash],
      );
    }
    await this.queueSettlementEvent(client, settlement);
  }

  private async queueSettlementEvent(client: Queryable, settlement: Settlement): Promise<void> {
    const context = await one<{
      agent_id: string;
      lane: LaneMode;
      pool_id: string;
      reservation_id: string;
      repay_wallet: string;
      debt_id: string | null;
    }>(
      client,
      `SELECT r.agent_id, r.lane, r.pool_id, r.id::text AS reservation_id,
              a.repay_wallet, d.id::text AS debt_id
       FROM bursar_reservations r
       INNER JOIN bursar_authorizations a ON a.id = r.authorization_id
       LEFT JOIN bursar_debts d ON d.settlement_id = r.settlement_id
       WHERE r.settlement_id = $1::uuid`,
      [settlement.id],
    );

    await this.trust.queue(client, {
      eventType: 'settlement_confirmed',
      // The direct lane has no account behind it; the payer wallet is the only subject there is.
      subject: context?.agent_id ?? settlement.payerWallet,
      idempotencyKey: `settlement:${settlement.id}`,
      occurredAt: settlement.settledAt ?? this.now(),
      lane: context?.lane ?? 'direct',
      poolId: context?.pool_id ?? 'direct',
      network: settlement.network,
      amountMicro: settlement.amountMicro,
      currency: this.currency,
      txHash: settlement.txHash,
      settlementId: settlement.id,
      reservationId: context?.reservation_id ?? null,
      debtId: context?.debt_id ?? null,
      payerWallet: settlement.payerWallet,
      repayWallet: context?.repay_wallet ?? null,
      merchantWallet: settlement.merchantWallet,
      assetId: settlement.asset,
      metadata: { feeMicro: settlement.feeMicro.toString() },
    });
  }

  async listAuthorizedSettlements(
    merchantWallet: string,
    limit = 100,
  ): Promise<readonly Settlement[]> {
    const size = Math.max(1, Math.min(limit, 500));
    const rows = await many<SettlementRow>(
      this.db,
      `SELECT ${SETTLEMENT_COLUMNS}
       FROM bursar_settlements
       WHERE merchant_wallet = $1 AND status = 'authorized'
       ORDER BY created_at ASC
       LIMIT $2`,
      [merchantWallet, size],
    );
    return rows.map(toSettlement);
  }


  async outstandingMicro(agentId: string, poolId?: string): Promise<Micro> {
    const row = await one<{ outstanding: string | null }>(
      this.db,
      `SELECT SUM(outstanding_micro)::text AS outstanding
       FROM bursar_debts
       WHERE agent_id = $1 AND status = 'open' AND ($2::text IS NULL OR pool_id = $2)`,
      [agentId, poolId ?? null],
    );
    return sumToMicro(row?.outstanding, 'outstanding_micro');
  }

  /**
   * Applies a payment to open debts, oldest first.
   *
   * Debts are locked in age order before anything is written, so two repayments arriving together
   * queue behind each other instead of both reading the same outstanding balance. Money that
   * arrives with no debt left to meet is recorded as received and unapplied. Refusing it would
   * leave a real transfer with nothing on the ledger to point at.
   */
  async applyRepayment(input: RepaymentInput): Promise<RepaymentResult> {
    if (input.amountMicro <= ZERO_MICRO) {
      throw new LedgerError('repayment_amount_invalid', 'a repayment must be a positive amount');
    }

    try {
      return await this.repaymentTransaction(input);
    } catch (error) {
      if (!isUniqueViolation(error, 'uq_repayment_reference')) throw error;
      return this.repaymentTransaction(input);
    }
  }

  private async repaymentTransaction(input: RepaymentInput): Promise<RepaymentResult> {
    return this.db.transaction(async (client) => {
      const existing = await one<RepaymentRow>(
        client,
        `SELECT ${REPAYMENT_COLUMNS}
         FROM bursar_repayments
         WHERE agent_id = $1 AND reference_id = $2
         FOR UPDATE`,
        [input.agentId, input.referenceId],
      );

      if (existing) {
        return {
          repayment: toRepayment(existing),
          idempotent: true,
          outstandingMicro: await sumOutstanding(client, input.agentId, input.poolId),
        };
      }

      const openDebts = await many<DebtRow>(
        client,
        `SELECT ${DEBT_COLUMNS}
         FROM bursar_debts
         WHERE agent_id = $1 AND status = 'open' AND ($2::text IS NULL OR pool_id = $2)
         ORDER BY created_at ASC, id ASC
         FOR UPDATE`,
        [input.agentId, input.poolId ?? null],
      );

      const debts = openDebts.map(toDebt);
      const allocation = allocateRepayment(
        debts.map((debt) => ({ id: debt.id, outstandingMicro: debt.outstandingMicro })),
        input.amountMicro,
      );

      const byPool = new Map<string, Micro>();
      const byId = new Map(debts.map((debt) => [debt.id, debt]));

      for (const application of allocation.applications) {
        await client.query(
          `UPDATE bursar_debts
           SET outstanding_micro = $2,
               status = $3,
               closed_at = $4,
               updated_at = $5
           WHERE id = $1::uuid`,
          [
            application.debtId,
            microToNumeric(application.remainingMicro),
            application.closes ? 'closed' : 'open',
            application.closes ? this.now() : null,
            this.now(),
          ],
        );

        // The collateral a debt held comes back the moment the debt is met, and not before: a
        // partly repaid debt is still owed in full as far as its backing is concerned.
        if (application.closes) await releaseCollateral(client, this.now(), application.debtId);

        const debt = byId.get(application.debtId);
        if (!debt) continue;
        byPool.set(debt.poolId, addMicro(byPool.get(debt.poolId) ?? ZERO_MICRO, application.appliedMicro));
      }

      for (const [poolId, amount] of byPool) {
        await bumpReserve(client, this.now(), {
          poolId,
          lane: 'collateral',
          outstandingDelta: negMicro(amount),
        });
      }

      const first = allocation.applications[0];
      const primary = first ? byId.get(first.debtId) ?? null : null;

      const inserted = await one<RepaymentRow>(
        client,
        `INSERT INTO bursar_repayments (
           agent_id, debt_id, pool_id, reference_id, source, amount_micro, applied_micro, tx_hash
         )
         VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8)
         RETURNING ${REPAYMENT_COLUMNS}`,
        [
          input.agentId,
          primary?.id ?? null,
          input.poolId ?? primary?.poolId ?? null,
          input.referenceId,
          input.source,
          microToNumeric(input.amountMicro),
          microToNumeric(allocation.appliedMicro),
          input.txHash ?? null,
        ],
      );
      if (!inserted) throw new LedgerError('repayment_insert_failed', 'could not record the repayment');
      const repayment = toRepayment(inserted);

      if (allocation.appliedMicro > ZERO_MICRO && primary) {
        await this.trust.queue(client, {
          eventType: 'repayment_received',
          subject: input.agentId,
          idempotencyKey: `repayment:${input.agentId}:${input.referenceId}`,
          occurredAt: repayment.createdAt,
          lane: 'collateral',
          poolId: primary.poolId,
          network: primary.network,
          amountMicro: allocation.appliedMicro,
          currency: this.currency,
          txHash: input.txHash ?? null,
          referenceId: input.referenceId,
          debtId: primary.id,
          payerWallet: primary.payerWallet,
          repayWallet: primary.repayWallet,
          metadata: {
            source: input.source,
            receivedMicro: input.amountMicro.toString(),
            unappliedMicro: allocation.unappliedMicro.toString(),
            debtsTouched: allocation.applications.length,
          },
        });
      }

      return {
        repayment,
        idempotent: false,
        outstandingMicro: await sumOutstanding(client, input.agentId, input.poolId),
      };
    });
  }

  /**
   * Records posted or withdrawn collateral and recomputes what it backs.
   *
   * A withdrawal is guarded in the UPDATE itself: the row only moves if it still has enough free
   * value after everything already locked. Checking first and writing second would let two
   * withdrawals both pass the check.
   */
  async applyCollateral(input: CollateralInput): Promise<CollateralResult> {
    if (input.amountMicro <= ZERO_MICRO) {
      throw new LedgerError('collateral_amount_invalid', 'a collateral event must move a positive amount');
    }

    try {
      return await this.collateralTransaction(input);
    } catch (error) {
      if (!isUniqueViolation(error, 'uq_collateral_event_reference')) throw error;
      return this.collateralTransaction(input);
    }
  }

  private async collateralTransaction(input: CollateralInput): Promise<CollateralResult> {
    return this.db.transaction(async (client) => {
      const pool = await lockedPool(client, input.poolId);
      if (!laneExtendsCredit(pool.lane)) throw new LaneDoesNotExtendCredit(pool.lane);

      const seen = await one<{ event_type: string; amount_micro: string }>(
        client,
        `SELECT event_type, amount_micro::text
         FROM bursar_collateral_events
         WHERE agent_id = $1 AND reference_id = $2
         FOR UPDATE`,
        [input.agentId, input.referenceId],
      );

      if (seen) {
        const position = await readPosition(client, input);
        const summary = await this.collateralSummary(client, input.agentId, input.poolId);
        return { idempotent: true, position, summary };
      }

      const assetRow = await one<CollateralAssetRow>(
        client,
        `SELECT asset_id, symbol, chain, haircut_bps, volatility_buffer_bps, status
         FROM bursar_collateral_assets WHERE asset_id = $1`,
        [input.assetId],
      );
      if (!assetRow || assetRow.status !== 'active') {
        throw new LedgerError('collateral_asset_not_supported', `${input.assetId} is not accepted as collateral`, {
          assetId: input.assetId,
        });
      }
      const asset = toCollateralAsset(assetRow);

      const deposit = input.eventType === 'deposit';
      const positionRow = deposit
        ? await one<CollateralPositionRow>(
            client,
            `INSERT INTO bursar_collateral_positions (
               agent_id, pool_id, collateral_account, asset_id, deposited_micro
             )
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (agent_id, pool_id, collateral_account, asset_id) DO UPDATE
             SET deposited_micro = bursar_collateral_positions.deposited_micro + EXCLUDED.deposited_micro,
                 updated_at = $6
             RETURNING ${POSITION_COLUMNS}`,
            [
              input.agentId,
              input.poolId,
              input.collateralAccount,
              input.assetId,
              microToNumeric(input.amountMicro),
              this.now(),
            ],
          )
        : await one<CollateralPositionRow>(
            client,
            `UPDATE bursar_collateral_positions
             SET withdrawn_micro = withdrawn_micro + $5::numeric, updated_at = $6
             WHERE agent_id = $1 AND pool_id = $2 AND collateral_account = $3 AND asset_id = $4
               AND status = 'active'
               AND deposited_micro - withdrawn_micro - locked_micro >= $5::numeric
             RETURNING ${POSITION_COLUMNS}`,
            [
              input.agentId,
              input.poolId,
              input.collateralAccount,
              input.assetId,
              microToNumeric(input.amountMicro),
              this.now(),
            ],
          );

      if (!positionRow) {
        throw new LedgerError(
          'collateral_withdraw_insufficient',
          `${input.collateralAccount} does not hold ${input.amountMicro} micro-USD free in ${input.poolId}`,
          { agentId: input.agentId, poolId: input.poolId },
        );
      }

      await client.query(
        `INSERT INTO bursar_collateral_events (
           agent_id, pool_id, lane, collateral_account, asset_id,
           reference_id, event_type, amount_micro, tx_hash
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.agentId,
          input.poolId,
          pool.lane,
          input.collateralAccount,
          input.assetId,
          input.referenceId,
          input.eventType,
          microToNumeric(input.amountMicro),
          input.txHash ?? null,
        ],
      );

      const backing = effectiveCollateral(input.amountMicro, asset.haircutBps);
      await bumpReserve(client, this.now(), {
        poolId: input.poolId,
        lane: pool.lane,
        collateralDelta: deposit ? backing : negMicro(backing),
      });

      const summary = await this.collateralSummary(client, input.agentId, input.poolId);
      if (!deposit) await this.assertBackingRemains(client, input.agentId, pool, summary);

      await client.query(
        `INSERT INTO bursar_health_snapshots (
           agent_id, lane, pool_id, collateral_value_micro, outstanding_micro,
           ltv_bps, health_factor, source
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,'facilitator')`,
        [
          input.agentId,
          pool.lane,
          input.poolId,
          microToNumeric(summary.effectiveCollateralMicro),
          microToNumeric(summary.outstandingMicro),
          summary.ltvBps,
          summary.healthFactor === null ? null : summary.healthFactor.toFixed(6),
        ],
      );

      await this.trust.queue(client, {
        eventType: deposit ? 'collateral_deposited' : 'collateral_withdrawn',
        subject: input.agentId,
        idempotencyKey: `collateral:${input.agentId}:${input.referenceId}`,
        occurredAt: this.now(),
        lane: pool.lane,
        poolId: input.poolId,
        amountMicro: input.amountMicro,
        currency: asset.symbol,
        txHash: input.txHash ?? null,
        referenceId: input.referenceId,
        collateralAccount: input.collateralAccount,
        assetId: input.assetId,
        metadata: {
          ltvBps: summary.ltvBps,
          healthFactor: summary.healthFactor,
          effectiveCollateralMicro: summary.effectiveCollateralMicro.toString(),
          outstandingMicro: summary.outstandingMicro.toString(),
        },
      });

      return { idempotent: false, position: toCollateralPosition(positionRow), summary };
    });
  }

  /**
   * Whether what is left after a withdrawal still backs everything drawn against it.
   *
   * The guard inside the withdrawal UPDATE reads `locked_micro`, and a hold locks nothing: the
   * collateral behind a draw is only locked when the call reports back and the debt opens. So a
   * draw that is approved and in flight is invisible to that guard, and the agent can take the
   * collateral it depends on back out from under it. Counted here with debt already recorded,
   * against the position as the withdrawal leaves it. The caller holds the pool row, which is what
   * makes this and a concurrent draw take turns instead of each reading the other's headroom.
   */
  private async assertBackingRemains(
    client: Queryable,
    agentId: string,
    pool: Pool,
    summary: CollateralSummary,
  ): Promise<void> {
    const held = await sumOpenHolds(client, agentId, pool.poolId);
    if (held <= ZERO_MICRO) return;

    const committed = addMicro(summary.outstandingMicro, held);
    const ceiling = mulBps(summary.effectiveCollateralMicro, pool.ltvCapBps);
    if (committed > ceiling) {
      throw new LedgerError(
        'collateral_backs_open_draws',
        `${agentId} has ${committed} micro-USD drawn or held against ${pool.poolId}, and what would be left supports ${ceiling}`,
        {
          agentId,
          poolId: pool.poolId,
          committedMicro: committed.toString(),
          heldMicro: held.toString(),
          outstandingMicro: summary.outstandingMicro.toString(),
          ceilingMicro: ceiling.toString(),
          effectiveCollateralMicro: summary.effectiveCollateralMicro.toString(),
        },
      );
    }

    const projected = healthFactor(committed, summary.effectiveCollateralMicro, pool.ltvCapBps);
    if (projected !== null && projected < pool.minHealthFactor) {
      throw new LedgerError(
        'health_factor_below_minimum',
        `this withdrawal would leave ${agentId} at a health factor of ${projected.toFixed(6)}, under the ${pool.minHealthFactor} ${pool.poolId} requires`,
        {
          agentId,
          poolId: pool.poolId,
          healthFactor: projected,
          minHealthFactor: pool.minHealthFactor,
          heldMicro: held.toString(),
        },
      );
    }
  }

  async getCollateralSummary(agentId: string, poolId: string): Promise<CollateralSummary> {
    return this.collateralSummary(this.db, agentId, poolId);
  }

  private async collateralSummary(
    client: Queryable,
    agentId: string,
    poolId: string,
  ): Promise<CollateralSummary> {
    // Backing is measured over everything posted and not withdrawn. Collateral locked against an
    // open debt is still backing that debt, so subtracting it here would count the same draw twice:
    // once in the outstanding balance and again as a fall in the collateral behind it. `available`
    // does subtract it, because that is the part an agent may still take back out.
    const aggregate = await one<{ available: string | null; effective: string | null }>(
      client,
      `SELECT
         SUM(GREATEST(p.deposited_micro - p.withdrawn_micro - p.locked_micro, 0))::text AS available,
         SUM(
           trunc(
             GREATEST(p.deposited_micro - p.withdrawn_micro, 0)
             * (10000 - a.haircut_bps) / 10000
           )
         )::text AS effective
       FROM bursar_collateral_positions p
       INNER JOIN bursar_collateral_assets a ON a.asset_id = p.asset_id
       WHERE p.agent_id = $1 AND p.pool_id = $2 AND p.status = 'active'`,
      [agentId, poolId],
    );

    const pool = await one<PoolRow>(client, `SELECT ${POOL_COLUMNS} FROM bursar_pools WHERE pool_id = $1`, [
      poolId,
    ]);
    const outstanding = await sumOutstanding(client, agentId, poolId);
    const effective = sumToMicro(aggregate?.effective, 'effective_collateral_micro');
    const capBps = pool ? pool.ltv_cap_bps : 0;

    return {
      poolId,
      totalAvailableMicro: sumToMicro(aggregate?.available, 'available_collateral_micro'),
      effectiveCollateralMicro: effective,
      outstandingMicro: outstanding,
      ltvBps: ltvBps(outstanding, effective),
      healthFactor: healthFactor(outstanding, effective, capBps),
    };
  }


  async statement(agentId: string, poolId: string): Promise<LaneStatement> {
    const account = await this.getAccount(agentId);
    if (!account) throw new LedgerError('account_not_found', `no account ${agentId}`, { agentId });

    const pool = await this.getPool(poolId);
    if (!pool) throw new LedgerError('pool_not_found', `no pool ${poolId}`, { poolId });

    return {
      account,
      lane: pool.lane,
      poolId,
      balance: pool.lane === 'prefund' ? await this.getBalance(agentId, poolId) : null,
      outstandingMicro: await this.outstandingMicro(agentId, poolId),
      collateral: pool.lane === 'collateral' ? await this.getCollateralSummary(agentId, poolId) : null,
    };
  }

  /**
   * One ordered history across funding, debt, repayment and settlement.
   *
   * Assembled by a single UNION ALL query, so the ordering comes from the database and the next
   * slice a caller asks for starts where this one ended.
   */
  async listTransactions(agentId: string, limit = 50): Promise<readonly LaneTransaction[]> {
    const size = Math.max(1, Math.min(limit, 200));
    const rows = await many<{
      type: LaneTransaction['type'];
      id: string;
      created_at: Date;
      lane: LaneMode;
      pool_id: string;
      amount_micro: string;
      outstanding_micro: string | null;
      status: string | null;
      reference_id: string | null;
      tx_hash: string | null;
    }>(
      this.db,
      `SELECT 'funding' AS type, id::text, created_at, lane, pool_id,
              amount_micro::text, NULL::text AS outstanding_micro, event_type AS status,
              reference_id, tx_hash
       FROM bursar_funding_events WHERE agent_id = $1
       UNION ALL
       SELECT 'debt', id::text, created_at, lane, pool_id,
              principal_micro::text, outstanding_micro::text, status, NULL, NULL
       FROM bursar_debts WHERE agent_id = $1
       UNION ALL
       SELECT 'repayment', r.id::text, r.created_at, 'collateral', COALESCE(r.pool_id, d.pool_id, ''),
              r.applied_micro::text, NULL, r.source, r.reference_id, r.tx_hash
       FROM bursar_repayments r
       LEFT JOIN bursar_debts d ON d.id = r.debt_id
       WHERE r.agent_id = $1
       UNION ALL
       SELECT 'settlement', s.id::text, s.created_at, res.lane, res.pool_id,
              s.amount_micro::text, NULL, s.status, res.request_nonce, s.tx_hash
       FROM bursar_settlements s
       INNER JOIN bursar_reservations res ON res.settlement_id = s.id
       WHERE res.agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, size],
    );

    return rows.map((row) => ({
      type: row.type,
      id: row.id,
      createdAt: row.created_at,
      lane: row.lane,
      poolId: row.pool_id,
      amountMicro: sumToMicro(row.amount_micro, 'amount_micro'),
      outstandingMicro:
        row.outstanding_micro === null ? null : sumToMicro(row.outstanding_micro, 'outstanding_micro'),
      status: row.status,
      referenceId: row.reference_id,
      txHash: row.tx_hash,
    }));
  }


  /**
   * Claims an authorisation nonce before anything is broadcast.
   *
   * Returns false when the nonce is already claimed, which is a replay. The token contract refuses
   * a spent nonce on chain anyway; this stops it before the relayer pays for the attempt, and
   * without the race two concurrent requests would otherwise have.
   */
  async claimPaymentNonce(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
    readonly amountMicro: Micro;
  }): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO bursar_payment_guard (network, payer_wallet, nonce, usage, amount_micro)
       VALUES ($1,$2,$3,'settle',$4)
       ON CONFLICT (network, payer_wallet, nonce) DO NOTHING`,
      [
        input.network,
        input.payerWallet.toLowerCase(),
        input.nonce.toLowerCase(),
        microToNumeric(input.amountMicro),
      ],
    );
    return result.rowCount > 0;
  }

  /**
   * Writes the transaction a claimed nonce produced, when nothing else could be.
   *
   * The settlement row is the record of a payment; this is the record that there was one. It is
   * written when the broadcast succeeded and the ledger write that follows it did not, so the hash
   * of a transfer that is already on chain survives somewhere an operator can reconcile from.
   */
  async recordPaymentTransaction(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
    readonly txHash: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE bursar_payment_guard
       SET tx_hash = $4
       WHERE network = $1 AND payer_wallet = $2 AND nonce = $3 AND tx_hash IS NULL`,
      [input.network, input.payerWallet.toLowerCase(), input.nonce.toLowerCase(), input.txHash],
    );
  }

  /**
   * What became of an authorisation this service has claimed, or null for one it never saw.
   *
   * A settle retried after its transfer landed fails verification, because the token reports the
   * nonce spent. This is how that retry is answered with the settlement it already paid for instead
   * of a refusal that reads as though nothing happened.
   */
  async paymentRecord(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
  }): Promise<PaymentRecord | null> {
    const row = await one<{ settlement_id: string | null; tx_hash: string | null; reservation_id: string | null }>(
      this.db,
      `SELECT g.settlement_id::text AS settlement_id, g.tx_hash, r.id::text AS reservation_id
       FROM bursar_payment_guard g
       LEFT JOIN bursar_reservations r ON r.settle_claim = g.id
       WHERE g.network = $1 AND g.payer_wallet = $2 AND g.nonce = $3`,
      [input.network, input.payerWallet.toLowerCase(), input.nonce.toLowerCase()],
    );
    if (!row) return null;
    return {
      settlement: row.settlement_id ? await readSettlement(this.db, row.settlement_id) : null,
      txHash: row.tx_hash,
      reservationId: row.reservation_id,
    };
  }

  /**
   * Settle claims older than `olderThanMs` that no settlement closed, for reconciliation.
   *
   * Each row is stamped as checked on the way out, so one the chain cannot answer for yet comes
   * back after the same interval rather than on every pass.
   */
  async unsettledPayments(olderThanMs: number, limit = 50): Promise<readonly UnsettledPayment[]> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - Math.max(0, olderThanMs));
    const rows = await many<{
      claim: string;
      network: string;
      payer_wallet: string;
      nonce: string;
      amount_micro: string;
      tx_hash: string | null;
      reservation_id: string | null;
    }>(
      this.db,
      `UPDATE bursar_payment_guard g
       SET checked_at = $1
       FROM (
         SELECT id FROM bursar_payment_guard
         WHERE settlement_id IS NULL AND usage = 'settle' AND created_at < $2
           AND (checked_at IS NULL OR checked_at < $2)
         ORDER BY created_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       ) due
       WHERE g.id = due.id
       RETURNING g.id::text AS claim, g.network, g.payer_wallet, g.nonce, g.amount_micro::text AS amount_micro,
                 g.tx_hash,
                 (SELECT r.id::text FROM bursar_reservations r WHERE r.settle_claim = g.id) AS reservation_id`,
      [now, cutoff, Math.max(1, Math.min(limit, 500))],
    );
    return rows.map((row) => ({
      claim: row.claim,
      network: row.network,
      payerWallet: row.payer_wallet as `0x${string}`,
      nonce: row.nonce as `0x${string}`,
      amountMicro: sumToMicro(row.amount_micro, 'amount_micro'),
      txHash: row.tx_hash,
      reservationId: row.reservation_id,
    }));
  }

  /**
   * Gives a claimed nonce back after a settle that provably did not broadcast.
   *
   * Only called when nothing was sent. A broadcast whose receipt could not be read has to keep its
   * claim, because releasing it would let the same authorisation be submitted a second time
   * against a transfer that may already have landed. A hold the claim was on is unclaimed by the
   * same statement, through the reference 0009 put on it.
   */
  async releasePaymentNonce(network: string, payerWallet: string, nonce: string): Promise<void> {
    await this.db.query(
      `DELETE FROM bursar_payment_guard
       WHERE network = $1 AND payer_wallet = $2 AND nonce = $3 AND settlement_id IS NULL`,
      [network, payerWallet.toLowerCase(), nonce.toLowerCase()],
    );
  }
}


/** Carries the expired hold out of the transaction that could not use it. Never thrown to a caller. */
class ReservationExpired extends Error {
  constructor(readonly reservation: Reservation) {
    super(`reservation ${reservation.id} expired`);
    this.name = 'ReservationExpired';
  }
}

function optionalAmount(value: Micro | null | undefined): string | null {
  return value === null || value === undefined ? null : microToNumeric(value);
}

/**
 * Refuses a payment that does not pay what the hold holds.
 *
 * The three values are what a scheme verified about a transfer, compared against the reservation
 * row the caller has locked. Without the comparison a settle naming a reservation redeems it with
 * any valid payment at all: the settlement is built from the reservation, so a one-micro transfer
 * to an attacker closes a hundred-USDG hold and is recorded as having paid the merchant.
 */
function assertPaysTheHold(reservation: Reservation, payment: PaymentTerms | undefined): void {
  if (!payment) return;
  if (
    payment.amountMicro === reservation.amountMicro &&
    sameWallet(payment.payerWallet, reservation.payerWallet) &&
    sameWallet(payment.merchantWallet, reservation.merchantWallet)
  ) {
    return;
  }

  throw new LedgerError(
    'lane_amount_mismatch',
    `the payment offered against reservation ${reservation.id} moves ${payment.amountMicro} micro-USD from ${payment.payerWallet} to ${payment.merchantWallet}, and the hold is ${reservation.amountMicro} micro-USD from ${reservation.payerWallet} to ${reservation.merchantWallet}`,
    {
      reservationId: reservation.id,
      amountMicro: reservation.amountMicro.toString(),
      offeredAmountMicro: payment.amountMicro.toString(),
      payerWallet: reservation.payerWallet,
      offeredPayerWallet: payment.payerWallet,
      merchantWallet: reservation.merchantWallet,
      offeredMerchantWallet: payment.merchantWallet,
    },
  );
}

function sameWallet(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Refuses a decision whose payer or network is not the account's.
 *
 * `/authorizations` records whatever a caller posts, and the hold is opened against the account the
 * decision names. Without this a decision naming agent A with somebody else's wallet locks A's
 * balance for a payment A's wallet never signs, and one naming a network A never enabled holds
 * funds on a chain the account does not settle on. An account that lists no networks has not
 * restricted them.
 */
function assertDecisionFitsAccount(
  decision: AuthorizationRecord,
  accountPayer: string,
  accountNetworks: unknown,
): void {
  if (!sameWallet(decision.payerWallet, accountPayer)) {
    throw new LedgerError(
      'authorization_account_mismatch',
      `the decision is for ${decision.payerWallet}, and ${decision.agentId} pays from ${accountPayer}`,
      { agentId: decision.agentId, payerWallet: decision.payerWallet, accountPayerWallet: accountPayer },
    );
  }

  const networks = Array.isArray(accountNetworks)
    ? accountNetworks.filter((entry): entry is string => typeof entry === 'string').map(canonicalNetwork)
    : [];
  if (networks.length > 0 && !networks.includes(canonicalNetwork(decision.network))) {
    throw new LedgerError(
      'authorization_account_mismatch',
      `the decision is on ${decision.network}, which ${decision.agentId} is not enabled for`,
      { agentId: decision.agentId, network: decision.network, networks },
    );
  }
}

async function ensureReserve(client: Queryable, poolId: string, lane: LaneMode): Promise<void> {
  await client.query(
    `INSERT INTO bursar_pool_reserves (pool_id, lane) VALUES ($1,$2)
     ON CONFLICT (pool_id) DO NOTHING`,
    [poolId, lane],
  );
}

async function lockedPool(client: Queryable, poolId: string): Promise<Pool> {
  const row = await one<PoolRow>(
    client,
    `SELECT ${POOL_COLUMNS} FROM bursar_pools WHERE pool_id = $1 FOR UPDATE`,
    [poolId],
  );
  if (!row) throw new LedgerError('pool_not_found', `no pool ${poolId}`, { poolId });
  await ensureReserve(client, poolId, row.lane);
  return toPool(row);
}

/**
 * Moves a pool's aggregates.
 *
 * GREATEST pins each total at zero. The individual guards above are what keep the ledger honest;
 * this clamp exists so an accounting slip in one pool cannot make a total negative and take down
 * every read of that pool with a constraint violation.
 */
async function bumpReserve(
  client: Queryable,
  now: Date,
  params: {
    readonly poolId: string;
    readonly lane: LaneMode;
    readonly reservedDelta?: Micro;
    readonly outstandingDelta?: Micro;
    readonly collateralDelta?: Micro;
  },
): Promise<void> {
  const outstanding = params.outstandingDelta ?? ZERO_MICRO;
  if (outstanding !== ZERO_MICRO && !laneExtendsCredit(params.lane)) {
    throw new LaneDoesNotExtendCredit(params.lane);
  }

  await ensureReserve(client, params.poolId, params.lane);
  await client.query(
    `UPDATE bursar_pool_reserves
     SET reserved_micro = GREATEST(reserved_micro + $2::numeric, 0),
         outstanding_micro = GREATEST(outstanding_micro + $3::numeric, 0),
         collateral_value_micro = GREATEST(collateral_value_micro + $4::numeric, 0),
         updated_at = $5
     WHERE pool_id = $1`,
    [
      params.poolId,
      microToNumeric(params.reservedDelta ?? ZERO_MICRO),
      microToNumeric(outstanding),
      microToNumeric(params.collateralDelta ?? ZERO_MICRO),
      now,
    ],
  );
}

async function readBalance(client: Queryable, agentId: string, poolId: string): Promise<LaneBalance> {
  const row = await one<LaneBalanceRow>(
    client,
    `SELECT ${BALANCE_COLUMNS} FROM bursar_lane_balances WHERE agent_id = $1 AND pool_id = $2`,
    [agentId, poolId],
  );
  if (row) return toLaneBalance(row);
  return {
    agentId,
    poolId,
    availableMicro: ZERO_MICRO,
    reservedMicro: ZERO_MICRO,
    spentMicro: ZERO_MICRO,
    updatedAt: new Date(0),
  };
}

/**
 * Applies deltas to a balance, or returns null when a guard fails.
 *
 * Every condition sits in the WHERE clause. Reading the balance, deciding, and writing
 * would leave a window between the decision and the write in which another transaction spends the
 * same funds. Here the decision and the write are one statement, so the loser sees no row.
 */
async function mutateBalance(
  client: Queryable,
  now: Date,
  params: {
    readonly agentId: string;
    readonly poolId: string;
    readonly availableDelta?: Micro;
    readonly reservedDelta?: Micro;
    readonly spentDelta?: Micro;
    readonly minAvailable?: Micro;
    readonly minReserved?: Micro;
  },
): Promise<LaneBalance | null> {
  await client.query(
    `INSERT INTO bursar_lane_balances (agent_id, pool_id) VALUES ($1,$2)
     ON CONFLICT (agent_id, pool_id) DO NOTHING`,
    [params.agentId, params.poolId],
  );

  const row = await one<LaneBalanceRow>(
    client,
    `UPDATE bursar_lane_balances
     SET available_micro = available_micro + $3::numeric,
         reserved_micro = reserved_micro + $4::numeric,
         spent_micro = spent_micro + $5::numeric,
         updated_at = $8
     WHERE agent_id = $1
       AND pool_id = $2
       AND available_micro + $3::numeric >= 0
       AND reserved_micro + $4::numeric >= 0
       AND spent_micro + $5::numeric >= 0
       AND ($6::numeric IS NULL OR available_micro >= $6::numeric)
       AND ($7::numeric IS NULL OR reserved_micro >= $7::numeric)
     RETURNING ${BALANCE_COLUMNS}`,
    [
      params.agentId,
      params.poolId,
      microToNumeric(params.availableDelta ?? ZERO_MICRO),
      microToNumeric(params.reservedDelta ?? ZERO_MICRO),
      microToNumeric(params.spentDelta ?? ZERO_MICRO),
      params.minAvailable === undefined ? null : microToNumeric(params.minAvailable),
      params.minReserved === undefined ? null : microToNumeric(params.minReserved),
      now,
    ],
  );

  return row ? toLaneBalance(row) : null;
}

/** Holds open against a pool, which are draws that have not become debts yet. */
async function sumOpenHolds(client: Queryable, agentId: string, poolId: string): Promise<Micro> {
  const row = await one<{ held: string | null }>(
    client,
    `SELECT SUM(amount_micro)::text AS held
     FROM bursar_reservations
     WHERE agent_id = $1 AND pool_id = $2 AND status = 'reserved'`,
    [agentId, poolId],
  );
  return sumToMicro(row?.held, 'amount_micro');
}

/**
 * Holds back the collateral a debt draws on, across as many positions as it takes.
 *
 * Positions are taken in the order they free up the most, so a draw that one position can carry
 * touches one row. A debt that already holds its collateral is left alone, which makes a retried
 * consume a no-op.
 */
async function lockCollateral(client: Queryable, now: Date, debt: Debt): Promise<void> {
  const held = await one<{ present: boolean }>(
    client,
    'SELECT true AS present FROM bursar_debt_collateral_locks WHERE debt_id = $1::uuid LIMIT 1',
    [debt.id],
  );
  if (held) return;

  const positions = await many<{ id: string; free: string; haircut_bps: number }>(
    client,
    `SELECT p.id::text,
            GREATEST(p.deposited_micro - p.withdrawn_micro - p.locked_micro, 0)::text AS free,
            a.haircut_bps
     FROM bursar_collateral_positions p
     INNER JOIN bursar_collateral_assets a ON a.asset_id = p.asset_id
     WHERE p.agent_id = $1 AND p.pool_id = $2 AND p.status = 'active'
     ORDER BY GREATEST(p.deposited_micro - p.withdrawn_micro - p.locked_micro, 0) DESC, p.id ASC
     FOR UPDATE OF p`,
    [debt.agentId, debt.poolId],
  );

  let remaining = debt.principalMicro;
  for (const position of positions) {
    if (remaining <= ZERO_MICRO) break;
    // A fully discounted asset backs nothing, so there is no amount of it to lock.
    if (position.haircut_bps >= 10_000) continue;

    const free = sumToMicro(position.free, 'free_collateral_micro');
    const backing = minMicro(effectiveCollateral(free, position.haircut_bps), remaining);
    if (backing <= ZERO_MICRO) continue;

    const gross = minMicro(grossedUpCollateral(backing, position.haircut_bps), free);
    const updated = await one<{ id: string }>(
      client,
      `UPDATE bursar_collateral_positions
       SET locked_micro = locked_micro + $2::numeric, updated_at = $3
       WHERE id = $1::uuid AND deposited_micro - withdrawn_micro - locked_micro >= $2::numeric
       RETURNING id::text`,
      [position.id, microToNumeric(gross), now],
    );
    if (!updated) {
      throw new LedgerError('collateral_lock_failed', `collateral behind ${debt.id} moved while it was being locked`, {
        debtId: debt.id,
      });
    }

    await client.query(
      `INSERT INTO bursar_debt_collateral_locks (debt_id, position_id, locked_micro)
       VALUES ($1::uuid, $2::uuid, $3)`,
      [debt.id, position.id, microToNumeric(gross)],
    );
    remaining = subMicro(remaining, backing);
  }

  if (remaining > ZERO_MICRO) {
    throw new LedgerError(
      'collateral_insufficient',
      `${debt.agentId} has ${remaining} micro-USD of this draw with no collateral left to back it`,
      { debtId: debt.id, agentId: debt.agentId, poolId: debt.poolId, shortfallMicro: remaining.toString() },
    );
  }
}

/** Gives back everything a debt held, to the positions it took it from. */
async function releaseCollateral(client: Queryable, now: Date, debtId: string): Promise<void> {
  await client.query(
    `WITH released AS (
       DELETE FROM bursar_debt_collateral_locks
       WHERE debt_id = $1::uuid
       RETURNING position_id, locked_micro
     )
     UPDATE bursar_collateral_positions p
     SET locked_micro = GREATEST(p.locked_micro - r.locked_micro, 0), updated_at = $2
     FROM released r
     WHERE p.id = r.position_id`,
    [debtId, now],
  );
}

async function sumOutstanding(client: Queryable, agentId: string, poolId?: string): Promise<Micro> {
  const row = await one<{ outstanding: string | null }>(
    client,
    `SELECT SUM(outstanding_micro)::text AS outstanding
     FROM bursar_debts
     WHERE agent_id = $1 AND status = 'open' AND ($2::text IS NULL OR pool_id = $2)`,
    [agentId, poolId ?? null],
  );
  return sumToMicro(row?.outstanding, 'outstanding_micro');
}

async function readSettlement(client: Queryable, id: string): Promise<Settlement> {
  const row = await one<SettlementRow>(
    client,
    `SELECT ${SETTLEMENT_COLUMNS} FROM bursar_settlements WHERE id = $1::uuid`,
    [id],
  );
  if (!row) throw new LedgerError('settlement_not_found', `no settlement ${id}`, { settlementId: id });
  return toSettlement(row);
}

async function readDebtBySettlement(client: Queryable, settlementId: string): Promise<Debt | null> {
  const row = await one<DebtRow>(
    client,
    `SELECT ${DEBT_COLUMNS} FROM bursar_debts WHERE settlement_id = $1::uuid`,
    [settlementId],
  );
  return row ? toDebt(row) : null;
}

async function readPosition(
  client: Queryable,
  input: {
    readonly agentId: string;
    readonly poolId: string;
    readonly collateralAccount: string;
    readonly assetId: string;
  },
): Promise<CollateralPosition> {
  const row = await one<CollateralPositionRow>(
    client,
    `SELECT ${POSITION_COLUMNS}
     FROM bursar_collateral_positions
     WHERE agent_id = $1 AND pool_id = $2 AND collateral_account = $3 AND asset_id = $4`,
    [input.agentId, input.poolId, input.collateralAccount, input.assetId],
  );
  if (!row) {
    throw new LedgerError('collateral_position_missing', 'the event is recorded but its position is not', {
      agentId: input.agentId,
      poolId: input.poolId,
    });
  }
  return toCollateralPosition(row);
}

