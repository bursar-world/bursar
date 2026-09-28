import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { decodeFunctionData, toFunctionSelector } from 'viem';
import type { Abi, Address, Hex } from 'viem';

import { escrowAbi, mandateAccountAbi } from '@/chain/abi';
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
    detail: 'The account owner paused this mandate, so it refuses every spend until it is resumed.',
    owner: 'principal',
  },
  IsRevoked: {
    state: 'mandate',
    headline: 'The agent was revoked',
    detail: 'This mandate has no agent. Seating one again is what puts it back to work.',
    owner: 'principal',
  },
  NotYetValid: {
    state: 'mandate',
    headline: 'The mandate had not opened yet',
    detail: 'The spend arrived before the date the mandate starts.',
    owner: 'principal',
  },
  Expired: {
    state: 'mandate',
    headline: 'The mandate had expired',
    detail: 'The valid-until date had passed. Extending it takes a limit change from the owner.',
    owner: 'principal',
  },
  PerCallCapExceeded: {
    state: 'mandate',
    headline: 'Over the limit for one payment',
    detail: 'The amount was above the ceiling on a single payment. The daily and monthly room was not the problem.',
    owner: 'principal',
  },
  DailyCapExceeded: {
    state: 'mandate',
    headline: 'The period cap was reached',
    detail: 'The amount was more than the current period had left. The cap refills when the period rolls.',
    owner: 'principal',
  },
  MonthlyCapExceeded: {
    state: 'mandate',
    headline: 'The second cap was reached',
    detail: 'The amount was more than the second window had left. That allowance returns when its window rolls.',
    owner: 'principal',
  },
  MerchantNotAllowed: {
    state: 'permission',
    headline: 'The payee is not on the list',
    detail: 'This mandate pays only the addresses its owner has allowed. Everything else is refused by default.',
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
    detail: 'This mandate reads its payee roster from a published root, and the spend carried no proof against it.',
    owner: 'agent',
  },
  BadMerkleProof: {
    state: 'permission',
    headline: 'The proof did not match the roster',
    detail: 'The proof carried with the spend does not belong to the roster this mandate is reading.',
    owner: 'agent',
  },
  AllowlistGateActive: {
    state: 'permission',
    headline: 'A proof was sent where none is read',
    detail: 'This mandate reads its own list of payees. A proof against a published root is never consulted.',
    owner: 'agent',
  },
  ApprovalRequired: {
    state: 'permission',
    headline: 'The amount needs the owner to approve it',
    detail: 'The spend is at or above the approval threshold, so it goes through only with consent the owner has signed or registered.',
    owner: 'principal',
  },
  ApprovalMismatch: {
    state: 'permission',
    headline: 'The consent does not cover this spend',
    detail: 'The approval names a different payee, capability or ceiling than the payment it was presented for.',
    owner: 'principal',
  },
  ApprovalExpired: {
    state: 'permission',
    headline: 'The consent had expired',
    detail: 'The approval was still valid when it was signed and had passed its expiry by the time it was used.',
    owner: 'principal',
  },
  ApprovalSpent: {
    state: 'permission',
    headline: 'The consent was already used',
    detail: 'Each approval covers one payment and is burned on use.',
    owner: 'principal',
  },
  BadSignature: {
    state: 'permission',
    headline: 'The signature was not accepted',
    detail: 'The consent did not recover to the account owner. A signature made against a different account or a different chain reads exactly like this.',
    owner: 'principal',
  },
  NotAgent: {
    state: 'permission',
    headline: 'The caller is not the agent',
    detail: 'Only the address seated as the agent can spend from this mandate.',
    owner: 'agent',
  },
  NotPrincipal: {
    state: 'permission',
    headline: 'Only the account owner can do that',
    detail: 'The call came from an address that does not own this mandate.',
    owner: 'principal',
  },
  NotPendingPrincipal: {
    state: 'permission',
    headline: 'Ownership was offered to a different address',
    detail: 'Only the address the current owner named can accept ownership of this mandate.',
    owner: 'principal',
  },
  PartyNotAllowed: {
    state: 'permission',
    headline: 'The provider cannot be paid',
    detail: 'The provider registry does not list this payee as able to trade, so the escrow refused the lock.',
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
    detail: 'The call to release the payment came from an address that is not the payee on the lock.',
    owner: 'provider',
  },
  NotPayer: {
    state: 'permission',
    headline: 'Only the payer can do that',
    detail: 'The call came from an address that did not open this lock.',
    owner: 'principal',
  },
  NotParty: {
    state: 'permission',
    headline: 'Only the two sides of the payment can do that',
    detail: 'Disputing a lock is open to its payer and its payee, and to nobody else.',
    owner: 'principal',
  },
  NotResolver: {
    state: 'permission',
    headline: 'Only the dispute resolver can rule',
    detail: 'The call came from an address that is not the resolver this escrow reads.',
    owner: 'operator',
  },
  TransferMismatch: {
    state: 'asset',
    headline: 'The token moved a different amount than it was told to',
    detail: 'The settlement asset delivered something other than the exact amount, so the call was rolled back. Nothing settles against a figure nobody asked for.',
    owner: 'token-issuer',
  },
  ZeroAmount: {
    state: null,
    headline: 'The amount was zero',
    detail: 'A payment of nothing is refused before anything else is checked.',
    owner: 'agent',
  },
  ZeroAddress: {
    state: null,
    headline: 'An address was left empty',
    detail: 'The call named the zero address where a real one is required.',
    owner: 'agent',
  },
  TooEarly: {
    state: null,
    headline: 'The escrow window had not opened',
    detail: 'The step was taken before the lock allows it. The five conditions had nothing to do with it; this is the escrow’s own lifecycle.',
    owner: 'provider',
  },
  TooLate: {
    state: null,
    headline: 'The escrow window had closed',
    detail: 'The step was taken after the lock stopped accepting it. The five conditions had nothing to do with it; this is the escrow’s own lifecycle.',
    owner: 'provider',
  },
  BadStatus: {
    state: null,
    headline: 'The lock was no longer in a state that allows it',
    detail: 'A lock is settled, timed out or disputed once. The second attempt finds it already moved on.',
    owner: 'provider',
  },
  BadTtl: {
    state: null,
    headline: 'The delivery deadline was outside the allowed range',
    detail: 'The escrow holds a minimum and a maximum for how long a provider has to answer, and the deadline sat outside both.',
    owner: 'agent',
  },
  BadBond: {
    state: 'funding',
    headline: 'The dispute bond was not posted',
    detail: 'Opening a dispute costs a bond in the settlement asset, and the account did not have it.',
    owner: 'principal',
  },
  BadRefund: {
    state: null,
    headline: 'The ruling named an impossible split',
    detail: 'A resolution has to divide the locked amount between the two sides. This one did not.',
    owner: 'operator',
  },
  BadWindow: {
    state: 'mandate',
    headline: 'A spending window was set to zero',
    detail: 'Both windows have to be longer than zero seconds, otherwise the mandate has no period to measure against.',
    owner: 'principal',
  },
  BadValidity: {
    state: 'mandate',
    headline: 'The mandate would expire before it opens',
    detail: 'Valid-until has to be after valid-from, or left unset for no expiry.',
    owner: 'principal',
  },
  BadApprovalThreshold: {
    state: 'mandate',
    headline: 'The approval threshold was left at zero',
    detail: 'Zero would put every payment behind the owner’s signature and read as a broken agent. Setting it above the per-payment limit is how approvals are turned off.',
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
    detail: 'The authorization passed its deadline before it was relayed.',
    owner: 'principal',
  },
  NotEscrow: {
    state: null,
    headline: 'Only the escrow can return an allowance',
    detail: 'Crediting a spend back to a window is something the escrow does when a lock exits without paying.',
    owner: 'operator',
  },
  UnknownSpend: {
    state: null,
    headline: 'The escrow id does not belong to this mandate',
    detail: 'Nothing can be credited against a payment this account never made.',
    owner: 'operator',
  },
  CreditExceedsSpend: {
    state: null,
    headline: 'The refund was larger than the payment',
    detail: 'A window can only be credited back what that spend took out of it.',
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
  detail: 'The amount was more than the total budget had left. The total never refills; only the account owner can raise it.',
  owner: 'principal',
};

/** What the console knows about the mandate a refusal came from. */
export type RefusalContext = {
  /** True when the second window is the total budget (see `isTotalBudgetWindow`). */
  readonly totalBudget?: boolean;
};

/** Selector to error name, built from the ABIs at load so it cannot drift from them. */
const SELECTORS: ReadonlyMap<string, string> = buildSelectors([mandateAccountAbi as Abi, escrowAbi as Abi]);

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
    headline: `Refused with ${errorName}`,
    detail: 'The contract named this error and this console has no plain-language reading for it yet.',
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
        detail: `USDG reported: ${message}. That block belongs to the token issuer, and no balance and no mandate setting overrides it.`,
        owner: 'token-issuer',
      };
    }
    if (/paus/i.test(message)) {
      return {
        errorName: undefined,
        state: 'asset',
        headline: 'USDG transfers are paused',
        detail: `USDG reported: ${message}. While the token is paused nothing that moves USDG settles, including a withdrawal back to the principal. Transaction fees are paid in ETH, which is a different asset, so pausing and revoking a mandate still work.`,
        owner: 'token-issuer',
      };
    }
    if (/balance|insufficient/i.test(message)) {
      return {
        errorName: undefined,
        state: 'funding',
        headline: 'The account did not hold enough',
        detail: `USDG reported: ${message}. The mandate needs the full amount on hand before the escrow will take it.`,
        owner: 'principal',
      };
    }
    if (/allowance/i.test(message)) {
      return {
        errorName: undefined,
        state: 'funding',
        headline: 'The transfer was not allowed by the wallet holding the funds',
        detail: `USDG reported: ${message}. Moving funds out of a wallet takes an allowance from that wallet first.`,
        owner: 'principal',
      };
    }
    return {
      errorName: undefined,
      state: null,
      headline: 'The call was rolled back',
      detail: `The contract reported: ${message}.`,
      owner: 'operator',
    };
  }

  if (reading?.selector) {
    return {
      errorName: undefined,
      state: null,
      headline: 'Refused with an error this build does not name',
      detail: `The contract reverted with ${reading.selector}. That selector is not in the contract set this console was built against, which usually means the deployment is ahead of the app.`,
      owner: 'operator',
    };
  }

  return {
    errorName: undefined,
    state: null,
    headline: 'The transaction was mined and the call was rolled back',
    detail: 'The network kept the fee and undid the call. The reason was not recorded where this console can read it.',
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
  spendApproved: 'Pay a provider with the owner’s consent',
  deposit: 'Add funds',
  withdraw: 'Take funds out',
  setLimits: 'Change the limits',
  setLimitsWithAuthorization: 'Change the limits from a signed authorization',
  setMerchant: 'Change the payee list',
  setMerchantGate: 'Change which payee list is read',
  setCapability: 'Change the allowed capabilities',
  setAgent: 'Seat an agent',
  revokeAgent: 'Revoke the agent',
  setPaused: 'Pause or resume the mandate',
  approveSpend: 'Register consent for a payment',
  revokeApproval: 'Withdraw consent',
  disputeSpend: 'Dispute a payment',
  transferPrincipal: 'Hand the mandate to a new owner',
  acceptPrincipal: 'Accept ownership of the mandate',
  setDocumentHash: 'Anchor the mandate document',
};

export function describeAttempt(input: Hex): Attempt | undefined {
  if (input.length < 10) return undefined;

  try {
    const decoded = decodeFunctionData({ abi: mandateAccountAbi, data: input });
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
