import type { Address, Hex } from 'viem';
import {
  caip2,
  deriveNonce,
  escrowSettlementNonce,
  hashRequest,
  randomSalt,
  requestCommit,
  requestDocument,
  requestURI,
} from '@bursar/core';
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
  readonly lane: PaymentLane;
  readonly amount: Micro;
  readonly payTo: Address;
  readonly asset: Address;
  readonly network: string;
  /**
   * What the facilitator records the payment under: the EIP-3009 nonce the wallet signed, or on the
   * mandate lane the settlement nonce derived from the lock.
   */
  readonly nonce: Hex;
  /** The escrow lock the mandate opened, on the mandate lane, and the request it committed to. */
  readonly lock?: { readonly escrow: Address; readonly id: bigint; readonly transaction: Hex; readonly inputCommit: Hex };
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

/**
 * A mandate that can also pay from its own balance. `MandateAccountClient` satisfies it.
 *
 * `pay` runs the account's `spend`, which debits the daily and monthly windows and moves the
 * amount into an escrow lock payable to the merchant, committed to the input it is handed.
 */
export type MandateSpender = PaymentGate & {
  readonly escrow: Address;
  pay(request: {
    readonly to: Address;
    readonly amount: Micro;
    readonly capability: string;
    readonly inputCommit: Hex;
    readonly inputURI: string;
  }): Promise<{ readonly escrowId: bigint; readonly hash: Hex }>;
};

/** The mandate that authorises this spend, and the capability the call falls under. */
export type PaymentAuthority = {
  readonly mandate: PaymentGate;
  readonly capability: string;
};

/**
 * Where the money for a paid call comes from.
 *
 *   mandate  the mandate account pays through its own `spend`. Every limit it holds is enforced
 *            on chain, the daily and monthly windows included, and the call is paid through an
 *            escrow lock the server's facilitator reads. Needs a server that offers `escrow`.
 *   wallet   the agent's own wallet signs an EIP-3009 transfer under the `exact` scheme. Per-call
 *            only; windows client-enforced: the mandate is read before signing, but nothing on
 *            chain counts these payments against the daily or monthly window.
 */
export type PaymentLane = 'mandate' | 'wallet';

/** The offer scheme each lane pays under. */
export const LANE_SCHEME: Readonly<Record<PaymentLane, string>> = { mandate: 'escrow', wallet: 'exact' };

type PayRequestBase = {
  readonly connection: Connection;
  /** Defaults to `wallet`. `mandate` needs `through` with a mandate that can pay. */
  readonly lane?: PaymentLane;
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
 * On the wallet lane, the default, the funds come from the signer on the connection: the `exact`
 * scheme is a signature from the address that holds the money, and a contract cannot produce one.
 * The payment is a single-use EIP-3009 authorization for the exact amount the server quoted, and
 * no allowance is left standing afterwards. Per-call only; windows client-enforced: `through` is
 * read before signing, and nothing on chain counts the payment against a window.
 *
 * On the mandate lane the mandate account pays through its own `spend`, so its daily and monthly
 * windows move by the amount paid and the contract refuses what they do not cover.
 *
 * Either way, pass `through` and a refusal lands before anything is signed or sent, with the limit
 * that stopped it named.
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

  const lane = options.lane ?? 'wallet';
  const spender = lane === 'mandate' ? mandateSpender(options.through) : undefined;
  const scheme = LANE_SCHEME[lane];

  const requirements = selectRequirement(challenge, {
    network,
    asset,
    scheme,
    ...(maxAmount === undefined ? {} : { maxAmount }),
  });

  if (!requirements) {
    throw new NoAcceptablePaymentError(
      resource,
      challenge.accepts.map(describe),
      `${scheme} in ${asset} on ${network}` + (maxAmount === undefined ? '' : `, up to ${usd(maxAmount)}`),
    );
  }

  if (options.through) {
    await options.through.mandate.assertCanPay({
      to: requirements.payTo,
      amount: requirements.amount,
      capability: options.through.capability,
    });
  }

  if (spender && options.through) {
    return payThroughMandate({
      spender,
      capability: options.through.capability,
      chainId: connection.chain.chainId,
      requirements,
      version: challenge.version,
      retryable,
      resource,
      fetchFn,
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
      lane: 'wallet',
      amount: requirements.amount,
      payTo: requirements.payTo,
      asset: requirements.asset,
      network: requirements.network,
      nonce: authorization.nonce,
      settlement,
    },
  };
}

function mandateSpender(through: PaymentAuthority | undefined): MandateSpender {
  const mandate = through?.mandate as Partial<MandateSpender> | undefined;
  if (!mandate || typeof mandate.pay !== 'function' || typeof mandate.escrow !== 'string') {
    throw new InvalidArgumentError(
      'lane',
      'The mandate lane pays from the mandate account, so it needs `through` with a mandate that can pay, ' +
        'such as a MandateAccountClient with a signer.',
    );
  }
  return mandate as MandateSpender;
}

/**
 * The mandate lane: the account's own `spend` opens an escrow lock for the quoted price, and the
 * retry carries a pointer to it.
 *
 * The lock publishes the call it pays for as its input: the method, the endpoint and the
 * request-bound nonce the wallet lane would have signed, as canonical JSON, committed to in
 * `inputCommit`. The facilitator recomputes that nonce from the body the provider received and the
 * salt sent here, so the lock can only be redeemed against the request it was opened for, and only
 * by whoever holds the salt. A resolver reading a disputed lock finds the job on chain, where a
 * lock with no input would leave it nothing to check. The mandate's refusals surface from `pay`
 * before anything moves.
 */
async function payThroughMandate(input: {
  readonly spender: MandateSpender;
  readonly capability: string;
  readonly chainId: number;
  readonly requirements: PaymentRequirements;
  readonly version: X402Version;
  readonly retryable: Request;
  readonly resource: string;
  readonly fetchFn: typeof fetch;
}): Promise<PaidResponse> {
  const { spender, requirements } = input;
  const binding: PaymentBinding = {
    requestHash: hashRequest(new Uint8Array(await input.retryable.clone().arrayBuffer())),
    salt: randomSalt(),
  };
  const document = requestDocument({ method: input.retryable.method, url: input.resource, binding });
  const inputCommit = requestCommit(document);

  const paid = await spender.pay({
    to: requirements.payTo,
    amount: requirements.amount,
    capability: input.capability,
    inputCommit,
    inputURI: requestURI(document),
  });

  const lock = { escrow: spender.escrow, id: paid.escrowId, transaction: paid.hash, inputCommit };
  const payload = {
    lock: { escrow: lock.escrow, id: lock.id.toString(), mandate: spender.address, transaction: lock.transaction, inputCommit },
    binding,
  };
  const envelope =
    input.version === 2
      ? { x402Version: 2, accepted: requirements.raw, payload }
      : { x402Version: 1, scheme: requirements.scheme, network: requirements.network, asset: requirements.asset, payTo: requirements.payTo, payload };

  const headers = new Headers(input.retryable.headers);
  headers.set(PAYMENT_HEADER[input.version], encodeBase64Json(envelope));

  const response = await input.fetchFn(new Request(input.retryable, { headers }));
  const settlement = settlementFrom(response.headers.get(SETTLEMENT_HEADER[input.version]));

  if (response.status === 402 || settlement?.success === false) {
    throw new PaymentRejectedError(
      input.resource,
      response.status,
      settlement?.errorReason ?? (await refusalReason(response)),
    );
  }

  return {
    response,
    payment: {
      lane: 'mandate',
      amount: requirements.amount,
      payTo: requirements.payTo,
      asset: requirements.asset,
      network: requirements.network,
      nonce: escrowSettlementNonce({ chainId: input.chainId, escrow: lock.escrow, lockId: lock.id, inputCommit }),
      lock,
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
