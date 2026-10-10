import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { readConfig } from './config.js';
import type { BursarEnv, Config, Scheme } from './config.js';
import { ConfigError } from './errors.js';
import { facilitator } from './facilitator.js';
import type { Exchange, Facilitator } from './facilitator.js';
import { outputCommit, releaseLock } from './release.js';
import { acceptedOf, agrees, challenge, hex, offersFor, readPayment, settlementHeaders } from './x402.js';
import type { Resource } from './x402.js';

/** What was paid for the request in front of a handler. Absent on a route that has no price. */
export type Payment = {
  readonly scheme: Scheme;
  /** The mandate account on the escrow scheme, the agent's wallet on exact. */
  readonly payer: Address;
  readonly amount: Micro;
  /** The escrow lock the mandate opened for this call, on the escrow scheme. */
  readonly lock?: { readonly escrow: Address; readonly id: bigint; readonly mandate: Address; readonly transaction: Hex };
};

export type Handler<Env> = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

export type Options = {
  /** Reads of an escrow lock the facilitator does not see yet, before the payment is refused. */
  readonly unseenRetries?: number;
  readonly unseenRetryMs?: number;
  /** Stands in for the facilitator and the chain in a test. */
  readonly fetch?: typeof fetch;
};

const payments = new WeakMap<Request, Payment>();

/** The payment behind a request, inside a handler wrapped by `withBursar`. */
export function paymentOf(request: Request): Payment | undefined {
  return payments.get(request);
}

/**
 * Wraps a Worker's fetch handler so its priced routes charge over x402.
 *
 * A priced request with no payment is answered 402 with the price, in USDG on Robinhood Chain,
 * payable through the escrow a mandate account spends from or by the agent's own wallet. A request
 * carrying a payment is verified with the facilitator before the handler runs, and settled after
 * it answers. The handler's response goes out with the settlement in its headers. A route with no
 * price passes through untouched.
 *
 * Nothing is settled for a response that is not a success. On the escrow scheme the lock then
 * returns to the payer at its deadline; on exact nothing was ever moved.
 */
export function withBursar<Env extends BursarEnv>(handler: Handler<Env>, options: Options = {}): Handler<Env> {
  const retries = options.unseenRetries ?? 2;
  const retryMs = options.unseenRetryMs ?? 3_000;

  return async (request, env, ctx) => {
    let config: Config;
    try {
      config = readConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) return misconfigured(error.message);
      throw error;
    }

    const url = new URL(request.url);
    const route = config.prices.match(request.method, url.pathname);
    if (!route) return handler(request, env, ctx);

    const offers = offersFor(config, route.amount);
    const resource: Resource = { url: `${url.origin}${url.pathname}`, description: `${request.method.toUpperCase()} ${url.pathname}` };

    const presented = readPayment(request);
    if (presented === null) return challenge(offers, resource, 'payment required');
    if (presented === 'malformed') return challenge(offers, resource, 'invalid_payload');

    const { version, payload } = presented;
    const accepted = acceptedOf(payload);
    const offer = accepted === null ? undefined : offers.find((entry) => agrees(entry, accepted));
    if (!offer) return challenge(offers, resource, 'offer_mismatch');

    const bytes = await request.clone().arrayBuffer();
    const exchange: Exchange = {
      paymentPayload: payload,
      paymentRequirements: offer,
      requestHash: hex(await crypto.subtle.digest('SHA-256', bytes)),
    };
    const remote: Facilitator = facilitator(config, options.fetch);

    let verdict = await remote.verify(exchange);
    for (let read = 0; read < retries && !verdict.isValid && verdict.invalidReason === 'escrow_lock_not_open'; read += 1) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      verdict = await remote.verify(exchange);
    }
    if (!verdict.isValid) {
      const settlement = { success: false, transaction: '', network: offer.network, payer: verdict.payer ?? '', errorReason: verdict.invalidReason };
      return challenge(offers, resource, verdict.invalidReason, { version, settlement });
    }

    const payment = paymentFrom(offer.scheme, verdict.payer as Address, route.amount, payload);
    payments.set(request, payment);

    const served = await handler(request, env, ctx);
    if (!served.ok) return served;

    const settlement = await remote.settle(exchange);
    if (!settlement.success) {
      return challenge(offers, resource, settlement.errorReason ?? 'settlement_failed', { version, settlement });
    }

    const response = new Response(served.body, served);
    for (const [name, value] of Object.entries(settlementHeaders(version, settlement))) response.headers.set(name, value);

    if (payment.lock && config.signer) {
      const { signer } = config;
      const { lock } = payment;
      ctx.waitUntil(
        response
          .clone()
          .arrayBuffer()
          .then((delivered) => releaseLock(signer, lock, outputCommit(delivered)))
          .then((hash) => console.log(`bursar: released lock ${lock.id} in ${hash}`))
          .catch((error: unknown) => console.error(`bursar: lock ${lock.id} is still open, release failed:`, error instanceof Error ? error.message : String(error))),
      );
    }

    return response;
  };
}

function paymentFrom(scheme: Scheme, payer: Address, amount: Micro, payload: Exchange['paymentPayload']): Payment {
  const raw = payload.payload?.['lock'];
  if (scheme !== 'escrow' || typeof raw !== 'object' || raw === null) return { scheme, payer, amount };
  const lock = raw as Record<string, unknown>;
  const escrow = lock['escrow'];
  const id = lock['id'];
  const mandate = lock['mandate'];
  const transaction = lock['transaction'];
  if (typeof escrow !== 'string' || typeof id !== 'string' || typeof mandate !== 'string' || typeof transaction !== 'string') {
    return { scheme, payer, amount };
  }
  return { scheme, payer, amount, lock: { escrow: escrow as Address, id: BigInt(id), mandate: mandate as Address, transaction: transaction as Hex } };
}

function misconfigured(detail: string): Response {
  console.error(`bursar: ${detail}`);
  return new Response(JSON.stringify({ error: 'bursar_misconfigured', detail }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}
