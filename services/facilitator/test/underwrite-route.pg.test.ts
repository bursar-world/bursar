import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { micro, toMicro } from '@bursar/core';
import { privateKeyToAccount } from 'viem/accounts';
import { LaneLedger } from '../src/lanes/ledger.js';
import { TrustStore } from '../src/trust/store.js';
import { SettlementBudget } from '../src/x402/budget.js';
import { Facilitator } from '../src/x402/facilitator.js';
import { createRouter, errorResponse } from '../src/http/routes.js';
import type { Router } from '../src/http/routes.js';
import type { ApiRequest } from '../src/http/io.js';
import type { MandateUnderwriter, UnderwriterDecision } from '../src/underwriting/underwriter.js';
import { FakeLedger, ScriptedScheme } from './support/doubles.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

/**
 * `/underwrite` all the way to a row.
 *
 * The route only earns its place if the decision it takes survives into `bursar_authorizations`
 * in a form a reservation can be opened against, so this drives it over a real database and then
 * opens one.
 */

const payer = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const ACCOUNT = '0x07EfBB6214E24a5B97625345D78eca660cAffcAf';
const MERCHANT = '0x7F97980568AD3bFe77B2150b5cdD98eB5f271718';
const CAPABILITY = '0x220f0024762d0558a93b06e5546a37f5aba35f5c9f7129155e9f1645a80a4a4c';
const NETWORK = 'eip155:4663';
const TREASURY = '0x4444444444444444444444444444444444444444';
const AGENT = 'agent-underwritten';
const POOL = 'prefund-main';

describe.skipIf(!TEST_DATABASE_URL)('taking a decision and recording it', () => {
  let scratch: Scratch;
  let router: Router;
  let verdict: UnderwriterDecision;
  let known: boolean;
  let decisions: number;
  let asked: Parameters<MandateUnderwriter['authorize']>[0] | null;

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_underwrite_test');
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.reset();
    verdict = { decision: 'allow' };
    known = true;
    decisions = 0;
    asked = null;

    const trust = new TrustStore({ topic: 'mandate.trust.v1' });
    const ledger = new LaneLedger({ db: scratch.db, trust, currency: 'USDG' });

    const underwriter: MandateUnderwriter = {
      account: ACCOUNT,
      async authorize(request) {
        decisions += 1;
        asked = request;
        return {
          decision: verdict,
          idempotent: false,
          quote: {
            decision: verdict,
            bucket: verdict.decision === 'refuse' ? 'per_call' : null,
            documentHash: `0x${'11'.repeat(32)}`,
            accountVersion: 1n,
            headroom: {
              perCall: micro(2_500_000n),
              daily: micro(50_000_000n),
              monthly: micro(500_000_000n),
              balance: micro(10_000_000n),
            },
          },
        };
      },
    };

    router = createRouter({
      db: scratch.db,
      facilitator: new Facilitator({
        scheme: new ScriptedScheme({ verify: { isValid: true, payer: payer.address } }),
        budget: new SettlementBudget({ dailySettlements: 100, perPayerPerHour: 100 }),
        ledger: new FakeLedger(),
        treasury: TREASURY,
        feeBps: 100,
        feeFloorMicro: toMicro(1_900),
      }),
      ledger,
      trust,
      reservationTtlMs: 120_000,
      treasury: TREASURY,
      describe: () => ({ network: NETWORK }),
      underwriterFor: async (agentId) => (known && agentId === AGENT ? underwriter : null),
    });
  });

  function call(method: string, path: string, body: unknown = {}): Promise<{ status: number; body: unknown }> {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(),
      headers: {},
      body,
      bytes: new TextEncoder().encode(JSON.stringify(body)),
    };
    return router(request);
  }

  /** The router plus the error mapping the HTTP server applies, which is the whole request path. */
  function answer(method: string, path: string, body: unknown = {}): Promise<{ status: number; body: unknown }> {
    return call(method, path, body).catch((error: unknown) => errorResponse(error));
  }

  async function setUp(): Promise<void> {
    await call('POST', '/accounts', {
      agentId: AGENT,
      payerWallet: payer.address,
      repayWallet: payer.address,
      networks: [NETWORK],
      mandateAccount: ACCOUNT,
    });
    await call('POST', '/pools', { poolId: POOL, lane: 'prefund', maxSingleMicro: '5000000' });
    await call('POST', `/lanes/${AGENT}/prefund`, {
      poolId: POOL,
      referenceId: 'deposit-1',
      eventType: 'deposit',
      amountMicro: '10000000',
    });
  }

  function ask(amountMicro: string, nonce: string): Record<string, unknown> {
    return {
      agentId: AGENT,
      payerWallet: payer.address,
      repayWallet: payer.address,
      requestNonce: nonce,
      network: NETWORK,
      lane: 'prefund',
      poolId: POOL,
      subject: 'agent:render-bot',
      action: 'gpu.render',
      amountMicro,
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    };
  }

  it('records an approval a reservation can then be opened against', async () => {
    await setUp();

    const decided = await call('POST', '/underwrite', ask('1000000', 'req-1'));
    expect(decided.status).toBe(201);
    expect(decided.body).toMatchObject({
      decision: { decision: 'allow' },
      mandateAccount: ACCOUNT,
      authorization: { approved: true, approvedMicro: 1_000_000n },
    });

    const authorization = (decided.body as { authorization: { id: string } }).authorization;
    const held = await call('POST', '/reservations', {
      authorizationId: authorization.id,
      merchantWallet: MERCHANT,
      amountMicro: '1000000',
    });
    expect(held.status).toBe(201);
  });

  it('records a refusal as unapproved, and no reservation opens against it', async () => {
    await setUp();
    verdict = { decision: 'refuse', reason: 'over_per_call_cap' };

    const decided = await call('POST', '/underwrite', ask('5000000', 'req-2'));
    expect(decided.status).toBe(201);
    expect(decided.body).toMatchObject({
      authorization: { approved: false, approvedMicro: 0n },
    });
    expect((decided.body as { authorization: { reasonCodes: string[] } }).authorization.reasonCodes)
      .toEqual(['over_per_call_cap', 'per_call']);

    const authorization = (decided.body as { authorization: { id: string } }).authorization;
    await expect(
      call('POST', '/reservations', {
        authorizationId: authorization.id,
        merchantWallet: MERCHANT,
        amountMicro: '5000000',
      }),
    ).rejects.toThrow();
  });

  it('hands the merchant proof to the underwriter, which a Merkle-gated account refuses without', async () => {
    await setUp();
    const proof = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`];

    const decided = await call('POST', '/underwrite', { ...ask('1000000', 'req-proof'), merchantProof: proof });
    expect(decided.status).toBe(201);
    expect(asked?.merchantProof).toEqual(proof);
  });

  it('refuses a merchant proof that is not a list of 32-byte values, before deciding', async () => {
    await setUp();
    const response = await answer('POST', '/underwrite', { ...ask('1000000', 'req-bad-proof'), merchantProof: ['0x12'] });
    expect(response).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
    expect(decisions).toBe(0);
  });

  it('holds a spend above the approval threshold without committing the funds', async () => {
    await setUp();
    verdict = { decision: 'hold', threshold_micros: 1_000_000n };

    const decided = await call('POST', '/underwrite', ask('2000000', 'req-3'));
    expect(decided.body).toMatchObject({
      authorization: { approved: false, approvedMicro: 0n, reasonCodes: ['approval_required'] },
    });
  });

  it('refuses rather than inventing a decision for an agent it does not underwrite', async () => {
    await setUp();
    known = false;
    await expect(call('POST', '/underwrite', ask('1000000', 'req-4'))).rejects.toThrow(
      /No mandate is underwritten/,
    );
  });

  it('answers an unknown pool the way it answers an unknown agent, and takes no decision', async () => {
    await setUp();

    const answered = await answer('POST', '/underwrite', { ...ask('1000000', 'req-5'), poolId: 'p1' });

    expect(answered.status).toBe(404);
    expect(answered.body).toMatchObject({ error: 'pool_not_found' });
    expect(JSON.stringify(answered.body)).toContain('POST /pools');
    // The decision is what costs chain reads and reserves against the lifetime ceiling. Reaching
    // it and then failing to record it would leave that reservation standing for nothing.
    expect(decisions).toBe(0);
  });

  it('answers an unknown agent account before it asks anyone to decide', async () => {
    await setUp();

    const answered = await answer('POST', '/underwrite', { ...ask('1000000', 'req-6'), agentId: AGENT });
    expect(answered.status).toBe(201);

    await scratch.db.query('DELETE FROM bursar_accounts WHERE agent_id = $1', [AGENT]);
    const missing = await answer('POST', '/underwrite', ask('1000000', 'req-7'));

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'account_not_found' });
    expect(JSON.stringify(missing.body)).toContain('POST /accounts');
  });

  it('turns a constraint on any other route into the same answer, never an internal error', async () => {
    await setUp();

    // `/authorizations` records a decision taken elsewhere, so it has no lookup in front of it and
    // the foreign key is the first thing that notices. It reaches the caller as the missing pool.
    const answered = await answer('POST', '/authorizations', {
      agentId: AGENT,
      payerWallet: payer.address,
      repayWallet: payer.address,
      requestNonce: 'req-8',
      network: NETWORK,
      lane: 'prefund',
      poolId: 'no-such-pool',
      requestedMicro: '1000000',
      approved: true,
      approvedMicro: '1000000',
      availableMicro: '1000000',
      outstandingMicro: '0',
    });

    expect(answered.status).toBe(404);
    expect(answered.body).toMatchObject({ error: 'pool_not_found' });
    expect(JSON.stringify(answered.body)).not.toContain('fkey');
    expect(JSON.stringify(answered.body)).not.toContain('bursar_authorizations');
  });

  it('opens a pool in the lane /config advertises, under the schema that stores it', async () => {
    const direct = await answer('POST', '/pools', {
      poolId: 'direct-main',
      lane: 'direct',
      maxSingleMicro: '5000000',
    });
    expect(direct.status).toBe(201);
    expect(direct.body).toMatchObject({ poolId: 'direct-main', lane: 'direct' });

    // The name the schema used before 0006, still accepted and stored as the one name.
    const deprecated = await answer('POST', '/pools', {
      poolId: 'direct-legacy',
      lane: 'none',
      maxSingleMicro: '5000000',
    });
    expect(deprecated.status).toBe(201);
    expect(deprecated.body).toMatchObject({ poolId: 'direct-legacy', lane: 'direct' });
  });
});
