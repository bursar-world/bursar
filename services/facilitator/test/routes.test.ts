import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import { LaneLedger } from '../src/lanes/ledger.js';
import { LANE_MODES } from '../src/lanes/types.js';
import { TrustStore } from '../src/trust/store.js';
import { SettlementBudget } from '../src/x402/budget.js';
import { Facilitator } from '../src/x402/facilitator.js';
import { createRouter, errorResponse } from '../src/http/routes.js';
import { encodeJson } from '../src/http/io.js';
import type { ApiRequest } from '../src/http/io.js';
import { FakeLedger, RecordingDatabase, ScriptedScheme } from './support/doubles.js';

function harness() {
  const db = new RecordingDatabase();
  const trust = new TrustStore({ topic: 'mandate.trust.v1' });
  const ledger = new LaneLedger({ db, trust, currency: 'USDG' });
  const facilitator = new Facilitator({
    scheme: new ScriptedScheme({ verify: { isValid: false, invalidReason: 'invalid_payload' } }),
    budget: new SettlementBudget({}),
    ledger: new FakeLedger(),
    treasury: '0x000000000000000000000000000000000000beef',
    feeBps: 100,
    feeFloorMicro: toMicro(1_900),
    requireBinding: true,
  });

  const router = createRouter({
    db,
    facilitator,
    ledger,
    trust,
    reservationTtlMs: 120_000,
    treasury: '0x000000000000000000000000000000000000beef',
    describe: () => ({ network: 'eip155:4663' }),
  });

  return { db, router, ledger, trust };
}

function request(overrides: Partial<ApiRequest> & Pick<ApiRequest, 'method' | 'path'>): ApiRequest {
  const bytes = overrides.bytes ?? new TextEncoder().encode(JSON.stringify(overrides.body ?? {}));
  return {
    query: new URLSearchParams(),
    headers: {},
    body: {},
    ...overrides,
    bytes,
  };
}

async function call(
  router: ReturnType<typeof harness>['router'],
  method: string,
  path: string,
  body?: unknown,
  query = '',
) {
  return router(request({ method, path, body: body ?? {}, query: new URLSearchParams(query) }));
}

describe('routing', () => {
  it('answers health without touching anything else', async () => {
    const { router } = harness();
    expect(await call(router, 'GET', '/healthz')).toEqual({ status: 200, body: { status: 'ok' }, headers: undefined });
  });

  it('reports an unknown path as not found', async () => {
    const { router } = harness();
    expect(await call(router, 'GET', '/nope')).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });

  it('reads a lane\'s funding history rather than a pool called prefund', async () => {
    const { db, router } = harness();
    const response = await call(router, 'GET', '/lanes/agent-1/prefund', undefined, 'poolId=prefund-main');

    expect(response).toMatchObject({ status: 200, body: { events: [] } });
    expect(db.saw(/FROM bursar_funding_events/)).toBe(true);
  });

  it('separates a wrong method from a wrong path', async () => {
    const { router } = harness();
    expect(await call(router, 'DELETE', '/verify')).toMatchObject({
      status: 405,
      body: { error: 'method_not_allowed' },
    });
  });

  it('publishes what the scheme supports alongside the budget', async () => {
    const { router } = harness();
    const response = await call(router, 'GET', '/supported');
    expect(response.body).toMatchObject({ dailyLimit: 2_000, perPayerHourlyLimit: 60 });
  });
});

describe('verify and settle', () => {
  it('refuses a body that is not a payment request', async () => {
    const { router } = harness();
    expect(await call(router, 'POST', '/verify', { nothing: true })).toMatchObject({
      status: 400,
      body: { isValid: false, invalidReason: 'invalid_payload' },
    });
  });

  it('hashes the bytes that arrived when the caller supplies no digest', async () => {
    const { router } = harness();
    const body = { paymentPayload: { payload: {} }, paymentRequirements: { network: 'eip155:4663' } };
    const response = await router(
      request({ method: 'POST', path: '/verify', body, bytes: new TextEncoder().encode(JSON.stringify(body)) }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ isValid: false });
  });

  it('returns a refused settlement as a complete answer, not a fault', async () => {
    const { router } = harness();
    const response = await call(router, 'POST', '/settle', {
      paymentPayload: { payload: {} },
      paymentRequirements: { network: 'eip155:4663' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: false });
  });
});

describe('input validation', () => {
  it('refuses money sent as a JSON number', async () => {
    const { router } = harness();
    const response = await router(
      request({
        method: 'POST',
        path: '/lanes/agent-1/prefund',
        body: { poolId: 'p', referenceId: 'r', eventType: 'deposit', amountMicro: 1000000 },
      }),
    ).catch((error: unknown) => errorResponse(error));
    expect(response).toMatchObject({ status: 400 });
    expect(JSON.stringify(response.body)).toContain('a JSON number cannot hold one exactly');
  });

  it('refuses an amount that is not an integer of micro-USD', async () => {
    const { router } = harness();
    const response = await router(
      request({
        method: 'POST',
        path: '/lanes/agent-1/prefund',
        body: { poolId: 'p', referenceId: 'r', eventType: 'deposit', amountMicro: '1.5' },
      }),
    ).catch((error: unknown) => errorResponse(error));
    expect(response).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
  });

  it('refuses a movement that is neither a deposit nor a withdrawal', async () => {
    const { router } = harness();
    const response = await router(
      request({
        method: 'POST',
        path: '/lanes/agent-1/prefund',
        body: { poolId: 'p', referenceId: 'r', eventType: 'steal', amountMicro: '1' },
      }),
    ).catch((error: unknown) => errorResponse(error));
    expect(response).toMatchObject({ status: 400 });
  });

  it('refuses a lane the ledger does not have, and names the ones it does', async () => {
    const { router } = harness();
    const response = await router(
      request({
        method: 'POST',
        path: '/pools',
        body: { poolId: 'p', lane: 'overdraft', maxSingleMicro: '1000000' },
      }),
    ).catch((error: unknown) => errorResponse(error));
    expect(response).toMatchObject({ status: 400, body: { error: 'lane_invalid' } });
    expect(JSON.stringify(response.body)).toContain('prefund, collateral, direct');
  });

  it('takes every lane it advertises, and the one name the schema used before 0006', async () => {
    const { router, db } = harness();
    db.answer(/INSERT INTO bursar_pools/, [
      { pool_id: 'p', lane: 'direct', status: 'active', ltv_cap_bps: 0, min_health_factor: '1.5', max_single_micro: '1000000' },
    ]);

    for (const lane of [...LANE_MODES, 'none']) {
      const response = await call(router, 'POST', '/pools', { poolId: 'p', lane, maxSingleMicro: '1000000' });
      expect(response.status, `lane ${lane}`).toBe(201);
    }
  });

  it('refuses a pool outside the collateral lane that carries a borrowing cap', async () => {
    const { router } = harness();
    const response = await router(
      request({
        method: 'POST',
        path: '/pools',
        body: { poolId: 'p', lane: 'prefund', ltvCapBps: 6000, maxSingleMicro: '1000000' },
      }),
    ).catch((error: unknown) => errorResponse(error));
    expect(response).toMatchObject({ status: 409, body: { error: 'lane_extends_no_credit' } });
  });

  it('refuses a limit that is not a positive integer', async () => {
    const { router } = harness();
    const response = await call(router, 'GET', '/accounts/agent-1/transactions', {}, 'limit=-1').catch(
      (error: unknown) => errorResponse(error),
    );
    expect(response).toMatchObject({ status: 400, body: { error: 'limit_invalid' } });
  });

  it('refuses a path identifier that is not a UUID before it reaches the database', async () => {
    const { router, db } = harness();
    for (const path of [
      '/reservations/abc',
      '/reservations/abc/release',
      '/reservations/abc/consume',
    ]) {
      const method = path === '/reservations/abc' ? 'GET' : 'POST';
      const response = await call(router, method, path, { asset: 'usdg' }).catch((error: unknown) =>
        errorResponse(error),
      );
      expect(response).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
    }
    expect(db.saw(/bursar_reservations/)).toBe(false);
  });

  it('refuses a body identifier that is not a UUID', async () => {
    const { router } = harness();
    const response = await router(
      request({
        method: 'POST',
        path: '/reservations',
        body: { authorizationId: 'not-a-uuid', merchantWallet: '0xabc', amountMicro: '1000' },
      }),
    ).catch((error: unknown) => errorResponse(error));
    expect(response).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
    expect(JSON.stringify(response.body)).toContain('authorizationId must be a UUID');
  });

  it('refuses a settlement identifier that is not a UUID', async () => {
    const { router } = harness();
    const response = await router(
      request({
        method: 'POST',
        path: '/settlements/net',
        body: { settlementIds: ['nope'], txHash: `0x${'ab'.repeat(32)}` },
      }),
    ).catch((error: unknown) => errorResponse(error));
    expect(response).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
  });

  it('refuses a journal offset that is not a number', async () => {
    const { router } = harness();
    const response = await call(router, 'GET', '/trust/events', {}, 'fromOffset=abc').catch(
      (error: unknown) => errorResponse(error),
    );
    expect(response).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
  });

  it('holds a reservation window to the range the configured default is held to', async () => {
    const { router } = harness();
    for (const ttlSeconds of [1, 9_000_000_000_000_000]) {
      const response = await router(
        request({
          method: 'POST',
          path: '/reservations',
          body: {
            authorizationId: '33333333-3333-4333-8333-333333333333',
            merchantWallet: '0xabc',
            amountMicro: '1000',
            ttlSeconds,
          },
        }),
      ).catch((error: unknown) => errorResponse(error));
      expect(response).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
      expect(JSON.stringify(response.body)).toContain('ttlSeconds must be between 90 and 3600');
    }
  });

  it('answers a malformed percent-encoding in the path with 400, not 500', async () => {
    const { router } = harness();
    const response = await router(request({ method: 'GET', path: '/accounts/%E0%A4%A' })).catch(
      (error: unknown) => errorResponse(error),
    );
    expect(response).toMatchObject({ status: 400, body: { error: 'path_invalid' } });
  });

  it('refuses a net settlement that names nothing', async () => {
    const { router } = harness();
    const response = await router(
      request({ method: 'POST', path: '/settlements/net', body: { txHash: '0xabc' } }),
    ).catch((error: unknown) => errorResponse(error));
    expect(response).toMatchObject({ status: 400, body: { error: 'settlement_ids_required' } });
  });
});

describe('reads', () => {
  it('reports a missing account as not found', async () => {
    const { router } = harness();
    expect(await call(router, 'GET', '/accounts/nobody')).toMatchObject({ status: 404 });
  });

  it('reports a missing pool as not found', async () => {
    const { router } = harness();
    expect(await call(router, 'GET', '/pools/nowhere')).toMatchObject({ status: 404 });
  });

  it('suspends an account and reports it back', async () => {
    const { router, db } = harness();
    db.answer(/FROM bursar_accounts WHERE agent_id/, [
      {
        agent_id: 'agent-1',
        mandate_account: null,
        payer_wallet: '0xpayer',
        repay_wallet: '0xrepay',
        networks: [],
        per_call_cap_micro: null,
        daily_cap_micro: null,
        monthly_cap_micro: null,
        approval_threshold_micro: null,
        status: 'active',
        created_at: new Date(0),
        updated_at: new Date(0),
      },
    ]);

    const response = await call(router, 'POST', '/accounts/agent-1/status', { status: 'suspended' });
    expect(response.status).toBe(200);
    expect(db.saw(/UPDATE bursar_accounts SET status/)).toBe(true);
  });

  it('refuses a status no account can be in', async () => {
    const { router, db } = harness();
    db.answer(/FROM bursar_accounts WHERE agent_id/, [{ agent_id: 'agent-1', status: 'active' }]);
    const response = await call(router, 'POST', '/accounts/agent-1/status', { status: 'frozen' }).catch(
      (error: unknown) => errorResponse(error),
    );
    expect(response).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
  });

  it('answers a missing account on a lane statement the way every other route does', async () => {
    const { router } = harness();
    const response = await call(router, 'GET', '/lanes/agent-1/prefund-main');
    const elsewhere = await call(router, 'GET', '/accounts/agent-1');

    expect(response).toEqual(elsewhere);
    expect(response).toEqual({
      status: 404,
      body: {
        error: 'account_not_found',
        detail: 'No agent account by the id agent-1. Create one with POST /accounts before spending against it.',
      },
    });
  });

  it('answers a missing pool on a lane statement the way every other route does', async () => {
    const { router, db } = harness();
    db.answer(/FROM bursar_accounts WHERE agent_id/, [{ agent_id: 'agent-1', status: 'active' }]);
    const response = await call(router, 'GET', '/lanes/agent-1/prefund-main');

    expect(response).toEqual(await call(router, 'GET', '/pools/prefund-main'));
    expect(response).toMatchObject({ status: 404, body: { error: 'pool_not_found' } });
  });

  it('refuses a pending-settlements lookup for something that is not an address', async () => {
    const { router, db } = harness();
    const response = await call(router, 'GET', '/settlements/pending/not-a-wallet').catch((error: unknown) =>
      errorResponse(error),
    );

    expect(response).toEqual({
      status: 400,
      body: { error: 'field_invalid', detail: 'merchant must be a 20-byte hex address' },
    });
    expect(db.saw(/FROM bursar_settlements/)).toBe(false);
  });

  it('looks up pending settlements for an address', async () => {
    const { router } = harness();
    const response = await call(router, 'GET', '/settlements/pending/0x000000000000000000000000000000000000dEaD');

    expect(response).toMatchObject({ status: 200, body: { settlements: [] } });
  });
});

describe('serialisation', () => {
  it('writes every amount as a string', () => {
    expect(encodeJson({ amountMicro: 90_071_992_547_409n })).toBe('{"amountMicro":"90071992547409"}');
  });

  it('never hides an unexpected fault behind a code a caller would act on', () => {
    expect(errorResponse(new TypeError('undefined is not a function'))).toEqual({
      status: 500,
      body: { error: 'internal_error' },
    });
  });
});
