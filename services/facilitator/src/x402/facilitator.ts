import { maxMicro, minMicro, mulBps, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { MAX_SETTLEMENT_CALLS, REASON, RECEIPT_WAIT_MS, canonicalNetwork, isNotSent } from '@bursar/x402';
import type {
  ClaimReservationInput,
  ConsumeResult,
  DirectSettlementInput,
  PaymentRecord,
  SettleReservationInput,
} from '../lanes/ledger.js';
import type { Reservation, Settlement } from '../lanes/types.js';
import { verifyBinding } from './binding.js';
import type { SettlementBudget } from './budget.js';
import {
  FACILITATOR_REASON,
  authorizationNonce,
  payloadBinding,
  requiredAmount,
} from './contract.js';
import type {
  PaymentPayload,
  PaymentRequirements,
  PaymentScheme,
  SchemeOptions,
  SettleResult,
  SupportedResponse,
  VerifyResult,
} from './contract.js';

/**
 * Verify and settle, on someone else's behalf.
 *
 * Verify is read-only and free. Settle broadcasts a transaction the relayer pays for, so it runs
 * its checks in the order that costs least: the scheme's own verdict first, then the request
 * binding, then the replay guard, and only then the budget and the broadcast. A payment that was
 * never going to work is refused without spending anything on it.
 *
 * What the ledger does afterwards depends on the lane. A settle that names a reservation claims it
 * before broadcasting, then consumes it and marks the resulting settlement paid in one transaction.
 * A settle that names none is the direct lane: one authorisation, one transaction, nothing held and
 * nothing owed.
 */

/**
 * The slice of the ledger this path uses.
 *
 * `LaneLedger` satisfies it. Naming it separately keeps the ordering above testable with a
 * double, which is the part that decides whether a bad payment costs the relayer gas.
 */
export type SettlementLedger = {
  claimPaymentNonce(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
    readonly amountMicro: Micro;
  }): Promise<boolean>;
  releasePaymentNonce(network: string, payerWallet: string, nonce: string): Promise<void>;
  recordPaymentTransaction(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
    readonly txHash: string;
  }): Promise<void>;
  paymentRecord(input: {
    readonly network: string;
    readonly payerWallet: string;
    readonly nonce: string;
  }): Promise<PaymentRecord | null>;
  getReservation(id: string): Promise<Reservation | null>;
  claimReservation(input: ClaimReservationInput): Promise<string | null>;
  settleReservation(input: SettleReservationInput): Promise<ConsumeResult>;
  recordDirectSettlement(input: DirectSettlementInput): Promise<Settlement>;
};

/**
 * How long a hold must still have to run for a settle to claim it.
 *
 * This service redeems EIP-3009 authorisations only, which settle in one transaction, so the
 * longest a settle waits after claiming is one receipt wait. A hold closer to its expiry than that
 * would be kept locked past the window it was opened for.
 */
export const CLAIM_MARGIN_MS = RECEIPT_WAIT_MS;

/**
 * The longest one settle can run, from the scheme's own bounds.
 *
 * Each of up to `MAX_SETTLEMENT_CALLS` transactions waits up to `RECEIPT_WAIT_MS` for its receipt,
 * and the reads, sends and ledger write around them get thirty seconds between them. With the
 * scheme's figures today that is 2 x 60 s + 30 s, 150 seconds. Shutdown waits at least this long
 * and reconciliation leaves a claim alone until well past it, because cutting a settle off
 * mid-wait is how a landed transfer ends up with no settlement.
 */
export const SETTLE_WORST_CASE_MS = MAX_SETTLEMENT_CALLS * RECEIPT_WAIT_MS + 30_000;

export type FacilitatorOptions = {
  readonly scheme: PaymentScheme;
  readonly budget: SettlementBudget;
  readonly ledger: SettlementLedger;
  readonly treasury: string;
  /** The facilitator's share of a settled call, in basis points. */
  readonly feeBps: number;
  /**
   * The smallest fee worth charging, and the floor any settle through this service has to clear.
   *
   * Every `/settle` broadcasts once, whether or not it names a reservation, and the relayer pays
   * the ETH for it out of the gas float, which the payment in USDG never reimburses. The floor is
   * therefore what this deployment is willing to spend a broadcast on, set by the operator rather
   * than derived from a gas price. A hold consumed through the net lane pays no floor: nothing is
   * broadcast per call there.
   */
  readonly feeFloorMicro: Micro;
  /** Defaults to `CLAIM_MARGIN_MS`. */
  readonly claimMarginMs?: number;
  /** Refuse any payment that carries no proof it was signed for the request it is redeemed for. */
  readonly requireBinding?: boolean;
  readonly log?: (line: string) => void;
};

export type VerifyRequest = {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
  /** sha256 of the exact request body the payment is being redeemed against. */
  readonly requestHash?: string;
};

export type SettleRequest = VerifyRequest & {
  /** Names the hold this settlement closes out. Absent in the direct lane. */
  readonly reservationId?: string;
  readonly asset?: string;
};

export type FacilitatorVerifyResponse = VerifyResult;

export type FacilitatorSettleResponse = SettleResult & {
  /** This service's own record of the payment, once one exists. */
  readonly settlementId?: string;
  readonly feeMicro?: string;
};

export class Facilitator {
  private readonly scheme: PaymentScheme;
  private readonly budget: SettlementBudget;
  private readonly ledger: SettlementLedger;
  private readonly treasury: string;
  private readonly feeBps: number;
  private readonly feeFloorMicro: Micro;
  private readonly requireBinding: boolean;
  private readonly claimMarginMs: number;
  private readonly log: (line: string) => void;

  constructor(options: FacilitatorOptions) {
    if (!Number.isInteger(options.feeBps) || options.feeBps < 0 || options.feeBps > 10_000) {
      throw new RangeError(`fee must be 0..10000 basis points, got ${options.feeBps}`);
    }
    this.scheme = options.scheme;
    this.budget = options.budget;
    this.ledger = options.ledger;
    this.treasury = options.treasury;
    this.feeBps = options.feeBps;
    this.feeFloorMicro = options.feeFloorMicro;
    this.requireBinding = options.requireBinding ?? true;
    this.claimMarginMs = options.claimMarginMs ?? CLAIM_MARGIN_MS;
    this.log = options.log ?? (() => undefined);
  }

  async supported(): Promise<SupportedResponse & Record<string, unknown>> {
    const kinds = await this.scheme.supported();
    return { ...kinds, ...this.budget.state() };
  }

  /**
   * What the facilitator charges on a settle of this size.
   *
   * Truncated toward zero like the contracts, raised to the floor because every settle here pays
   * for a broadcast, then capped at the payment itself. Settle refuses anything at or under the
   * floor before broadcasting, so the cap only shows on a figure asked for outside it.
   */
  fee(amountMicro: Micro): Micro {
    return minMicro(maxMicro(mulBps(amountMicro, this.feeBps), this.feeFloorMicro), amountMicro);
  }

  async verify(request: VerifyRequest): Promise<FacilitatorVerifyResponse> {
    const options = this.schemeOptions(request);
    const verdict = await this.scheme.verify(
      request.paymentPayload,
      request.paymentRequirements,
      options,
    );
    if (!verdict.isValid) return verdict;

    return this.checkBinding(request, verdict.payer) ?? verdict;
  }

  async settle(request: SettleRequest): Promise<FacilitatorSettleResponse> {
    // Canonicalised once, here, and used for every write this settle makes. The replay guard, the
    // release and the settlement record have to key on one spelling: taking the client's casing
    // for the guard and the scheme's for the update leaves `EIP155:...` and `eip155:...` as two
    // guard rows, which burns two budget slots and leaves a settled payment with no hash on it.
    const network = canonicalNetwork(request.paymentRequirements.network);
    const refuse = (reason: string, payer = ''): FacilitatorSettleResponse => ({
      success: false,
      settled: false,
      broadcast: false,
      errorReason: reason,
      payer,
      transaction: '',
      network,
    });

    const options = this.schemeOptions(request);
    const nonce = authorizationNonce(request.paymentPayload);
    const verdict = await this.scheme.verify(
      request.paymentPayload,
      request.paymentRequirements,
      options,
    );
    if (!verdict.isValid) {
      // A retry of a settle whose transfer landed fails here, because the token now reports the
      // authorisation spent, which the scheme calls a state refusal. The answer it is owed is the
      // settlement it already paid for. Any other refusal is not a landed payment.
      const prior =
        verdict.invalidReason === REASON.state
          ? await this.priorSettlement(request, network, verdict.payer, nonce)
          : null;
      return prior ?? refuse(verdict.invalidReason, verdict.payer ?? '');
    }

    const binding = this.checkBinding(request, verdict.payer);
    if (binding) return refuse(binding.invalidReason, verdict.payer);

    const amount = requiredAmount(request.paymentRequirements);
    if (amount === null) return refuse(FACILITATOR_REASON.requirements, verdict.payer);
    const amountMicro = toMicro(amount);

    if (nonce === null) return refuse(FACILITATOR_REASON.payload, verdict.payer);

    // Every settle here spends a broadcast, so a payment that would not clear the floor the
    // operator set is refused before anything reaches the chain. At the floor exactly the fee is
    // the whole payment and the merchant nets nothing, which is not a settlement worth broadcasting
    // either. Naming a reservation changes neither: the transfer is still one broadcast per call.
    if (amountMicro <= this.feeFloorMicro) {
      return refuse(FACILITATOR_REASON.belowFloor, verdict.payer);
    }

    // A settle naming a reservation redeems it, and everything the settlement records comes off the
    // reservation rather than off the payment. So the payment has to be the one the hold is for,
    // and it is cheaper to find that out here than after the relayer has paid for a broadcast. The
    // reservation row is read again under its own lock when it is consumed, which is where the
    // answer is binding; this is the same question asked early enough to cost nothing.
    if (request.reservationId) {
      const mismatch = await this.checkReservation(request, verdict.payer, amountMicro);
      if (mismatch) return refuse(mismatch, verdict.payer);
    }

    const claimed = await this.ledger.claimPaymentNonce({
      network,
      payerWallet: verdict.payer,
      nonce,
      amountMicro,
    });
    if (!claimed) {
      const prior = await this.priorSettlement(request, network, verdict.payer, nonce);
      return prior ?? refuse(FACILITATOR_REASON.replay, verdict.payer);
    }

    // The hold is claimed before anything is broadcast. Without it two settles naming one hold both
    // reach the chain, and a hold that lapses during the receipt wait is expired and handed back
    // while its transfer lands.
    let claim: string | null = null;
    if (request.reservationId) {
      claim = await this.ledger.claimReservation({
        reservationId: request.reservationId,
        network,
        payerWallet: verdict.payer,
        nonce,
        minRemainingMs: this.claimMarginMs,
      });
      if (claim === null) {
        await this.release(network, verdict.payer, nonce);
        return refuse(FACILITATOR_REASON.held, verdict.payer);
      }
    }

    const allowance = this.budget.take(verdict.payer);
    if (!allowance.ok) {
      await this.release(network, verdict.payer, nonce);
      return refuse(allowance.reason, verdict.payer);
    }

    let settlement: SettleResult;
    try {
      settlement = await this.scheme.settle(
        request.paymentPayload,
        request.paymentRequirements,
        options,
      );
    } catch (error) {
      // A throw carries no answer to the one question that decides this: whether a transaction left
      // the process. A lost response to an accepted `eth_sendRawTransaction` looks exactly like a
      // send that never happened, and giving the claim back on one would let the authorisation be
      // submitted again against a transfer that is already mining. So the claim and the allowance
      // stay unless the scheme says outright that nothing was sent.
      const sent = !isNotSent(error);
      if (!sent) {
        this.budget.refund(verdict.payer);
        await this.release(network, verdict.payer, nonce);
      }
      this.log(`settle failed payer=${verdict.payer} broadcast=${sent ? 'unknown' : 'no'} reason=${describe(error)}`);
      return {
        ...refuse(FACILITATOR_REASON.schemeUnavailable, verdict.payer),
        // Unknown is reported the way an unread broadcast is, because that is what it may be.
        settled: sent ? null : false,
        broadcast: sent,
        detail: SCHEME_FAILED,
      };
    }

    // Keyed on the broadcast, which comes apart from `settled`: a landed permit whose pull then
    // reverted has spent gas, advanced the payer's permit nonce and left an allowance standing.
    // Giving the allowance or the claim back would let it be spent twice.
    if (!settlement.broadcast) {
      this.budget.refund(verdict.payer);
      await this.release(network, verdict.payer, nonce);
    }

    if (!settlement.success || !settlement.transaction) {
      // A broadcast whose receipt could not be read still has a hash, and no settlement row is
      // written for it. The guard row this payment already owns is the only place that hash can
      // live, and reconciliation reads it from there.
      if (settlement.broadcast && settlement.transaction) {
        await this.keepTransaction(network, verdict.payer, nonce, settlement.transaction);
      }
      this.log(
        `settle refused payer=${verdict.payer} reason=${settlement.errorReason ?? 'unknown'}${settlement.detail ? ` detail=${settlement.detail}` : ''}`,
      );
      return withoutDetail(settlement);
    }

    const feeMicro = this.fee(amountMicro);
    try {
      const recorded = claim
        ? await this.closeReservation(claim, request, settlement, verdict.payer, amountMicro, feeMicro)
        : await this.recordDirect(request, settlement, verdict.payer, amountMicro, feeMicro, nonce, network);

      this.log(`settle ok payer=${verdict.payer} tx=${settlement.transaction} settlement=${recorded.id}`);
      return {
        ...withoutDetail(settlement),
        settlementId: recorded.id,
        feeMicro: recorded.feeMicro.toString(),
      };
    } catch (error) {
      // The transfer is on chain and the gas is spent. Failing the call here would tell the payer
      // nothing happened while their money has moved. The hash goes onto the replay guard, the one
      // row this payment already owns, and the caller is told what landed.
      await this.keepTransaction(network, verdict.payer, nonce, settlement.transaction);
      this.log(`settle unrecorded payer=${verdict.payer} tx=${settlement.transaction} reason=${describe(error)}`);
      // A payment the ledger refused and a ledger that could not be written to are different
      // answers. The first names what was wrong with the payment; the second says the money moved
      // and this service has no record of it yet.
      const mismatch = isMismatch(error);
      return {
        ...withoutDetail(settlement),
        errorReason: mismatch ? FACILITATOR_REASON.amount : FACILITATOR_REASON.unrecorded,
        detail: mismatch ? MISMATCH_LANDED : UNRECORDED,
      };
    }
  }

  /**
   * The answer a settle already got, for a retry of it, or null when there is none to give.
   *
   * Only for the payer the authorisation names and, where binding is required, only for the
   * request it was bound to. A retry naming a different reservation than the one the payment
   * closed is not a retry of that settle.
   */
  private async priorSettlement(
    request: SettleRequest,
    network: string,
    payer: `0x${string}` | undefined,
    nonce: string | null,
  ): Promise<FacilitatorSettleResponse | null> {
    if (!payer || nonce === null) return null;
    if (this.checkBinding(request, payer)) return null;

    const record = await this.ledger.paymentRecord({ network, payerWallet: payer, nonce });
    if (!record || (request.reservationId ?? null) !== record.reservationId) return null;

    const settled = record.settlement?.status === 'settled' ? record.settlement : null;
    if (settled?.txHash) {
      return {
        success: true,
        settled: true,
        broadcast: true,
        payer,
        transaction: settled.txHash,
        network,
        settlementId: settled.id,
        feeMicro: settled.feeMicro.toString(),
      };
    }
    if (record.txHash) {
      return {
        success: false,
        settled: null,
        broadcast: true,
        errorReason: FACILITATOR_REASON.pending,
        payer,
        transaction: record.txHash,
        network,
      };
    }
    return null;
  }

  /**
   * Gives a claim back, and logs rather than throws when it cannot.
   *
   * Every caller is already on its way to a refusal, and a guard row left behind costs nothing but
   * the payer's retry: reconciliation finds it unused on chain and deletes it.
   */
  private async release(network: string, payer: string, nonce: string): Promise<void> {
    try {
      await this.ledger.releasePaymentNonce(network, payer, nonce);
    } catch (error) {
      this.log(`nonce release failed payer=${payer} nonce=${nonce} reason=${describe(error)}`);
    }
  }

  /** Best effort by definition: the ledger write that got here has already failed once. */
  private async keepTransaction(
    network: string,
    payer: string,
    nonce: string,
    transaction: string,
  ): Promise<void> {
    try {
      await this.ledger.recordPaymentTransaction({ network, payerWallet: payer, nonce, txHash: transaction });
    } catch (error) {
      this.log(`settle hash unrecorded tx=${transaction} reason=${describe(error)}`);
    }
  }

  /**
   * Whether the hold a settle names is the one this payment pays, or the reason it is not.
   *
   * Null when they agree. Read before anything is claimed or broadcast, so a settle pointed at
   * somebody else's hold costs the relayer nothing.
   */
  private async checkReservation(
    request: SettleRequest,
    payer: `0x${string}`,
    amountMicro: Micro,
  ): Promise<string | null> {
    const reservation = await this.ledger.getReservation(request.reservationId ?? '');
    if (!reservation) return FACILITATOR_REASON.lane;

    const terms = this.paymentTerms(request, payer, amountMicro);
    const agrees =
      terms.amountMicro === reservation.amountMicro &&
      sameWallet(terms.payerWallet, reservation.payerWallet) &&
      sameWallet(terms.merchantWallet, reservation.merchantWallet);
    return agrees ? null : FACILITATOR_REASON.amount;
  }

  private async closeReservation(
    claim: string,
    request: SettleRequest,
    settlement: SettleResult,
    payer: `0x${string}`,
    amountMicro: Micro,
    feeMicro: Micro,
  ): Promise<Settlement> {
    const closed = await this.ledger.settleReservation({
      reservationId: request.reservationId ?? '',
      claim,
      asset: String(request.paymentRequirements.asset ?? request.asset ?? ''),
      feeMicro,
      payment: this.paymentTerms(request, payer, amountMicro),
      txHash: settlement.transaction,
      treasury: this.treasury,
    });
    return closed.settlement;
  }

  private async recordDirect(
    request: SettleRequest,
    settlement: SettleResult,
    payer: `0x${string}`,
    amountMicro: Micro,
    feeMicro: Micro,
    nonce: string,
    network: string,
  ): Promise<Settlement> {
    return this.ledger.recordDirectSettlement({
      network,
      asset: String(request.paymentRequirements.asset ?? request.asset ?? ''),
      payerWallet: payer,
      merchantWallet: String(request.paymentRequirements.payTo ?? ''),
      amountMicro,
      feeMicro,
      txHash: settlement.transaction,
      nonce,
      treasury: this.treasury,
    });
  }

  /** What the scheme just verified, in the terms the ledger records a settlement in. */
  private paymentTerms(
    request: SettleRequest,
    payer: `0x${string}`,
    amountMicro: Micro,
  ): { readonly amountMicro: Micro; readonly payerWallet: string; readonly merchantWallet: string } {
    return {
      amountMicro,
      payerWallet: payer,
      merchantWallet: String(request.paymentRequirements.payTo ?? ''),
    };
  }

  /** Null when the payment is bound, or an unbound verdict the caller returns as is. */
  private checkBinding(
    request: VerifyRequest,
    payer: `0x${string}`,
  ): { readonly isValid: false; readonly invalidReason: string; readonly payer: `0x${string}` } | null {
    if (!this.requireBinding) return null;

    const unbound = {
      isValid: false as const,
      invalidReason: FACILITATOR_REASON.unbound,
      payer,
    };

    if (!request.requestHash) return unbound;
    const nonce = authorizationNonce(request.paymentPayload);
    if (nonce === null) return { ...unbound, invalidReason: FACILITATOR_REASON.payload };

    const check = verifyBinding({
      payload: request.paymentPayload,
      requestHash: request.requestHash,
      nonce,
    });
    return check.bound ? null : unbound;
  }

  /**
   * What the scheme needs that only this service holds.
   *
   * The scheme sees the payload but never the request body, so without the digest passed down it
   * has no way to judge a permit-rail binding and refuses every payment. The salt is whatever the
   * payer chose, or zero on a rail that does not use one.
   */
  private schemeOptions(request: VerifyRequest): SchemeOptions {
    if (!request.requestHash) return { binding: null };
    const derived = payloadBinding(request.paymentPayload);
    return {
      binding: {
        requestHash: request.requestHash.toLowerCase(),
        salt: derived?.salt ?? ZERO_SALT,
      },
    };
  }
}

const ZERO_SALT = `0x${'00'.repeat(32)}` as const;

/**
 * What a caller is told when something below this service failed.
 *
 * Fixed text. The underlying messages come from the RPC transport and the database driver, and
 * those carry endpoint URLs, API keys in query strings and connection details. They go to the log,
 * where the operator reads them; the caller gets the reason code and this.
 */
const SCHEME_FAILED = 'the settlement scheme failed before answering; the facilitator log has the cause';
const UNRECORDED = 'the transfer was broadcast and could not be recorded; it is reconciled from the chain';
const MISMATCH_LANDED = 'the transfer was broadcast and does not pay the reservation it names';

/** A scheme's own detail is transport output as often as not, so it is logged and not forwarded. */
function withoutDetail(result: SettleResult): SettleResult {
  if (result.detail === undefined) return result;
  const { detail, ...rest } = result;
  void detail;
  return rest;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameWallet(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The ledger's refusal of a payment that does not pay the hold it names. */
function isMismatch(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === FACILITATOR_REASON.amount
  );
}

/** Reads a `/verify` or `/settle` body, rejecting anything that is not shaped like one. */
export function readRequest(
  body: unknown,
): { readonly ok: true; readonly request: SettleRequest } | { readonly ok: false; readonly reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: FACILITATOR_REASON.payload };

  const raw = body as Record<string, unknown>;
  const payload = raw.paymentPayload;
  const requirements = raw.paymentRequirements;

  if (!payload || typeof payload !== 'object') return { ok: false, reason: FACILITATOR_REASON.payload };
  if (!requirements || typeof requirements !== 'object') {
    return { ok: false, reason: FACILITATOR_REASON.requirements };
  }

  const requestHash = typeof raw.requestHash === 'string' ? raw.requestHash : undefined;
  if (requestHash !== undefined && !/^[0-9a-f]{64}$/i.test(requestHash)) {
    return { ok: false, reason: FACILITATOR_REASON.payload };
  }

  const reservationId = typeof raw.reservationId === 'string' ? raw.reservationId : undefined;
  if (reservationId !== undefined && !UUID.test(reservationId)) {
    return { ok: false, reason: FACILITATOR_REASON.lane };
  }

  return {
    ok: true,
    request: {
      paymentPayload: payload as PaymentPayload,
      paymentRequirements: requirements as PaymentRequirements,
      requestHash,
      reservationId,
      asset: typeof raw.asset === 'string' ? raw.asset : undefined,
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
