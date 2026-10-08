import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { decodeFunctionData, toFunctionSelector } from 'viem';
import type { Abi, Address, Hex } from 'viem';

import { escrowAbi, mandateAccountAbi, mandateAccountAbiV1 } from '@/chain/abi';
import type { ActionOwner, StateKey } from '@/state/types';

/**
 * Why a payment was refused, and which of the five states produced the refusal.
 *
 * A refusal that says only "declined" is the failure this surface exists to prevent. Each of the
 * five states has a different owner and a different fix, so every refusal is attributed to one of
 * them, or explicitly to none of them when the truth is that the escrow's own lifecycle rules
 * stopped the call. Naming nothing is never an option: an error this build does not recognise is
 * reported with its selector and said to be unrecognised.
 */

export type RefusalCause = {
  /** The contract's own name for the error, when this build recognises the selector. */
  readonly errorName: string | undefined;
  /** Which of the five states caused it, or null when none of them did. */
  readonly state: StateKey | null;
  readonly headline: string;
  readonly detail: string;
  readonly owner: ActionOwner;
};

export type RevertReading = {
  readonly selector?: Hex | undefined;
  readonly message?: string | undefined;
};

const CAUSES: Readonly<Record<string, Omit<RefusalCause, 'errorName'>>> = {
  IsPaused: {
    state: 'mandate',
    headline: 'The mandate was paused',
    detail: 'The owner paused this mandate. Payments are refused until it is resumed.',
    owner: 'principal',
  },
  IsRevoked: {
    state: 'mandate',
    headline: 'The agent was revoked',
    detail: 'This mandate has no agent. Seat one to start again.',
    owner: 'principal',
  },
  NotYetValid: {
    state: 'mandate',
    headline: 'The mandate had not opened yet',
    detail: 'The payment came before the mandate’s start date.',
    owner: 'principal',
  },
  Expired: {
    state: 'mandate',
    headline: 'The mandate had expired',
    detail: 'The end date had passed. The owner can extend it by changing the limits.',
    owner: 'principal',
  },
  PerCallCapExceeded: {
    state: 'mandate',
    headline: 'Over the limit for one payment',
    detail: 'The amount was above the per-payment limit.',
    owner: 'principal',
  },
  DailyCapExceeded: {
    state: 'mandate',
    headline: 'The period cap was reached',
    detail: 'The amount was more than the current period had left. It refills when the period resets.',
    owner: 'principal',
  },
  MonthlyCapExceeded: {
    state: 'mandate',
    headline: 'The second cap was reached',
    detail: 'The amount was more than the second cap had left. It refills when that period resets.',
    owner: 'principal',
  },
  TotalCapExceeded: {
    state: 'mandate',
    headline: 'The total budget is spent',
    detail: 'The amount was more than the total budget had left. It never refills; only the owner can raise it.',
    owner: 'principal',
  },
  ClassNotAllowed: {
    state: 'permission',
    headline: 'This kind of spend is not allowed',
    detail: 'This mandate does not allow this kind of payment.',
    owner: 'principal',
  },
  MerchantNotAllowed: {
    state: 'permission',
    headline: 'The payee is not on the list',
    detail: 'This mandate pays only the payees its owner has allowed.',
    owner: 'principal',
  },
  CapabilityNotAllowed: {
    state: 'permission',
    headline: 'The capability is not allowed',
    detail: 'The work being bought is outside what this mandate covers.',
    owner: 'principal',
  },
  MerkleGateActive: {
    state: 'permission',
    headline: 'The payee list needs a proof',
    detail: 'This mandate checks payees against a published list, and the payment carried no proof.',
    owner: 'agent',
  },
  BadMerkleProof: {
    state: 'permission',
    headline: 'The proof did not match the payee list',
    detail: 'The proof does not match the published payee list.',
    owner: 'agent',
  },
  AllowlistGateActive: {
    state: 'permission',
    headline: 'A proof was sent that is not needed',
    detail: 'This mandate uses its own payee list, so it takes no proof.',
    owner: 'agent',
  },
  ApprovalRequired: {
    state: 'permission',
    headline: 'The amount needs the owner to approve it',
    detail: 'The payment is at or above the approval threshold, so it needs the owner’s approval.',
    owner: 'principal',
  },
  ApprovalMismatch: {
    state: 'permission',
    headline: 'The approval does not cover this payment',
    detail: 'The approval names a different payee, kind of work or amount.',
    owner: 'principal',
  },
  ApprovalExpired: {
    state: 'permission',
    headline: 'The approval had expired',
    detail: 'The approval expired before it was used.',
    owner: 'principal',
  },
  ApprovalSpent: {
    state: 'permission',
    headline: 'The approval was already used',
    detail: 'Each approval covers one payment.',
    owner: 'principal',
  },
  BadSignature: {
    state: 'permission',
    headline: 'The signature was not accepted',
    detail: 'The approval was not signed by this mandate’s owner, or was signed for another mandate or network.',
    owner: 'principal',
  },
  NotAgent: {
    state: 'permission',
    headline: 'The caller is not the agent',
    detail: 'Only this mandate’s agent can spend from it.',
    owner: 'agent',
  },
  NotPrincipal: {
    state: 'permission',
    headline: 'Only the owner can do that',
    detail: 'The call came from an address that does not own this mandate.',
    owner: 'principal',
  },
  NotPendingPrincipal: {
    state: 'permission',
    headline: 'Ownership was offered to a different address',
    detail: 'Only the address the current owner named can accept ownership of this mandate.',
    owner: 'principal',
  },
  AlreadyPrincipal: {
    state: null,
    headline: 'That address already owns the mandate',
    detail: 'Transferring a mandate to its current owner changes nothing.',
    owner: 'principal',
  },
  PartyNotAllowed: {
    state: 'permission',
    headline: 'The provider cannot be paid',
    detail: 'This payee is not an active provider, so the payment was refused.',
    owner: 'provider',
  },
  PayeeCapExceeded: {
    state: 'permission',
    headline: 'Above what this provider may carry in one job',
    detail: 'A provider earns a larger per-job ceiling by settling work. Until then a payment above it is refused.',
    owner: 'provider',
  },
  NotPayee: {
    state: 'permission',
    headline: 'Only the provider can claim this payment',
    detail: 'The claim came from another address.',
    owner: 'provider',
  },
  NotPayer: {
    state: 'permission',
    headline: 'Only the payer can do that',
    detail: 'The call came from an address that did not make this payment.',
    owner: 'principal',
  },
  NotParty: {
    state: 'permission',
    headline: 'Only the two sides of the payment can do that',
    detail: 'Only the payer and the payee can contest a payment.',
    owner: 'principal',
  },
  NotResolver: {
    state: 'permission',
    headline: 'Only the dispute resolver can rule',
    detail: 'The call did not come from the resolvers.',
    owner: 'operator',
  },
  TransferMismatch: {
    state: 'asset',
    headline: 'USDG moved an unexpected amount',
    detail: 'USDG moved a different amount than expected, so the payment was cancelled.',
    owner: 'token-issuer',
  },
  ZeroAmount: {
    state: null,
    headline: 'The amount was zero',
    detail: 'A payment of zero is refused.',
    owner: 'agent',
  },
  ZeroAddress: {
    state: null,
    headline: 'An address was missing',
    detail: 'A required address was left empty.',
    owner: 'agent',
  },
  TooEarly: {
    state: null,
    headline: 'Too early for this step',
    detail: 'The escrow does not allow this step yet.',
    owner: 'provider',
  },
  TooLate: {
    state: null,
    headline: 'Too late for this step',
    detail: 'The escrow no longer allows this step.',
    owner: 'provider',
  },
  BadStatus: {
    state: null,
    headline: 'The payment had already moved on',
    detail: 'A payment is settled, returned or contested only once.',
    owner: 'provider',
  },
  BadTtl: {
    state: null,
    headline: 'The delivery deadline was outside the allowed range',
    detail: 'The deadline was shorter or longer than the escrow allows.',
    owner: 'agent',
  },
  BelowMinLock: {
    state: null,
    headline: 'The payment was below the minimum',
    detail: 'Payments have to meet the escrow’s minimum amount.',
    owner: 'agent',
  },
  BadMinLock: {
    state: null,
    headline: 'The escrow’s minimum is not set correctly',
    detail: 'This concerns the escrow’s setup, not a payment.',
    owner: 'operator',
  },
  EnforcedPause: {
    state: null,
    headline: 'The escrow is paused',
    detail: 'The escrow takes no new payments for now. Payments it already holds still settle, and nothing about this mandate needs changing.',
    owner: 'operator',
  },
  SafeERC20FailedOperation: {
    state: 'asset',
    headline: 'USDG refused the transfer',
    detail: 'USDG turned down the transfer, so nothing moved. This happens when the token is paused, an address is frozen or the balance is short.',
    owner: 'token-issuer',
  },
  BadBond: {
    state: 'funding',
    headline: 'The dispute bond was not posted',
    detail: 'Contesting needs a USDG bond, and the mandate did not hold enough.',
    owner: 'principal',
  },
  BadRefund: {
    state: null,
    headline: 'The ruling named an impossible split',
    detail: 'A ruling has to split the amount between the two sides. This one did not.',
    owner: 'operator',
  },
  BadWindow: {
    state: 'mandate',
    headline: 'A spending period was set to zero',
    detail: 'Every period has to be longer than zero.',
    owner: 'principal',
  },
  BadValidity: {
    state: 'mandate',
    headline: 'The mandate would expire before it opens',
    detail: 'The end date has to be after the start date, or left empty for no expiry.',
    owner: 'principal',
  },
  BadApprovalThreshold: {
    state: 'mandate',
    headline: 'The approval threshold was left at zero',
    detail: 'Set it above the per-payment limit to turn approvals off.',
    owner: 'principal',
  },
  BadNonce: {
    state: null,
    headline: 'The limit change was out of order',
    detail: 'Limit changes are applied in the order they were signed. An earlier one cannot overtake a later one.',
    owner: 'principal',
  },
  AuthorizationExpired: {
    state: null,
    headline: 'The signed limit change had expired',
    detail: 'The signed change expired before it was sent.',
    owner: 'principal',
  },
  NotEscrow: {
    state: null,
    headline: 'Only the escrow can restore a budget',
    detail: 'The escrow restores the budget when a payment ends without being paid.',
    owner: 'operator',
  },
  UnknownSpend: {
    state: null,
    headline: 'The payment does not belong to this mandate',
    detail: 'Nothing can be restored for a payment this mandate never made.',
    owner: 'operator',
  },
  CreditExceedsSpend: {
    state: null,
    headline: 'The refund was larger than the payment',
    detail: 'A budget can only get back what the payment took.',
    owner: 'operator',
  },
};

/**
 * `MonthlyCapExceeded` from a mandate whose second window is the total budget. The contract names
 * the window, not what it is used for, so the console reads the window's length to say which.
 */
const TOTAL_BUDGET_CAUSE: Omit<RefusalCause, 'errorName'> = {
  state: 'mandate',
  headline: 'The total budget is spent',
  detail: 'The amount was more than the total budget had left. It never refills; only the owner can raise it.',
  owner: 'principal',
};

/** What the console knows about the mandate a refusal came from. */
export type RefusalContext = {
  /** True when the second window is the total budget (see `isTotalBudgetWindow`). */
  readonly totalBudget?: boolean;
};

/** Selector to error name, built from the ABIs at load so it cannot drift from them. */
const SELECTORS: ReadonlyMap<string, string> = buildSelectors([mandateAccountAbi as Abi, mandateAccountAbiV1 as Abi, escrowAbi as Abi]);

function buildSelectors(abis: readonly Abi[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const abi of abis) {
    for (const entry of abi) {
      if (entry.type !== 'error') continue;
      const signature = `${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`;
      map.set(toFunctionSelector(signature).toLowerCase(), entry.name);
    }
  }
  return map;
}

export function errorNameFor(selector: Hex | undefined): string | undefined {
  return selector === undefined ? undefined : SELECTORS.get(selector.toLowerCase());
}

export function refusalForErrorName(errorName: string, context: RefusalContext = {}): RefusalCause {
  if (errorName === 'MonthlyCapExceeded' && context.totalBudget === true) return { errorName, ...TOTAL_BUDGET_CAUSE };
  const known = CAUSES[errorName];
  if (known) return { errorName, ...known };

  return {
    errorName,
    state: null,
    headline: 'Refused by the contract',
    detail: 'This console has no plain description for this refusal yet.',
    owner: 'operator',
  };
}

/**
 * What a reverted call hit.
 *
 * The settlement asset reverts with a plain string where everything else here uses a custom error,
 * and two of those strings matter a great deal: a blocked address and a paused token are the token
 * issuer's decisions, not this system's, and a treasurer who reads "declined" would look in the
 * wrong place.
 */
export function refusalFor(reading: RevertReading | undefined, context: RefusalContext = {}): RefusalCause {
  const errorName = errorNameFor(reading?.selector);
  if (errorName && errorName !== 'Error') return refusalForErrorName(errorName, context);

  const message = reading?.message?.trim();
  if (message) {
    // USDG's per-address control is `isFrozen`, so its revert says frozen. `blacklist` is the
    // retired chain's word for the same thing and is still matched, because a revert read as an
    // unnamed rollback sends a treasurer to the wrong owner.
    if (/frozen|freeze|blacklist/i.test(message)) {
      return {
        errorName: undefined,
        state: 'asset',
        headline: 'The token refuses to move funds for this address',
        detail: `USDG reported: ${message}. Only the token issuer can lift this.`,
        owner: 'token-issuer',
      };
    }
    if (/paus/i.test(message)) {
      return {
        errorName: undefined,
        state: 'asset',
        headline: 'USDG transfers are paused',
        detail: `USDG reported: ${message}. Nothing that moves USDG settles while it is paused. You can still pause or revoke a mandate.`,
        owner: 'token-issuer',
      };
    }
    if (/balance|insufficient/i.test(message)) {
      return {
        errorName: undefined,
        state: 'funding',
        headline: 'The account did not hold enough',
        detail: `USDG reported: ${message}. The mandate needs the full amount on hand.`,
        owner: 'principal',
      };
    }
    if (/allowance/i.test(message)) {
      return {
        errorName: undefined,
        state: 'funding',
        headline: 'The wallet has not approved this transfer',
        detail: `USDG reported: ${message}. Approve the amount from that wallet first.`,
        owner: 'principal',
      };
    }
    return {
      errorName: undefined,
      state: null,
      headline: 'The transaction was cancelled',
      detail: `The contract reported: ${message}.`,
      owner: 'operator',
    };
  }

  if (reading?.selector) {
    return {
      errorName: undefined,
      state: null,
      headline: 'Refused by the contract',
      detail: 'This console does not recognise this refusal. Only the network fee was spent.',
      owner: 'operator',
    };
  }

  return {
    errorName: undefined,
    state: null,
    headline: 'The transaction was cancelled',
    detail: 'Only the network fee was spent. The reason is not available.',
    owner: 'operator',
  };
}

/** What a failed transaction was trying to do, read from its own calldata. */
export type Attempt = {
  readonly action: string;
  readonly merchant: Address | undefined;
  readonly capabilityId: Hex | undefined;
  readonly amount: Micro | undefined;
};

const ACTIONS: Readonly<Record<string, string>> = {
  spend: 'Pay a provider',
  spendApproved: 'Pay a provider with the owner’s approval',
  deposit: 'Add funds',
  withdraw: 'Take funds out',
  setLimits: 'Change the limits',
  setLimitsWithAuthorization: 'Change the limits with a signed request',
  setMerchant: 'Change the payee list',
  setMerchantGate: 'Switch the payee list',
  setCapability: 'Change the allowed capabilities',
  setAgent: 'Seat an agent',
  revokeAgent: 'Revoke the agent',
  setPaused: 'Pause or resume the mandate',
  approveSpend: 'Register an approval',
  revokeApproval: 'Withdraw an approval',
  disputeSpend: 'Contest a payment',
  transferPrincipal: 'Hand the mandate to a new owner',
  acceptPrincipal: 'Accept ownership of the mandate',
  setDocumentHash: 'Save the mandate document',
};

const EITHER_ACCOUNT_ABI = [...mandateAccountAbi, ...mandateAccountAbiV1] as Abi;

export function describeAttempt(input: Hex): Attempt | undefined {
  if (input.length < 10) return undefined;

  try {
    // Both builds, because a v1 spend carries a shorter request and so a different selector.
    const decoded = decodeFunctionData({ abi: EITHER_ACCOUNT_ABI, data: input });
    const name = decoded.functionName as string;
    const args = (decoded.args ?? []) as readonly unknown[];
    const request = args[0] as { merchant?: Address; capabilityId?: Hex; amount?: bigint } | undefined;

    const carriesRequest = name === 'spend' || name === 'spendApproved';
    return {
      action: ACTIONS[name] ?? name,
      merchant: carriesRequest ? request?.merchant : undefined,
      capabilityId: carriesRequest ? request?.capabilityId : undefined,
      amount: carriesRequest && request?.amount !== undefined ? micro(request.amount) : undefined,
    };
  } catch {
    return undefined;
  }
}
