import { isBursarError } from '@bursar/core';
import type { Micro } from '@bursar/core';
import {
  ContractRevertError,
  GasFailureError,
  InsufficientFundsError,
  MandateDeniedError,
  TransactionRevertedError,
  denialReasonFor,
  gasFailureFrom,
  revertFrom,
} from '@bursar/sdk';
import type { GasFailureReason, GasSignal, MandateSnapshot, RevertInfo } from '@bursar/sdk';
import type { Address, Hex } from 'viem';

import type { FundingFacts, MandateFacts } from '@/state/types';

/**
 * The seam between a raw wallet failure and the errors this product knows how to say out loud.
 *
 * Writes in the console go out through wagmi, never through `@bursar/sdk`, so nothing comes back
 * typed: a spend the mandate refused with `DailyCapExceeded` arrives as a viem error with
 * four bytes buried somewhere in its cause chain, and the screen ends up quoting the node instead
 * of naming the limit. The decoding is the SDK's own, and so is every error raised from it, which
 * is what keeps one taxonomy behind the agent path and the console.
 */
export type WriteContext = {
  /** The call in the reader's words, quoted back in the message. "Pay a provider", not "spend". */
  readonly action: string;
  readonly mandate?: Address;
  readonly merchant?: Address;
  readonly capability?: string;
  readonly capabilityId?: Hex;
  readonly amount?: Micro;
  /** The reading already on the screen. It is what lets a refusal name the bucket and the clock. */
  readonly facts?: MandateFacts;
  /** Who pays the fee and what they hold, for the failures gas causes. */
  readonly funding?: FundingFacts;
  /** Set once the transaction is on chain. A failure with a hash behind it mined and rolled back. */
  readonly hash?: Hex;
};

/**
 * Names the failure behind a write. Wrap a caught one with it:
 * `writeContractAsync(request).catch((caught) => { throw failureFrom(caught, { action: 'Pay a provider', mandate, amount, facts: system.mandate.facts }); })`
 *
 * Order carries the design, and it is the SDK's. A decoded contract error is the most specific
 * thing available and wins. What is left is read for a gas failure before anything generic, since
 * the generic answer says the reason could not be read and a gas failure has a reason.
 */
export function failureFrom(error: unknown, context: WriteContext): unknown {
  if (isUserRejection(error)) return error;

  // Anything already carrying a code was named where it was raised, and that naming had more to
  // work with than this does. The RPC pool's own errors are the exception: they are an envelope
  // around the node's answer, and a refusal the contract wrote is inside one.
  if (isBursarError(error) && !error.code.startsWith('rpc_')) return error;

  const revert = revertFrom(error);
  if (revert) {
    return named(revert, context) ?? new ContractRevertError(context.action, revert.errorName, error);
  }

  const signal = gasFailureFrom(error);
  if (signal) return gasFailure(signal, context, error);

  if (isBursarError(error)) return error;
  if (context.hash !== undefined) return new TransactionRevertedError(context.action, context.hash);

  return error;
}

/** The two revert families this product has a better story for than the name of the error. */
function named(revert: RevertInfo, context: WriteContext): Error | undefined {
  const mandate = context.mandate ?? context.facts?.account?.address;
  if (mandate === undefined) return undefined;

  const reason = denialReasonFor(revert.errorName);
  if (reason) {
    return new MandateDeniedError({
      reason,
      errorName: revert.errorName,
      mandate,
      merchant: context.merchant,
      capability: context.capability,
      capabilityId: context.capabilityId,
      amount: context.amount,
      snapshot: snapshotOf(context.facts),
    });
  }

  if (isShortOfFunds(revert)) {
    return new InsufficientFundsError(mandate, context.facts?.account?.balance, context.amount);
  }

  return undefined;
}

/**
 * The settlement asset reports a short balance twice over: as the ERC-6093 error a modern token
 * raises, and as the plain string an older one reverts with. Both mean the account needs funding.
 */
function isShortOfFunds(revert: RevertInfo): boolean {
  if (revert.errorName === 'ERC20InsufficientBalance') return true;
  if (revert.errorName !== 'Error') return false;

  const reason = revert.args[0];
  return typeof reason === 'string' && /balance|funds/i.test(reason);
}

function snapshotOf(facts: MandateFacts | undefined): MandateSnapshot | undefined {
  const account = facts?.account;
  if (!account) return undefined;

  return {
    limits: account.limits,
    remaining: account.remaining,
    daily: account.daily,
    monthly: account.monthly,
  };
}

function gasFailure(signal: GasSignal, context: WriteContext, cause: unknown): GasFailureError {
  const funding = context.funding;

  return new GasFailureError(
    {
      reason: settledReason(signal, funding),
      action: context.action,
      sender: funding?.gasPayer,
      balanceWei: funding?.gasBalance,
      gasLimit: signal.gasLimit,
      gasNeeded: signal.gasNeeded,
      hash: context.hash,
      nodeMessage: signal.nodeMessage,
    },
    cause,
  );
}

/**
 * Decides between a call that is too large and a signer that has run out of ETH.
 *
 * A node caps its estimate at what the sender can pay, so both come back in the same sentence. The
 * signer's ETH balance is the only thing that separates them, and it is already on the screen. A
 * limit the node rejected outright is left alone: that number is wrong at any balance.
 */
function settledReason(signal: GasSignal, funding: FundingFacts | undefined): GasFailureReason {
  if (signal.reason !== 'estimate-failed' && signal.reason !== 'out-of-gas') return signal.reason;
  if (funding?.gasBalance === undefined) return signal.reason;

  return funding.gasBalance < funding.roundTripFee ? 'unfunded' : signal.reason;
}

/** Every wallet reports a cancelled signature differently. All of them mean the same thing. */
export function isUserRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const shaped = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (shaped.name === 'UserRejectedRequestError') return true;
  if (shaped.code === 4001) return true;
  if (typeof shaped.message === 'string' && /user rejected|user denied|request rejected/i.test(shaped.message)) return true;
  return shaped.cause !== undefined && isUserRejection(shaped.cause);
}
