import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import { LaneLedger } from '../src/lanes/ledger.js';
import { TrustStore } from '../src/trust/store.js';
import { SettlementBudget } from '../src/x402/budget.js';
import { Facilitator } from '../src/x402/facilitator.js';
import { RATE_LIMITED, RequestMeter, callerOf, createPublicSurface } from '../src/x402/public.js';
import { createRouter, routeClass } from '../src/http/routes.js';
import { createHttpServer, listen } from '../src/http/server.js';
import type { ApiRequest } from '../src/http/io.js';
import { FakeLedger, RecordingDatabase, ScriptedScheme } from './support/doubles.js';

/**
 * The keyless routes: the reference shapes, the shared budget and replay guard, the meter, and the
 * token guard letting them through while everything beside them stays shut.
 */
const PAYER = '0x877c349EFb5926082C413833E8055F0991185c61' as const;
const PAY_TO = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as const;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TX = `0x${'ab'.repeat(32)}`;

function payment(nonce = `0x${'11'.repeat(32)}`) {
  return {
    paymentPayload: {
      x402Version: 2,
      accepted: { scheme: 'exact', network: 'eip155:4663' },
      payload: { signature: `0x${'22'.repeat(65)}`, authorization: { from: PAYER, to: PAY_TO, value: '10000', validAfter: '0', validBefore: '9999999999', nonce } },
    },
    paymentRequirements: { scheme: 'exact', network: 'eip155:4663', amount: '10000', asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'Global Dollar', version: '1' } },
  };
}

function harness(options: { dailySettlements?: number; ratePerMinute?: number; open?: boolean } = {}) {
  const db = new RecordingDatabase();
  const trust = new TrustStore({ topic: 'mandate.trust.v1' });
  const ledger = new LaneLedger({ db, trust, currency: 'USDG' });
  const settlements = new FakeLedger();
  const budget = new SettlementBudget({ dailySettlements: options.dailySettlements ?? 2_000, perPayerPerHour: 60 });
  const scheme = new ScriptedScheme({
    verify: { isValid: true, payer: PAYER },
    settle: { success: true, settled: true, broadcast: true, payer: PAYER, transaction: TX, network: 'eip155:4663' },
  });
  const terms = { budget, ledger: settlements, treasury: '0x000000000000000000000000000000000000beef', feeBps: 100, feeFloorMicro: toMicro(1_900) };
  const bound = new Facilitator({ ...terms, scheme: new ScriptedScheme(), requireBinding: true });
  const open = createPublicSurface({
    facilitator: new Facilitator({ ...terms, scheme, requireBinding: false }),
    signers: ['0x2176977dD7010927C9492CfF765bC766a16d5f99'],
    ratePerMinute: options.ratePerMinute ?? 120,
  });
  const router = createRouter({
    db,
    facilitator: bound,
    ledger,
    trust,
    reservationTtlMs: 120_000,
    treasury: terms.treasury,
    describe: () => ({}),
    ...(options.open === false ? {} : { open }),
  });
  return { router, scheme, settlements, budget };
}

function request(method: string, path: string, body: unknown = {}, headers: ApiRequest['headers'] = {}): ApiRequest {
  return { method, path, query: new URLSearchParams(), headers, body, bytes: new TextEncoder().encode(JSON.stringify(body)), remoteAddress: '203.0.113.7' };
}

describe('the keyless routes', () => {
  it('are their own route class, and nothing else under the prefix is', () => {
    expect(routeClass('/x402/supported')).toBe('public');
    expect(routeClass('/x402/verify')).toBe('public');
    expect(routeClass('/x402/settle')).toBe('public');
    expect(routeClass('/x402/accounts')).toBe('admin');
    expect(routeClass('/supported')).toBe('provider');
  });

  it('publish the kinds in the reference shape, with the relayer as the signer', async () => {
    const { router } = harness();
    const response = await router(request('GET', '/x402/supported'));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      kinds: [{ scheme: 'exact', network: 'eip155:4663' }],
      extensions: [],
      signers: { 'eip155:*': ['0x2176977dD7010927C9492CfF765bC766a16d5f99'] },
    });
  });

  it('verify a stock payment with no request digest', async () => {
    const { router, scheme } = harness();
    const response = await router(request('POST', '/x402/verify', { x402Version: 2, ...payment() }));
    expect(response).toMatchObject({ status: 200, body: { isValid: true, payer: PAYER } });
    expect(scheme.verifyCalls).toBe(1);
  });

  it('word a refusal the way the reference client reads it', async () => {
    const { router, scheme } = harness();
    scheme.set({ verify: { isValid: false, invalidReason: 'insufficient_funds', payer: PAYER, detail: 'balance is 0' } });
    const response = await router(request('POST', '/x402/verify', payment()));
    expect(response).toMatchObject({ status: 200, body: { isValid: false, invalidReason: 'insufficient_funds', invalidMessage: 'balance is 0', payer: PAYER } });
    expect(response.body).not.toHaveProperty('detail');
  });

  it('refuse a body that is not a payment with a 400 the client can read', async () => {
    const { router } = harness();
    expect(await router(request('POST', '/x402/verify', { nothing: true }))).toMatchObject({ status: 400, body: { isValid: false, invalidReason: 'invalid_payload' } });
    expect(await router(request('POST', '/x402/settle', { nothing: true }))).toMatchObject({ status: 400, body: { success: false, errorReason: 'invalid_payload', transaction: '', network: '' } });
  });

  it('settle through the shared ledger and answer the reference shape', async () => {
    const { router, settlements } = harness();
    const response = await router(request('POST', '/x402/settle', payment()));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, settled: true, broadcast: true, payer: PAYER, transaction: TX, network: 'eip155:4663' });
    expect(response.body).not.toHaveProperty('settlementId');
    expect(settlements.kinds()).toEqual(['claim', 'direct']);
  });

  it('refuse the same authorisation a second time', async () => {
    const { router } = harness();
    await router(request('POST', '/x402/settle', payment()));
    const again = await router(request('POST', '/x402/settle', payment()));
    expect(again).toMatchObject({ status: 200, body: { success: false, errorReason: 'payment_already_used', transaction: '' } });
  });

  it('draw on the same daily budget as the provider routes', async () => {
    const { router } = harness({ dailySettlements: 1 });
    expect(await router(request('POST', '/x402/settle', payment(`0x${'01'.repeat(32)}`)))).toMatchObject({ status: 200, body: { success: true } });
    expect(await router(request('POST', '/x402/settle', payment(`0x${'02'.repeat(32)}`)))).toMatchObject({ status: 429, body: { success: false, errorReason: 'daily_budget_exhausted' } });
  });

  it('meter one caller across the three routes', async () => {
    const { router } = harness({ ratePerMinute: 2 });
    await router(request('GET', '/x402/supported'));
    await router(request('POST', '/x402/verify', payment()));
    expect(await router(request('POST', '/x402/settle', payment()))).toMatchObject({ status: 429, body: { success: false, errorReason: RATE_LIMITED, transaction: '', network: 'eip155:4663' } });
    // Another address is another caller.
    expect(await router(request('GET', '/x402/supported', {}, { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }))).toMatchObject({ status: 200 });
  });

  it('answer 404 and name the switch when the deployment has not opened them', async () => {
    const { router } = harness({ open: false });
    const response = await router(request('GET', '/x402/supported'));
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain('FACILITATOR_PUBLIC_EXACT');
  });
});

describe('the meter', () => {
  it('slides over a minute per caller', () => {
    let now = 1_000_000;
    const meter = new RequestMeter(2, () => now);
    expect(meter.take('a')).toBe(true);
    expect(meter.take('a')).toBe(true);
    expect(meter.take('a')).toBe(false);
    expect(meter.take('b')).toBe(true);
    now += 60_001;
    expect(meter.take('a')).toBe(true);
  });

  it('names the caller by the proxy header first, then the socket', () => {
    expect(callerOf(request('GET', '/x402/supported', {}, { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }))).toBe('198.51.100.9');
    expect(callerOf(request('GET', '/x402/supported'))).toBe('203.0.113.7');
    expect(callerOf({ ...request('GET', '/x402/supported'), remoteAddress: undefined })).toBe('unknown');
  });
});

describe('the token guard', () => {
  it('lets the keyless routes through and keeps the provider routes shut', async () => {
    const seen: string[] = [];
    const server = createHttpServer({
      router: async (incoming) => {
        seen.push(incoming.path);
        return { status: 200, body: { remote: incoming.remoteAddress } };
      },
      host: '0.0.0.0',
      port: 0,
      authToken: 'p'.repeat(32),
      adminToken: 'a'.repeat(32),
    });
    const running = await listen(server, '127.0.0.1', 0);
    try {
      const base = `http://127.0.0.1:${running.port}`;
      const open = await fetch(`${base}/x402/supported`);
      expect(open.status).toBe(200);
      expect(await open.json()).toEqual({ remote: '127.0.0.1' });
      expect((await fetch(`${base}/supported`)).status).toBe(401);
      expect((await fetch(`${base}/x402/accounts`)).status).toBe(401);
      expect(seen).toEqual(['/x402/supported']);
    } finally {
      await running.close();
    }
  });
});
