import { getAddress } from 'viem';
import type { Address } from 'viem';
import { canonicalNetwork, sameNetwork, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { InvalidArgumentError } from '../errors.js';

/** The two live shapes of the protocol. v1 carries the offer in the body, v2 in a header. */
export type X402Version = 1 | 2;

export const PAYMENT_HEADER = { 1: 'x-payment', 2: 'payment-signature' } as const;
export const CHALLENGE_HEADER = 'payment-required';
export const SETTLEMENT_HEADER = { 1: 'x-payment-response', 2: 'payment-response' } as const;

/** One way a resource server is willing to be paid, normalized across protocol versions. */
export type PaymentRequirements = {
  readonly scheme: string;
  /** CAIP-2 where the server named one. v1 servers may name a chain, which is left as written. */
  readonly network: string;
  readonly payTo: Address;
  readonly asset: Address;
  /** The exact amount under the `exact` scheme, in the asset's own atomic units. */
  readonly amount: Micro;
  readonly maxTimeoutSeconds: number;
  readonly resource: string | undefined;
  readonly description: string | undefined;
  /** The token's EIP-712 domain as the server believes it to be. Never trusted over the token. */
  readonly extra: { readonly name?: string; readonly version?: string } | undefined;
  /** The entry exactly as the server sent it, echoed back in the payment payload. */
  readonly raw: Readonly<Record<string, unknown>>;
};

export type X402Challenge = {
  readonly version: X402Version;
  readonly accepts: readonly PaymentRequirements[];
  /** Whatever the server said about why the request was unpaid. */
  readonly error: string | undefined;
};

/** What a server's work budget defaults to when it quotes none. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * The longest work budget this client will sign against, one hour.
 *
 * The number is the payer's exposure. It sets how long the authorization stays redeemable, so a
 * server quoting 1e30 is asking for a signature good for longer than the chain will exist, to be
 * spent whenever it likes. An offer past the ceiling is not taken: paying it would agree to
 * terms nobody quoted.
 */
export const MAX_TIMEOUT_SECONDS = 3_600;

/**
 * The work budget an offer quoted, or null when it quoted something that is not one.
 *
 * `undefined` is not a rejection: a server that says nothing gets the default. Everything else has
 * to be a whole number of seconds this client would be willing to wait.
 */
export function readTimeoutSeconds(value: unknown): number | null {
  if (value === undefined) return DEFAULT_MAX_TIMEOUT_SECONDS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return value > 0 && value <= MAX_TIMEOUT_SECONDS ? value : null;
}

/**
 * Whether two spellings name the same chain, and a network string with its packaging removed.
 *
 * Both come from `@bursar/core`. The agent deciding whether an offer is on its chain and the
 * facilitator deciding whether to settle that same offer have to reach the same answer, and two
 * copies of this rule is how they stop doing so.
 */
export { canonicalNetwork, sameNetwork };

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requirementFrom(entry: unknown): PaymentRequirements | undefined {
  if (!entry || typeof entry !== 'object') return undefined;

  const raw = entry as Record<string, unknown>;
  const rawAmount = raw['amount'] ?? raw['maxAmountRequired'];
  const payTo = raw['payTo'];
  const asset = raw['asset'];

  if (typeof payTo !== 'string' || typeof asset !== 'string') return undefined;
  if (typeof rawAmount !== 'string' && typeof rawAmount !== 'number') return undefined;

  let amount: Micro;
  try {
    amount = toMicro(rawAmount);
  } catch {
    return undefined;
  }

  if (amount < 0n) return undefined;

  let addresses: { payTo: Address; asset: Address };
  try {
    addresses = { payTo: getAddress(payTo), asset: getAddress(asset) };
  } catch {
    return undefined;
  }

  // An offer whose budget this client will not sign against is not an offer it can take. It is
  // dropped here alongside the malformed ones.
  const maxTimeoutSeconds = readTimeoutSeconds(raw['maxTimeoutSeconds'] ?? undefined);
  if (maxTimeoutSeconds === null) return undefined;

  const extra = raw['extra'];

  return {
    scheme: typeof raw['scheme'] === 'string' ? raw['scheme'] : 'exact',
    network: typeof raw['network'] === 'string' ? raw['network'] : '',
    payTo: addresses.payTo,
    asset: addresses.asset,
    amount,
    maxTimeoutSeconds,
    resource: optionalString(raw['resource']),
    description: optionalString(raw['description']),
    extra: extra && typeof extra === 'object' ? (extra as { name?: string; version?: string }) : undefined,
    raw,
  };
}

// Written against the web primitives rather than Buffer so the same client works in a browser.
// A principal approving a payment is as likely to be sitting in one as in a server-side agent.
function decodeBase64Json(value: string): unknown {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Reads the offer out of a 402.
 *
 * v2 carries it in `PAYMENT-REQUIRED` as base64 JSON; v1 carries it in the body under `accepts`.
 * The body is consumed here, so a caller that wants it should clone the response first.
 */
export async function parseChallenge(response: Response): Promise<X402Challenge> {
  const header = response.headers.get(CHALLENGE_HEADER);

  if (header) {
    let decoded: unknown;

    // The header is a server's word for what it wants paid, and a malformed one is a failed
    // payment, not a broken client. atob and JSON.parse both throw their own errors here.
    try {
      decoded = decodeBase64Json(header);
    } catch {
      throw new InvalidArgumentError(
        'response',
        `The ${CHALLENGE_HEADER} header is not base64 JSON, so there is no offer in it to pay against.`,
        { status: response.status },
      );
    }

    if (!decoded || typeof decoded !== 'object') {
      throw new InvalidArgumentError(
        'response',
        `The ${CHALLENGE_HEADER} header does not carry an x402 payment offer.`,
        { status: response.status },
      );
    }

    return challengeFrom(2, decoded as Record<string, unknown>);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new InvalidArgumentError(
      'response',
      'The server answered 402 with no payment offer: no PAYMENT-REQUIRED header and no JSON body. ' +
        'There is nothing here to pay against.',
      { status: response.status },
    );
  }

  if (!body || typeof body !== 'object') {
    throw new InvalidArgumentError('response', 'The 402 body is not an x402 payment offer.', {
      status: response.status,
    });
  }

  const record = body as Record<string, unknown>;
  const version = record['x402Version'] === 2 ? 2 : 1;

  return challengeFrom(version, record);
}

function challengeFrom(version: X402Version, record: Record<string, unknown>): X402Challenge {
  const offered = record['accepts'];
  const entries = Array.isArray(offered) ? offered : [];

  return {
    version,
    accepts: entries
      .map(requirementFrom)
      .filter((entry): entry is PaymentRequirements => entry !== undefined),
    error: optionalString(record['error']),
  };
}

export type RequirementFilter = {
  readonly network: string;
  readonly asset: Address;
  readonly scheme?: string;
  /** No offer above this is taken, whatever the mandate would have allowed. */
  readonly maxAmount?: Micro;
};

/**
 * The cheapest offer this client can actually settle.
 *
 * Nothing else is approximated: an offer on another chain, in another asset, or under a scheme
 * this package does not sign is not a payment it can make.
 */
export function selectRequirement(
  challenge: X402Challenge,
  filter: RequirementFilter,
): PaymentRequirements | undefined {
  const scheme = filter.scheme ?? 'exact';

  return challenge.accepts
    .filter(
      (entry) =>
        entry.scheme === scheme &&
        sameNetwork(entry.network, filter.network) &&
        entry.asset.toLowerCase() === filter.asset.toLowerCase() &&
        (filter.maxAmount === undefined || entry.amount <= filter.maxAmount),
    )
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1))[0];
}
