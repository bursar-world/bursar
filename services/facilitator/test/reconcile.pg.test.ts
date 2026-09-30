import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LaneLedger } from '../src/lanes/ledger.js';
import { TrustStore } from '../src/trust/store.js';
import type { SettlementFee } from '../src/x402/facilitator.js';
import { reconcile } from '../src/x402/reconcile.js';
import type { AuthorizationChain, LandedTransfer } from '../src/x402/reconcile.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

/**
 * Settle claims nothing closed, reconciled against what the token says.
 *
 * The ledger is real, because what matters is the SQL: that an unused claim frees the nonce and the
 * hold together, and that a used one lands as the settlement the settle would have written. The
 * chain is a double, because the token's answer is the input here and not the thing under test.
 */

const m = (value: number): Micro => toMicro(value);

const AGENT = 'agent-1';
const PREFUND = 'prefund-main';
const PAYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x3333333333333333333333333333333333333333';
const ASSET = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NETWORK = 'eip155:4663';
const TREASURY = '0x4444444444444444444444444444444444444444';
const NONCE = `0x${'7e'.repeat(32)}` as const;
const TX = `0x${'11'.repeat(32)}` as const;
const AFTER_MS = 300_000;

class FakeChain implements AuthorizationChain {
  used = false;
  transfer: LandedTransfer | null = null;
  readonly lookups: (string | null)[] = [];

  async authorizationUsed(): Promise<boolean> {
    return this.used;
  }

  async findTransfer(_payer: `0x${string}`, _nonce: `0x${string}`, txHash: string | null): Promise<LandedTransfer | null> {
    this.lookups.push(txHash);
    return this.transfer;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('settle reconciliation against Postgres', () => {
  let scratch: Scratch;
  let ledger: LaneLedger;
  let chain: FakeChain;
  let now: Date;
  let priced: string[];

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_reconcile_test');
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.reset();
    // Guard rows take their creation time from the database clock, so the ledger's clock starts
    // there too and is moved past the threshold when a test wants a claim to count as abandoned.
    now = new Date();
    ledger = new LaneLedger({
      db: scratch.db,
      trust: new TrustStore({ topic: 'bursar.trust.v1', now: () => now }),
      currency: 'USDG',
      now: () => now,
    });
    chain = new FakeChain();
    priced = [];

    await ledger.upsertAccount({ agentId: AGENT, payerWallet: PAYER, repayWallet: PAYER, networks: [NETWORK] });
    await ledger.upsertPool({
      poolId: PREFUND,
      lane: 'prefund',
      status: 'active',
      ltvCapBps: 0,
      minHealthFactor: 1.5,
      maxSingleMicro: m(5_000_000),
    });
    await ledger.applyFunding({
      agentId: AGENT,
      poolId: PREFUND,
      referenceId: 'deposit-1',
      amountMicro: m(10_000_000),
      eventType: 'deposit',
    });
  });

  const pass = (fee: SettlementFee = { feeMicro: m(1_900), rebateBps: 0, rebateMicro: m(0) }) =>
    reconcile({
      ledger,
      chain,
      network: NETWORK,
      asset: ASSET,
      treasury: TREASURY,
      fee: async (_amountMicro, payee) => {
        priced.push(payee);
        return fee;
      },
      olderThanMs: AFTER_MS,
    });

  async function claimedHold(): Promise<string> {
    const decision = await ledger.recordAuthorization({
      agentId: AGENT,
      payerWallet: PAYER,
      repayWallet: PAYER,
      requestNonce: 'n-1',
      network: NETWORK,
      lane: 'prefund',
      poolId: PREFUND,
      requestedMicro: m(1_000_000),
      approved: true,
      approvedMicro: m(1_000_000),
      availableMicro: m(1_000_000),
      outstandingMicro: m(0),
    });
    const hold = await ledger.openReservation({
      authorizationId: decision.id,
      merchantWallet: MERCHANT,
      amountMicro: m(1_000_000),
      ttlMs: 120_000,
    });
    await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce: NONCE, amountMicro: m(1_000_000) });
    const claim = await ledger.claimReservation({
      reservationId: hold.id,
      network: NETWORK,
      payerWallet: PAYER,
      nonce: NONCE,
      minRemainingMs: 60_000,
    });
    expect(claim).not.toBeNull();
    return hold.id;
  }

  async function guardRows(): Promise<readonly { settlement_id: string | null }[]> {
    const result = await scratch.db.query<{ settlement_id: string | null }>(
      'SELECT settlement_id::text AS settlement_id FROM bursar_payment_guard',
    );
    return result.rows;
  }

  it('leaves a claim alone while its settle may still be running', async () => {
    await claimedHold();
    expect(await pass()).toMatchObject({ checked: 0 });
    expect(await guardRows()).toHaveLength(1);
  });

  it('frees the nonce and the hold when the authorisation is unused on chain', async () => {
    const hold = await claimedHold();
    now = new Date(now.getTime() + AFTER_MS + 1_000);

    expect(await pass()).toEqual({ checked: 1, released: 1, recorded: 0, unresolved: 0 });
    expect(await guardRows()).toEqual([]);

    // Unclaimed with the guard, so the hold can expire and give the balance back.
    now = new Date(now.getTime() + 600_000);
    expect(await ledger.expireReservations()).toBe(1);
    expect((await ledger.getReservation(hold))?.status).toBe('expired');
    expect((await ledger.getBalance(AGENT, PREFUND))?.availableMicro).toBe(10_000_000n);
  });

  it('records the transfer against the claimed hold when the authorisation was spent', async () => {
    const hold = await claimedHold();
    await ledger.recordPaymentTransaction({ network: NETWORK, payerWallet: PAYER, nonce: NONCE, txHash: TX });
    chain.used = true;
    chain.transfer = { txHash: TX, to: MERCHANT, amountMicro: m(1_000_000) };
    now = new Date(now.getTime() + AFTER_MS + 1_000);

    expect(await pass()).toEqual({ checked: 1, released: 0, recorded: 1, unresolved: 0 });
    expect(chain.lookups).toEqual([TX]);

    const reservation = await ledger.getReservation(hold);
    expect(reservation?.status).toBe('consumed');
    const [guard] = await guardRows();
    expect(guard?.settlement_id).toBe(reservation?.settlementId);
    expect((await ledger.getBalance(AGENT, PREFUND))?.spentMicro).toBe(1_000_000n);
  });

  it('records a direct settlement from the transfer when no hold was claimed', async () => {
    await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce: NONCE, amountMicro: m(1_000_000) });
    chain.used = true;
    chain.transfer = { txHash: TX, to: MERCHANT, amountMicro: m(1_000_000) };
    now = new Date(now.getTime() + AFTER_MS + 1_000);

    expect(await pass()).toMatchObject({ recorded: 1 });
    const settled = await scratch.db.query<{ status: string; merchant_wallet: string; tx_hash: string }>(
      'SELECT status, merchant_wallet, tx_hash FROM bursar_settlements',
    );
    expect(settled.rows).toEqual([{ status: 'settled', merchant_wallet: MERCHANT, tx_hash: TX }]);
    expect((await guardRows())[0]?.settlement_id).not.toBeNull();
  });

  it('prices the transfer for the payee it paid and records the rebate with it', async () => {
    await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce: NONCE, amountMicro: m(1_000_000) });
    chain.used = true;
    chain.transfer = { txHash: TX, to: MERCHANT, amountMicro: m(1_000_000) };
    now = new Date(now.getTime() + AFTER_MS + 1_000);

    expect(await pass({ feeMicro: m(7_000), rebateBps: 3_000, rebateMicro: m(3_000) })).toMatchObject({ recorded: 1 });
    expect(priced).toEqual([MERCHANT]);
    const settled = await scratch.db.query<{ fee_micro: string; rebate_bps: number; rebate_micro: string }>(
      'SELECT fee_micro::text, rebate_bps, rebate_micro::text FROM bursar_settlements',
    );
    expect(settled.rows).toEqual([{ fee_micro: '7000.000000', rebate_bps: 3_000, rebate_micro: '3000.000000' }]);
  });

  it('keeps a spent claim it cannot find the transfer for, and asks again only after the interval', async () => {
    await claimedHold();
    chain.used = true;
    now = new Date(now.getTime() + AFTER_MS + 1_000);

    expect(await pass()).toMatchObject({ checked: 1, unresolved: 1 });
    expect(await guardRows()).toHaveLength(1);
    expect(await pass()).toMatchObject({ checked: 0 });
  });
});
