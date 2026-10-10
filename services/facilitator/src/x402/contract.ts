/**
 * What this service needs from a payment scheme, and nothing else.
 *
 * The scheme itself lives in `@bursar/x402`: the EIP-712 domain read from the token, the three
 * authorisation methods, the refusal matrix. None of that is duplicated here. These declarations
 * describe the shape that package exposes, so the facilitator compiles and is testable on its own
 * and binds to the real verifier by injection.
 *
 * The types are structural, so a scheme that satisfies them satisfies this service. Wiring
 * replaces this file's contents with re-exports from `@bursar/x402` without touching a caller.
 */

export type PaymentRequirements = {
  readonly scheme?: string;
  readonly network?: string;
  readonly amount?: string | number | bigint;
  readonly maxAmountRequired?: string | number | bigint;
  readonly asset?: string;
  readonly payTo?: string;
  readonly maxTimeoutSeconds?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
};

export type SchemePayload = {
  readonly signature?: unknown;
  readonly authorization?: unknown;
  readonly permit?: unknown;
  readonly binding?: unknown;
  readonly bindingSignature?: unknown;
  readonly [key: string]: unknown;
};

export type PaymentPayload = {
  readonly x402Version?: unknown;
  readonly accepted?: PaymentRequirements;
  readonly payload?: SchemePayload;
  readonly [key: string]: unknown;
};

export type VerifySuccess = {
  readonly isValid: true;
  readonly payer: `0x${string}`;
  readonly method?: string;
  readonly amount?: bigint;
  /**
   * The escrow lock this payment redeems, where the scheme read one on chain. Absent on the `exact`
   * rails, where the payer's signed authorisation is the payment.
   */
  readonly lock?: RedeemedLock;
};

/**
 * A lock the mandate lane verified, as the facilitator records it.
 *
 * `inputCommit` is what the payer bound to the request. `nonce` is the identity the redemption is
 * recorded under, derived from the lock by the scheme that read it, and the only name the
 * facilitator accepts for the payment.
 */
export type RedeemedLock = {
  readonly chainId: number;
  readonly escrow: `0x${string}`;
  readonly id: bigint;
  readonly inputCommit: `0x${string}`;
  readonly nonce: `0x${string}`;
};

export type VerifyFailure = {
  readonly isValid: false;
  readonly invalidReason: string;
  readonly payer?: `0x${string}`;
  readonly detail?: string;
};

export type VerifyResult = VerifySuccess | VerifyFailure;

export type SettleResult = {
  readonly success: boolean;
  /**
   * `true` settled, `false` nothing was broadcast, `null` broadcast and the receipt could not be
   * read. The third case is money that probably moved: treating it as a failure would refund or
   * serve free against a transfer that landed.
   */
  readonly settled: boolean | null;
  /**
   * Whether a transaction left this process.
   *
   * Separate from `settled` because the two come apart on the permit rails: a permit that lands and
   * a pull that then reverts is `settled: false` with gas spent, an advanced permit nonce and a
   * standing allowance. Anything the facilitator gives back on a failure keys off this, never off
   * `settled`.
   */
  readonly broadcast: boolean;
  readonly errorReason?: string;
  readonly payer: string;
  readonly transaction: string;
  readonly network: string;
  readonly method?: string;
  readonly detail?: string;
};

export type SupportedResponse = {
  readonly kinds: readonly Readonly<Record<string, unknown>>[];
};

/**
 * What a payer signed a request digest into, on the rails where the payer picks its own nonce.
 *
 * `deriveNonce` in the scheme folds these two into the authorisation nonce, so the token's own
 * refusal of a spent nonce is what stops the payment being redeemed against a different request.
 * No extra signature, no extra gas, and the chain is the one enforcing it. The salt is what lets
 * a payer pay for the same request twice when it means to.
 */
export type RequestBinding = {
  readonly requestHash: string;
  readonly salt: `0x${string}`;
};

export type SchemeOptions = {
  readonly binding?: RequestBinding | null;
};

export type PaymentScheme = {
  /**
   * The same deployment under the protocol's own rules: no request binding, and an authorisation
   * that outlives the check by the protocol's margin rather than the quoted budget. What the
   * keyless `/x402` routes run. Absent on a scheme that has no such profile.
   */
  readonly standard?: () => PaymentScheme;
  supported(): SupportedResponse | Promise<SupportedResponse>;
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options?: SchemeOptions,
  ): Promise<VerifyResult>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options?: SchemeOptions,
  ): Promise<SettleResult>;
};

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The binding a payload carries, when it carries the nonce-derived form.
 *
 * Null covers both "nothing here" and "the other form": a payer on the EIP-2612 rail cannot pick
 * its own nonce, so it signs a separate message instead and that arrives as a hex string under
 * the same key. Callers distinguish the two by which of these returns a value.
 */
export function payloadBinding(payload: PaymentPayload): RequestBinding | null {
  const raw = payload.payload?.binding;
  if (typeof raw !== 'object' || raw === null) return null;

  const record = raw as { requestHash?: unknown; salt?: unknown };
  const requestHash = typeof record.requestHash === 'string' ? record.requestHash.toLowerCase() : '';
  const salt = typeof record.salt === 'string' ? record.salt.toLowerCase() : '';
  if (!SHA256.test(requestHash) || !HEX32.test(salt)) return null;

  return { requestHash, salt: salt as `0x${string}` };
}

/** The separate signature an EIP-2612 payer sends, since its nonce is the token's own counter. */
export function payloadBindingSignature(payload: PaymentPayload): `0x${string}` | null {
  const raw = payload.payload?.binding;
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw)) return raw as `0x${string}`;

  const separate = payload.payload?.bindingSignature;
  if (typeof separate === 'string' && /^0x[0-9a-fA-F]+$/.test(separate)) {
    return separate as `0x${string}`;
  }
  return null;
}

/** Refusals this service produces itself, before or after the scheme has had its say. */
export const FACILITATOR_REASON = {
  payload: 'invalid_payload',
  requirements: 'invalid_payment_requirements',
  replay: 'payment_already_used',
  unbound: 'payment_not_bound_to_request',
  dailyBudget: 'daily_budget_exhausted',
  payerRate: 'payer_rate_limited',
  lane: 'invalid_lane_reference',
  amount: 'lane_amount_mismatch',
  /** Gas on a per-call settlement would exceed what the call is worth. */
  belowFloor: 'amount_below_settlement_floor',
  /** The scheme threw instead of answering. `broadcast` says whether anything may have been sent. */
  schemeUnavailable: 'settlement_scheme_unavailable',
  /** The transfer is on chain and this service could not write it down. */
  unrecorded: 'settlement_not_recorded',
  /** The reservation is closed, lapsing, or claimed by another settle, so nothing was broadcast. */
  held: 'reservation_not_claimable',
  /** An earlier settle of this authorisation broadcast and has no settlement recorded yet. */
  pending: 'settlement_pending',
} as const;

export type FacilitatorReason = (typeof FACILITATOR_REASON)[keyof typeof FACILITATOR_REASON];

/**
 * The amount a payment must carry, as a bigint of atomic units.
 *
 * Protocol version one calls it `maxAmountRequired` and version two calls it `amount`. The name
 * says ceiling; the `exact` scheme means either one holds the exact figure. Null means the
 * requirements did not state a price, which is not something to guess at.
 */
export function requiredAmount(requirements: PaymentRequirements): bigint | null {
  const raw = requirements.amount ?? requirements.maxAmountRequired;
  if (raw === undefined || raw === null) return null;
  try {
    const value = BigInt(raw);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * The EIP-3009 nonce a payload carries, lowercased, or null when it carries none.
 *
 * On the `exact` rails this is what the payer signed, what the token burns, and so what the
 * settlement is recorded under. The mandate lane records nothing under a value read off the
 * payload: its identity is derived from the lock the scheme reads on chain, and a payload on that
 * lane that names a nonce at all has to name that one.
 */
export function authorizationNonce(payload: PaymentPayload): string | null {
  const authorization = payload.payload?.authorization;
  if (!authorization || typeof authorization !== 'object') return null;
  const nonce = (authorization as { nonce?: unknown }).nonce;
  if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
  return nonce.toLowerCase();
}
