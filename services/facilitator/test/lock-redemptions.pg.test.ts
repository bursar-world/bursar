import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { LaneLedger } from '../src/lanes/ledger.js';
import { TrustStore } from '../src/trust/store.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

/**
 * One escrow lock, one settlement, enforced by the database.
 *
 * The replay guard refuses a second settle of a lock before anything is written, and a double can
 * show that. What only a real server can show is the constraint underneath it: two settlements of
 * one lock, arriving under two names at once, and exactly one of them committing.
 */

const ESCROW: Address = '0x4315F8be7C9661345710910577Ec31cb867f3c20';
const OTHER_ESCROW: Address = '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const MANDATE: Address = '0x420BeB507F72173E7d78e0f956968f64fb508356';
const PAYEE: Address = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const TREASURY = '0x4444444444444444444444444444444444444444';
const TX: Hex = `0x${'ab'.repeat(32)}`;
const NETWORK = 'eip155:4663';

const nonce = `0x${'a1'.repeat(32)}` as const;
const other = `0x${'7e'.repeat(32)}` as const;

const terms = {
  network: NETWORK,
  asset: USDG,
  payerWallet: MANDATE,
  merchantWallet: PAYEE,
  amountMicro: toMicro(10_000),
  feeMicro: toMicro(0),
  txHash: TX,
  treasury: TREASURY,
};

const lock = { chainId: 4663, escrow: ESCROW, id: 7n };

describe.skipIf(!TEST_DATABASE_URL)('lock redemptions against Postgres', () => {
  let scratch: Scratch;
  let ledger: LaneLedger;

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_lock_redemptions_test');
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.reset();
    ledger = new LaneLedger({ db: scratch.db, trust: new TrustStore({ topic: 'bursar.trust.v1' }), currency: 'USDG' });
  });

  async function count(table: string): Promise<number> {
    const { rows } = await scratch.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    return Number(rows[0]?.count ?? '0');
  }

  it('records a lock once, whatever name the second settlement arrives under', async () => {
    const first = await ledger.recordDirectSettlement({ ...terms, nonce, lock });

    await expect(ledger.recordDirectSettlement({ ...terms, nonce: other, lock })).rejects.toMatchObject({
      code: 'payment_already_used',
    });
    // The refused settlement's own row went with the rollback.
    expect(await count('bursar_settlements')).toBe(1);
    expect(await count('bursar_lock_redemptions')).toBe(1);

    // The same name again is the retry of the first settle, and gets the first settlement back.
    const again = await ledger.recordDirectSettlement({ ...terms, nonce, lock });
    expect(again.id).toBe(first.id);
  });

  it('lets exactly one of two racing settlements redeem a lock', async () => {
    const outcomes = await Promise.allSettled(
      [nonce, other].map((name) => ledger.recordDirectSettlement({ ...terms, nonce: name, lock })),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toMatchObject({ code: 'payment_already_used' });
    expect(await count('bursar_settlements')).toBe(1);
    expect(await count('bursar_lock_redemptions')).toBe(1);
  });

  it('holds under a burst of settlements for one lock, each under its own name', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `0x${(index + 16).toString(16).repeat(32)}` as Hex);
    const outcomes = await Promise.allSettled(names.map((name) => ledger.recordDirectSettlement({ ...terms, nonce: name, lock })));

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await count('bursar_settlements')).toBe(1);
    expect(await count('bursar_lock_redemptions')).toBe(1);
  });

  it('keys the lock on its chain, its escrow and its id, spelled one way', async () => {
    await ledger.recordDirectSettlement({ ...terms, nonce, lock });

    // The same id on another escrow, or another chain, is another lock.
    await ledger.recordDirectSettlement({ ...terms, nonce: other, lock: { ...lock, escrow: OTHER_ESCROW } });
    await ledger.recordDirectSettlement({ ...terms, nonce: `0x${'7f'.repeat(32)}`, lock: { ...lock, chainId: 46630 } });
    expect(await count('bursar_lock_redemptions')).toBe(3);

    // The same escrow in another case is the same lock.
    await expect(
      ledger.recordDirectSettlement({ ...terms, nonce: `0x${'70'.repeat(32)}`, lock: { ...lock, escrow: ESCROW.toLowerCase() as Address } }),
    ).rejects.toMatchObject({ code: 'payment_already_used' });
  });

  it('holds a lock id as wide as the chain can issue', async () => {
    const widest = 2n ** 256n - 1n;
    await ledger.recordDirectSettlement({ ...terms, nonce, lock: { ...lock, id: widest } });

    const { rows } = await scratch.db.query<{ lock_id: string }>('SELECT lock_id::text AS lock_id FROM bursar_lock_redemptions');
    expect(rows[0]?.lock_id).toBe(widest.toString());
  });

  it('leaves a settlement that redeems no lock alone', async () => {
    await ledger.recordDirectSettlement({ ...terms, nonce });
    await ledger.recordDirectSettlement({ ...terms, nonce: other });
    expect(await count('bursar_settlements')).toBe(2);
    expect(await count('bursar_lock_redemptions')).toBe(0);
  });
});
