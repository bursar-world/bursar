import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LaneLedger } from '../src/lanes/ledger.js';
import { fromAccountTuple } from '../src/lanes/onchain-collateral.js';
import type { OnchainCollateral, OnchainCollateralReader } from '../src/lanes/onchain-collateral.js';
import { TrustStore } from '../src/trust/store.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

const m = (value: number | string): Micro => toMicro(value);

const COLLATERAL = 'collateral-main';
const AGENT = 'agent-1';
const PAYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x3333333333333333333333333333333333333333';
const MANDATE = '0x4686C3566E1C50b4cC14c37A1088b7892d7D7407';
const NETWORK = 'eip155:4663';

class FakeVault implements OnchainCollateralReader {
  reads: string[] = [];
  constructor(public position: OnchainCollateral) {}
  async read(mandate: `0x${string}`): Promise<OnchainCollateral> {
    this.reads.push(mandate);
    return this.position;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('collateral lane read from chain', () => {
  let scratch: Scratch;
  let ledger: LaneLedger;
  let vault: FakeVault;
  const now = new Date('2026-09-29T12:00:00.000Z');

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_onchain_collateral_test');
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.reset();
    vault = new FakeVault(fromAccountTuple(MANDATE, [49_808n, 39_846n, 20_001n, 11_875n, 1_992_200_389_980_500_974n]));
    const trust = new TrustStore({ topic: 'mandate.trust.v1', now: () => now });
    ledger = new LaneLedger({ db: scratch.db, trust, currency: 'USDG', now: () => now, onchainCollateral: vault });
    await ledger.upsertAccount({
      agentId: AGENT,
      payerWallet: PAYER,
      repayWallet: PAYER,
      mandateAccount: MANDATE,
      networks: [NETWORK],
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

  async function reserve(amount: Micro, nonce: string) {
    const record = await ledger.recordAuthorization({
      agentId: AGENT,
      payerWallet: PAYER,
      repayWallet: PAYER,
      requestNonce: nonce,
      network: NETWORK,
      lane: 'collateral',
      poolId: COLLATERAL,
      requestedMicro: amount,
      approved: true,
      approvedMicro: amount,
      availableMicro: amount,
      outstandingMicro: m(0),
    });
    return ledger.openReservation({ authorizationId: record.id, merchantWallet: MERCHANT, amountMicro: amount, ttlMs: 120_000 });
  }

  it('reports the vault figures for an account with a mandate', async () => {
    const summary = await ledger.getCollateralSummary(AGENT, COLLATERAL);
    expect(summary.source).toBe('chain');
    expect(summary.effectiveCollateralMicro).toBe(39_846n);
    expect(summary.outstandingMicro).toBe(20_001n);
    expect(summary.headroomMicro).toBe(11_875n);
    expect(summary.healthFactor).toBe(1.9922);
    expect(vault.reads).toEqual([MANDATE]);

    const statement = await ledger.statement(AGENT, COLLATERAL);
    expect(statement.collateral?.source).toBe('chain');
  });

  it('holds a draw inside the vault headroom and refuses one past it', async () => {
    await reserve(m(10_000), 'n-1');
    // 11,875 of headroom less the 10,000 hold still open leaves 1,875.
    await expect(reserve(m(2_000), 'n-2')).rejects.toMatchObject({ code: 'collateral_headroom_exceeded' });
    await reserve(m(1_875), 'n-3');
  });

  it('refuses every draw when the vault reads no collateral', async () => {
    vault.position = fromAccountTuple(MANDATE, [0n, 0n, 0n, 0n, (1n << 256n) - 1n]);
    await expect(reserve(m(1), 'n-4')).rejects.toMatchObject({ code: 'collateral_headroom_exceeded' });
    const summary = await ledger.getCollateralSummary(AGENT, COLLATERAL);
    expect(summary.healthFactor).toBeNull();
  });

  it('falls back to the ledger rows for an account with no mandate', async () => {
    await ledger.upsertAccount({ agentId: 'agent-2', payerWallet: PAYER, repayWallet: PAYER, networks: [NETWORK] });
    const summary = await ledger.getCollateralSummary('agent-2', COLLATERAL);
    expect(summary.source).toBe('ledger');
    expect(vault.reads).toEqual([]);
  });
});
