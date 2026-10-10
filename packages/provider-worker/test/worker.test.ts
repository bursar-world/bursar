import type { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeBase64Json } from '../src/x402.js';
import { ENV, ESCROW, LOCK_TX, MANDATE, PROVIDER, VALID, escrowPayment, facilitatorStub, offerOf, sha256Hex, worker } from './support.js';

let running: Miniflare | undefined;
afterEach(async () => {
  await running?.dispose();
  running = undefined;
});

async function start(bindings: Record<string, string>, outbound: Parameters<typeof worker>[1]): Promise<Miniflare> {
  running = await worker(bindings, outbound);
  return running;
}

const BODY = JSON.stringify({ prompt: 'a koi' });

describe('a worker wrapped by withBursar, on workerd', () => {
  it('leaves a route with no price alone', async () => {
    const mf = await start(ENV, async () => new Response('never', { status: 599 }));
    const response = await mf.dispatchFetch('http://worker/free');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ free: true });
  });

  it('answers a priced route with 402 and the price in both versions', async () => {
    const mf = await start(ENV, async () => new Response('never', { status: 599 }));
    const response = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    expect(response.status).toBe(402);

    const escrow = await offerOf(response, 'escrow');
    expect(escrow).toMatchObject({
      network: 'eip155:4663',
      amount: '10000',
      asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      payTo: PROVIDER,
      maxTimeoutSeconds: 120,
      extra: { capability: 'service:render:1', escrow: '0x11e73B5632837355e250fC236cFC2Be03aD0845A' },
    });
    const exact = await offerOf(response, 'exact');
    expect(exact).toMatchObject({ amount: '10000', payTo: PROVIDER, extra: { name: 'Global Dollar', version: '1' } });

    const body = (await response.json()) as { x402Version: number; error: string; resource: { url: string }; accepts: Record<string, unknown>[] };
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe('payment required');
    expect(body.resource.url).toBe('http://worker/render');
    expect(body.accepts[0]).toMatchObject({ maxAmountRequired: '10000', resource: 'http://worker/render' });
  });

  it('verifies an escrow payment, serves the call, settles, and reports the settlement', async () => {
    const stub = facilitatorStub({ verify: () => VALID });
    const mf = await start(ENV, stub.handle);
    const first = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    const offer = await offerOf(first, 'escrow');
    const requestHash = await sha256Hex(BODY);

    const paid = await mf.dispatchFetch('http://worker/render', {
      method: 'POST',
      body: BODY,
      headers: { 'payment-signature': escrowPayment(offer, requestHash) },
    });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ rendered: 'a koi', payer: MANDATE, scheme: 'escrow', amount: '10000', lock: '7' });

    const report = decodeBase64Json(paid.headers.get('payment-response') ?? '') as Record<string, unknown>;
    expect(report).toEqual({ success: true, transaction: LOCK_TX, network: 'eip155:4663', payer: MANDATE });

    expect(stub.calls.map((call) => call.path)).toEqual(['/verify', '/settle']);
    for (const call of stub.calls) {
      expect(call.authorization).toBe('Bearer token-under-test');
      expect(call.body['requestHash']).toBe(requestHash);
      expect(call.body['paymentRequirements']).toMatchObject({ scheme: 'escrow', amount: '10000', payTo: PROVIDER });
      expect((call.body['paymentPayload'] as Record<string, unknown>)['payload']).toMatchObject({ lock: { id: '7', escrow: ESCROW } });
    }
  });

  it('judges the worker’s own price, not the one the payer echoes', async () => {
    const stub = facilitatorStub({ verify: () => VALID });
    const mf = await start(ENV, stub.handle);
    const first = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    const offer = { ...(await offerOf(first, 'escrow')), amount: '1' };

    const paid = await mf.dispatchFetch('http://worker/render', {
      method: 'POST',
      body: BODY,
      headers: { 'payment-signature': escrowPayment(offer, await sha256Hex(BODY)) },
    });
    expect(paid.status).toBe(402);
    expect(((await paid.json()) as { error: string }).error).toBe('offer_mismatch');
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses what the facilitator refuses, with the reason, and settles nothing', async () => {
    const stub = facilitatorStub({ verify: () => ({ isValid: false, invalidReason: 'escrow_amount_mismatch', payer: MANDATE }) });
    const mf = await start(ENV, stub.handle);
    const first = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    const offer = await offerOf(first, 'escrow');

    const paid = await mf.dispatchFetch('http://worker/render', {
      method: 'POST',
      body: BODY,
      headers: { 'payment-signature': escrowPayment(offer, await sha256Hex(BODY)) },
    });
    expect(paid.status).toBe(402);
    expect(((await paid.json()) as { error: string }).error).toBe('escrow_amount_mismatch');
    const report = decodeBase64Json(paid.headers.get('payment-response') ?? '') as Record<string, unknown>;
    expect(report).toMatchObject({ success: false, errorReason: 'escrow_amount_mismatch', payer: MANDATE });
    expect(stub.calls.map((call) => call.path)).toEqual(['/verify']);
  });

  it('asks again for a lock the facilitator does not see yet', async () => {
    const stub = facilitatorStub({ verify: (_body, call) => (call === 0 ? { isValid: false, invalidReason: 'escrow_lock_not_open' } : VALID) });
    const mf = await start(ENV, stub.handle);
    const first = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    const offer = await offerOf(first, 'escrow');

    const paid = await mf.dispatchFetch('http://worker/render', {
      method: 'POST',
      body: BODY,
      headers: { 'payment-signature': escrowPayment(offer, await sha256Hex(BODY)) },
    });
    expect(paid.status).toBe(200);
    expect(stub.calls.map((call) => call.path)).toEqual(['/verify', '/verify', '/settle']);
  });

  it('settles nothing when the handler fails', async () => {
    const stub = facilitatorStub({ verify: () => VALID });
    const mf = await start(ENV, stub.handle);
    const first = await mf.dispatchFetch('http://worker/fail', { method: 'POST', body: BODY });
    const offer = await offerOf(first, 'escrow');

    const paid = await mf.dispatchFetch('http://worker/fail', {
      method: 'POST',
      body: BODY,
      headers: { 'payment-signature': escrowPayment(offer, await sha256Hex(BODY)) },
    });
    expect(paid.status).toBe(500);
    expect(paid.headers.get('payment-response')).toBeNull();
    expect(stub.calls.map((call) => call.path)).toEqual(['/verify']);
  });

  it('reports a settlement that failed as a refusal', async () => {
    const stub = facilitatorStub({
      verify: () => VALID,
      settle: () => ({ success: false, errorReason: 'escrow_nonce_mismatch', payer: MANDATE, transaction: '', network: 'eip155:4663' }),
    });
    const mf = await start(ENV, stub.handle);
    const first = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    const offer = await offerOf(first, 'escrow');

    const paid = await mf.dispatchFetch('http://worker/render', {
      method: 'POST',
      body: BODY,
      headers: { 'payment-signature': escrowPayment(offer, await sha256Hex(BODY)) },
    });
    expect(paid.status).toBe(402);
    expect(((await paid.json()) as { error: string }).error).toBe('escrow_nonce_mismatch');
  });

  it('treats a facilitator that does not answer as unavailable, not as a refusal of the payer', async () => {
    const mf = await start(ENV, async () => new Response('gateway', { status: 502 }));
    const first = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    const offer = await offerOf(first, 'escrow');

    const paid = await mf.dispatchFetch('http://worker/render', {
      method: 'POST',
      body: BODY,
      headers: { 'payment-signature': escrowPayment(offer, await sha256Hex(BODY)) },
    });
    expect(paid.status).toBe(402);
    expect(((await paid.json()) as { error: string }).error).toBe('facilitator_unavailable');
  });

  it('speaks version 1 to a version 1 client', async () => {
    const stub = facilitatorStub({ verify: () => VALID });
    const mf = await start(ENV, stub.handle);
    const first = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    const offer = await offerOf(first, 'escrow');

    const paid = await mf.dispatchFetch('http://worker/render', {
      method: 'POST',
      body: BODY,
      headers: { 'x-payment': escrowPayment(offer, await sha256Hex(BODY), { x402Version: 1, accepted: undefined, scheme: 'escrow', network: offer['network'], asset: offer['asset'], payTo: offer['payTo'] }) },
    });
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-response')).toBeNull();
    expect(decodeBase64Json(paid.headers.get('x-payment-response') ?? '')).toMatchObject({ success: true });
  });

  it('names the variable that is missing instead of failing the request', async () => {
    const mf = await start({ ...ENV, BURSAR_PROVIDER: 'not-an-address' }, async () => new Response('never', { status: 599 }));
    const response = await mf.dispatchFetch('http://worker/render', { method: 'POST', body: BODY });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'bursar_misconfigured', detail: expect.stringContaining('BURSAR_PROVIDER') });
  });
});
