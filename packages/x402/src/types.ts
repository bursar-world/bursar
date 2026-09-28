import type { Caip2, Micro } from '@bursar/core';
import type { InvalidReason } from './reasons.js';

/**
 * Wire shapes for the two live versions of the protocol, plus the results this package returns.
 *
 * Everything that arrives from a client is typed loosely. A payment header is attacker
 * controlled, so the fields below describe what a well-formed one looks like, and the verifier
 * narrows each field itself instead of trusting the declaration.
 */
export type X402Version = 1 | 2;

export const SUPPORTED_VERSIONS: readonly X402Version[] = Object.freeze([1, 2]);

export function isSupportedVersion(value: unknown): value is X402Version {
  return value === 1 || value === 2;
}

/**
 * How the payer authorises the move.
 *
 * USDG answers the first two, confirmed against chain 4663 on 2026-09-22, and Permit2 holds code
 * at its canonical address there. EIP-3009 is the default because it is one transaction and needs
 * no prior approval from the payer. EIP-2612 costs two
 * transactions: the relayer submits the permit, then pulls. Permit2 is one transaction but only
 * after the payer has approved the Permit2 contract on the token once.
 */
export type TransferMethod = 'eip3009' | 'eip2612' | 'permit2';

export const TRANSFER_METHODS: readonly TransferMethod[] = Object.freeze([
  'eip3009',
  'eip2612',
  'permit2',
]);

export function isTransferMethod(value: unknown): value is TransferMethod {
  return value === 'eip3009' || value === 'eip2612' || value === 'permit2';
}

/** Terms a resource server publishes. Written in v2 spelling; `codec` renames for v1. */
export type PaymentRequirements = {
  readonly scheme?: string;
  readonly network?: string;
  /** v2 name for the price, in atomic units of the asset. */
  readonly amount?: string | number | bigint;
  /** v1 name for the same figure. The scheme is `exact`, so it is never a ceiling. */
  readonly maxAmountRequired?: string | number | bigint;
  readonly asset?: string;
  readonly payTo?: string;
  /** How long the resource server may take. The authorisation has to outlive it. */
  readonly maxTimeoutSeconds?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
};

/** The scheme-specific half of a payment header. */
export type SchemePayload = {
  readonly signature?: unknown;
  readonly authorization?: unknown;
  readonly permit?: unknown;
  readonly binding?: unknown;
  readonly [key: string]: unknown;
};

export type PaymentPayload = {
  readonly x402Version?: unknown;
  readonly accepted?: PaymentRequirements;
  readonly payload?: SchemePayload;
  readonly [key: string]: unknown;
};

/** What the payer signed, once the verifier has narrowed it. */
export type Authorization = {
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly value: Micro;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: `0x${string}`;
};

/**
 * An EIP-2612 permit, narrowed. It names no payee, so the payer trusts the facilitator to forward
 * the funds; `PERMIT_TYPES` explains why that makes this path the fallback.
 */
export type Permit = {
  readonly owner: `0x${string}`;
  readonly spender: `0x${string}`;
  readonly value: Micro;
  readonly nonce: bigint;
  readonly deadline: bigint;
};

/**
 * A Permit2 SignatureTransfer, narrowed. The nonce is a bitmap position, not a counter, so it need
 * not be sequential. The recipient is chosen by the spender at call time and carries the same
 * trust note as the permit above.
 */
export type Permit2Transfer = {
  readonly owner: `0x${string}`;
  readonly token: `0x${string}`;
  readonly spender: `0x${string}`;
  readonly amount: Micro;
  readonly nonce: bigint;
  readonly deadline: bigint;
};

export type VerifySuccess = {
  readonly isValid: true;
  readonly payer: `0x${string}`;
  readonly method: TransferMethod;
  readonly amount: Micro;
};

export type VerifyFailure = {
  readonly isValid: false;
  readonly invalidReason: InvalidReason;
  /** Present whenever the payload named a payer, so a client knows which wallet was refused. */
  readonly payer?: `0x${string}`;
  readonly detail?: string;
};

export type VerifyResult = VerifySuccess | VerifyFailure;

/**
 * A verdict that came back from another process.
 *
 * The method and the amount are optional here because a facilitator written by somebody else is
 * under no obligation to report them. The BURSAR facilitator always does.
 */
export type RemoteVerifySuccess = {
  readonly isValid: true;
  readonly payer: string;
  readonly method?: TransferMethod;
  readonly amount?: Micro;
};

export type RemoteVerifyResult = RemoteVerifySuccess | VerifyFailure;

export type SettleResult = {
  readonly success: boolean;
  /**
   * `true` settled, `false` nothing was broadcast, `null` broadcast and the receipt could not be
   * read. The third case is money that probably moved, and treating it as a failure refunds a
   * payer who was charged.
   */
  readonly settled: boolean | null;
  /**
   * Whether anything reached the mempool. A gas budget refunds an allowance only when this is
   * false, because a broadcast that failed still cost the relayer its gas.
   */
  readonly broadcast: boolean;
  readonly errorReason?: InvalidReason;
  readonly payer: string;
  readonly transaction: string;
  readonly network: string;
  readonly method?: TransferMethod;
  readonly detail?: string;
};

/** One asset as `GET /supported` describes it, including the domain a payer must sign under. */
export type SupportedAsset = {
  readonly address: `0x${string}`;
  readonly name: string;
  readonly version: string;
  readonly decimals: number;
  readonly methods: readonly TransferMethod[];
};

export type SupportedKind = {
  readonly x402Version: X402Version;
  readonly scheme: 'exact';
  readonly network: Caip2;
  readonly extra: {
    readonly assetTransferMethod: TransferMethod;
    readonly assetTransferMethods: readonly TransferMethod[];
    readonly assets: readonly SupportedAsset[];
  };
};

export type SupportedResponse = {
  readonly kinds: readonly SupportedKind[];
};
