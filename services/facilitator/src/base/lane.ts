import { BASE_MAINNET, canonicalNetwork, deriveNonce, mulBps, sameNetwork, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';

import { requiredAmount } from '../x402/contract.js';
import type { PaymentRequirements, RequestBinding } from '../x402/contract.js';
import { lockReference, opensFor } from '../x402/escrow-lock.js';
import type { EscrowChain, EscrowDeployment, EscrowLock } from '../x402/escrow-lock.js';
import type { BaseFloat, BaseLedger, BasePayment, LockWriter, TransferAuthorization } from './ports.js';

/**
 * The Base lane: a mandate's USDG lock on Robinhood Chain pays a USDC service on Base.
 *
 * The facilitator signs one EIP-3009 authorization from its Base float per lock, and the lock is
 * what bounds it: the authorization is for the amount the lock was quoted on, to the payee the
 * offer names, under a nonce derived from the same request binding the lock commits to. Whether
 * the USDC moved is read off the token, never off what the payer reports, and that reading is what
 * releases the lock to the float or cancels it back to the mandate.
 */

export const BASE_REASON = {
  off: 'base_lane_off',
  float: 'base_float_insufficient',
  tooLarge: 'base_amount_too_large',
  offer: 'base_offer_unsupported',
  payload: 'base_payload_invalid',
  notOpen: 'base_lock_not_open',
  payee: 'base_lock_payee_mismatch',
  amount: 'base_lock_amount_mismatch',
  unbound: 'base_lock_not_bound',
  deadline: 'base_lock_deadline_too_close',
  replay: 'base_lock_already_paid',
  payer: 'base_payer_not_a_mandate',
  unreadable: 'base_lock_unreadable',
  notFound: 'base_payment_not_found',
} as const;

export type BaseReason = (typeof BASE_REASON)[keyof typeof BASE_REASON];

export type BaseRefusal = {
  readonly refused: true;
  readonly reason: BaseReason;
  readonly detail: string;
  readonly status: number;
};

export type BaseQuote = {
  readonly refused?: false;
  readonly lane: 'base';
  readonly network: string;
  readonly asset: Address;
  readonly float: Address;
  readonly amountMicro: Micro;
  readonly lockMicro: Micro;
  readonly feeMicro: Micro;
  readonly feeBps: number;
  readonly feeFloorMicro: Micro;
  readonly minLockMicro: Micro;
  readonly availableMicro: Micro;
  readonly validForSeconds: number;
  /** What the mandate has to lock, in the terms `pay` takes. */
  readonly lock: { readonly chainId: number; readonly payee: Address; readonly asset: Address; readonly amountMicro: Micro; readonly ttlSeconds: number };
};

export type SignedPayment = {
  readonly refused?: false;
  readonly payment: BasePayment;
  readonly authorization: Readonly<Record<string, string>>;
  readonly signature: Hex;
};

export type ReconcileResult = {
  readonly checked: number;
  readonly settled: number;
  readonly returned: number;
  readonly pending: number;
  readonly failed: number;
};

export type FloatStatus = {
  readonly lane: 'base';
  readonly network: string;
  readonly asset: Address;
  readonly float: Address;
  readonly balanceMicro: string;
  readonly promisedMicro: string;
  readonly availableMicro: string;
  readonly minimumMicro: string;
  readonly maxPaymentMicro: string;
  readonly feeBps: number;
  readonly feeFloorMicro: string;
  readonly open: number;
  readonly stuck: number;
  readonly healthy: boolean;
};

export type BaseLaneOptions = {
  readonly chainId: number;
  readonly escrow: EscrowChain;
  readonly deployments: readonly EscrowDeployment[];
  readonly float: BaseFloat;
  readonly locks: LockWriter;
  readonly ledger: BaseLedger;
  readonly feeBps: number;
  readonly feeFloorMicro: Micro;
  /** The escrow's smallest lock. A quote never asks for less. */
  readonly minLockMicro: Micro;
  readonly floatMinimumMicro: Micro;
  readonly maxPaymentMicro: Micro;
  readonly log?: (line: string) => void;
  /** Unix seconds. */
  readonly now?: () => number;
  readonly unseenRetryMs?: number;
};

/** Headroom the authorization keeps past the offer's own work budget, as the wallet lane signs it. */
export const AUTHORIZATION_MARGIN_SECONDS = 30;
/** How long after an authorization expires the lane waits before returning the lock. Clock skew. */
export const RETURN_GRACE_SECONDS = 60;
/** What the lock has to keep past the authorization, for the worker to release or cancel it. */
export const WORKER_MARGIN_SECONDS = 900;
/** The least of that margin a lock may have left when it is presented. */
const PRESENT_MARGIN_SECONDS = 300;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 3_600;
const LOCKED = 1;
const NONE = 0;
const UNSEEN_READS = 4;
const RECONCILE_BATCH = 50;

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function refuse(reason: BaseReason, detail: string, status = 409): BaseRefusal {
  return { refused: true, reason, detail, status };
}

function timeoutOf(offer: PaymentRequirements): number | null {
  const value = offer.maxTimeoutSeconds;
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_SECONDS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return value > 0 && value <= MAX_TIMEOUT_SECONDS ? value : null;
}

export function readBinding(value: unknown): RequestBinding | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { requestHash?: unknown; salt?: unknown };
  const requestHash = typeof record.requestHash === 'string' ? record.requestHash.toLowerCase() : '';
  const salt = typeof record.salt === 'string' ? record.salt.toLowerCase() : '';
  if (!SHA256.test(requestHash) || !HASH.test(salt)) return null;
  return { requestHash, salt: salt as Hex };
}

export class BaseLane {
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: BaseLaneOptions) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get float(): Address {
    return this.options.float.address;
  }

  /** The lock that pays for `amountMicro` of USDC: amount plus the fee, never under the escrow's floor. */
  price(amountMicro: Micro): { lockMicro: Micro; feeMicro: Micro } {
    const fee = mulBps(amountMicro, this.options.feeBps);
    const floored = fee < this.options.feeFloorMicro ? this.options.feeFloorMicro : fee;
    const lock = toMicro(amountMicro + floored);
    const lockMicro = lock < this.options.minLockMicro ? this.options.minLockMicro : lock;
    return { lockMicro, feeMicro: toMicro(lockMicro - amountMicro) };
  }

  async quote(input: { amount: unknown; payTo: unknown; resource?: unknown; maxTimeoutSeconds?: unknown }): Promise<BaseQuote | BaseRefusal> {
    const amount = requiredAmount({ amount: input.amount as string });
    if (amount === null || amount <= 0n) return refuse(BASE_REASON.payload, 'amount must be a positive count of USDC atomic units, as a string', 400);
    if (typeof input.payTo !== 'string' || !ADDRESS.test(input.payTo)) return refuse(BASE_REASON.payload, 'payTo must be the service address the offer names', 400);
    const validFor = timeoutOf({ maxTimeoutSeconds: input.maxTimeoutSeconds as number | undefined });
    if (validFor === null) return refuse(BASE_REASON.offer, `maxTimeoutSeconds must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}`, 400);
    return this.quoteFor(toMicro(amount), validFor);
  }

  private async quoteFor(amountMicro: Micro, validFor: number): Promise<BaseQuote | BaseRefusal> {
    if (amountMicro > this.options.maxPaymentMicro) {
      return refuse(BASE_REASON.tooLarge, `one Base payment is capped at ${this.options.maxPaymentMicro} USDC atomic units on this facilitator`);
    }
    const [balance, promised] = await Promise.all([this.options.float.balance(), this.options.ledger.promised(this.float)]);
    const available = toMicro(balance - promised);
    if (available - amountMicro < this.options.floatMinimumMicro) {
      return refuse(BASE_REASON.float, `the Base float can cover ${available > 0n ? available : 0n} USDC atomic units beyond its reserve right now, and this payment needs ${amountMicro}`);
    }
    const { lockMicro, feeMicro } = this.price(amountMicro);
    return {
      lane: 'base',
      network: this.options.float.network,
      asset: this.options.float.asset,
      float: this.float,
      amountMicro,
      lockMicro,
      feeMicro,
      feeBps: this.options.feeBps,
      feeFloorMicro: this.options.feeFloorMicro,
      minLockMicro: this.options.minLockMicro,
      availableMicro: available,
      validForSeconds: validFor,
      lock: {
        chainId: this.options.chainId,
        payee: this.float,
        asset: this.options.deployments[0]?.asset ?? ('0x' as Address),
        amountMicro: lockMicro,
        ttlSeconds: validFor + AUTHORIZATION_MARGIN_SECONDS + RETURN_GRACE_SECONDS + WORKER_MARGIN_SECONDS,
      },
    };
  }

  async pay(input: { lock: unknown; binding: unknown; offer: unknown }): Promise<SignedPayment | BaseRefusal> {
    const reference = lockReference({ payload: { lock: input.lock } });
    if (!reference) return refuse(BASE_REASON.payload, 'lock must name escrow, id, mandate, transaction and inputCommit', 400);
    const binding = readBinding(input.binding);
    if (!binding) return refuse(BASE_REASON.payload, 'binding must carry the request digest and the salt the lock was opened with', 400);
    const offer = (input.offer && typeof input.offer === 'object' ? input.offer : null) as PaymentRequirements | null;
    if (!offer) return refuse(BASE_REASON.payload, 'offer must be the entry the service sent in its 402', 400);

    if (offer.scheme !== undefined && offer.scheme !== 'exact') return refuse(BASE_REASON.offer, `the Base lane pays the exact scheme, and the offer names ${String(offer.scheme)}`, 400);
    if (!sameNetwork(offer.network, this.options.float.network)) return refuse(BASE_REASON.offer, `the offer is on ${canonicalNetwork(offer.network) || 'no network'}, and this lane pays on ${this.options.float.network}`, 400);
    if (typeof offer.asset !== 'string' || !same(offer.asset, this.options.float.asset)) return refuse(BASE_REASON.offer, `the offer is in ${String(offer.asset)}, and this lane pays in USDC at ${this.options.float.asset}`, 400);
    const payTo = typeof offer.payTo === 'string' && ADDRESS.test(offer.payTo) ? (offer.payTo as Address) : null;
    if (!payTo) return refuse(BASE_REASON.offer, 'the offer names no payTo address', 400);
    const amount = requiredAmount(offer);
    if (amount === null || amount <= 0n) return refuse(BASE_REASON.offer, 'the offer names no positive amount', 400);
    const validFor = timeoutOf(offer);
    if (validFor === null) return refuse(BASE_REASON.offer, `the offer's maxTimeoutSeconds is not a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}`, 400);
    const resource = typeof offer.resource === 'string' ? offer.resource : '';

    const amountMicro = toMicro(amount);
    if (amountMicro > this.options.maxPaymentMicro) {
      return refuse(BASE_REASON.tooLarge, `one Base payment is capped at ${this.options.maxPaymentMicro} USDC atomic units on this facilitator`);
    }
    const quote = this.price(amountMicro);

    const deployment = this.options.deployments.find((d) => same(d.escrow, reference.escrow));
    if (!deployment) return refuse(BASE_REASON.payer, `${reference.escrow} is not an escrow this facilitator settles for`);

    const now = BigInt(this.now());
    const validBefore = now + BigInt(validFor + AUTHORIZATION_MARGIN_SECONDS);
    const mustRemain = validBefore + BigInt(RETURN_GRACE_SECONDS + PRESENT_MARGIN_SECONDS);

    let lock: EscrowLock;
    try {
      lock = await this.readOpened(reference.escrow, reference.id);
      if (lock.status !== LOCKED) return refuse(BASE_REASON.notOpen, `lock ${reference.id} on ${reference.escrow} is not open`);
      if (!same(lock.payer, reference.mandate)) return refuse(BASE_REASON.payer, `lock ${reference.id} was not opened by ${reference.mandate}`);
      if (!same(lock.payee, this.float)) return refuse(BASE_REASON.payee, `lock ${reference.id} is payable to ${lock.payee}, and the Base lane settles to ${this.float}`);
      if (lock.amount !== quote.lockMicro) return refuse(BASE_REASON.amount, `lock ${reference.id} holds ${lock.amount} USDG atomic units, and ${amount} USDC with the fee needs ${quote.lockMicro}`);
      if (!same(lock.inputCommit, reference.inputCommit)) return refuse(BASE_REASON.unbound, `lock ${reference.id} commits to a different input than the one presented`);
      if (!opensFor(lock, binding)) return refuse(BASE_REASON.unbound, `lock ${reference.id} was not opened for this request`);
      if (lock.deadline < mustRemain) return refuse(BASE_REASON.deadline, `lock ${reference.id} runs out at ${lock.deadline}, and the authorization needs it to hold until ${mustRemain}`);

      const account = await this.options.escrow.mandate(reference.mandate);
      if (!same(account.escrow, reference.escrow)) return refuse(BASE_REASON.payer, `${reference.mandate} does not settle through ${reference.escrow}`);
      const accounts = await this.options.escrow.accountsOf(deployment.factory, account.principal);
      if (!accounts.some((entry) => same(entry, reference.mandate))) return refuse(BASE_REASON.payer, `${reference.mandate} is not a mandate account this deployment created`);
      const ids = await this.options.escrow.lockedIn(reference.transaction, reference.escrow);
      if (!ids.includes(reference.id)) return refuse(BASE_REASON.notOpen, `${reference.transaction} did not open lock ${reference.id}`);
    } catch (error) {
      this.log(`base pay unreadable lock=${reference.id} reason=${describe(error)}`);
      return refuse(BASE_REASON.unreadable, 'the lock could not be read from Robinhood Chain; try again in a moment', 503);
    }

    if (await this.options.ledger.findLock(this.options.chainId, reference.escrow, reference.id)) {
      return refuse(BASE_REASON.replay, `lock ${reference.id} already paid for a Base authorization`);
    }

    // Judged before anything is signed, and judged again under the ledger's lock when the row is
    // written. A pay the float cannot cover returns the lock now: it is payable to this lane.
    const [signedBlock, balance, promised] = await Promise.all([
      this.options.float.blockNumber(),
      this.options.float.balance(),
      this.options.ledger.promised(this.float),
    ]);
    if (toMicro(balance - promised) - amountMicro < this.options.floatMinimumMicro) {
      return this.shortFloat(reference.escrow, reference.id, toMicro(balance - promised), amountMicro);
    }

    const authorization: TransferAuthorization = {
      from: this.float,
      to: payTo,
      value: amount,
      validAfter: now - 60n,
      validBefore,
      nonce: deriveNonce(binding),
    };
    const signature = await this.options.float.signAuthorization(authorization);

    const opened = await this.options.ledger.open(
      {
        chainId: this.options.chainId,
        escrow: reference.escrow,
        lockId: reference.id,
        lockTransaction: reference.transaction,
        mandate: reference.mandate,
        float: this.float,
        network: this.options.float.network,
        asset: this.options.float.asset,
        payTo,
        resource,
        amountMicro,
        lockMicro: quote.lockMicro,
        feeMicro: quote.feeMicro,
        nonce: authorization.nonce,
        validBefore,
        deadline: lock.deadline,
        signedBlock,
      },
      { balance, minimumMicro: this.options.floatMinimumMicro },
    );
    if (!opened.opened) {
      // The signature never left this process, so nothing is out there to spend.
      if (opened.reason === 'replay') return refuse(BASE_REASON.replay, `lock ${reference.id} already paid for a Base authorization`);
      return this.shortFloat(reference.escrow, reference.id, opened.availableMicro, amountMicro);
    }

    this.log(`base signed payment=${opened.payment.id} lock=${reference.id} usdc=${amount} usdg=${quote.lockMicro} to=${payTo}`);
    return {
      payment: opened.payment,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
      signature,
    };
  }

  /** The float cannot cover a lock already open for this lane: return the lock, then say so. */
  private async shortFloat(escrow: Address, id: bigint, availableMicro: Micro, amountMicro: Micro): Promise<BaseRefusal> {
    const returned = await this.returnLock(escrow, id);
    return refuse(
      BASE_REASON.float,
      `the Base float can cover ${availableMicro > 0n ? availableMicro : 0n} USDC atomic units beyond its reserve right now, and this payment needs ${amountMicro}; ` +
        (returned ? `lock ${id} was cancelled and its USDG is back in the mandate (${returned})` : `lock ${id} could not be cancelled yet and returns to the mandate on timeout() after its deadline`),
    );
  }

  private async returnLock(escrow: Address, id: bigint): Promise<Hex | null> {
    try {
      const hash = await this.options.locks.cancel(escrow, id);
      this.log(`base returned unsigned lock=${id} tx=${hash}`);
      return hash;
    } catch (error) {
      this.log(`base could not return lock=${id} reason=${describe(error)}`);
      return null;
    }
  }

  async outcome(id: string, body: unknown): Promise<BasePayment | BaseRefusal> {
    const payment = await this.options.ledger.find(id);
    if (!payment) return refuse(BASE_REASON.notFound, `no Base payment by the id ${id}`, 404);
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const transaction = record['transaction'];
    if (typeof transaction === 'string' && HASH.test(transaction)) {
      await this.options.ledger.report(id, transaction as Hex);
    }
    return (await this.options.ledger.find(id)) ?? payment;
  }

  async payment(id: string): Promise<BasePayment | BaseRefusal> {
    const payment = await this.options.ledger.find(id);
    return payment ?? refuse(BASE_REASON.notFound, `no Base payment by the id ${id}`, 404);
  }

  /**
   * One pass over everything still open.
   *
   * A used nonce settles the lock to the float; an authorization past its window returns the lock to
   * the mandate. A row the chain will not answer for, or a write that fails, waits for the next pass.
   */
  async reconcile(): Promise<ReconcileResult> {
    const open = await this.options.ledger.listOpen(RECONCILE_BATCH);
    let settled = 0;
    let returned = 0;
    let pending = 0;
    let failed = 0;
    for (const payment of open) {
      try {
        const step = await this.reconcileOne(payment);
        if (step === 'settled') settled += 1;
        else if (step === 'returned') returned += 1;
        else pending += 1;
      } catch (error) {
        failed += 1;
        this.log(`base reconcile failed payment=${payment.id} lock=${payment.lockId} reason=${describe(error)}`);
      }
    }
    return { checked: open.length, settled, returned, pending, failed };
  }

  private async reconcileOne(payment: BasePayment): Promise<'settled' | 'returned' | 'pending'> {
    const now = BigInt(this.now());
    if (payment.status === 'signed') {
      const used = await this.options.float.authorizationUsed(payment.nonce);
      if (!used) {
        if (now <= payment.validBefore + BigInt(RETURN_GRACE_SECONDS)) return 'pending';
        const hash = await this.options.locks.cancel(payment.escrow, payment.lockId);
        await this.options.ledger.close(payment.id, 'returned', hash);
        this.log(`base returned payment=${payment.id} lock=${payment.lockId} tx=${hash}`);
        return 'returned';
      }
      const transaction = await this.transactionOf(payment);
      await this.options.ledger.markPaid(payment.id, transaction);
      return this.release({ ...payment, baseTransaction: transaction });
    }
    return this.release(payment);
  }

  private async release(payment: BasePayment): Promise<'settled'> {
    const proof = payment.baseTransaction ?? payment.nonce;
    const hash = await this.options.locks.release(
      payment.escrow,
      payment.lockId,
      keccak256(toBytes(proof)),
      payment.baseTransaction ? `${BASE_MAINNET.explorer}/tx/${payment.baseTransaction}` : `base:authorization:${payment.nonce}`,
    );
    await this.options.ledger.close(payment.id, 'settled', hash);
    this.log(`base settled payment=${payment.id} lock=${payment.lockId} base=${payment.baseTransaction ?? 'unknown'} tx=${hash}`);
    return 'settled';
  }

  private async transactionOf(payment: BasePayment): Promise<Hex | null> {
    try {
      const found = await this.options.float.authorizationTransaction(payment.nonce, payment.signedBlock);
      if (found) return found;
    } catch (error) {
      this.log(`base logs unreadable payment=${payment.id} reason=${describe(error)}`);
    }
    return payment.reportedTransaction;
  }

  async status(): Promise<FloatStatus> {
    const [balance, promised, open, stuck] = await Promise.all([
      this.options.float.balance(),
      this.options.ledger.promised(this.float),
      this.options.ledger.listOpen(RECONCILE_BATCH),
      this.options.ledger.countStuck(BigInt(this.now())),
    ]);
    const available = balance - promised;
    return {
      lane: 'base',
      network: this.options.float.network,
      asset: this.options.float.asset,
      float: this.float,
      balanceMicro: balance.toString(),
      promisedMicro: promised.toString(),
      availableMicro: available.toString(),
      minimumMicro: this.options.floatMinimumMicro.toString(),
      maxPaymentMicro: this.options.maxPaymentMicro.toString(),
      feeBps: this.options.feeBps,
      feeFloorMicro: this.options.feeFloorMicro.toString(),
      open: open.length,
      stuck,
      healthy: available >= this.options.floatMinimumMicro && stuck === 0,
    };
  }

  private async readOpened(escrow: Address, id: bigint): Promise<EscrowLock> {
    let lock = await this.options.escrow.lock(escrow, id);
    for (let read = 1; lock.status === NONE && read < UNSEEN_READS; read += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.options.unseenRetryMs ?? 1500));
      lock = await this.options.escrow.lock(escrow, id);
    }
    return lock;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
