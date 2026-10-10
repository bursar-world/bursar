import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { PostgresBaseLedger } from '../src/base/ledger.js';
import type { OpenPaymentInput } from '../src/base/ports.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

/**
 * The Base lane's ledger against a real server: the two keys, the float check under the advisory
 * lock, and the status transitions the CHECK constraint allows.
 */

const ESCROW: Address = '0x11e73B5632837355e250fC236cFC2Be03aD0845A';
const FLOAT: Address = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const MANDATE: Address = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const SERVICE: Address = '0xD7d49D6a12Ee3852f29A52A40908069bF4e48914';

function input(overrides: Partial<OpenPaymentInput> = {}): OpenPaymentInput {
  return {
    chainId: 4663,
    escrow: ESCROW,
    lockId: 7n,
    lockTransaction: `0x${'ab'.repeat(32)}`,
    mandate: MANDATE,
    float: FLOAT,
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: SERVICE,
    resource: 'https://api.base-service.dev/fact',
    amountMicro: toMicro(1_000n),
    lockMicro: toMicro(10_000n),
    feeMicro: toMicro(9_000n),
    nonce: `0x${'11'.repeat(32)}`,
    validBefore: 1_800_000_330n,
    deadline: 1_800_001_290n,
    signedBlock: 52_000_000n,
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)('the base ledger', () => {
  let scratch: Scratch;
  let ledger: PostgresBaseLedger;

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_base_ledger_test');
    ledger = new PostgresBaseLedger(scratch.db);
  });
  beforeEach(() => scratch.db.query('DELETE FROM bursar_base_payments'));
  afterAll(() => scratch.drop());

  it('opens one row per lock and one per nonce, and refuses the float before the insert', async () => {
    const first = await ledger.open(input(), { balance: 5_000_000n, minimumMicro: toMicro(1_000_000n) });
    expect(first).toMatchObject({ opened: true, payment: { lockId: 7n, status: 'signed', amountMicro: 1_000n, lockMicro: 10_000n } });
    expect(await ledger.promised(FLOAT)).toBe(1_000n);

    const sameLock = await ledger.open(input({ nonce: `0x${'22'.repeat(32)}` }), { balance: 5_000_000n, minimumMicro: toMicro(1_000_000n) });
    expect(sameLock).toMatchObject({ opened: false, reason: 'replay', availableMicro: 4_999_000n });

    await expect(ledger.open(input({ lockId: 8n }), { balance: 5_000_000n, minimumMicro: toMicro(1_000_000n) })).rejects.toThrow(/uq_base_payments_nonce/);

    const short = await ledger.open(input({ lockId: 9n, nonce: `0x${'33'.repeat(32)}` }), { balance: 1_001_500n, minimumMicro: toMicro(1_000_000n) });
    expect(short).toMatchObject({ opened: false, reason: 'float', availableMicro: 1_000_500n });
    expect(await ledger.findLock(4663, ESCROW, 9n)).toBeNull();
  });

  it('moves a row through paid and settled, or straight to returned, and counts what is stuck', async () => {
    const opened = await ledger.open(input(), { balance: 5_000_000n, minimumMicro: toMicro(0n) });
    const id = opened.opened ? opened.payment.id : '';
    const baseTx: Hex = `0x${'ee'.repeat(32)}`;

    await ledger.report(id, baseTx);
    await ledger.markPaid(id, null);
    expect(await ledger.find(id)).toMatchObject({ status: 'paid', reportedTransaction: baseTx, baseTransaction: null });
    expect(await ledger.promised(FLOAT)).toBe(0n);
    expect(await ledger.listOpen(10)).toHaveLength(1);

    await ledger.close(id, 'settled', `0x${'5e'.repeat(32)}`);
    expect(await ledger.find(id)).toMatchObject({ status: 'settled', rhcTransaction: `0x${'5e'.repeat(32)}`, closedAt: expect.any(Date) });
    expect(await ledger.listOpen(10)).toHaveLength(0);
    // Closed is closed: a second close or a late markPaid changes nothing.
    await ledger.close(id, 'returned', `0x${'ca'.repeat(32)}`);
    await ledger.markPaid(id, baseTx);
    expect(await ledger.find(id)).toMatchObject({ status: 'settled', rhcTransaction: `0x${'5e'.repeat(32)}`, baseTransaction: null });

    const second = await ledger.open(input({ lockId: 8n, nonce: `0x${'22'.repeat(32)}`, deadline: 1_800_000_100n }), { balance: 5_000_000n, minimumMicro: toMicro(0n) });
    const other = second.opened ? second.payment.id : '';
    expect(await ledger.countStuck(1_800_000_200n)).toBe(1);
    await ledger.close(other, 'returned', `0x${'ca'.repeat(32)}`);
    expect(await ledger.countStuck(1_800_000_200n)).toBe(0);
    expect(await ledger.listMandate(MANDATE, 10)).toHaveLength(2);
  });
});
