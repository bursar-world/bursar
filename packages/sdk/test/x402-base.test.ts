import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { BASE_MAINNET, hashRequest, micro, nonceBindsRequest, readRequestURI, requestCommit } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { BaseLaneRefusedError, NoAcceptablePaymentError, PaymentRejectedError } from '../src/errors.js';
import { payRequest, type PaymentGate } from '../src/x402/fetch.js';
import { encodeBase64Json } from '../src/x402/requirements.js';
import { fakeConnection } from './helpers/fake-connection.js';

/**
 * The Base lane, with the service and the facilitator both scripted.
 *
 * What the suite holds the client to: the quote comes before the lock and a refusal there locks
 * nothing; the lock is for the facilitator's address and the quoted USDG, committed to the request;
 * the retry carries the facilitator's signature and never one of the agent's; and a refusal from
 * the facilitator or the service reaches the caller in the SDK's words.
 */

const RESOURCE = 'https://api.base-service.dev/fact';
const SERVICE: Address = '0xD7d49D6a12Ee3852f29A52A40908069bF4e48914';
const FLOAT: Address = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const ESCROW: Address = '0x11e73B5632837355e250fC236cFC2Be03aD0845A';
const LOCK_TX = `0x${'ab'.repeat(32)}` as const;
const SIGNATURE = `0x${'cd'.repeat(65)}` as const;
const FACILITATOR = 'https://facilitator.test';

function baseOffer(overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '1000',
    asset: BASE_MAINNET.usdc,
    payTo: SERVICE,
    maxTimeoutSeconds: 300,
    resource: RESOURCE,
    extra: { name: 'USD Coin', version: '2' },
    ...overrides,
  };
}

type Call = { url: string; init?: RequestInit; request?: Request };

/**
 * One fetch for everything: the service answers 402 then whatever `served` says, and the
 * facilitator's two routes answer from the script. Every call is kept for the assertions.
 */
function world(script: {
  accepts?: unknown[];
  quote?: { status: number; body: unknown };
  pay?: { status: number; body: unknown };
  served?: Response;
}) {
  const calls: Call[] = [];
  const quote = script.quote ?? {
    status: 200,
    body: { float: FLOAT, amountMicro: '1000', lockMicro: '10000', feeMicro: '9000', validForSeconds: 300, lock: { payee: FLOAT, amountMicro: '10000', ttlSeconds: 1290 } },
  };
  const pay = script.pay ?? {
    status: 201,
    body: {
      payment: { id: '7f5c1c2e-6b1e-4f4f-9a44-2f0d8b1f9c11', float: FLOAT, validBefore: '1800000330', nonce: `0x${'11'.repeat(32)}` },
      authorization: { from: FLOAT, to: SERVICE, value: '1000', validAfter: '1799999940', validBefore: '1800000330', nonce: `0x${'11'.repeat(32)}` },
      signature: SIGNATURE,
    },
  };
  let serviceCalls = 0;
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    calls.push({ url, init, request });
    if (url.startsWith(FACILITATOR)) {
      if (url.endsWith('/base/quote')) return new Response(JSON.stringify(quote.body), { status: quote.status });
      if (url.endsWith('/base/pay')) return new Response(JSON.stringify(pay.body), { status: pay.status });
      return new Response('{}', { status: 200 });
    }
    serviceCalls += 1;
    if (serviceCalls === 1) {
      return new Response('{}', {
        status: 402,
        headers: { 'payment-required': encodeBase64Json({ x402Version: 2, error: 'payment required', accepts: script.accepts ?? [baseOffer()] }) },
      });
    }
    return script.served ?? served();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function served(): Response {
  return new Response('{"fact":"flamingos"}', {
    status: 200,
    headers: {
      'payment-response': encodeBase64Json({ success: true, transaction: `0x${'ee'.repeat(32)}`, network: 'eip155:8453', payer: FLOAT }),
    },
  });
}

function spender(paid: { calls: unknown[]; refused?: PaymentGate['assertCanPay'] }) {
  return {
    address: '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c' as Address,
    escrow: ESCROW,
    assertCanPay: paid.refused ?? (async () => undefined),
    pay: async (request: unknown) => {
      paid.calls.push(request);
      return { escrowId: 42n, hash: LOCK_TX };
    },
  };
}

describe('the base lane', () => {
  it('quotes, locks for the facilitator, carries its signature to the service and reports back', async () => {
    const { connection } = fakeConnection();
    const paid = { calls: [] as unknown[] };
    const { fetchFn, calls } = world({});

    const result = await payRequest(RESOURCE, {
      connection,
      fetchFn,
      lane: 'base',
      facilitator: FACILITATOR,
      through: { mandate: spender(paid), capability: 'service:demo.x402:1' },
      init: { method: 'POST', body: '{"q":1}' },
    });

    const quote = calls.find((call) => call.url.endsWith('/base/quote'));
    expect(JSON.parse(String(quote?.init?.body))).toEqual({ amount: '1000', payTo: SERVICE, resource: RESOURCE, maxTimeoutSeconds: 300 });

    // The lock is for the facilitator's address and the USDG it quoted, not for the service.
    expect(paid.calls).toHaveLength(1);
    const lock = paid.calls[0] as { to: Address; amount: Micro; inputCommit: `0x${string}`; inputURI: string; ttlSeconds: number };
    expect(lock).toMatchObject({ to: FLOAT, amount: micro(10_000n), capability: 'service:demo.x402:1', ttlSeconds: 1290 });
    const document = readRequestURI(lock.inputURI);
    expect(document).toMatchObject({ method: 'POST', resource: RESOURCE });
    expect(document && requestCommit(document)).toBe(lock.inputCommit);

    const pay = calls.find((call) => call.url.endsWith('/base/pay'));
    const sent = JSON.parse(String(pay?.init?.body)) as { lock: Record<string, string>; binding: { requestHash: string; salt: `0x${string}` }; offer: Record<string, unknown> };
    expect(sent.lock).toEqual({ escrow: ESCROW, id: '42', mandate: '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c', transaction: LOCK_TX, inputCommit: lock.inputCommit });
    expect(sent.binding.requestHash).toBe(hashRequest(new TextEncoder().encode('{"q":1}')));
    expect(nonceBindsRequest(document?.requestNonce ?? '', sent.binding)).toBe(true);
    expect(sent.offer).toEqual(baseOffer());

    // The retry carries what the facilitator signed, in the v2 envelope the service's facilitator reads.
    const retry = calls.filter((call) => call.url === RESOURCE)[1];
    const envelope = JSON.parse(atob(retry?.request?.headers.get('payment-signature') ?? '')) as {
      x402Version: number;
      accepted: Record<string, unknown>;
      payload: { signature: string; authorization: Record<string, string> };
    };
    expect(envelope.x402Version).toBe(2);
    expect(envelope.accepted).toEqual(baseOffer());
    expect(envelope.payload.signature).toBe(SIGNATURE);
    expect(envelope.payload.authorization).toMatchObject({ from: FLOAT, to: SERVICE, value: '1000' });
    expect(envelope.payload).not.toHaveProperty('binding');

    const outcome = calls.find((call) => call.url.endsWith('/outcome'));
    expect(outcome?.url).toBe(`${FACILITATOR}/base/payments/7f5c1c2e-6b1e-4f4f-9a44-2f0d8b1f9c11/outcome`);
    expect(JSON.parse(String(outcome?.init?.body))).toMatchObject({ transaction: `0x${'ee'.repeat(32)}`, success: true, status: 200 });

    expect(await result.response.json()).toEqual({ fact: 'flamingos' });
    expect(result.payment).toMatchObject({
      lane: 'base',
      amount: micro(1_000n),
      payTo: SERVICE,
      asset: BASE_MAINNET.usdc,
      network: 'eip155:8453',
      lock: { escrow: ESCROW, id: 42n, transaction: LOCK_TX, inputCommit: lock.inputCommit },
      base: { paymentId: '7f5c1c2e-6b1e-4f4f-9a44-2f0d8b1f9c11', float: FLOAT, lockMicro: micro(10_000n), feeMicro: micro(9_000n), validBefore: 1_800_000_330n, facilitator: FACILITATOR },
    });
  });

  it('asks the mandate about the lock it would open, not about the service', async () => {
    const { connection } = fakeConnection();
    const asked: unknown[] = [];
    const paid = {
      calls: [] as unknown[],
      refused: async (request: { to: Address; amount: Micro; capability: string }) => {
        asked.push(request);
      },
    };
    const { fetchFn } = world({});

    await payRequest(RESOURCE, { connection, fetchFn, lane: 'base', facilitator: FACILITATOR, through: { mandate: spender(paid), capability: 'service:demo.x402:1' } });

    expect(asked).toEqual([{ to: FLOAT, amount: micro(10_000n), capability: 'service:demo.x402:1' }]);
  });

  it('refuses in the facilitator’s words when the float is short, before anything is locked', async () => {
    const { connection } = fakeConnection();
    const paid = { calls: [] as unknown[] };
    const { fetchFn, calls } = world({
      quote: { status: 409, body: { error: 'base_float_insufficient', detail: 'the Base float can cover 0 USDC atomic units beyond its reserve right now, and this payment needs 1000' } },
    });

    const refused = await payRequest(RESOURCE, { connection, fetchFn, lane: 'base', facilitator: FACILITATOR, through: { mandate: spender(paid), capability: 'service:demo.x402:1' } }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(BaseLaneRefusedError);
    const error = refused as BaseLaneRefusedError;
    expect(error.reason).toBe('base_float_insufficient');
    expect(error.refusal?.owner).toBe('counterparty');
    expect(error.message).toContain('Nothing was locked');
    expect(error.message).toContain('needs 1000');
    expect(paid.calls).toHaveLength(0);
    expect(calls.some((call) => call.url.endsWith('/base/pay'))).toBe(false);
  });

  it('refuses a service that offers nothing in USDC on Base rather than paying from the wallet', async () => {
    const { connection } = fakeConnection();
    const paid = { calls: [] as unknown[] };
    const { fetchFn } = world({ accepts: [baseOffer({ network: 'eip155:4663', asset: connection.addresses.settlementAsset })] });

    await expect(
      payRequest(RESOURCE, { connection, fetchFn, lane: 'base', facilitator: FACILITATOR, through: { mandate: spender(paid), capability: 'service:demo.x402:1' } }),
    ).rejects.toBeInstanceOf(NoAcceptablePaymentError);
    expect(paid.calls).toHaveLength(0);
  });

  it('holds the ceiling against the USDC price', async () => {
    const { connection } = fakeConnection();
    const paid = { calls: [] as unknown[] };
    const { fetchFn } = world({});

    await expect(
      payRequest(RESOURCE, { connection, fetchFn, lane: 'base', facilitator: FACILITATOR, maxAmount: micro(500n), through: { mandate: spender(paid), capability: 'service:demo.x402:1' } }),
    ).rejects.toBeInstanceOf(NoAcceptablePaymentError);
    expect(paid.calls).toHaveLength(0);
  });

  it('names the lock and when it returns when the service refuses the payment', async () => {
    const { connection } = fakeConnection();
    const paid = { calls: [] as unknown[] };
    const refusedByService = new Response('{"error":"insufficient_funds"}', {
      status: 402,
      headers: { 'payment-response': encodeBase64Json({ success: false, errorReason: 'insufficient_funds', network: 'eip155:8453' }) },
    });
    const { fetchFn } = world({ served: refusedByService });

    const rejected = await payRequest(RESOURCE, { connection, fetchFn, lane: 'base', facilitator: FACILITATOR, through: { mandate: spender(paid), capability: 'service:demo.x402:1' } }).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(PaymentRejectedError);
    expect((rejected as PaymentRejectedError).message).toBe(
      `${RESOURCE} refused the payment: insufficient_funds. Lock 42 (0.01 USDG) returns to the mandate once the authorization expires at 2027-01-15T08:05:30.000Z, unless the service settles it first.`,
    );
  });

  it('reads the reason out of a v2 server’s second 402', async () => {
    const { connection } = fakeConnection();
    const paid = { calls: [] as unknown[] };
    const refusedByService = new Response('{}', {
      status: 402,
      headers: { 'payment-required': encodeBase64Json({ x402Version: 2, error: 'insufficient_funds', accepts: [baseOffer()] }) },
    });
    const { fetchFn } = world({ served: refusedByService });

    const rejected = await payRequest(RESOURCE, { connection, fetchFn, lane: 'base', facilitator: FACILITATOR, through: { mandate: spender(paid), capability: 'service:demo.x402:1' } }).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(PaymentRejectedError);
    expect((rejected as PaymentRejectedError).reason).toBe('insufficient_funds');
  });

  it('needs a mandate that can pay', async () => {
    const { connection } = fakeConnection();
    const { fetchFn } = world({});
    const gate: PaymentGate = { address: FLOAT, assertCanPay: async () => undefined };

    await expect(
      payRequest(RESOURCE, { connection, fetchFn, lane: 'base', facilitator: FACILITATOR, through: { mandate: gate, capability: 'x' } }),
    ).rejects.toMatchObject({ code: 'argument_invalid' });
  });
});
