import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Database, Queryable, QueryResult, SqlParam } from '../../src/db/sql.js';
import { LedgerError } from '../../src/errors.js';
import type {
  ClaimReservationInput,
  ConsumeResult,
  DirectSettlementInput,
  PaymentRecord,
  PaymentTerms,
  SettleReservationInput,
} from '../../src/lanes/ledger.js';
import type { Reservation, Settlement } from '../../src/lanes/types.js';
import type { SettlementLedger } from '../../src/x402/facilitator.js';
import type {
  PaymentPayload,
  PaymentRequirements,
  PaymentScheme,
  SettleResult,
  SupportedResponse,
  VerifyResult,
} from '../../src/x402/contract.js';

/** Doubles for the three collaborators that own I/O: the database, the chain, and the sink. */

export type RecordedQuery = { readonly text: string; readonly params: readonly SqlParam[] };

/**
 * A database that records what it was asked and answers from a script.
 *
 * Matchers are tried in order and the first whose pattern appears in the statement wins, so a test
 * states only the statements it cares about and everything else comes back empty.
 */
export class RecordingDatabase implements Database {
  readonly queries: RecordedQuery[] = [];
  private readonly answers: { pattern: RegExp; rows: object[] }[] = [];

  answer(pattern: RegExp, rows: object[]): this {
    this.answers.push({ pattern, rows });
    return this;
  }

  async query<Row extends object>(text: string, params?: readonly SqlParam[]): Promise<QueryResult<Row>> {
    this.queries.push({ text, params: params ?? [] });
    const match = this.answers.find((answer) => answer.pattern.test(text));
    const rows = (match?.rows ?? []) as Row[];
    return { rows, rowCount: rows.length };
  }

  async transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}

  saw(pattern: RegExp): boolean {
    return this.queries.some((query) => pattern.test(query.text));
  }
}

export type SchemeScript = {
  readonly verify?: VerifyResult;
  readonly settle?: SettleResult;
};

export class ScriptedScheme implements PaymentScheme {
  verifyCalls = 0;
  settleCalls = 0;

  constructor(private script: SchemeScript = {}) {}

  set(script: SchemeScript): void {
    this.script = script;
  }

  supported(): SupportedResponse {
    return { kinds: [{ scheme: 'exact', network: 'eip155:4663' }] };
  }

  async verify(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResult> {
    this.verifyCalls += 1;
    return this.script.verify ?? { isValid: false, invalidReason: 'invalid_payload' };
  }

  async settle(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<SettleResult> {
    this.settleCalls += 1;
    return (
      this.script.settle ?? {
        success: false,
        settled: false,
        broadcast: false,
        errorReason: 'invalid_transaction_state',
        payer: '',
        transaction: '',
        network: 'eip155:4663',
      }
    );
  }
}

/** A scheme that fails the way a dead RPC endpoint does: by throwing. */
export class ThrowingScheme implements PaymentScheme {
  settleCalls = 0;

  constructor(private readonly error: Error = new Error('socket hang up')) {}

  supported(): SupportedResponse {
    return { kinds: [] };
  }

  async verify(): Promise<VerifyResult> {
    return { isValid: true, payer: `0x${'33'.repeat(20)}` };
  }

  async settle(): Promise<SettleResult> {
    this.settleCalls += 1;
    throw this.error;
  }
}

export type LedgerCall =
  | { readonly kind: 'claim'; readonly nonce: string; readonly network: string }
  | { readonly kind: 'release'; readonly nonce: string; readonly network: string }
  | { readonly kind: 'keepHash'; readonly nonce: string; readonly txHash: string }
  | { readonly kind: 'readHold'; readonly reservationId: string }
  | { readonly kind: 'claimHold'; readonly reservationId: string; readonly minRemainingMs: number }
  | {
      readonly kind: 'settleHold';
      readonly reservationId: string;
      readonly claim: string;
      readonly feeMicro: Micro;
      readonly txHash: string;
    }
  | { readonly kind: 'record'; readonly nonce: string }
  | { readonly kind: 'direct'; readonly input: DirectSettlementInput };

export function settlementFixture(overrides: Partial<Settlement> = {}): Settlement {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    network: 'eip155:4663',
    asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    payerWallet: '0xpayer',
    merchantWallet: '0xmerchant',
    amountMicro: toMicro(1_000_000),
    feeMicro: toMicro(1_900),
    status: 'settled',
    txHash: `0x${'ab'.repeat(32)}`,
    settleNonce: null,
    settledAt: new Date('2026-09-11T00:00:00.000Z'),
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    ...overrides,
  };
}

export function reservationFixture(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    authorizationId: '22222222-2222-4222-8222-222222222222',
    agentId: 'agent-1',
    payerWallet: '0xpayer',
    merchantWallet: '0xmerchant',
    requestNonce: 'nonce-1',
    network: 'eip155:4663',
    lane: 'prefund',
    poolId: 'prefund-main',
    amountMicro: toMicro(1_000_000),
    lockedMicro: toMicro(1_000_000),
    status: 'reserved',
    expiresAt: new Date('2026-09-11T01:00:00.000Z'),
    settlementId: null,
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    updatedAt: new Date('2026-09-11T00:00:00.000Z'),
    ...overrides,
  };
}

/** A ledger that records what the settle path asked of it, with a working nonce guard. */
export class FakeLedger implements SettlementLedger {
  readonly calls: LedgerCall[] = [];
  /** Set to make every write a settle depends on fail, the way an unreachable database does. */
  writesFail: Error | null = null;
  /** The hold `/settle` finds when it names one. Null is a reference to nothing. */
  reservation: Reservation | null = reservationFixture();
  /** Runs inside the consume, which is where the real ledger takes the row lock. */
  beforeConsume: (() => void) | null = null;
  /** Set to make releasing a claim fail, the way a dropped connection does. */
  releaseFails: Error | null = null;
  /** What `paymentRecord` answers, keyed `network:payer:nonce`. */
  readonly records = new Map<string, PaymentRecord>();
  /** Holds already claimed, and by which guard row, the way the real conditional UPDATE sees them. */
  readonly holdClaims = new Map<string, string>();
  private readonly claimed = new Set<string>();

  constructor(private readonly settlement: Settlement = settlementFixture()) {}

  async claimPaymentNonce(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
    readonly amountMicro: Micro;
  }): Promise<boolean> {
    this.calls.push({ kind: 'claim', nonce: input.nonce, network: input.network });
    const key = `${input.network}:${input.payerWallet.toLowerCase()}:${input.nonce}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async releasePaymentNonce(network: string, payerWallet: string, nonce: string): Promise<void> {
    this.calls.push({ kind: 'release', nonce, network });
    if (this.releaseFails) throw this.releaseFails;
    const key = `${network}:${payerWallet.toLowerCase()}:${nonce}`;
    this.claimed.delete(key);
    // The real guard row carries the hold's claim with it when it goes.
    for (const [hold, claim] of this.holdClaims) if (claim === key) this.holdClaims.delete(hold);
  }

  async paymentRecord(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
  }): Promise<PaymentRecord | null> {
    this.calls.push({ kind: 'record', nonce: input.nonce });
    return this.records.get(`${input.network}:${input.payerWallet.toLowerCase()}:${input.nonce}`) ?? null;
  }

  async recordPaymentTransaction(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
    readonly txHash: string;
  }): Promise<void> {
    this.calls.push({ kind: 'keepHash', nonce: input.nonce, txHash: input.txHash });
  }

  async getReservation(id: string): Promise<Reservation | null> {
    this.calls.push({ kind: 'readHold', reservationId: id });
    return this.reservation;
  }

  async claimReservation(input: ClaimReservationInput): Promise<string | null> {
    this.calls.push({ kind: 'claimHold', reservationId: input.reservationId, minRemainingMs: input.minRemainingMs });
    const hold = this.reservation;
    if (!hold || hold.status !== 'reserved' || this.holdClaims.has(input.reservationId)) return null;
    const key = `${input.network}:${input.payerWallet.toLowerCase()}:${input.nonce.toLowerCase()}`;
    this.holdClaims.set(input.reservationId, key);
    return key;
  }

  async settleReservation(input: SettleReservationInput): Promise<ConsumeResult> {
    this.calls.push({
      kind: 'settleHold',
      reservationId: input.reservationId,
      claim: input.claim,
      feeMicro: input.feeMicro,
      txHash: input.txHash,
    });
    if (this.writesFail) throw this.writesFail;
    this.beforeConsume?.();

    const hold = this.reservation ?? reservationFixture({ id: input.reservationId });
    // The real ledger compares under the row lock and refuses with this code. A double that took
    // any payment at all would make the settle path look safe on a ledger that is not.
    if (input.payment && !paysTheHold(hold, input.payment)) {
      throw new LedgerError('lane_amount_mismatch', 'the payment does not pay the hold it names');
    }
    if (this.holdClaims.get(input.reservationId) !== input.claim) {
      throw new LedgerError('reservation_claimed', 'the hold is not claimed by this settlement');
    }
    if (input.feeMicro >= hold.amountMicro) {
      throw new LedgerError('fee_exceeds_amount', 'the facilitator fee cannot take the whole payment');
    }

    return {
      reservation: { ...hold, status: 'consumed', settlementId: this.settlement.id },
      settlement: {
        ...this.settlement,
        status: 'settled',
        txHash: input.txHash,
        amountMicro: hold.amountMicro,
        payerWallet: hold.payerWallet,
        merchantWallet: hold.merchantWallet,
        feeMicro: input.feeMicro,
      },
      debt: null,
    };
  }

  async recordDirectSettlement(input: DirectSettlementInput): Promise<Settlement> {
    this.calls.push({ kind: 'direct', input });
    if (this.writesFail) throw this.writesFail;
    if (input.feeMicro >= input.amountMicro) {
      throw new LedgerError('fee_exceeds_amount', 'the facilitator fee cannot take the whole payment');
    }
    return { ...this.settlement, txHash: input.txHash, amountMicro: input.amountMicro, feeMicro: input.feeMicro };
  }

  kinds(): string[] {
    return this.calls.map((call) => call.kind);
  }
}

function paysTheHold(reservation: Reservation, payment: PaymentTerms): boolean {
  return (
    payment.amountMicro === reservation.amountMicro &&
    payment.payerWallet.toLowerCase() === reservation.payerWallet.toLowerCase() &&
    payment.merchantWallet.toLowerCase() === reservation.merchantWallet.toLowerCase()
  );
}
