import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import { privateKeyToAccount } from 'viem/accounts';
import { LaneLedger } from '../src/lanes/ledger.js';
import { TrustStore } from '../src/trust/store.js';
import { TrustRelay } from '../src/trust/relay.js';
import { drain } from './support/drain.js';
import { SettlementBudget } from '../src/x402/budget.js';
import { Facilitator } from '../src/x402/facilitator.js';
import { deriveNonce } from '@bursar/core';
import { hashRequest } from '../src/x402/binding.js';
import { createRouter } from '../src/http/routes.js';
import type { Router } from '../src/http/routes.js';
import type { ApiRequest } from '../src/http/io.js';
import type { TrustEventPayload } from '../src/trust/types.js';
import { ScriptedScheme } from './support/doubles.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

/**
 * The whole path, over the real database: a principal funds a mandate, an agent spends inside it,
 * a merchant is paid net, and the trust layer hears about it exactly once.
 */

const payer = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const NETWORK = 'eip155:4663';
const ASSET = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const MERCHANT = '0x000000000000000000000000000000000000dEaD';
const TREASURY = '0x4444444444444444444444444444444444444444';
const AGENT = 'agent-1';
const POOL = 'prefund-main';

describe.skipIf(!TEST_DATABASE_URL)('paying a provider through the prefund lane', () => {
  let scratch: Scratch;
  let router: Router;
  let ledger: LaneLedger;
  let trust: TrustStore;
  let scheme: ScriptedScheme;
  let delivered: TrustEventPayload[];
  let relay: TrustRelay;
  /** What the staking pool reports for each payee, lowercased. Anyone missing has no stake. */
  let tiers: Map<string, number>;

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_flow_test');
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.reset();
    delivered = [];
    trust = new TrustStore({ topic: 'mandate.trust.v1' });
    ledger = new LaneLedger({ db: scratch.db, trust, currency: 'USDG' });
    scheme = new ScriptedScheme({ verify: { isValid: true, payer: payer.address } });
    tiers = new Map();

    const facilitator = new Facilitator({
      scheme,
      budget: new SettlementBudget({ dailySettlements: 100, perPayerPerHour: 100 }),
      ledger,
      treasury: TREASURY,
      feeBps: 100,
      feeFloorMicro: toMicro(1_900),
      rebateOf: async (payee) => tiers.get(payee) ?? 0,
      requireBinding: true,
    });

    router = createRouter({
      db: scratch.db,
      facilitator,
      ledger,
      trust,
      reservationTtlMs: 120_000,
      treasury: TREASURY,
      describe: () => ({ network: NETWORK }),
    });

    relay = new TrustRelay({
      db: scratch.db,
      store: trust,
      sink: {
        name: 'recording',
        deliver: async (batch) => {
          delivered.push(...batch.map((message) => message.payload));
          return { delivered: batch.map((m) => m.eventId), statusCode: 202, error: null, permanent: false };
        },
      },
    });
  });

  function call(method: string, path: string, body: unknown = {}, query = ''): Promise<{ status: number; body: unknown }> {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(query),
      headers: {},
      body,
      bytes: new TextEncoder().encode(JSON.stringify(body)),
    };
    return router(request).then((response) => ({ status: response.status, body: response.body }));
  }

  async function setUp(): Promise<void> {
    expect(
      (
        await call('POST', '/accounts', {
          agentId: AGENT,
          payerWallet: payer.address,
          repayWallet: payer.address,
          networks: [NETWORK],
          perCallCapMicro: '2000000',
          dailyCapMicro: '10000000',
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await call('POST', '/pools', {
          poolId: POOL,
          lane: 'prefund',
          maxSingleMicro: '5000000',
        })
      ).status,
    ).toBe(201);
  }

  async function reserve(amountMicro: string, nonce: string): Promise<string> {
    const authorization = await call('POST', '/authorizations', {
      agentId: AGENT,
      payerWallet: payer.address,
      repayWallet: payer.address,
      requestNonce: nonce,
      network: NETWORK,
      lane: 'prefund',
      poolId: POOL,
      requestedMicro: amountMicro,
      approved: true,
      approvedMicro: amountMicro,
      availableMicro: amountMicro,
      outstandingMicro: '0',
    });
    const authorizationId = (authorization.body as { id: string }).id;

    const reservation = await call('POST', '/reservations', {
      authorizationId,
      merchantWallet: MERCHANT,
      amountMicro,
    });
    expect(reservation.status).toBe(201);
    return (reservation.body as { id: string }).id;
  }

  it('funds once, spends per call, and pays the merchant net', async () => {
    await setUp();

    const funded = await call('POST', `/lanes/${AGENT}/prefund`, {
      poolId: POOL,
      referenceId: `0x${'de'.repeat(32)}`,
      eventType: 'deposit',
      amountMicro: '10000000',
    });
    expect(funded.status).toBe(200);

    const statement = await call('GET', `/lanes/${AGENT}/${POOL}`);
    expect(statement.body).toMatchObject({ lane: 'prefund', outstandingMicro: 0n });

    const settlementIds: string[] = [];
    for (const [index, amount] of ['1000000', '2000000', '500000'].entries()) {
      const reservationId = await reserve(amount, `call-${index}`);
      const consumed = await call('POST', `/reservations/${reservationId}/consume`, {
        asset: ASSET,
        feeMicro: '1900',
      });
      expect(consumed.status).toBe(200);
      settlementIds.push((consumed.body as { settlement: { id: string } }).settlement.id);
    }

    // Three calls have been authorised and nothing has been broadcast yet.
    const pending = await call('GET', `/settlements/pending/${MERCHANT}`);
    expect((pending.body as { settlements: unknown[] }).settlements).toHaveLength(3);
    expect(await ledger.getBalance(AGENT, POOL)).toMatchObject({
      availableMicro: 6_500_000n,
      reservedMicro: 0n,
      spentMicro: 3_500_000n,
    });

    const net = await call('POST', '/settlements/net', {
      settlementIds,
      txHash: `0x${'ab'.repeat(32)}`,
    });
    expect((net.body as { settled: unknown[] }).settled).toHaveLength(3);
    expect((await call('GET', `/settlements/pending/${MERCHANT}`)).body).toEqual({ settlements: [] });

    await drain(relay);
    const confirmations = delivered.filter((event) => event.eventType === 'settlement_confirmed');
    expect(confirmations).toHaveLength(3);
    expect(confirmations.map((event) => event.amountMicro).sort()).toEqual([
      '1000000',
      '2000000',
      '500000',
    ]);
    expect(new Set(confirmations.map((event) => event.txHash)).size).toBe(1);
  });

  it('stops a call once the prefunded balance is gone', async () => {
    await setUp();
    await call('POST', `/lanes/${AGENT}/prefund`, {
      poolId: POOL,
      referenceId: 'deposit-1',
      eventType: 'deposit',
      amountMicro: '1000000',
    });

    await reserve('1000000', 'call-0');
    await expect(reserve('1000000', 'call-1')).rejects.toThrow(/does not hold/);
  });

  /** A direct `/settle` for one 1 USDG call, landing on chain as the scheme reports it. */
  async function settleDirect(): Promise<{ status: number; body: unknown }> {
    // The request the payment buys is the one the resource server served, not this envelope. It
    // forwards the digest of those bytes, and the payer derived its nonce from the same digest.
    const requestHash = hashRequest(JSON.stringify({ prompt: 'render this frame' }));
    const salt = `0x${'5a'.repeat(32)}` as `0x${string}`;
    const nonce = deriveNonce({ requestHash, salt });
    const requirements = {
      scheme: 'exact',
      network: NETWORK,
      amount: '1000000',
      asset: ASSET,
      payTo: MERCHANT,
    };
    const body = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          authorization: { from: payer.address, nonce },
          signature: '0xsig',
          binding: { requestHash, salt },
        },
      },
      paymentRequirements: requirements,
      requestHash,
    };

    scheme.set({
      verify: { isValid: true, payer: payer.address },
      settle: {
        success: true,
        settled: true,
        broadcast: true,
        payer: payer.address,
        transaction: `0x${'cd'.repeat(32)}`,
        network: NETWORK,
      },
    });

    const response = await router({
      method: 'POST',
      path: '/settle',
      query: new URLSearchParams(),
      headers: {},
      body,
      bytes: new TextEncoder().encode(JSON.stringify(body)),
    });
    return { status: response.status, body: response.body };
  }

  it('settles a direct call on chain and reports it once', async () => {
    await setUp();

    const response = await settleDirect();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true });

    await drain(relay);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      eventType: 'settlement_confirmed',
      lane: 'direct',
      poolId: 'direct',
      amountMicro: '1000000',
    });
  });

  it('takes a staked payee\'s rebate off the fee, and says so in the answer and the ledger', async () => {
    await setUp();
    tiers.set(MERCHANT.toLowerCase(), 2_000);

    const response = await settleDirect();

    // 1% of 1 USDG is 10,000 micro-USD, and the payee's 20% tier takes 2,000 of it.
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, feeMicro: '8000', rebateBps: 2_000, rebateMicro: '2000' });

    const rows = await scratch.db.query<{ fee_micro: string; rebate_bps: number; rebate_micro: string; owed: string }>(
      `SELECT s.fee_micro::text, s.rebate_bps, s.rebate_micro::text, f.amount_micro::text AS owed
       FROM bursar_settlements s
       INNER JOIN bursar_fee_ledger f ON f.settlement_id = s.id`,
    );
    expect(rows.rows).toEqual([
      { fee_micro: '8000.000000', rebate_bps: 2_000, rebate_micro: '2000.000000', owed: '8000.000000' },
    ]);
  });

  it('reports the trust queue and its quarantine to an operator', async () => {
    await setUp();
    await call('POST', `/lanes/${AGENT}/prefund`, {
      poolId: POOL,
      referenceId: 'deposit-1',
      eventType: 'deposit',
      amountMicro: '1000000',
    });

    const before = await call('GET', '/trust/outbox');
    expect(before.body).toMatchObject({ counts: { pending: 1, deadLettered: 0 } });

    const events = await call('GET', '/trust/events');
    expect((events.body as { events: unknown[] }).events).toHaveLength(1);

    const replayed = await call('POST', '/trust/outbox/replay', { fromOffset: 0, limit: 10 });
    expect(replayed.body).toMatchObject({ scanned: 1, enqueued: 0 });
  });
});
