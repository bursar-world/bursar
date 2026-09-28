import type { Address, Hex } from 'viem';
import { caip2, deriveNonce, hashRequest, randomSalt } from '@bursar/core';
import type { Micro, PaymentBinding } from '@bursar/core';

import { requireSigner, type Connection } from '../connection.js';
import { InvalidArgumentError, NoAcceptablePaymentError, PaymentRejectedError } from '../errors.js';
import { usd } from '../format.js';
import { checkPositiveAmount } from '../guards.js';
import {
  AUTHORIZATION_MARGIN_SECONDS,
  authorizationFor,
  encodeAuthorization,
  signTransferAuthorization,
  type TransferAuthorization,
} from './authorization.js';
import {
  MAX_TIMEOUT_SECONDS,
  PAYMENT_HEADER,
  SETTLEMENT_HEADER,
  encodeBase64Json,
  parseChallenge,
  readTimeoutSeconds,
  selectRequirement,
  type PaymentRequirements,
  type X402Version,
} from './requirements.js';

/** What `fetch` accepts as its first argument, without depending on the DOM lib for the name. */
export type FetchTarget = string | URL | Request;

/**
 * What the facilitator reports back about the settlement it broadcast. Absent when the server
 * settles asynchronously and says nothing on the response.
 */
export type Settlement = {
  readonly success: boolean;
  readonly transaction: Hex | undefined;
  readonly network: string | undefined;
  readonly payer: Address | undefined;
  readonly errorReason: string | undefined;
};

export type PaymentRecord = {
  readonly amount: Micro;
  readonly payTo: Address;
  readonly asset: Address;
  readonly network: string;
  readonly nonce: Hex;
  readonly settlement: Settlement | undefined;
};

export type PaidResponse = {
  readonly response: Response;
  /** Absent when the resource was not behind a paywall and nothing was paid. */
  readonly payment: PaymentRecord | undefined;
};

/**
 * The mandate consulted before a payment is signed. `MandateAccountClient` satisfies it.
 *
 * This is the seam that keeps the http path honest: the mandate decides, and whatever it refuses
 * is never signed.
 */
export type PaymentGate = {
  readonly address: Address;
  assertCanPay(request: { to: Address; amount: Micro; capability: string }): Promise<void>;
};

/** The mandate that authorises this spend, and the capability the call falls under. */
export type PaymentAuthority = {
  readonly mandate: PaymentGate;
  readonly capability: string;
};

type PayRequestBase = {
  readonly connection: Connection;
  /** How long the signed authorization stays valid. Defaults to the offer's own timeout. */
  readonly validForSeconds?: number;
  readonly fetchFn?: typeof fetch;
  readonly init?: RequestInit;
};

/**
 * Where the payment's bound comes from. One of the two is required.
 *
 * `through` hands the decision to a mandate, which answers against limits the contract enforces.
 * `maxAmount` is a flat ceiling this client will not pay past. With neither, whatever a 402
 * quotes is what gets signed, and the first host to answer 402 with a large enough number empties
 * the wallet. The union is what makes that a compile error rather than a surprise on the chain.
 */
export type PayRequestOptions = PayRequestBase &
  (
    | { readonly maxAmount: Micro; readonly through?: PaymentAuthority }
    | { readonly through: PaymentAuthority; readonly maxAmount?: Micro }
  );

function settlementFrom(header: string | null): Settlement | undefined {
  if (!header) return undefined;

  let decoded: unknown;
  try {
    const binary = atob(header);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }

  if (!decoded || typeof decoded !== 'object') return undefined;
  const record = decoded as Record<string, unknown>;

  return {
    success: record['success'] === true,
    transaction: typeof record['transaction'] === 'string' ? (record['transaction'] as Hex) : undefined,
    network: typeof record['network'] === 'string' ? record['network'] : undefined,
    payer: typeof record['payer'] === 'string' ? (record['payer'] as Address) : undefined,
    errorReason: typeof record['errorReason'] === 'string' ? record['errorReason'] : undefined,
  };
}

/**
 * v1 flattens the accepted terms into the envelope; v2 nests them under `accepted` and echoes the
 * entry the server sent. Facilitators read one or the other, not both.
 */
function paymentEnvelope(
  version: X402Version,
  requirements: PaymentRequirements,
  authorization: TransferAuthorization,
  signature: Hex,
  binding: PaymentBinding,
): Record<string, unknown> {
  const payload = { signature, authorization: encodeAuthorization(authorization), binding };

  if (version === 2) return { x402Version: 2, accepted: requirements.raw, payload };

  return {
    x402Version: 1,
    scheme: requirements.scheme,
    network: requirements.network,
    asset: requirements.asset,
    payTo: requirements.payTo,
    payload,
  };
}

function describe(entry: PaymentRequirements): string {
  return `${usd(entry.amount)} in ${entry.asset} on ${entry.network} under ${entry.scheme}`;
}

/**
 * Fetches a resource, paying for it over x402 if it asks to be paid.
 *
 * The funds come from the signer on the connection, not from the mandate account: the `exact`
 * scheme is a signature from the address that holds the money, and a contract cannot produce one.
 * The mandate is what decides whether the payment happens at all. Pass `through` and a refusal
 * lands before anything is signed, with the limit that stopped it named.
 *
 * The payment is a single-use EIP-3009 authorization for the exact amount the server quoted. No
 * allowance is left standing afterwards.
 */
export async function payRequest(
  input: FetchTarget,
  options: PayRequestOptions,
): Promise<PaidResponse> {
  // The type already rules this out. The check is here for callers who reach the package from
  // JavaScript, where an unbounded payer is one missing property away.
  if (options.maxAmount === undefined && options.through === undefined) {
    throw new InvalidArgumentError(
      'maxAmount',
      'A payment needs a bound: pass `through` so a mandate decides, or `maxAmount` as a ceiling. ' +
        'Without one, whatever the server quotes is what gets signed.',
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const connection = options.connection;
  const request = new Request(input, options.init);
  const resource = request.url;

  // Cloned before the first send, because fetch consumes the body and the retry needs the same one.
  const retryable = request.clone();
  const first = await fetchFn(request);

  if (first.status !== 402) return { response: first, payment: undefined };

  const challenge = await parseChallenge(first);
  const network = caip2(connection.chain.chainId);
  const asset = connection.addresses.settlementAsset;

  // Checked here, not at the comparison: a negative ceiling filters every offer out and would be
  // reported as a server with nothing this client can pay.
  const maxAmount = options.maxAmount === undefined ? undefined : checkPositiveAmount('maxAmount', options.maxAmount);

  const requirements = selectRequirement(challenge, {
    network,
    asset,
    ...(maxAmount === undefined ? {} : { maxAmount }),
  });

  if (!requirements) {
    throw new NoAcceptablePaymentError(
      resource,
      challenge.accepts.map(describe),
      `exact in ${asset} on ${network}` + (maxAmount === undefined ? '' : `, up to ${usd(maxAmount)}`),
    );
  }

  if (options.through) {
    await options.through.mandate.assertCanPay({
      to: requirements.payTo,
      amount: requirements.amount,
      capability: options.through.capability,
    });
  }

  const { account } = requireSigner(connection, 'x402 payment');

  // The authorisation names the request it pays for by deriving its nonce from the request's
  // bytes. Without that, a payment header seen in flight is a bearer token: whoever holds it can
  // put their own request in front of it and spend this authorisation on a call of their choosing.
  // The token refuses a spent nonce, so it is the chain that enforces one request, one payment.
  const binding: PaymentBinding = {
    requestHash: hashRequest(new Uint8Array(await retryable.clone().arrayBuffer())),
    salt: randomSalt(),
  };

  const validFor =
    options.validForSeconds === undefined
      ? requirements.maxTimeoutSeconds
      : readTimeoutSeconds(options.validForSeconds);

  if (validFor === null) {
    throw new InvalidArgumentError(
      'validForSeconds',
      `validForSeconds must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}. ` +
        'It is how long the signed authorization stays redeemable.',
      { validForSeconds: options.validForSeconds },
    );
  }

  const authorization = authorizationFor({
    from: account.address,
    to: requirements.payTo,
    value: requirements.amount,
    // The margin is what keeps the authorization alive long enough to be judged. A facilitator
    // requires it to outlive the server's own work budget, counted from when the facilitator
    // looks, so an authorization signed for exactly that budget has already expired by the time
    // it arrives.
    seconds: validFor + AUTHORIZATION_MARGIN_SECONDS,
    nonce: deriveNonce(binding),
  });

  const signature = await signTransferAuthorization(connection, requirements.asset, authorization);
  const envelope = paymentEnvelope(challenge.version, requirements, authorization, signature, binding);

  const headers = new Headers(retryable.headers);
  headers.set(PAYMENT_HEADER[challenge.version], encodeBase64Json(envelope));

  const response = await fetchFn(new Request(retryable, { headers }));
  const settlement = settlementFrom(response.headers.get(SETTLEMENT_HEADER[challenge.version]));

  if (response.status === 402 || settlement?.success === false) {
    throw new PaymentRejectedError(
      resource,
      response.status,
      settlement?.errorReason ?? (await refusalReason(response)),
    );
  }

  return {
    response,
    payment: {
      amount: requirements.amount,
      payTo: requirements.payTo,
      asset: requirements.asset,
      network: requirements.network,
      nonce: authorization.nonce,
      settlement,
    },
  };
}

async function refusalReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    const error = body['error'] ?? body['invalidReason'];
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A drop-in `fetch` that pays for what it asks for. Hand it to the HTTP client that talks to the
 * paid service.
 *
 * Give it to one client, not to every request an agent makes. Installed as the global `fetch`, it
 * turns a 402 from any host the agent happens to touch into a signed transfer, and the bound it
 * carries is the same one for all of them. A response that was never a 402 does come back
 * untouched, which is what makes it a drop-in replacement, not a reason to widen its reach.
 */
export function paidFetch(options: PayRequestOptions): typeof fetch {
  return async (input: FetchTarget, init?: RequestInit) => {
    const paid = await payRequest(input, { ...options, ...(init ? { init } : {}) });
    return paid.response;
  };
}
