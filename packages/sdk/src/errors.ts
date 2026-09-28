import { BursarError, isTotalBudgetWindow } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { formatGwei } from 'viem';
import type { Address, Hex } from 'viem';

import { eth, formatDeadline, toDate, usd } from './format.js';
import { issuerRefusal } from './refusals.js';
import type { Refusal } from './refusals.js';
import type { MandateLimits, Remaining, SpendWindow, TotalSpend } from './types.js';

/**
 * Why a mandate refused a spend, in the vocabulary a caller can branch on. One reason per
 * Solidity error keeps the mapping mechanical. An error the contract adds later shows up as an
 * unmapped name, not as a wrong reason.
 */
export type DenialReason =
  | 'paused'
  | 'revoked'
  | 'not-yet-valid'
  | 'expired'
  | 'per-call-cap'
  | 'daily-cap'
  | 'monthly-cap'
  | 'total-budget'
  | 'class-not-allowed'
  | 'capability-not-allowed'
  | 'merchant-not-allowed'
  | 'merchant-proof-required'
  | 'merchant-proof-invalid'
  | 'merchant-proof-unexpected'
  | 'approval-required'
  | 'approval-mismatch'
  | 'approval-expired'
  | 'approval-spent'
  | 'bad-signature'
  | 'not-agent'
  | 'zero-amount'
  | 'zero-address';

const DENIAL_REASONS: Readonly<Record<string, DenialReason>> = {
  IsPaused: 'paused',
  IsRevoked: 'revoked',
  NotYetValid: 'not-yet-valid',
  Expired: 'expired',
  PerCallCapExceeded: 'per-call-cap',
  DailyCapExceeded: 'daily-cap',
  MonthlyCapExceeded: 'monthly-cap',
  TotalCapExceeded: 'total-budget',
  ClassNotAllowed: 'class-not-allowed',
  CapabilityNotAllowed: 'capability-not-allowed',
  MerchantNotAllowed: 'merchant-not-allowed',
  MerkleGateActive: 'merchant-proof-required',
  BadMerkleProof: 'merchant-proof-invalid',
  AllowlistGateActive: 'merchant-proof-unexpected',
  ApprovalRequired: 'approval-required',
  ApprovalMismatch: 'approval-mismatch',
  ApprovalExpired: 'approval-expired',
  ApprovalSpent: 'approval-spent',
  BadSignature: 'bad-signature',
  NotAgent: 'not-agent',
  ZeroAmount: 'zero-amount',
  ZeroAddress: 'zero-address',
};

/**
 * The reason a Solidity error name stands for, or undefined when the account did not raise it.
 *
 * `MonthlyCapExceeded` comes back as `monthly-cap` here, because the name alone cannot say whether
 * the second window rolls. A `MandateDeniedError` that carries a snapshot settles it: a second
 * window long enough to be the total budget turns the reason into `total-budget`.
 */
export function denialReasonFor(errorName: string): DenialReason | undefined {
  return DENIAL_REASONS[errorName];
}

/** What the mandate looked like when it refused, read back so the message can be specific. */
export type MandateSnapshot = {
  readonly limits: MandateLimits;
  readonly remaining: Remaining;
  readonly daily: SpendWindow;
  readonly monthly: SpendWindow;
  /** The native lifetime total of a v2 account. Absent or null where there is none. */
  readonly total?: TotalSpend | null;
};

export type MandateDenial = {
  readonly reason: DenialReason;
  readonly errorName: string;
  readonly mandate: Address;
  readonly merchant?: Address;
  readonly capabilityId?: Hex;
  readonly capability?: string;
  readonly amount?: Micro;
  readonly snapshot?: MandateSnapshot;
  readonly now?: Date;
};

function subject(denial: MandateDenial): string {
  const amount = denial.amount === undefined ? 'a payment' : `a ${usd(denial.amount)} payment`;
  const to = denial.merchant === undefined ? '' : ` to ${denial.merchant}`;
  return `Mandate ${denial.mandate} refused ${amount}${to}`;
}

function capabilityLabel(denial: MandateDenial): string {
  return denial.capability ?? denial.capabilityId ?? 'the requested capability';
}

function windowClause(
  label: string,
  window: SpendWindow,
  remaining: Micro,
  denial: MandateDenial,
  now: Date,
): string {
  const asked = denial.amount === undefined ? '' : ` and this call asks for ${usd(denial.amount)}`;
  return (
    `the ${label} limit has ${usd(remaining)} left of ${usd(window.cap)}${asked}. ` +
    `The ${label} window resets at ${formatDeadline(window.resetsAt, now)}.`
  );
}

function clauseFor(denial: MandateDenial, now: Date): string {
  const snapshot = denial.snapshot;

  switch (denial.reason) {
    case 'paused':
      return 'the principal has paused it. Spending resumes when the principal calls setPaused(false).';
    case 'revoked':
      return 'the agent was revoked. The principal has to seat one with setAgent before it can spend again.';
    case 'not-yet-valid':
      return snapshot
        ? `it is not valid until ${formatDeadline(toDate(snapshot.limits.validFrom), now)}.`
        : 'it is not valid yet.';
    case 'expired':
      return snapshot
        ? `it expired at ${toDate(snapshot.limits.validUntil).toISOString()}.`
        : 'it has expired.';
    case 'per-call-cap':
      return snapshot
        ? `the per-call limit is ${usd(snapshot.limits.perCallCap)}${
            denial.amount === undefined ? '' : ` and this call asks for ${usd(denial.amount)}`
          }. Split the job or raise the limit.`
        : 'the payment is above the per-call limit.';
    case 'daily-cap':
      return snapshot
        ? windowClause('daily', snapshot.daily, snapshot.remaining.daily, denial, now)
        : 'the daily limit is exhausted.';
    case 'monthly-cap':
      return snapshot
        ? windowClause('monthly', snapshot.monthly, snapshot.remaining.monthly, denial, now)
        : 'the monthly limit is exhausted.';
    case 'total-budget': {
      if (snapshot?.total) {
        const asked = denial.amount === undefined ? '' : ` and this call asks for ${usd(denial.amount)}`;
        return (
          `the total budget has ${usd(snapshot.total.remaining)} left of ${usd(snapshot.total.cap)}${asked}. ` +
          'The total budget does not refill; the principal raises it with setLimits.'
        );
      }
      if (!snapshot) return 'the total budget is spent. It does not refill; the principal raises it with setLimits.';
      const asked = denial.amount === undefined ? '' : ` and this call asks for ${usd(denial.amount)}`;
      return (
        `the total budget has ${usd(snapshot.remaining.monthly)} left of ${usd(snapshot.monthly.cap)}${asked}. ` +
        'The total budget does not refill; the principal raises it with setLimits.'
      );
    }
    case 'class-not-allowed':
      return 'its principal has not allowed this class of spend. The principal changes the allowed classes with setLimits.';
    case 'capability-not-allowed':
      return `${capabilityLabel(denial)} is not on its capability allowlist.`;
    case 'merchant-not-allowed':
      return 'the merchant is not on its allowlist. The principal adds one with setMerchant.';
    case 'merchant-proof-required':
      return 'it gates merchants by Merkle root, so the spend has to carry a proof for this merchant.';
    case 'merchant-proof-invalid':
      return 'the merchant proof does not verify against the root this mandate holds.';
    case 'merchant-proof-unexpected':
      return 'it gates merchants by allowlist, so the spend must not carry a Merkle proof.';
    case 'approval-required':
      return snapshot
        ? `it is at or above the approval threshold of ${usd(
            snapshot.limits.approvalThreshold,
          )} and carries no approval from the principal. Sign one with signApproval and pass it to pay.`
        : 'it is at or above the approval threshold and carries no approval from the principal.';
    case 'approval-mismatch':
      return 'the approval names a different merchant, capability, or a smaller amount than this spend.';
    case 'approval-expired':
      return 'the approval has expired. The principal has to sign a new one.';
    case 'approval-spent':
      return 'the approval was already used or revoked. Approvals are single use.';
    case 'bad-signature':
      return 'the approval signature does not recover to the principal on this mandate.';
    case 'not-agent':
      return 'the signer is not the agent seated on this mandate.';
    case 'zero-amount':
      return 'the amount is zero.';
    case 'zero-address':
      return 'the merchant address is zero.';
  }
}

/**
 * A spend the mandate refused, with the limit that stopped it and the clock attached.
 *
 * Every field the message quotes is also a property. A caller waiting for the window to roll
 * reads `resetsAt` and leaves the prose alone.
 */
export class MandateDeniedError extends BursarError {
  readonly reason: DenialReason;
  readonly errorName: string;
  readonly mandate: Address;
  readonly merchant: Address | undefined;
  readonly capabilityId: Hex | undefined;
  readonly amount: Micro | undefined;
  readonly snapshot: MandateSnapshot | undefined;
  /** When the limit that stopped this spend next frees allowance. Undefined when nothing resets. */
  readonly resetsAt: Date | undefined;

  constructor(given: MandateDenial) {
    const denial = withTotalBudget(given);
    const now = denial.now ?? new Date();
    super('mandate_denied', `${subject(denial)}: ${clauseFor(denial, now)}`, {
      reason: denial.reason,
      errorName: denial.errorName,
      mandate: denial.mandate,
      merchant: denial.merchant,
      capabilityId: denial.capabilityId,
      amount: denial.amount?.toString(),
    });

    this.reason = denial.reason;
    this.errorName = denial.errorName;
    this.mandate = denial.mandate;
    this.merchant = denial.merchant;
    this.capabilityId = denial.capabilityId;
    this.amount = denial.amount;
    this.snapshot = denial.snapshot;
    this.resetsAt = resetOf(denial);
  }
}

/**
 * A `MonthlyCapExceeded` from a second window that never rolls is the total budget running out,
 * and it is named that way. Calling it a monthly cap would send the reader to wait for a reset that
 * never comes.
 */
function withTotalBudget(denial: MandateDenial): MandateDenial {
  if (denial.reason !== 'monthly-cap' || !denial.snapshot) return denial;
  return isTotalBudgetWindow(denial.snapshot.limits.monthlyWindow) ? { ...denial, reason: 'total-budget' } : denial;
}

function resetOf(denial: MandateDenial): Date | undefined {
  if (!denial.snapshot) return undefined;
  if (denial.reason === 'daily-cap') return denial.snapshot.daily.resetsAt;
  if (denial.reason === 'monthly-cap') return denial.snapshot.monthly.resetsAt;
  return undefined;
}

/**
 * A contract said no for a reason that is not a spending limit: the escrow would not take the
 * lock, the caller is not the principal, the deadline sits outside the escrow's bounds. The
 * message says which condition and what to do about it; `errorName` is the Solidity error behind it.
 */
export class CallRefusedError extends BursarError {
  readonly errorName: string;

  constructor(errorName: string, message: string, details: Record<string, unknown> = {}) {
    super('call_refused', message, { ...details, errorName });
    this.errorName = errorName;
  }
}

/** The mandate account does not hold enough of the settlement asset to open the lock. */
export class InsufficientFundsError extends BursarError {
  readonly account: Address;
  readonly balance: Micro | undefined;
  readonly required: Micro | undefined;

  constructor(account: Address, balance: Micro | undefined, required: Micro | undefined) {
    const held = balance === undefined ? '' : ` It holds ${usd(balance)}`;
    const needs = required === undefined ? '.' : ` and this spend needs ${usd(required)}.`;
    super(
      'insufficient_funds',
      `Mandate ${account} is not funded for this payment.${held}${needs} ` +
        'Fund it by sending USDG to the account, or call deposit.',
      { account, balance: balance?.toString(), required: required?.toString() },
    );

    this.account = account;
    this.balance = balance;
    this.required = required;
  }
}

/**
 * A failure on gas, split by what the caller has to change.
 *
 * Money fixes `unfunded`. A different limit fixes `out-of-gas`, `limit-below-intrinsic` and
 * `estimate-failed`. Nothing but less work fixes `limit-above-block`. One shared message would
 * leave a caller guessing between funding an address and rewriting a call.
 */
export type GasFailureReason =
  /** The sender holds too little ETH to pay the fee. Its USDG balance has no bearing on this. */
  | 'unfunded'
  /** Execution consumed the whole limit it was given. */
  | 'out-of-gas'
  /** The limit was under the fixed cost of admitting the transaction, so nothing ran. */
  | 'limit-below-intrinsic'
  /** The limit was over what a single block can hold, so nothing ran. */
  | 'limit-above-block'
  /** The node would not price the call, and the transaction was never broadcast. */
  | 'estimate-failed';

export type GasFailure = {
  readonly reason: GasFailureReason;
  /** The contract function this was, named the way the caller wrote it. */
  readonly action: string;
  /** The address that pays the fee: the signer, never the mandate account. */
  readonly sender?: Address;
  /** The sender's ETH balance in wei, which is the asset fees are charged in. */
  readonly balanceWei?: bigint;
  /** The limit in play, when the node or the receipt said what it was. */
  readonly gasLimit?: bigint;
  /** What the node said the call needs, or what it was allowed to use. */
  readonly gasNeeded?: bigint;
  readonly maxFeePerGas?: bigint;
  /** Set when the transaction mined and failed, so the caller can look it up. */
  readonly hash?: Hex;
  /** The node's own words, kept for a log line and left out of the message. */
  readonly nodeMessage?: string;
};

function gasCount(gas: bigint): string {
  return gas.toLocaleString('en-US');
}

function atPrice(failure: GasFailure): string {
  return failure.maxFeePerGas === undefined ? '' : ` at ${formatGwei(failure.maxFeePerGas)} gwei`;
}

/** How much gas the sender's balance covers, which is the number that settles the ambiguity. */
function coverage(failure: GasFailure): string {
  const { balanceWei, sender, maxFeePerGas } = failure;
  if (balanceWei === undefined || sender === undefined) return '';

  const covers =
    maxFeePerGas === undefined || maxFeePerGas <= 0n
      ? ''
      : `, which covers ${gasCount(balanceWei / maxFeePerGas)} gas${atPrice(failure)}`;

  return ` ${sender} holds ${eth(balanceWei)}${covers}.`;
}

function gasClause(failure: GasFailure): string {
  const { action, gasLimit, gasNeeded } = failure;

  switch (failure.reason) {
    case 'unfunded': {
      const needs =
        gasLimit !== undefined && failure.maxFeePerGas !== undefined
          ? ` and the fee comes to ${eth(gasLimit * failure.maxFeePerGas)}`
          : '';
      const holds =
        failure.balanceWei === undefined ? '' : ` It holds ${eth(failure.balanceWei)}${needs}.`;

      return (
        `${action} cannot be paid for: ${failure.sender ?? 'the signer'} is out of ETH.${holds} ` +
        'Fees are charged in ETH and payments settle in USDG, so a signer can hold all the USDG ' +
        'it needs and still be unable to send this. Send ETH to the signer and try again. Funding ' +
        'the mandate account does not help: that funds payments, not fees.'
      );
    }

    case 'out-of-gas': {
      const used =
        gasLimit === undefined
          ? 'execution used every unit of gas it was given'
          : `execution used the whole ${gasCount(gasLimit)} gas limit`;
      const where = failure.hash === undefined ? '' : ` in transaction ${failure.hash}`;

      return (
        `${action} ran out of gas: ${used}${where}. Raise the gas limit and send it again, or ` +
        `split the work if it cannot fit in one transaction.${coverage(failure)}`
      );
    }

    case 'limit-below-intrinsic': {
      const floor = gasNeeded === undefined ? '' : ` of at least ${gasCount(gasNeeded)}`;
      const given = gasLimit === undefined ? 'the gas limit' : `a gas limit of ${gasCount(gasLimit)}`;

      return (
        `${action} was rejected before it ran: ${given} is below what the chain charges just to ` +
        `admit a transaction of this size. Set a limit${floor}, or leave it unset and let the ` +
        'estimate pick one.'
      );
    }

    case 'limit-above-block': {
      const ceiling = gasNeeded === undefined ? '' : ` of ${gasCount(gasNeeded)}`;
      const given = gasLimit === undefined ? 'the gas limit' : `a gas limit of ${gasCount(gasLimit)}`;

      return (
        `${action} was rejected before it ran: ${given} is above the block gas limit${ceiling}. ` +
        'No single transaction can use that much. Split the work across calls.'
      );
    }

    case 'estimate-failed': {
      const allowance =
        gasNeeded === undefined
          ? ''
          : ` It needs more than the ${gasCount(gasNeeded)} gas it is allowed.`;

      return (
        `${action} was never sent: the node would not estimate gas for it.${allowance} Pass a gas ` +
        `limit if you know the call fits in a block, or split the work.${coverage(failure)}`
      );
    }
  }
}

/**
 * A transaction that failed on gas.
 *
 * Worth separating from a revert because the fixes have nothing in common: a caller told "the
 * revert data decoded to nothing this package knows" goes looking for a spending limit that never
 * fired, when the answer is a number in the transaction or a balance on the signer.
 *
 * `unfunded` is the one a caller is most likely to misread, because a node reports a signer that
 * cannot pay and a gas limit set too low with the same sentence. The balance tells them apart and
 * the wording does not. `balanceWei` is ETH, the asset fees are charged in, and it is a plain
 * bigint rather than a `Micro`: the settlement asset is USDG and the two are not the same money.
 */
export class GasFailureError extends BursarError {
  readonly reason: GasFailureReason;
  readonly action: string;
  readonly sender: Address | undefined;
  /** The signer's ETH balance in wei. Undefined when the node could not be asked for it. */
  readonly balanceWei: bigint | undefined;
  readonly gasLimit: bigint | undefined;
  readonly gasNeeded: bigint | undefined;
  readonly maxFeePerGas: bigint | undefined;
  readonly hash: Hex | undefined;

  constructor(failure: GasFailure, cause?: unknown) {
    super('gas_failure', gasClause(failure), {
      reason: failure.reason,
      action: failure.action,
      sender: failure.sender,
      balanceWei: failure.balanceWei?.toString(),
      gasLimit: failure.gasLimit?.toString(),
      gasNeeded: failure.gasNeeded?.toString(),
      maxFeePerGas: failure.maxFeePerGas?.toString(),
      hash: failure.hash,
      nodeMessage: failure.nodeMessage,
    });

    this.reason = failure.reason;
    this.action = failure.action;
    this.sender = failure.sender;
    this.balanceWei = failure.balanceWei;
    this.gasLimit = failure.gasLimit;
    this.gasNeeded = failure.gasNeeded;
    this.maxFeePerGas = failure.maxFeePerGas;
    this.hash = failure.hash;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Branch on a gas failure without `instanceof`, which is only true for the copy of this package
 * that threw. A workspace resolving two copies is ordinary, and the code on the error survives it.
 */
export function isGasFailure(error: unknown): error is GasFailureError {
  return error instanceof BursarError && error.code === 'gas_failure';
}

/**
 * A revert this package has no better name for. The decoded Solidity error is on the instance.
 *
 * The named branch is a last resort: `MandateAccountClient` and `EscrowClient` write the condition
 * out for every error their own contracts declare, so reaching this means the call hit a contract
 * further down, or a deployment newer than this package. It still has to leave the caller with
 * something to do, because it renders on the money path.
 */
export class ContractRevertError extends BursarError {
  readonly errorName: string | undefined;

  constructor(action: string, errorName: string | undefined, cause?: unknown) {
    super(
      'contract_reverted',
      errorName === undefined
        ? `${action} failed and came back with no reason attached. Some nodes drop revert data, ` +
            'so retry against a second endpoint; if it is still empty, the call reverted inside a ' +
            'contract this deployment does not record.'
        : `${action} was refused with ${errorName}, and there is no plain-language reading for that ` +
            'name here yet. The condition behind it holds until something changes, so read the ' +
            'mandate again before sending the same call a second time. ' +
            `${errorName} is the contract's own name for the condition: quote it when you report this.`,
      { action, errorName },
    );

    this.errorName = errorName;
    if (cause !== undefined) this.cause = cause;
  }
}

/** A transaction that mined and failed. viem resolves a reverted receipt as an ordinary result. */
export class TransactionRevertedError extends BursarError {
  readonly hash: Hex;

  constructor(action: string, hash: Hex) {
    super(
      'transaction_reverted',
      `${action} reverted on chain in transaction ${hash}. A receipt carries no reason, so ` +
        'simulate the same call at that block to get one.',
      { action, hash },
    );
    this.hash = hash;
  }
}

/**
 * The node accepted the transaction but no receipt arrived inside the wait. The hash is the part
 * a caller keeps: the transaction may still confirm. Report it and check later before sending the
 * same call a second time.
 */
export class SubmittedButUnconfirmedError extends BursarError {
  readonly hash: Hex;

  constructor(hash: Hex, timeoutMs: number, cause?: unknown) {
    super(
      'receipt_timeout',
      `Transaction ${hash} was submitted but no receipt arrived within ${timeoutMs}ms. ` +
        'It may still confirm. Report the hash and check it before sending the call again.',
      { hash, timeoutMs },
    );

    this.hash = hash;
    if (cause !== undefined) this.cause = cause;
  }
}

/** A receipt that carried none of the event the call is identified by. */
export class MissingEventError extends BursarError {
  readonly hash: Hex;

  constructor(eventName: string, emitter: Address, hash: Hex) {
    super(
      'event_missing',
      `Transaction ${hash} carried no ${eventName} event from ${emitter}. ` +
        'The transaction succeeded, so this is a node returning a pruned receipt rather than a failed call.',
      { eventName, emitter, hash },
    );
    this.hash = hash;
  }
}

/**
 * The transaction mined and its receipt cannot be tied to one spend.
 *
 * Separate from `InvalidArgumentError` because of what a caller does next. An argument error means
 * nothing happened and the call can be corrected and repeated; this one means the money has
 * already moved. Read the transaction rather than sending it again.
 */
export class AmbiguousSpendError extends BursarError {
  readonly hash: Hex;
  readonly spends: number;

  constructor(hash: Hex, mandate: Address, spends: number) {
    super(
      'spend_ambiguous',
      `Transaction ${hash} carried ${spends} spends from mandate ${mandate}, so none of them can ` +
        'be identified as this one. The payments have settled: read the transaction rather than ' +
        'sending it again. pay() sends one spend per transaction; batch through the escrow ' +
        'directly if you need more.',
      { hash, mandate, spends },
    );

    this.hash = hash;
    this.spends = spends;
  }
}

/**
 * A sealed score whose fate is unknown, with the pair that opens it.
 *
 * The salt exists only in this process until the reveal. Once the commitment has been handed to
 * the network, a failure anywhere after that point (the send, the wait for a receipt, the read
 * back) can leave it on chain with nothing else holding the salt, and a commitment nobody reveals
 * is slashed as silence. So whatever went wrong travels as `cause`, and the salt travels here.
 */
export class UnconfirmedCommitError extends BursarError {
  readonly salt: Hex;
  readonly score: number;
  readonly disputeId: bigint;

  constructor(input: { disputeId: bigint; score: number; salt: Hex; cause: unknown }) {
    const said = input.cause instanceof Error ? input.cause.message.trim() : String(input.cause);
    const reason = /[.!?]$/u.test(said) ? said : `${said}.`;
    const causeCode = input.cause instanceof BursarError ? input.cause.code : undefined;
    const hash = (input.cause as { hash?: unknown } | null)?.hash;

    super(
      'commit_unconfirmed',
      `Sealing score ${input.score} on dispute ${input.disputeId} did not finish: ${reason} ` +
        'The commitment may be on chain. If it is, only salt ' +
        `${input.salt} with score ${input.score} reveals it, and a commitment left sealed is slashed ` +
        `as silence. Keep both, and read committedBy for dispute ${input.disputeId} before ` +
        'committing again.',
      {
        disputeId: input.disputeId.toString(),
        score: input.score,
        salt: input.salt,
        ...(causeCode === undefined ? {} : { causeCode }),
        ...(typeof hash === 'string' ? { hash } : {}),
      },
    );

    this.salt = input.salt;
    this.score = input.score;
    this.disputeId = input.disputeId;
    this.cause = input.cause;
  }
}

/** Which address in the pair a client opens on came back empty. */
export type MissingContract = 'account' | 'escrow';

/**
 * The network answered, and the address holds nothing that behaves like the contract asked for.
 *
 * A well-formed address that holds no code is the first mistake a newcomer makes: a wallet
 * pasted in place of a mandate, a mandate from another chain, a deployment that never landed.
 * All three read as an empty return from every call, which viem reports as a decoding failure
 * against the function name it tried. That names the wrong problem, so it is caught here.
 */
export class NotAMandateAccountError extends BursarError {
  readonly address: Address;
  readonly contract: MissingContract;

  constructor(input: { address: Address; contract: MissingContract; account?: Address }) {
    super(
      'no_mandate_account',
      input.contract === 'account'
        ? `No mandate account is deployed at ${input.address}. The network answered and nothing at ` +
            'this address behaves like a mandate account. Check the address and the chain this ' +
            'connection is on, or deploy one with createMandate.'
        : `Mandate ${input.account ?? 'account'} names ${input.address} as its escrow, and nothing ` +
            'at that address answers as one. The two usually come from different deployments: ' +
            'check which chain this connection is pointed at.',
      { address: input.address, contract: input.contract, account: input.account },
    );

    this.address = input.address;
    this.contract = input.contract;
  }
}

/** An argument this package rejected before it cost anything. `field` names which one. */
export class InvalidArgumentError extends BursarError {
  readonly field: string;

  constructor(field: string, message: string, details: Record<string, unknown> = {}) {
    super('argument_invalid', message, { ...details, field });
    this.field = field;
  }
}

/** A resource server asked to be paid in a way this client cannot settle. */
export class NoAcceptablePaymentError extends BursarError {
  readonly offers: readonly string[];

  constructor(resource: string, offers: readonly string[], wanted: string) {
    super(
      'x402_no_offer',
      offers.length === 0
        ? `${resource} answered 402 but offered no payment terms this client could read.`
        : `${resource} offered ${offers.join(', ')}, and this client settles ${wanted}.`,
      { resource, offers, wanted },
    );

    this.offers = offers;
  }
}

/** The payment was made and the server still refused it. */
export class PaymentRejectedError extends BursarError {
  readonly status: number;
  readonly reason: string | undefined;
  /**
   * Set when the refusal is one the token issuer owns, which is the only kind no retry and no
   * mandate change can clear. Null for every other reason, including one this build has no
   * reading for, so `refusal === null` is never a claim that the caller can fix it.
   */
  readonly refusal: Refusal | null;

  constructor(resource: string, status: number, reason: string | undefined) {
    const refusal = reason === undefined ? null : issuerRefusal(reason);

    super(
      'x402_rejected',
      `${resource} refused the payment` +
        (reason === undefined
          ? ` and answered ${status}.`
          : refusal === null
            ? `: ${reason}`
            : `: ${reason}. ${refusal.message}`),
      { resource, status, reason, owner: refusal?.owner },
    );

    this.status = status;
    this.reason = reason;
    this.refusal = refusal;
  }
}

/**
 * A write was asked for on a connection that holds no signer.
 *
 * `openedBy` is the call that built the connection. A caller who opened a client with
 * `mandateAccount(address, { rpc })` never called connect(), so telling them to pass an account to
 * connect() sends them looking for a call that is not in their code.
 */
export class NoSignerError extends BursarError {
  constructor(action: string, openedBy = 'connect()') {
    super(
      'no_signer',
      `${action} sends a transaction, and this client was opened read-only: ${openedBy} was given ` +
        `no account and no walletClient. Pass account (a private key or a viem Account) or ` +
        `walletClient in the options to ${openedBy}.`,
      { action, openedBy },
    );
  }
}

/**
 * connect() was asked for a chain BURSAR has no deployment on.
 *
 * Every address in a deployment record is a contract on one chain. Answering a request for chain
 * 8453 with the 4663 record would point every read at the wrong network, so the request is refused
 * and the chains that do have a record are named.
 */
export class UnsupportedChainError extends BursarError {
  readonly chainId: number;
  readonly supported: readonly number[];

  constructor(chainId: number, supported: readonly number[]) {
    super(
      'chain_unsupported',
      supported.length === 0
        ? `BURSAR has no deployment on chain ${chainId}, and this build records none on any chain.`
        : `BURSAR has no deployment on chain ${chainId}. Supported: ${supported
            .map((id) => (id === 4663 ? '4663 (Robinhood Chain mainnet)' : String(id)))
            .join(', ')}.`,
      { chainId, supported },
    );

    this.chainId = chainId;
    this.supported = supported;
  }
}
