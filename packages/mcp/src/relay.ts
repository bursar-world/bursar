import { microToAtomicString } from '@bursar/core';
import type { ContractSet } from '@bursar/core';
import { isHex } from 'viem';
import type { Address, Hex } from 'viem';

import { ToolError } from './errors.js';
import { refusalForName } from './reasons.js';
import type { RefusalScope } from './reasons.js';
import type { ApprovalInput } from './types.js';

/**
 * The transaction the relay is asked to sign and send. Field names follow the contract, because the
 * relay's other caller is the facilitator and one vocabulary across that seam is worth more than a
 * prettier payload.
 */
export type RelaySpendRequest = {
  readonly mandateAccount: Address;
  readonly merchant: Address;
  readonly capabilityId: Hex;
  readonly inputCommit: Hex;
  readonly inputURI: string;
  /** Six-decimal atomic units, as a string. JSON numbers lose value at this size. */
  readonly amount: string;
  readonly deadline: string;
  readonly merchantProof: readonly Hex[];
  readonly approval: RelayApproval | null;
  /** 0 for a service, 1 for a hire. A v2 or v3 account checks it against the classes it allows. */
  readonly spendClass: number;
  /**
   * Which build of the account this is. A v1 account takes the spend request without a class, so
   * a relay encodes against the v1 ABI when it says so; v2 and v3 take the same request.
   */
  readonly contractSet: ContractSet;
};

export type RelayApproval = {
  readonly approvalId: Hex;
  readonly merchant: Address;
  readonly capabilityId: Hex;
  readonly amount: string;
  readonly expiry: string;
  readonly signature: Hex | null;
};

export type RelaySpendReceipt = {
  readonly escrowId: bigint;
  readonly txHash: Hex;
};

export type RelayDisputeRequest = {
  readonly mandateAccount: Address;
  readonly escrowId: bigint;
};

export type RelayTransactionReceipt = {
  readonly txHash: Hex;
};

/** A stock purchase through the mandate's `buy`. Amounts are atomic units, as strings. */
export type RelayBuyRequest = {
  readonly mandateAccount: Address;
  readonly asset: Address;
  readonly usdgIn: string;
  readonly minOut: string;
  readonly quotedPriceE8: string;
};

export type RelayBuyReceipt = {
  readonly txHash: Hex;
  /** Raw token units the mandate received. */
  readonly amountOut: bigint;
};

/**
 * Signing lives behind this seam and nowhere else.
 *
 * The contracts hold the funds; what signs is the operator's choice. This server reaches a signer
 * of their own over HTTP, or holds a key itself under `BURSAR_SIGNER=local` and implements this
 * type in process. Either way the spending path above it is the same, and so are the refusals.
 */
export type SpendRelay = {
  spend(request: RelaySpendRequest): Promise<RelaySpendReceipt>;
  dispute(request: RelayDisputeRequest): Promise<RelayTransactionReceipt>;
  buy(request: RelayBuyRequest): Promise<RelayBuyReceipt>;
};

/**
 * What a resolver asks its signer to send, as a closed set of named actions.
 *
 * Named rather than open: a route that took a destination and calldata would be a blank cheque on
 * the operator's key, and the point of this seam is that the operator decides what its key does.
 * Every request carries the address it has to be signed as, so a relay pointed at the wrong key
 * can refuse instead of writing a commitment nobody can reveal.
 */
export type ResolverRequest = { readonly resolver: Address } & (
  | { readonly action: 'bond'; readonly amount: string }
  | { readonly action: 'add-bond'; readonly amount: string }
  | { readonly action: 'commit'; readonly disputeId: string; readonly commitment: Hex }
  | { readonly action: 'reveal'; readonly disputeId: string; readonly score: number; readonly salt: Hex }
  | { readonly action: 'finalize'; readonly disputeId: string }
  | { readonly action: 'fail'; readonly disputeId: string }
  | { readonly action: 'claim-rewards' }
  | { readonly action: 'request-unbond' }
  | { readonly action: 'complete-unbond' }
  | { readonly action: 'cancel-unbond' }
);

/** The same for a provider, against the agent registry. */
export type ProviderRequest = { readonly provider: Address } & (
  | { readonly action: 'register'; readonly name: string; readonly stake: string }
  | { readonly action: 'add-stake'; readonly amount: string }
  | { readonly action: 'request-withdrawal'; readonly amount: string }
  | { readonly action: 'execute-withdrawal' }
  | { readonly action: 'cancel-withdrawal' }
  | { readonly action: 'deactivate' }
  | { readonly action: 'reactivate' }
);

/** The signer seam for the two roles that act on their own behalf rather than a mandate's. */
export type RoleRelay = {
  resolverCall(request: ResolverRequest): Promise<RelayTransactionReceipt>;
  providerCall(request: ProviderRequest): Promise<RelayTransactionReceipt>;
};

/** Everything one operator's signer serves. A deployment may wire only part of it. */
export type BursarRelay = SpendRelay & RoleRelay;

export type HttpRelayOptions = {
  readonly url: string;
  readonly token?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
};

export function toRelayApproval(approval: ApprovalInput, merchant: Address, capabilityId: Hex): RelayApproval {
  return {
    approvalId: approval.approvalId,
    merchant,
    capabilityId,
    amount: microToAtomicString(approval.amount),
    expiry: String(approval.expiry),
    signature: approval.signature,
  };
}

/**
 * Talks to a relay that exposes two routes:
 *
 *   POST {url}/v1/spends                      -> { escrowId, txHash }
 *   POST {url}/v1/spends/{escrowId}/dispute   -> { txHash }
 *
 * A refusal comes back as a non-2xx status with `{ error, message, revert }`, where `revert` names
 * the contract error. That name is translated here into the same sentence a quote would have given,
 * so an agent that skipped the quote still learns which limit stopped it.
 */
export function createHttpRelay(options: HttpRelayOptions): BursarRelay {
  const base = options.url.replace(/\/+$/u, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  async function post(
    path: string,
    body: unknown,
    scope: RefusalScope,
    subject: Subject,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };

    if (options.token !== undefined && options.token !== '') {
      headers['authorization'] = `Bearer ${options.token}`;
    }

    let response: Response;
    let text: string;

    // The body is read inside the same guard as the request. A read that is cut off mid-stream is
    // the same timeout as one that never connected, and it has to answer in the same vocabulary.
    try {
      response = await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw unanswered(error, timeoutMs, subject);
    }

    const payload = parseJson(text);

    if (!response.ok) throw rejection(response.status, payload, scope, subject);

    if (payload === null) {
      throw unusable('a body that is not JSON', subject, { status: response.status });
    }

    return payload;
  }

  return {
    async spend(request: RelaySpendRequest): Promise<RelaySpendReceipt> {
      const payload = await post('/v1/spends', request, 'mandate', 'spend');

      return { escrowId: readId(payload, 'escrowId', 'spend'), txHash: readHash(payload, 'spend') };
    },
    async dispute(request: RelayDisputeRequest): Promise<RelayTransactionReceipt> {
      const payload = await post(
        `/v1/spends/${request.escrowId.toString()}/dispute`,
        { mandateAccount: request.mandateAccount },
        'mandate',
        'dispute',
      );

      return { txHash: readHash(payload, 'dispute') };
    },
    async buy(request: RelayBuyRequest): Promise<RelayBuyReceipt> {
      const payload = await post('/v1/buys', request, 'mandate', 'transaction');
      const out = payload['amountOut'];
      if (typeof out !== 'string' || !/^[0-9]+$/u.test(out)) {
        throw unusable('no amountOut', 'transaction', { amountOut: out });
      }

      return { txHash: readHash(payload, 'transaction'), amountOut: BigInt(out) };
    },
    async resolverCall(request: ResolverRequest): Promise<RelayTransactionReceipt> {
      const { action, ...body } = request;

      const payload = await post(`/v1/resolver/${action}`, body, 'resolver', 'transaction');

      return { txHash: readHash(payload, 'transaction') };
    },
    async providerCall(request: ProviderRequest): Promise<RelayTransactionReceipt> {
      const { action, ...body } = request;

      const payload = await post(`/v1/provider/${action}`, body, 'provider', 'transaction');

      return { txHash: readHash(payload, 'transaction') };
    },
  };
}

/** What the relay was asked to put on chain, which decides what to read before trying again. */
type Subject = 'spend' | 'dispute' | 'transaction';

/**
 * The sentence for every answer that leaves the outcome open.
 *
 * The relay signs and submits before it answers. Anything short of a clean answer or a refusal
 * it owns (a timeout, a server error, a body that cannot be read) therefore says nothing about
 * whether the transaction went out, and an agent told nothing happened pays twice.
 */
function mayBeOnChain(subject: Subject): string {
  switch (subject) {
    case 'spend':
      return 'It submits before it answers, so this spend may already be on chain. Read the settlements ' +
        'for this mandate before paying again.';
    case 'dispute':
      return 'It submits before it answers, so the dispute may already be open. Read the settlement ' +
        'before contesting it again.';
    case 'transaction':
      return 'It submits before it answers, so this transaction may already be on chain. Read the ' +
        'current state before sending it again.';
  }
}

function unusable(problem: string, subject: Subject, detail: Record<string, unknown> = {}): ToolError {
  return new ToolError(
    'relay_bad_response',
    `The relay accepted the request and answered with ${problem}. ${mayBeOnChain(subject)}`,
    detail,
  );
}

/**
 * What to tell an agent when the relay never answered.
 *
 * A refused connection never reached it, so nothing was signed and nothing was spent. A timeout is
 * a different fact: the relay signs and submits before it answers, so the spend may be mining
 * right now. Saying "nothing was spent" about that is what makes an agent pay twice.
 */
function unanswered(error: unknown, timeoutMs: number, subject: Subject): ToolError {
  const cause = describe(error);

  if (timedOut(error)) {
    return new ToolError(
      'relay_timeout',
      `The relay did not answer within ${timeoutMs}ms. ${mayBeOnChain(subject)}`,
      { cause, timeoutMs },
    );
  }

  return new ToolError(
    'relay_unreachable',
    'The relay that signs for this mandate did not answer. Nothing was submitted, so nothing was spent.',
    { cause },
  );
}

/**
 * `AbortSignal.timeout` rejects with a DOMException named TimeoutError, and a body cut off
 * mid-stream arrives wrapped in whatever the fetch implementation throws. Read by name and through
 * the cause chain, so neither a second copy of a class nor a wrapper hides it.
 */
function timedOut(error: unknown): boolean {
  let node: unknown = error;

  for (let depth = 0; depth < 4 && typeof node === 'object' && node !== null; depth += 1) {
    if ((node as { name?: unknown }).name === 'TimeoutError') return true;
    node = (node as { cause?: unknown }).cause;
  }

  return false;
}

function describe(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;

  return typeof message === 'string' ? message : String(error);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);

    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rejection(
  status: number,
  payload: Record<string, unknown> | null,
  scope: RefusalScope,
  subject: Subject,
): ToolError {
  const revert = typeof payload?.['revert'] === 'string' ? payload['revert'] : null;
  const refusal = revert === null ? null : refusalForName(revert, scope);
  const reported = typeof payload?.['message'] === 'string' ? payload['message'] : null;

  if (refusal) {
    return new ToolError(scope === 'mandate' ? 'mandate_refused' : `${scope}_refused`, refusal.message, {
      revert: refusal.code,
      subject: refusal.subject,
    });
  }

  const detail = revert === null ? { status } : { status, revert };

  // A 4xx is the relay declining the request, which it does before signing. A 5xx is the relay
  // failing somewhere, possibly after the transaction went out, so it proves nothing either way.
  if (status >= 500) {
    return new ToolError(
      'relay_failed',
      `${reported ?? `The relay failed and answered ${status}.`} ${mayBeOnChain(subject)}`,
      detail,
    );
  }

  return new ToolError(
    'relay_rejected',
    reported ?? `The relay refused the transaction and answered ${status}. Nothing was spent.`,
    detail,
  );
}

function readId(payload: Record<string, unknown>, field: string, subject: Subject): bigint {
  const value = payload[field];

  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);

  throw unusable(`no usable ${field}`, subject);
}

function readHash(payload: Record<string, unknown>, subject: Subject): Hex {
  const value = payload['txHash'];

  if (typeof value === 'string' && isHex(value) && value.length === 66) return value;

  throw unusable('no transaction hash', subject);
}
