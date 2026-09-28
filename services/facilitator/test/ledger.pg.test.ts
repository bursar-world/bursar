import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LaneLedger } from '../src/lanes/ledger.js';
import { TrustStore } from '../src/trust/store.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

const m = (value: number | string): Micro => toMicro(value);

const PREFUND = 'prefund-main';
const COLLATERAL = 'collateral-main';
const AGENT = 'agent-1';
const PAYER = '0x1111111111111111111111111111111111111111';
const REPAY = '0x2222222222222222222222222222222222222222';
const MERCHANT = '0x3333333333333333333333333333333333333333';
const ASSET = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NETWORK = 'eip155:4663';
const TREASURY = '0x4444444444444444444444444444444444444444';

describe.skipIf(!TEST_DATABASE_URL)('lane ledger against Postgres', () => {
  let scratch: Scratch;
  let ledger: LaneLedger;
  let trust: TrustStore;
  let now: Date;

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_ledger_test');
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.reset();
    now = new Date('2026-09-11T12:00:00.000Z');
    trust = new TrustStore({ topic: 'mandate.trust.v1', now: () => now });
    ledger = new LaneLedger({ db: scratch.db, trust, currency: 'USDG', now: () => now });

    await ledger.upsertAccount({ agentId: AGENT, payerWallet: PAYER, repayWallet: REPAY, networks: [NETWORK] });
    await ledger.upsertPool({
      poolId: PREFUND,
      lane: 'prefund',
      status: 'active',
      ltvCapBps: 0,
      minHealthFactor: 1.5,
      maxSingleMicro: m(5_000_000),
    });
    await ledger.upsertPool({
      poolId: COLLATERAL,
      lane: 'collateral',
      status: 'active',
      ltvCapBps: 6_000,
      minHealthFactor: 1.5,
      maxSingleMicro: m(2_000_000),
    });
  });

  async function authorize(
    lane: 'prefund' | 'collateral' | 'direct',
    poolId: string,
    amount: Micro,
    nonce: string,
  ): Promise<string> {
    const record = await ledger.recordAuthorization({
      agentId: AGENT,
      payerWallet: PAYER,
      repayWallet: REPAY,
      requestNonce: nonce,
      network: NETWORK,
      lane,
      poolId,
      requestedMicro: amount,
      approved: true,
      approvedMicro: amount,
      availableMicro: amount,
      outstandingMicro: m(0),
    });
    return record.id;
  }

  async function fund(amount: Micro, reference = 'deposit-1'): Promise<void> {
    await ledger.applyFunding({
      agentId: AGENT,
      poolId: PREFUND,
      referenceId: reference,
      amountMicro: amount,
      eventType: 'deposit',
    });
  }

  describe('prefunding', () => {
    it('credits a confirmed deposit and reports it as available', async () => {
      const result = await fund(m(10_000_000));
      const balance = await ledger.getBalance(AGENT, PREFUND);
      expect(balance).toMatchObject({ availableMicro: 10_000_000n, reservedMicro: 0n, spentMicro: 0n });
      expect(result).toBeUndefined();
    });

    it('credits once however many times the same deposit is reported', async () => {
      await fund(m(10_000_000), 'tx-a');
      const replay = await ledger.applyFunding({
        agentId: AGENT,
        poolId: PREFUND,
        referenceId: 'tx-a',
        amountMicro: m(10_000_000),
        eventType: 'deposit',
      });
      expect(replay.idempotent).toBe(true);
      expect((await ledger.getBalance(AGENT, PREFUND))?.availableMicro).toBe(10_000_000n);
    });

    it('refuses a reference that reports a different amount than it did before', async () => {
      await fund(m(10_000_000), 'tx-a');
      await expect(
        ledger.applyFunding({
          agentId: AGENT,
          poolId: PREFUND,
          referenceId: 'tx-a',
          amountMicro: m(20_000_000),
          eventType: 'deposit',
        }),
      ).rejects.toThrow(/funding_reference_conflict|already recorded/);
    });

    it('refuses a withdrawal larger than the balance', async () => {
      await fund(m(1_000_000));
      await expect(
        ledger.applyFunding({
          agentId: AGENT,
          poolId: PREFUND,
          referenceId: 'w-1',
          amountMicro: m(2_000_000),
          eventType: 'withdraw',
        }),
      ).rejects.toThrow(/does not hold/);
      expect((await ledger.getBalance(AGENT, PREFUND))?.availableMicro).toBe(1_000_000n);
    });

    it('refuses to fund a pool that holds no balance', async () => {
      await expect(
        ledger.applyFunding({
          agentId: AGENT,
          poolId: COLLATERAL,
          referenceId: 'x',
          amountMicro: m(1),
          eventType: 'deposit',
        }),
      ).rejects.toThrow(/only a prefund pool/);
    });

    it('queues one trust event per movement', async () => {
      await fund(m(1_000_000), 'd-1');
      await ledger.applyFunding({
        agentId: AGENT,
        poolId: PREFUND,
        referenceId: 'w-1',
        amountMicro: m(400_000),
        eventType: 'withdraw',
      });
      const journal = await trust.readJournal(scratch.db);
      expect(journal.map((entry) => entry.eventType)).toEqual(['prefund_deposited', 'prefund_withdrawn']);
      expect(journal[1]?.payload.amountMicro).toBe('400000');
    });
  });

  describe('reservations', () => {
    it('refuses a decision whose payer is not the account\'s', async () => {
      await fund(m(10_000_000));
      const record = await ledger.recordAuthorization({
        agentId: AGENT,
        payerWallet: '0x5555555555555555555555555555555555555555',
        repayWallet: REPAY,
        requestNonce: 'n-other-payer',
        network: NETWORK,
        lane: 'prefund',
        poolId: PREFUND,
        requestedMicro: m(1_000_000),
        approved: true,
        approvedMicro: m(1_000_000),
        availableMicro: m(1_000_000),
        outstandingMicro: m(0),
      });
      await expect(
        ledger.openReservation({ authorizationId: record.id, merchantWallet: MERCHANT, amountMicro: m(1_000_000), ttlMs: 120_000 }),
      ).rejects.toMatchObject({ code: 'authorization_account_mismatch' });
      expect((await ledger.getBalance(AGENT, PREFUND))?.reservedMicro).toBe(0n);
    });

    it('refuses a decision on a network the account is not enabled for', async () => {
      await fund(m(10_000_000));
      const record = await ledger.recordAuthorization({
        agentId: AGENT,
        payerWallet: PAYER,
        repayWallet: REPAY,
        requestNonce: 'n-other-network',
        network: 'eip155:1',
        lane: 'prefund',
        poolId: PREFUND,
        requestedMicro: m(1_000_000),
        approved: true,
        approvedMicro: m(1_000_000),
        availableMicro: m(1_000_000),
        outstandingMicro: m(0),
      });
      await expect(
        ledger.openReservation({ authorizationId: record.id, merchantWallet: MERCHANT, amountMicro: m(1_000_000), ttlMs: 120_000 }),
      ).rejects.toMatchObject({ code: 'authorization_account_mismatch' });
    });

    it('moves prefunded balance from available to reserved', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(2_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(2_000_000),
        ttlMs: 60_000,
      });

      expect(reservation).toMatchObject({ lane: 'prefund', lockedMicro: 2_000_000n, status: 'reserved' });
      expect(await ledger.getBalance(AGENT, PREFUND)).toMatchObject({
        availableMicro: 8_000_000n,
        reservedMicro: 2_000_000n,
      });
      expect((await ledger.getPoolReserve(PREFUND))?.reservedMicro).toBe(2_000_000n);
    });

    it('refuses a second hold the balance cannot cover', async () => {
      await fund(m(1_000_000));
      const first = await authorize('prefund', PREFUND, m(800_000), 'n-1');
      const second = await authorize('prefund', PREFUND, m(800_000), 'n-2');
      await ledger.openReservation({
        authorizationId: first,
        merchantWallet: MERCHANT,
        amountMicro: m(800_000),
        ttlMs: 60_000,
      });
      await expect(
        ledger.openReservation({
          authorizationId: second,
          merchantWallet: MERCHANT,
          amountMicro: m(800_000),
          ttlMs: 60_000,
        }),
      ).rejects.toThrow(/prefund_insufficient|does not hold/);
      expect(await ledger.getBalance(AGENT, PREFUND)).toMatchObject({
        availableMicro: 200_000n,
        reservedMicro: 800_000n,
      });
    });

    it('refuses to open a call for a suspended account', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000_000), 'n-1');
      await ledger.setAccountStatus(AGENT, 'suspended');

      await expect(
        ledger.openReservation({
          authorizationId: id,
          merchantWallet: MERCHANT,
          amountMicro: m(1_000_000),
          ttlMs: 60_000,
        }),
      ).rejects.toThrow(/is suspended and cannot open a call/);
      expect((await ledger.getBalance(AGENT, PREFUND))?.availableMicro).toBe(10_000_000n);

      await ledger.setAccountStatus(AGENT, 'active');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });
      expect(reservation.status).toBe('reserved');
    });

    it('refuses more than the decision approved', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000_000), 'n-1');
      await expect(
        ledger.openReservation({
          authorizationId: id,
          merchantWallet: MERCHANT,
          amountMicro: m(1_000_001),
          ttlMs: 60_000,
        }),
      ).rejects.toThrow(/approved 1000000/);
    });

    it('refuses more than the pool allows on a single call', async () => {
      await fund(m(100_000_000));
      const id = await authorize('prefund', PREFUND, m(9_000_000), 'n-1');
      await expect(
        ledger.openReservation({
          authorizationId: id,
          merchantWallet: MERCHANT,
          amountMicro: m(9_000_000),
          ttlMs: 60_000,
        }),
      ).rejects.toThrow(/caps a single call/);
    });

    it('gives the hold back when it is released', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(2_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(2_000_000),
        ttlMs: 60_000,
      });

      expect(await ledger.releaseReservation(reservation.id)).toBe(true);
      expect(await ledger.releaseReservation(reservation.id)).toBe(false);
      expect(await ledger.getBalance(AGENT, PREFUND)).toMatchObject({
        availableMicro: 10_000_000n,
        reservedMicro: 0n,
      });
      expect((await ledger.getPoolReserve(PREFUND))?.reservedMicro).toBe(0n);
    });

    it('releases a hold that outlived its window', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(2_000_000), 'n-1');
      await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(2_000_000),
        ttlMs: 60_000,
      });

      now = new Date(now.getTime() + 120_000);
      expect(await ledger.expireReservations()).toBe(1);
      expect(await ledger.getBalance(AGENT, PREFUND)).toMatchObject({
        availableMicro: 10_000_000n,
        reservedMicro: 0n,
      });
    });

    it('refuses to consume a hold that has expired, and hands the funds back', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(2_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(2_000_000),
        ttlMs: 60_000,
      });

      now = new Date(now.getTime() + 120_000);
      await expect(
        ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(0) }),
      ).rejects.toThrow(/expired/);
      expect((await ledger.getBalance(AGENT, PREFUND))?.availableMicro).toBe(10_000_000n);
      expect((await ledger.getReservation(reservation.id))?.status).toBe('expired');
    });
  });

  describe('consuming in the prefund lane', () => {
    async function consume(amount: Micro, nonce = 'n-1') {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, amount, nonce);
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: amount,
        ttlMs: 60_000,
      });
      return ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(1_900) });
    }

    it('refuses a payment that does not pay the hold it is closing', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });

      // Everything the settlement records comes off the reservation. A consume that takes the
      // payment's word for nothing would close this hold against a one-micro transfer to whoever
      // asked, and write a million-micro payment to the merchant with that transfer's hash on it.
      const attacker = '0x9999999999999999999999999999999999999999';
      await expect(
        ledger.consumeReservation({
          reservationId: reservation.id,
          asset: ASSET,
          feeMicro: m(0),
          payment: { amountMicro: m(1), payerWallet: PAYER, merchantWallet: attacker },
        }),
      ).rejects.toThrow(/lane_amount_mismatch|does not pay|moves 1 micro-USD/);

      // Nothing moved: the hold is still open and the balance is still reserved against it.
      expect((await ledger.getReservation(reservation.id))?.status).toBe('reserved');
      expect(await ledger.getBalance(AGENT, PREFUND)).toMatchObject({
        availableMicro: 9_000_000n,
        reservedMicro: 1_000_000n,
        spentMicro: 0n,
      });
    });

    it('takes the payment the hold was opened for', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });

      const result = await ledger.consumeReservation({
        reservationId: reservation.id,
        asset: ASSET,
        feeMicro: m(1_900),
        // Checksummed the way a scheme hands a payer's address back, against a row stored lower.
        payment: {
          amountMicro: m(1_000_000),
          payerWallet: PAYER.toUpperCase().replace('0X', '0x'),
          merchantWallet: MERCHANT,
        },
      });
      expect(result.settlement).toMatchObject({ status: 'authorized', amountMicro: 1_000_000n });
    });

    it('does not deadlock when consumes and releases for one agent overlap', async () => {
      await fund(m(20_000_000));
      const holds = [];
      for (let index = 0; index < 16; index += 1) {
        const id = await authorize('prefund', PREFUND, m(100_000), `hold-${index}`);
        holds.push(
          await ledger.openReservation({
            authorizationId: id,
            merchantWallet: MERCHANT,
            amountMicro: m(100_000),
            ttlMs: 60_000,
          }),
        );
      }

      // Both of these move the pool aggregate and the agent's balance, for the same agent and the
      // same pool. Taking the two in different orders is a cycle Postgres breaks by killing one of
      // the transactions, and the one it kills is somebody's payment.
      const work = holds.map((hold, index) =>
        index % 2 === 0
          ? ledger.consumeReservation({ reservationId: hold.id, asset: ASSET, feeMicro: m(0) })
          : ledger.releaseReservation(hold.id),
      );

      const settled = await Promise.allSettled(work);
      const failures = settled.flatMap((result) =>
        result.status === 'rejected' ? [String((result.reason as Error)?.message ?? result.reason)] : [],
      );
      expect(failures).toEqual([]);
    }, 30_000);

    it('spends the hold and records the payment as authorised, not settled', async () => {
      const result = await consume(m(2_000_000));
      expect(result.settlement).toMatchObject({ status: 'authorized', txHash: null, feeMicro: 1_900n });
      expect(result.debt).toBeNull();
      expect(await ledger.getBalance(AGENT, PREFUND)).toMatchObject({
        availableMicro: 8_000_000n,
        reservedMicro: 0n,
        spentMicro: 2_000_000n,
      });
    });

    it('opens no debt and leaves the pool owing nothing', async () => {
      await consume(m(2_000_000));
      expect(await ledger.outstandingMicro(AGENT)).toBe(0n);
      expect((await ledger.getPoolReserve(PREFUND))?.outstandingMicro).toBe(0n);
    });

    it('returns the same settlement when the consume is retried', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });

      const first = await ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(0) });
      const second = await ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(0) });
      expect(second.settlement.id).toBe(first.settlement.id);
      expect((await ledger.getBalance(AGENT, PREFUND))?.spentMicro).toBe(1_000_000n);
    });

    it('refuses a fee larger than the payment', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000),
        ttlMs: 60_000,
      });
      await expect(
        ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(1_001) }),
      ).rejects.toThrow(/cannot take the whole payment/);
    });

    it('refuses a fee that leaves the merchant nothing', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000),
        ttlMs: 60_000,
      });

      // A call the merchant was paid nothing for is a call that should not have been settled. The
      // fee floor is what produces one, and it belongs to the direct lane, not to this one.
      await expect(
        ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(1_000) }),
      ).rejects.toThrow(/cannot take the whole payment/);
    });

    it('emits the trust event when the merchant is paid, not when the call is authorised', async () => {
      const result = await consume(m(2_000_000));
      expect(await trust.readJournal(scratch.db, { subject: AGENT })).toHaveLength(1);

      const [settled] = await ledger.markSettled({
        settlementIds: [result.settlement.id],
        txHash: `0x${'ab'.repeat(32)}`,
        treasury: TREASURY,
      });

      expect(settled).toMatchObject({ status: 'settled', feeMicro: 1_900n });
      const journal = await trust.readJournal(scratch.db, { subject: AGENT });
      expect(journal.map((entry) => entry.eventType)).toEqual(['prefund_deposited', 'settlement_confirmed']);
      expect(journal[1]?.payload).toMatchObject({
        lane: 'prefund',
        amountMicro: '2000000',
        merchantWallet: MERCHANT,
      });
    });

    it('pays many authorised calls with one transaction', async () => {
      await fund(m(10_000_000));
      const ids: string[] = [];
      for (const nonce of ['n-1', 'n-2', 'n-3']) {
        const authorization = await authorize('prefund', PREFUND, m(1_000_000), nonce);
        const reservation = await ledger.openReservation({
          authorizationId: authorization,
          merchantWallet: MERCHANT,
          amountMicro: m(1_000_000),
          ttlMs: 60_000,
        });
        const consumed = await ledger.consumeReservation({
          reservationId: reservation.id,
          asset: ASSET,
          feeMicro: m(1_900),
        });
        ids.push(consumed.settlement.id);
      }

      const settled = await ledger.markSettled({
        settlementIds: ids,
        txHash: `0x${'cd'.repeat(32)}`,
        treasury: TREASURY,
      });
      expect(settled).toHaveLength(3);
      expect(await ledger.listAuthorizedSettlements(MERCHANT)).toHaveLength(0);

      const fees = await scratch.db.query<{ amount_micro: string }>(
        'SELECT amount_micro::text FROM bursar_fee_ledger',
      );
      expect(fees.rows).toHaveLength(3);
    });

    it('marks a settlement paid once, and refuses the batch that would pay it again', async () => {
      const result = await consume(m(1_000_000));
      const tx = `0x${'ef'.repeat(32)}`;
      expect(await ledger.markSettled({ settlementIds: [result.settlement.id], txHash: tx, treasury: TREASURY })).toHaveLength(1);

      // Silently returning the rows it hit would leave the caller to work out that its transfer
      // covered a settlement somebody else had already paid, which nothing downstream does.
      await expect(
        ledger.markSettled({ settlementIds: [result.settlement.id], txHash: tx, treasury: TREASURY }),
      ).rejects.toThrow(/not awaiting payment/);
    });

    it('refuses the whole batch when one id in it is not awaiting payment, and names it', async () => {
      const paid = await consume(m(1_000_000), 'n-1');
      const waiting = await consume(m(2_000_000), 'n-2');
      const tx = `0x${'ef'.repeat(32)}`;
      await ledger.markSettled({ settlementIds: [paid.settlement.id], txHash: tx, treasury: TREASURY });

      // The transfer covered both, or it covered neither. Marking the one it could and dropping
      // the other leaves a merchant waiting on money that has already been declared paid.
      const batch = ledger.markSettled({
        settlementIds: [paid.settlement.id, waiting.settlement.id],
        txHash: `0x${'ab'.repeat(32)}`,
        treasury: TREASURY,
      });
      await expect(batch).rejects.toThrow(paid.settlement.id);

      const still = await ledger.listAuthorizedSettlements(MERCHANT);
      expect(still.map((settlement) => settlement.id)).toEqual([waiting.settlement.id]);
    });

    it('refuses a batch naming a settlement that does not exist', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      await expect(
        ledger.markSettled({ settlementIds: [missing], txHash: `0x${'ef'.repeat(32)}`, treasury: TREASURY }),
      ).rejects.toThrow(missing);
    });
  });

  describe('the collateral lane', () => {
    async function post(amount: Micro, reference = 'c-1'): Promise<void> {
      await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'usdg-rhc',
        referenceId: reference,
        amountMicro: amount,
        eventType: 'deposit',
      });
    }

    async function borrow(amount: Micro, nonce: string): Promise<{ settlementId: string; debtId: string }> {
      const authorization = await authorize('collateral', COLLATERAL, amount, nonce);
      const reservation = await ledger.openReservation({
        authorizationId: authorization,
        merchantWallet: MERCHANT,
        amountMicro: amount,
        ttlMs: 60_000,
      });
      const consumed = await ledger.consumeReservation({
        reservationId: reservation.id,
        asset: ASSET,
        feeMicro: m(0),
      });
      if (!consumed.debt) throw new Error('the collateral lane must open a debt');
      return { settlementId: consumed.settlement.id, debtId: consumed.debt.id };
    }

    it('counts posted collateral as backing', async () => {
      await post(m(5_000_000));
      const summary = await ledger.getCollateralSummary(AGENT, COLLATERAL);
      expect(summary).toMatchObject({
        totalAvailableMicro: 5_000_000n,
        effectiveCollateralMicro: 5_000_000n,
        outstandingMicro: 0n,
        ltvBps: 0,
        healthFactor: null,
      });
    });

    it('records a deposit once however many times it is reported', async () => {
      await post(m(5_000_000), 'c-1');
      const replay = await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'usdg-rhc',
        referenceId: 'c-1',
        amountMicro: m(5_000_000),
        eventType: 'deposit',
      });
      expect(replay.idempotent).toBe(true);
      expect(replay.position.depositedMicro).toBe(5_000_000n);
    });

    it('refuses a withdrawal of collateral that is not there', async () => {
      await post(m(1_000_000));
      await expect(
        ledger.applyCollateral({
          agentId: AGENT,
          poolId: COLLATERAL,
          collateralAccount: '0xc0113',
          assetId: 'usdg-rhc',
          referenceId: 'w-1',
          amountMicro: m(2_000_000),
          eventType: 'withdraw',
        }),
      ).rejects.toThrow(/does not hold/);
    });

    it('refuses collateral in an asset nobody has argued a haircut for', async () => {
      await expect(
        ledger.applyCollateral({
          agentId: AGENT,
          poolId: COLLATERAL,
          collateralAccount: '0xc0113',
          assetId: 'some-memecoin',
          referenceId: 'c-1',
          amountMicro: m(1),
          eventType: 'deposit',
        }),
      ).rejects.toThrow(/not accepted as collateral/);
    });

    it('refuses collateral against a pool that lends nothing', async () => {
      await expect(
        ledger.applyCollateral({
          agentId: AGENT,
          poolId: PREFUND,
          collateralAccount: '0xc0113',
          assetId: 'usdg-rhc',
          referenceId: 'c-1',
          amountMicro: m(1),
          eventType: 'deposit',
        }),
      ).rejects.toThrow(/settles against funds already held/);
    });

    it('opens a debt and moves the position health with it', async () => {
      await post(m(5_000_000));
      await borrow(m(1_500_000), 'n-1');

      expect(await ledger.outstandingMicro(AGENT, COLLATERAL)).toBe(1_500_000n);
      const summary = await ledger.getCollateralSummary(AGENT, COLLATERAL);
      expect(summary.ltvBps).toBe(3_000);
      expect(summary.healthFactor).toBeCloseTo(2, 5);
      expect((await ledger.getPoolReserve(COLLATERAL))?.outstandingMicro).toBe(1_500_000n);
    });

    it('locks the collateral a debt draws on, so it cannot be withdrawn from under it', async () => {
      await post(m(5_000_000));
      await borrow(m(1_000_000), 'n-1');

      const position = (await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'usdg-rhc',
        referenceId: 'probe',
        amountMicro: m(1),
        eventType: 'deposit',
      })).position;
      expect(position.lockedMicro).toBe(1_000_000n);

      await expect(
        ledger.applyCollateral({
          agentId: AGENT,
          poolId: COLLATERAL,
          collateralAccount: '0xc0113',
          assetId: 'usdg-rhc',
          referenceId: 'w-all',
          amountMicro: m(5_000_001),
          eventType: 'withdraw',
        }),
      ).rejects.toThrow(/does not hold/);

      // Everything above the debt is still the agent's to take back.
      const withdrawn = await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'usdg-rhc',
        referenceId: 'w-free',
        amountMicro: m(4_000_001),
        eventType: 'withdraw',
      });
      expect(withdrawn.idempotent).toBe(false);
    });

    it('locks the posted amount grossed up by the asset haircut', async () => {
      await scratch.db.query(
        `INSERT INTO bursar_collateral_assets (asset_id, symbol, chain, haircut_bps, volatility_buffer_bps, status)
         VALUES ('weth-rhc', 'WETH', 'robinhood-chain', 2000, 0, 'active')
         ON CONFLICT (asset_id) DO NOTHING`,
      );
      await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'weth-rhc',
        referenceId: 'c-weth',
        amountMicro: m(5_000_000),
        eventType: 'deposit',
      });

      await borrow(m(1_000_000), 'n-1');

      // A fifth of the posted value is discounted, so backing 1.000000 of debt consumes 1.250000.
      const locked = await scratch.db.query<{ locked_micro: string }>(
        `SELECT locked_micro::text FROM bursar_collateral_positions WHERE asset_id = 'weth-rhc'`,
      );
      expect(locked.rows[0]?.locked_micro).toBe('1250000.000000');

      await expect(
        ledger.applyCollateral({
          agentId: AGENT,
          poolId: COLLATERAL,
          collateralAccount: '0xc0113',
          assetId: 'weth-rhc',
          referenceId: 'w-1',
          amountMicro: m(3_750_001),
          eventType: 'withdraw',
        }),
      ).rejects.toThrow(/does not hold/);
    });

    it('keeps the lock in place while a debt is only part repaid', async () => {
      await post(m(5_000_000));
      await borrow(m(1_000_000), 'n-1');
      await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-part',
        amountMicro: m(400_000),
        source: 'transfer',
      });

      await expect(
        ledger.applyCollateral({
          agentId: AGENT,
          poolId: COLLATERAL,
          collateralAccount: '0xc0113',
          assetId: 'usdg-rhc',
          referenceId: 'w-1',
          amountMicro: m(4_500_000),
          eventType: 'withdraw',
        }),
      ).rejects.toThrow(/does not hold/);
    });

    it('gives the collateral back when the debt is met', async () => {
      await post(m(5_000_000));
      await borrow(m(1_000_000), 'n-1');
      await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-full',
        amountMicro: m(1_000_000),
        source: 'transfer',
      });

      const result = await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'usdg-rhc',
        referenceId: 'w-1',
        amountMicro: m(5_000_000),
        eventType: 'withdraw',
      });
      expect(result.position.lockedMicro).toBe(0n);
      expect(result.summary.totalAvailableMicro).toBe(0n);
    });

    it('locks once however many times the consume is retried', async () => {
      await post(m(5_000_000));
      const authorization = await authorize('collateral', COLLATERAL, m(1_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: authorization,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });
      await ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(0) });
      await ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(0) });

      const rows = await scratch.db.query<{ locked_micro: string }>(
        'SELECT locked_micro::text FROM bursar_collateral_positions',
      );
      expect(rows.rows[0]?.locked_micro).toBe('1000000.000000');
    });

    it('measures health against everything posted, not only the part still free', async () => {
      await post(m(5_000_000));
      await borrow(m(1_000_000), 'n-1');

      const summary = await ledger.getCollateralSummary(AGENT, COLLATERAL);
      expect(summary.effectiveCollateralMicro).toBe(5_000_000n);
      expect(summary.totalAvailableMicro).toBe(4_000_000n);
      expect(summary.ltvBps).toBe(2_000);
    });

    it('refuses a draw past what the posted collateral supports at the pool cap', async () => {
      await post(m(1_000_000));
      const authorization = await authorize('collateral', COLLATERAL, m(700_000), 'n-1');
      await expect(
        ledger.openReservation({
          authorizationId: authorization,
          merchantWallet: MERCHANT,
          amountMicro: m(700_000),
          ttlMs: 60_000,
        }),
      ).rejects.toThrow(/can draw 600000 micro-USD more/);
    });

    it('refuses a draw that would leave the position under the pool minimum health factor', async () => {
      // 1.800000 of borrowing room against 3.000000 posted, so the draw is inside the cap and the
      // health factor it would leave, 1.2, is what blocks it.
      await post(m(3_000_000));
      const authorization = await authorize('collateral', COLLATERAL, m(1_500_000), 'n-1');
      await expect(
        ledger.openReservation({
          authorizationId: authorization,
          merchantWallet: MERCHANT,
          amountMicro: m(1_500_000),
          ttlMs: 60_000,
        }),
      ).rejects.toThrow(/health factor of 1\.200000/);
    });

    it('counts a hold that has not reported back against the next draw', async () => {
      await post(m(5_000_000));
      const first = await authorize('collateral', COLLATERAL, m(2_000_000), 'n-1');
      await ledger.openReservation({
        authorizationId: first,
        merchantWallet: MERCHANT,
        amountMicro: m(2_000_000),
        ttlMs: 60_000,
      });

      const second = await authorize('collateral', COLLATERAL, m(1_500_000), 'n-2');
      await expect(
        ledger.openReservation({
          authorizationId: second,
          merchantWallet: MERCHANT,
          amountMicro: m(1_500_000),
          ttlMs: 60_000,
        }),
      ).rejects.toThrow(/can draw 1000000 micro-USD more/);
    });

    it('refuses to withdraw the collateral an approved call is still drawing against', async () => {
      await post(m(5_000_000));
      const authorization = await authorize('collateral', COLLATERAL, m(1_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: authorization,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });

      // A hold locks nothing on the position: the collateral behind a draw is only locked when the
      // call reports back and the debt opens. So the guard inside the withdrawal UPDATE, which
      // reads `locked_micro`, cannot see this draw at all.
      await expect(
        ledger.applyCollateral({
          agentId: AGENT,
          poolId: COLLATERAL,
          collateralAccount: '0xc0113',
          assetId: 'usdg-rhc',
          referenceId: 'w-1',
          amountMicro: m(5_000_000),
          eventType: 'withdraw',
        }),
      ).rejects.toThrow(/drawn or held/);

      const consumed = await ledger.consumeReservation({
        reservationId: reservation.id,
        asset: ASSET,
        feeMicro: m(0),
      });
      expect(consumed.debt?.outstandingMicro).toBe(1_000_000n);
      expect((await ledger.getCollateralSummary(AGENT, COLLATERAL)).totalAvailableMicro).toBe(4_000_000n);
    });

    it('lets an agent take back what nothing is drawing against', async () => {
      await post(m(5_000_000));
      const authorization = await authorize('collateral', COLLATERAL, m(1_000_000), 'n-1');
      await ledger.openReservation({
        authorizationId: authorization,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });

      const result = await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'usdg-rhc',
        referenceId: 'w-1',
        amountMicro: m(2_000_000),
        eventType: 'withdraw',
      });
      expect(result.position.withdrawnMicro).toBe(2_000_000n);
    });

    it('applies a repayment to the oldest debt first', async () => {
      await post(m(10_000_000));
      const first = await borrow(m(1_000_000), 'n-1');
      now = new Date(now.getTime() + 1_000);
      const second = await borrow(m(2_000_000), 'n-2');

      const result = await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-1',
        amountMicro: m(1_500_000),
        source: 'transfer',
      });

      expect(result.repayment.appliedMicro).toBe(1_500_000n);
      expect(result.outstandingMicro).toBe(1_500_000n);

      const debts = await scratch.db.query<{ id: string; status: string; outstanding_micro: string }>(
        'SELECT id::text, status, outstanding_micro::bigint::text AS outstanding_micro FROM bursar_debts WHERE agent_id = $1',
        [AGENT],
      );
      const byId = new Map(debts.rows.map((debt) => [debt.id, debt]));
      expect(byId.get(first.debtId)).toMatchObject({ status: 'closed', outstanding_micro: '0' });
      expect(byId.get(second.debtId)).toMatchObject({ status: 'open', outstanding_micro: '1500000' });
    });

    it('records money that arrives with no debt left to meet', async () => {
      await post(m(10_000_000));
      await borrow(m(1_000_000), 'n-1');

      const result = await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-1',
        amountMicro: m(3_000_000),
        source: 'transfer',
      });

      expect(result.repayment).toMatchObject({ amountMicro: 3_000_000n, appliedMicro: 1_000_000n });
      expect(result.outstandingMicro).toBe(0n);
    });

    it('lists a repayment under the pool it was sent to when nothing was owed there', async () => {
      const result = await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-1',
        amountMicro: m(1_000_000),
        source: 'transfer',
        poolId: COLLATERAL,
      });

      expect(result.repayment).toMatchObject({ appliedMicro: 0n, debtId: null, poolId: COLLATERAL });
      const history = await ledger.listTransactions(AGENT);
      expect(history.find((entry) => entry.type === 'repayment')).toMatchObject({ poolId: COLLATERAL });
    });

    it('applies a repayment once however many times it is reported', async () => {
      await post(m(10_000_000));
      await borrow(m(1_000_000), 'n-1');

      const first = await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-1',
        amountMicro: m(400_000),
        source: 'transfer',
      });
      const second = await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-1',
        amountMicro: m(400_000),
        source: 'transfer',
      });

      expect(first.idempotent).toBe(false);
      expect(second.idempotent).toBe(true);
      expect(second.outstandingMicro).toBe(600_000n);
    });

    it('brings the pool balance back down as debts close', async () => {
      await post(m(10_000_000));
      await borrow(m(1_000_000), 'n-1');
      await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-1',
        amountMicro: m(1_000_000),
        source: 'transfer',
      });
      expect((await ledger.getPoolReserve(COLLATERAL))?.outstandingMicro).toBe(0n);
      expect((await ledger.getCollateralSummary(AGENT, COLLATERAL)).healthFactor).toBeNull();
    });

    it('reports every movement to the trust layer once', async () => {
      await post(m(5_000_000));
      await borrow(m(1_000_000), 'n-1');
      await ledger.applyRepayment({
        agentId: AGENT,
        referenceId: 'repay-1',
        amountMicro: m(1_000_000),
        source: 'transfer',
      });
      await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'usdg-rhc',
        referenceId: 'w-1',
        amountMicro: m(2_000_000),
        eventType: 'withdraw',
      });

      const journal = await trust.readJournal(scratch.db, { subject: AGENT });
      expect(journal.map((entry) => entry.eventType)).toEqual([
        'collateral_deposited',
        'repayment_received',
        'collateral_withdrawn',
      ]);
    });
  });

  describe('the boundary around credit', () => {
    it('will not open a debt outside the collateral lane', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });
      const consumed = await ledger.consumeReservation({
        reservationId: reservation.id,
        asset: ASSET,
        feeMicro: m(0),
      });
      expect(consumed.debt).toBeNull();

      await expect(
        scratch.db.query(
          `INSERT INTO bursar_debts (
             agent_id, payer_wallet, repay_wallet, network, lane, pool_id,
             settlement_id, principal_micro, outstanding_micro
           )
           VALUES ($1,$2,$3,$4,'prefund',$5,$6::uuid,1,1)`,
          [AGENT, PAYER, REPAY, NETWORK, PREFUND, consumed.settlement.id],
        ),
      ).rejects.toThrow(/chk_debts_collateral_lane_only/);
    });

    it('will not let a pool outside the collateral lane carry a borrowing cap', async () => {
      await expect(
        ledger.upsertPool({
          poolId: 'bad',
          lane: 'prefund',
          status: 'active',
          ltvCapBps: 6_000,
          minHealthFactor: 1.5,
          maxSingleMicro: m(1),
        }),
      ).rejects.toThrow(/settles against funds already held/);
    });
  });

  describe('the replay guard', () => {
    it('claims an authorisation nonce once', async () => {
      const nonce = `0x${'7e'.repeat(32)}`;
      expect(await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce, amountMicro: m(1) })).toBe(true);
      expect(await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce, amountMicro: m(1) })).toBe(false);
    });

    it('matches a nonce whatever case it arrives in', async () => {
      const nonce = `0x${'AB'.repeat(32)}`;
      await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER.toUpperCase(), nonce, amountMicro: m(1) });
      expect(
        await ledger.claimPaymentNonce({
          network: NETWORK,
          payerWallet: PAYER.toLowerCase(),
          nonce: nonce.toLowerCase(),
          amountMicro: m(1),
        }),
      ).toBe(false);
    });

    it('points the guard row at the settlement whatever case the nonce arrived in', async () => {
      const nonce = `0x${'AB'.repeat(32)}`;
      await ledger.claimPaymentNonce({
        network: NETWORK,
        payerWallet: PAYER,
        nonce,
        amountMicro: m(1_000_000),
      });
      const settlement = await ledger.recordDirectSettlement({
        network: NETWORK,
        asset: ASSET,
        payerWallet: PAYER,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        feeMicro: m(1_900),
        txHash: `0x${'11'.repeat(32)}`,
        nonce,
        treasury: TREASURY,
      });

      // A settled payment whose guard row carries neither a settlement nor a hash is a payment
      // nothing can be reconciled against.
      const guard = await scratch.db.query<{ settlement_id: string | null; tx_hash: string | null }>(
        'SELECT settlement_id::text, tx_hash FROM bursar_payment_guard WHERE nonce = $1',
        [nonce.toLowerCase()],
      );
      expect(guard.rows[0]).toMatchObject({ settlement_id: settlement.id, tx_hash: `0x${'11'.repeat(32)}` });
    });

    it('writes the transaction onto the guard row when nothing else could record it', async () => {
      const nonce = `0x${'7e'.repeat(32)}`;
      await ledger.claimPaymentNonce({
        network: NETWORK,
        payerWallet: PAYER,
        nonce,
        amountMicro: m(1_000_000),
      });
      await ledger.recordPaymentTransaction({
        network: NETWORK,
        payerWallet: PAYER,
        nonce,
        txHash: `0x${'22'.repeat(32)}`,
      });

      const guard = await scratch.db.query<{ tx_hash: string | null }>(
        'SELECT tx_hash FROM bursar_payment_guard WHERE nonce = $1',
        [nonce],
      );
      expect(guard.rows[0]?.tx_hash).toBe(`0x${'22'.repeat(32)}`);
    });

    it('stamps the settlement on the paying wallet\'s row and leaves the other payer alone', async () => {
      // One nonce, two payers. A payload carrying no binding object derives its nonce from the
      // request digest and an all-zero salt, so two agents paying for the same request arrive
      // holding the same one, and the guard is keyed on the payer precisely so they can.
      const nonce = `0x${'7e'.repeat(32)}`;
      const other = '0x5555555555555555555555555555555555555555';
      for (const wallet of [PAYER, other]) {
        expect(
          await ledger.claimPaymentNonce({
            network: NETWORK,
            payerWallet: wallet,
            nonce,
            amountMicro: m(1_000_000),
          }),
        ).toBe(true);
      }

      const settlement = await ledger.recordDirectSettlement({
        network: NETWORK,
        asset: ASSET,
        payerWallet: PAYER,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        feeMicro: m(1_900),
        txHash: `0x${'11'.repeat(32)}`,
        nonce,
        treasury: TREASURY,
      });

      const rows = await scratch.db.query<{ payer_wallet: string; settlement_id: string | null }>(
        'SELECT payer_wallet, settlement_id::text FROM bursar_payment_guard WHERE nonce = $1 ORDER BY payer_wallet',
        [nonce],
      );
      expect(rows.rows).toEqual([
        { payer_wallet: PAYER.toLowerCase(), settlement_id: settlement.id },
        { payer_wallet: other.toLowerCase(), settlement_id: null },
      ]);

      // Stamping the other payer's row would make `releasePaymentNonce` refuse to release it, and
      // that payer could never use the nonce again.
      await ledger.releasePaymentNonce(NETWORK, other, nonce);
      expect(
        await ledger.claimPaymentNonce({
          network: NETWORK,
          payerWallet: other,
          nonce,
          amountMicro: m(1),
        }),
      ).toBe(true);
    });

    it('gives a claim back when nothing was broadcast', async () => {
      const nonce = `0x${'7e'.repeat(32)}`;
      await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce, amountMicro: m(1) });
      await ledger.releasePaymentNonce(NETWORK, PAYER, nonce);
      expect(await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce, amountMicro: m(1) })).toBe(true);
    });

    it('keeps a claim that already named a settlement', async () => {
      const nonce = `0x${'7e'.repeat(32)}`;
      await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce, amountMicro: m(1_000_000) });
      await ledger.recordDirectSettlement({
        network: NETWORK,
        asset: ASSET,
        payerWallet: PAYER,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        feeMicro: m(1_900),
        txHash: `0x${'11'.repeat(32)}`,
        nonce,
        treasury: TREASURY,
      });
      await ledger.releasePaymentNonce(NETWORK, PAYER, nonce);
      expect(await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce, amountMicro: m(1) })).toBe(false);
    });
  });

  describe('settle claims', () => {
    const NONCE = `0x${'7e'.repeat(32)}`;
    const TX = `0x${'11'.repeat(32)}`;
    const MARGIN = 60_000;

    async function heldAndGuarded(ttlMs = 120_000): Promise<string> {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000_000), 'n-claim');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs,
      });
      await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce: NONCE, amountMicro: m(1_000_000) });
      return reservation.id;
    }

    function claimFor(reservationId: string, nonce = NONCE, payerWallet = PAYER) {
      return ledger.claimReservation({ reservationId, network: NETWORK, payerWallet, nonce, minRemainingMs: MARGIN });
    }

    it('lets one settle claim a hold, and refuses the next', async () => {
      const held = await heldAndGuarded();
      const other = `0x${'7f'.repeat(32)}`;
      await ledger.claimPaymentNonce({ network: NETWORK, payerWallet: PAYER, nonce: other, amountMicro: m(1_000_000) });

      const [first, second] = await Promise.all([claimFor(held), claimFor(held, other)]);
      expect([first, second].filter((claim) => claim !== null)).toHaveLength(1);
    });

    it('refuses to claim a hold that lapses within the receipt wait', async () => {
      const held = await heldAndGuarded(90_000);
      now = new Date(now.getTime() + 31_000);
      expect(await claimFor(held)).toBeNull();
    });

    it('does not expire a claimed hold, and does not release it on request', async () => {
      const held = await heldAndGuarded();
      expect(await claimFor(held)).not.toBeNull();

      // The receipt wait outlasts the hold. Expiring it here hands the balance back to the payer
      // while the transfer that pays for it lands.
      now = new Date(now.getTime() + 600_000);
      expect(await ledger.expireReservations()).toBe(0);
      expect(await ledger.releaseReservation(held)).toBe(false);
      expect((await ledger.getReservation(held))?.status).toBe('reserved');
      expect((await ledger.getBalance(AGENT, PREFUND))?.reservedMicro).toBe(1_000_000n);
    });

    it('consumes a claimed hold only for its claim, however late', async () => {
      const held = await heldAndGuarded();
      const claim = await claimFor(held);
      if (!claim) throw new Error('claim refused');

      await expect(
        ledger.consumeReservation({ reservationId: held, asset: ASSET, feeMicro: m(0) }),
      ).rejects.toMatchObject({ code: 'reservation_claimed' });

      now = new Date(now.getTime() + 600_000);
      const result = await ledger.settleReservation({
        reservationId: held,
        claim,
        asset: ASSET,
        feeMicro: m(1_900),
        payment: { amountMicro: m(1_000_000), payerWallet: PAYER, merchantWallet: MERCHANT },
        txHash: TX,
        treasury: TREASURY,
      });
      expect(result.settlement).toMatchObject({ status: 'settled', txHash: TX });
      expect(result.reservation.status).toBe('consumed');
    });

    it('unclaims the hold when the guard is given back', async () => {
      const held = await heldAndGuarded();
      expect(await claimFor(held)).not.toBeNull();
      await ledger.releasePaymentNonce(NETWORK, PAYER, NONCE);

      now = new Date(now.getTime() + 600_000);
      expect(await ledger.expireReservations()).toBe(1);
    });

    it('consumes and marks paid in one transaction, so a netting run never sees it authorised', async () => {
      const held = await heldAndGuarded();
      const claim = await claimFor(held);
      if (!claim) throw new Error('claim refused');

      const settled = await ledger.settleReservation({
        reservationId: held,
        claim,
        asset: ASSET,
        feeMicro: m(1_900),
        txHash: TX,
        treasury: TREASURY,
      });
      expect(await ledger.listAuthorizedSettlements(MERCHANT)).toEqual([]);

      const guard = await scratch.db.query<{ settlement_id: string | null; tx_hash: string | null }>(
        'SELECT settlement_id::text, tx_hash FROM bursar_payment_guard WHERE nonce = $1',
        [NONCE],
      );
      expect(guard.rows[0]).toEqual({ settlement_id: settled.settlement.id, tx_hash: TX });
    });

    it('rolls the consume back when marking it paid fails', async () => {
      const held = await heldAndGuarded();
      const claim = await claimFor(held);
      if (!claim) throw new Error('claim refused');

      // A null treasury fails the fee row, which is written after the consume. Separate
      // transactions would leave the settlement authorised and unpaid with its transfer landed.
      await expect(
        ledger.settleReservation({
          reservationId: held,
          claim,
          asset: ASSET,
          feeMicro: m(1_900),
          txHash: TX,
          treasury: null as unknown as string,
        }),
      ).rejects.toThrow();
      expect((await ledger.getReservation(held))?.status).toBe('reserved');
      expect(await ledger.listAuthorizedSettlements(MERCHANT)).toEqual([]);
    });
  });

  describe('direct settlement', () => {
    it('records a payment that already moved, with its hash', async () => {
      const settlement = await ledger.recordDirectSettlement({
        network: NETWORK,
        asset: ASSET,
        payerWallet: PAYER,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        feeMicro: m(1_900),
        txHash: `0x${'11'.repeat(32)}`,
        nonce: `0x${'7e'.repeat(32)}`,
        treasury: TREASURY,
      });
      expect(settlement).toMatchObject({ status: 'settled', amountMicro: 1_000_000n });
      expect(settlement.settledAt).not.toBeNull();
    });

    it('records one transaction once', async () => {
      const input = {
        network: NETWORK,
        asset: ASSET,
        payerWallet: PAYER,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        feeMicro: m(1_900),
        txHash: `0x${'11'.repeat(32)}`,
        nonce: `0x${'7e'.repeat(32)}`,
        treasury: TREASURY,
      };
      const first = await ledger.recordDirectSettlement(input);
      const second = await ledger.recordDirectSettlement(input);
      expect(second.id).toBe(first.id);
    });

    it('keeps two payers holding the same nonce apart', async () => {
      // Keyed on the network alone, the second payer's transfer collided with the first's and came
      // back as the first payer's settlement: money moved and nothing recorded it.
      const nonce = `0x${'7e'.repeat(32)}`;
      const other = '0x5555555555555555555555555555555555555555';
      const base = {
        network: NETWORK,
        asset: ASSET,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        feeMicro: m(1_900),
        nonce,
        treasury: TREASURY,
      };
      const first = await ledger.recordDirectSettlement({ ...base, payerWallet: PAYER, txHash: `0x${'11'.repeat(32)}` });
      const second = await ledger.recordDirectSettlement({ ...base, payerWallet: other, txHash: `0x${'22'.repeat(32)}` });

      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({ payerWallet: other, txHash: `0x${'22'.repeat(32)}` });

      // A checksummed spelling of the first payer is still the first payer.
      const retried = await ledger.recordDirectSettlement({
        ...base,
        payerWallet: PAYER.toUpperCase().replace('0X', '0x'),
        txHash: `0x${'11'.repeat(32)}`,
      });
      expect(retried.id).toBe(first.id);
    });

    it('writes the fee and the trust event on the settlement\'s own transaction', async () => {
      const settlement = await ledger.recordDirectSettlement({
        network: NETWORK,
        asset: ASSET,
        payerWallet: PAYER,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        feeMicro: m(1_900),
        txHash: `0x${'11'.repeat(32)}`,
        nonce: `0x${'7e'.repeat(32)}`,
        treasury: TREASURY,
      });

      // Announcing on a second transaction leaves a payment that landed with no event and no fee
      // row whenever the process dies in between, which is the one thing the outbox exists to stop.
      const journal = await trust.readJournal(scratch.db, { subject: PAYER });
      expect(journal).toHaveLength(1);
      expect(journal[0]?.payload).toMatchObject({ settlementId: settlement.id, lane: 'direct' });

      const fees = await scratch.db.query<{ amount_micro: string; treasury: string }>(
        'SELECT amount_micro::text, treasury FROM bursar_fee_ledger WHERE settlement_id = $1::uuid',
        [settlement.id],
      );
      expect(fees.rows).toHaveLength(1);
      expect(fees.rows[0]?.treasury).toBe(TREASURY);
    });

    it('reports it to the trust layer under the payer when there is no account', async () => {
      const settlement = await ledger.recordDirectSettlement({
        network: NETWORK,
        asset: ASSET,
        payerWallet: PAYER,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        feeMicro: m(1_900),
        txHash: `0x${'11'.repeat(32)}`,
        nonce: `0x${'7e'.repeat(32)}`,
        treasury: TREASURY,
      });
      expect(settlement.status).toBe('settled');

      const journal = await trust.readJournal(scratch.db, { subject: PAYER });
      expect(journal).toHaveLength(1);
      expect(journal[0]?.payload).toMatchObject({ lane: 'direct', poolId: 'direct' });
    });
  });

  describe('statements', () => {
    it('shows a prefunded account its balance and no debt', async () => {
      await fund(m(3_000_000));
      const statement = await ledger.statement(AGENT, PREFUND);
      expect(statement).toMatchObject({ lane: 'prefund', outstandingMicro: 0n, collateral: null });
      expect(statement.balance?.availableMicro).toBe(3_000_000n);
    });

    it('shows a collateral account its backing', async () => {
      await ledger.applyCollateral({
        agentId: AGENT,
        poolId: COLLATERAL,
        collateralAccount: '0xc0113',
        assetId: 'usdg-rhc',
        referenceId: 'c-1',
        amountMicro: m(4_000_000),
        eventType: 'deposit',
      });
      const statement = await ledger.statement(AGENT, COLLATERAL);
      expect(statement).toMatchObject({ lane: 'collateral', balance: null });
      expect(statement.collateral?.effectiveCollateralMicro).toBe(4_000_000n);
    });

    it('lists funding, debt, repayment and settlement in one history', async () => {
      await fund(m(10_000_000));
      const id = await authorize('prefund', PREFUND, m(1_000_000), 'n-1');
      const reservation = await ledger.openReservation({
        authorizationId: id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });
      await ledger.consumeReservation({ reservationId: reservation.id, asset: ASSET, feeMicro: m(0) });

      const history = await ledger.listTransactions(AGENT);
      expect(history.map((entry) => entry.type).sort()).toEqual(['funding', 'settlement']);
    });

    it('refuses a statement for an account that does not exist', async () => {
      await expect(ledger.statement('nobody', PREFUND)).rejects.toThrow(/account_not_found|no account/);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('concurrency', () => {
  let scratch: Scratch;
  let ledger: LaneLedger;

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_concurrency_test');
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.reset();
    ledger = new LaneLedger({
      db: scratch.db,
      trust: new TrustStore({ topic: 'mandate.trust.v1' }),
      currency: 'USDG',
    });
    await ledger.upsertAccount({ agentId: AGENT, payerWallet: PAYER, repayWallet: REPAY });
    await ledger.upsertPool({
      poolId: PREFUND,
      lane: 'prefund',
      status: 'active',
      ltvCapBps: 0,
      minHealthFactor: 1.5,
      maxSingleMicro: m(5_000_000),
    });
  });

  it('credits one deposit once when the same reference arrives twice at the same moment', async () => {
    const deposit = () =>
      ledger.applyFunding({
        agentId: AGENT,
        poolId: PREFUND,
        referenceId: 'tx-a',
        amountMicro: m(1_000_000),
        eventType: 'deposit',
      });

    const [first, second] = await Promise.all([deposit(), deposit()]);
    expect([first.idempotent, second.idempotent].filter(Boolean)).toHaveLength(1);
    expect((await ledger.getBalance(AGENT, PREFUND))?.availableMicro).toBe(1_000_000n);
  });

  it('opens one hold when the same request is reserved twice at the same moment', async () => {
    await ledger.applyFunding({
      agentId: AGENT,
      poolId: PREFUND,
      referenceId: 'tx-a',
      amountMicro: m(5_000_000),
      eventType: 'deposit',
    });
    const authorization = await ledger.recordAuthorization({
      agentId: AGENT,
      payerWallet: PAYER,
      repayWallet: REPAY,
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

    const open = () =>
      ledger.openReservation({
        authorizationId: authorization.id,
        merchantWallet: MERCHANT,
        amountMicro: m(1_000_000),
        ttlMs: 60_000,
      });

    const results = await Promise.allSettled([open(), open()]);
    const opened = results.filter((result) => result.status === 'fulfilled');
    expect(opened.length).toBeGreaterThanOrEqual(1);
    expect((await ledger.getBalance(AGENT, PREFUND))?.reservedMicro).toBe(1_000_000n);
  });
});
