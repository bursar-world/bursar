import type { Micro } from '@bursar/core';
import type { PaymentBinding } from './binding.js';
import type { AssetMeta } from './domain.js';
import type { PaymentChain, SettlementCall } from './ports.js';
import type { InvalidReason } from './reasons.js';
import type { SchemePayload, TransferMethod } from './types.js';

/**
 * What every authorisation path is handed, and what every one of them returns.
 *
 * The three paths differ in what the payer signs and in how many transactions it takes to move the
 * money. They do not differ in the questions asked of them, so the shared shape keeps the
 * orchestration in one place and each path down to its own arithmetic.
 */
export type MethodContext = {
  readonly chain: PaymentChain;
  readonly asset: AssetMeta;
  readonly payTo: `0x${string}`;
  readonly required: Micro;
  /** Unix seconds the check is made against. Injected so every verdict is testable. */
  readonly now: number;
  /** How far into the future the authorisation must stay valid, in seconds. */
  readonly mustOutlive: number;
  /**
   * The address that will submit the transaction. Null when this process cannot settle, which the
   * permit paths refuse outright: a permit names its spender, and a verifier that does not know
   * which spender to expect cannot tell a payment meant for this facilitator from one meant for
   * somebody else's.
   */
  readonly relayer: `0x${string}` | null;
  /** Where Permit2 is deployed on this chain, when the permit2 path is configured. */
  readonly permit2: `0x${string}` | null;
  readonly payload: SchemePayload;
  /** Set when the caller requires the payment to be bound to a specific request. */
  readonly binding: PaymentBinding | null;
};

export type MethodSuccess = {
  readonly ok: true;
  readonly payer: `0x${string}`;
  readonly amount: Micro;
  /**
   * Transactions to submit, in order. Only the first can be simulated against current state; a
   * permit followed by a pull has no allowance to pull against until the permit lands.
   */
  readonly calls: readonly SettlementCall[];
};

export type MethodFailure = {
  readonly ok: false;
  readonly reason: InvalidReason;
  readonly payer?: `0x${string}`;
  readonly detail?: string;
};

export type MethodVerdict = MethodSuccess | MethodFailure;

export type AuthorizationPath = {
  readonly method: TransferMethod;
  check(context: MethodContext): Promise<MethodVerdict>;
};

export function refuse(reason: InvalidReason, payer?: `0x${string}`, detail?: string): MethodFailure {
  return {
    ok: false,
    reason,
    ...(payer === undefined ? {} : { payer }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Whatever a chain client throws, in one line a log can carry. */
export function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const short = record['shortMessage'];
    if (typeof short === 'string' && short.length > 0) return short;
    const message = record['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}
