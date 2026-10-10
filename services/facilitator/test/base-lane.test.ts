import { describe, expect, it } from 'vitest';
import { deriveNonce, requestCommit, requestDocument, requestURI, toMicro } from '@bursar/core';
import { keccak256, toBytes, verifyTypedData } from 'viem';
import type { Address, Hex } from 'viem';

import { AUTHORIZATION_MARGIN_SECONDS, BASE_REASON, BaseLane, RETURN_GRACE_SECONDS } from '../src/base/lane.js';
import type { BaseRefusal, SignedPayment } from '../src/base/lane.js';
import { hashRequest } from '../src/x402/binding.js';
import { FakeBaseLedger, FakeFloat, FakeLockWriter, FLOAT_ACCOUNT, TRANSFER_WITH_AUTHORIZATION_TYPES, USDC, USDC_DOMAIN, scriptedEscrow } from './support/base-doubles.js';

/**
 * The Base lane against doubles: a scripted escrow, a float that signs with a real key, a writer
 * that records its moves and a ledger in memory.
 *
 * What the suite holds the lane to: a quote never asks for less than the escrow opens; a short
 * float refuses before a signature exists; a lock has to be payable to the float, for the quoted
 * amount, bound to the request and open long enough; one lock signs once; and the worker settles
 * from what USDC says and returns what USDC never saw.
 */

const ESCROW: Address = '0x11e73B5632837355e250fC236cFC2Be03aD0845A';
const FACTORY: Address = '0xC42dBCbd34E64e2D81B48866F673ddB7B42ba562';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const MANDATE: Address = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const PRINCIPAL: Address = '0x877c349EFb5926082C413833E8055F0991185c61';
const SERVICE: Address = '0xD7d49D6a12Ee3852f29A52A40908069bF4e48914';
const TX: Hex = `0x${'ab'.repeat(32)}`;
const SALT: Hex = `0x${'5a'.repeat(32)}`;
const URL = 'https://api.base-service.dev/fact';
const BODY = '{"q":1}';
const NOW = 1_800_000_000;

const binding = { requestHash: hashRequest(BODY), salt: SALT };
const document = requestDocument({ method: 'POST', url: URL, binding });
const commit = requestCommit(document);

const offer = (overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: USDC,
  payTo: SERVICE,
  maxTimeoutSeconds: 300,
  resource: URL,
  extra: { name: 'USD Coin', version: '2' },
  ...overrides,
});

function harness(options: { balance?: bigint; feeBps?: number; floor?: bigint; minLock?: bigint; minimum?: bigint; max?: bigint } = {}) {
  const escrow = scriptedEscrow();
  const float = new FakeFloat();
  float.balanceMicro = options.balance ?? 10_000_000n;
  const locks = new FakeLockWriter();
  const ledger = new FakeBaseLedger();
  let now = NOW;
  const lane = new BaseLane({
    chainId: 4663,
    escrow,
    deployments: [{ escrow: ESCROW, factory: FACTORY, asset: USDG }],
    float,
    locks,
    ledger,
    feeBps: options.feeBps ?? 100,
    feeFloorMicro: toMicro(options.floor ?? 2_000n),
    minLockMicro: toMicro(options.minLock ?? 10_000n),
    floatMinimumMicro: toMicro(options.minimum ?? 1_000_000n),
    maxPaymentMicro: toMicro(options.max ?? 5_000_000n),
    now: () => now,
    unseenRetryMs: 1,
  });
  escrow.accounts.set(MANDATE.toLowerCase(), { escrow: ESCROW, principal: PRINCIPAL });
  escrow.created = [MANDATE];
  return { lane, escrow, float, locks, ledger, tick: (seconds: number) => (now += seconds) };
}

function openLock(h: ReturnType<typeof harness>, id: bigint, overrides: Partial<{ payee: Address; amount: bigint; inputCommit: Hex; inputURI: string; deadline: bigint; status: number; payer: Address }> = {}) {
  h.escrow.locks.set(`${ESCROW.toLowerCase()}:${id}`, {
    payer: overrides.payer ?? MANDATE,
    payee: overrides.payee ?? FLOAT_ACCOUNT.address,
    capabilityId: `0x${'11'.repeat(32)}`,
    inputCommit: overrides.inputCommit ?? commit,
    inputURI: overrides.inputURI ?? requestURI(document),
    amount: overrides.amount ?? 10_000n,
    deadline: overrides.deadline ?? BigInt(NOW + 1_290),
    status: overrides.status ?? 1,
  });
  h.escrow.openedIn.set(TX, [id]);
  return { escrow: ESCROW, id: id.toString(), mandate: MANDATE, transaction: TX, inputCommit: overrides.inputCommit ?? commit };
}

describe('quote', () => {
  it('prices a lock at the amount plus the fee, and never under the escrow floor', async () => {
    const { lane } = harness();
    expect(lane.price(toMicro(1_000n))).toEqual({ lockMicro: 10_000n, feeMicro: 9_000n });
    expect(lane.price(toMicro(50_000n))).toEqual({ lockMicro: 52_000n, feeMicro: 2_000n });
    expect(lane.price(toMicro(1_000_000n))).toEqual({ lockMicro: 1_010_000n, feeMicro: 10_000n });

    const quote = await lane.quote({ amount: '50000', payTo: SERVICE, resource: URL, maxTimeoutSeconds: 300 });
    expect(quote).toMatchObject({
      lane: 'base',
      float: FLOAT_ACCOUNT.address,
      amountMicro: 50_000n,
      lockMicro: 52_000n,
      feeMicro: 2_000n,
      availableMicro: 10_000_000n,
      validForSeconds: 300,
      lock: { chainId: 4663, payee: FLOAT_ACCOUNT.address, asset: USDG, amountMicro: 52_000n, ttlSeconds: 300 + AUTHORIZATION_MARGIN_SECONDS + RETURN_GRACE_SECONDS + 900 },
    });
  });

  it('refuses when the float could not cover the payment beyond its reserve', async () => {
    const { lane } = harness({ balance: 1_000_500n });
    const refused = (await lane.quote({ amount: '1000', payTo: SERVICE })) as BaseRefusal;
    expect(refused).toMatchObject({ refused: true, reason: BASE_REASON.float, status: 409 });
    expect(refused.detail).toContain('needs 1000');
  });

  it('counts what is already promised against the float', async () => {
    const h = harness({ balance: 1_002_000n });
    openLock(h, 1n);
    const first = await h.lane.pay({ lock: openLock(h, 1n), binding, offer: offer() });
    expect(first.refused).toBeUndefined();
    const second = (await h.lane.quote({ amount: '1500', payTo: SERVICE })) as BaseRefusal;
    expect(second).toMatchObject({ refused: true, reason: BASE_REASON.float });
  });

  it('caps one payment and refuses a malformed ask without reading anything', async () => {
    const { lane } = harness({ max: 20_000n });
    expect(await lane.quote({ amount: '20001', payTo: SERVICE })).toMatchObject({ reason: BASE_REASON.tooLarge });
    expect(await lane.quote({ amount: '-1', payTo: SERVICE })).toMatchObject({ reason: BASE_REASON.payload, status: 400 });
    expect(await lane.quote({ amount: '1000', payTo: 'nobody' })).toMatchObject({ reason: BASE_REASON.payload, status: 400 });
    expect(await lane.quote({ amount: '1000', payTo: SERVICE, maxTimeoutSeconds: 7_200 })).toMatchObject({ reason: BASE_REASON.offer, status: 400 });
  });
});

describe('pay', () => {
  it('signs one authorization the float itself would accept, for the lock it read', async () => {
    const h = harness();
    const lock = openLock(h, 7n);

    const signed = (await h.lane.pay({ lock, binding, offer: offer() })) as SignedPayment;
    expect(signed.refused).toBeUndefined();

    expect(signed.authorization).toEqual({
      from: FLOAT_ACCOUNT.address,
      to: SERVICE,
      value: '1000',
      validAfter: String(NOW - 60),
      validBefore: String(NOW + 300 + AUTHORIZATION_MARGIN_SECONDS),
      nonce: deriveNonce(binding),
    });
    expect(
      await verifyTypedData({
        address: FLOAT_ACCOUNT.address,
        domain: USDC_DOMAIN,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: FLOAT_ACCOUNT.address,
          to: SERVICE,
          value: 1_000n,
          validAfter: BigInt(NOW - 60),
          validBefore: BigInt(NOW + 330),
          nonce: deriveNonce(binding),
        },
        signature: signed.signature,
      }),
    ).toBe(true);

    expect(signed.payment).toMatchObject({
      chainId: 4663,
      escrow: ESCROW,
      lockId: 7n,
      lockTransaction: TX,
      mandate: MANDATE,
      float: FLOAT_ACCOUNT.address,
      payTo: SERVICE,
      resource: URL,
      amountMicro: 1_000n,
      lockMicro: 10_000n,
      feeMicro: 9_000n,
      status: 'signed',
      validBefore: BigInt(NOW + 330),
      deadline: BigInt(NOW + 1_290),
    });
    expect(await h.ledger.promised(FLOAT_ACCOUNT.address)).toBe(1_000n);
  });

  it('signs a lock once, whatever the second payload says', async () => {
    const h = harness();
    const lock = openLock(h, 7n);
    await h.lane.pay({ lock, binding, offer: offer() });
    const again = await h.lane.pay({ lock, binding, offer: offer() });
    expect(again).toMatchObject({ refused: true, reason: BASE_REASON.replay });
    expect(h.float.signed).toHaveLength(1);
  });

  it('refuses a lock that does not pay the lane, the quote, or this request', async () => {
    const h = harness();
    expect(await h.lane.pay({ lock: openLock(h, 1n, { payee: SERVICE }), binding, offer: offer() })).toMatchObject({ reason: BASE_REASON.payee });
    expect(await h.lane.pay({ lock: openLock(h, 2n, { amount: 9_999n }), binding, offer: offer() })).toMatchObject({ reason: BASE_REASON.amount });
    expect(await h.lane.pay({ lock: openLock(h, 3n), binding: { ...binding, salt: `0x${'5b'.repeat(32)}` }, offer: offer() })).toMatchObject({ reason: BASE_REASON.unbound });
    expect(await h.lane.pay({ lock: openLock(h, 4n, { deadline: BigInt(NOW + 600) }), binding, offer: offer() })).toMatchObject({ reason: BASE_REASON.deadline });
    expect(await h.lane.pay({ lock: openLock(h, 5n, { status: 2 }), binding, offer: offer() })).toMatchObject({ reason: BASE_REASON.notOpen });
    expect(await h.lane.pay({ lock: openLock(h, 6n, { payer: PRINCIPAL }), binding, offer: offer() })).toMatchObject({ reason: BASE_REASON.payer });
    expect(h.float.signed).toHaveLength(0);
  });

  it('refuses an offer the lane does not pay, before reading the lock', async () => {
    const h = harness();
    const lock = openLock(h, 1n);
    expect(await h.lane.pay({ lock, binding, offer: offer({ network: 'eip155:4663' }) })).toMatchObject({ reason: BASE_REASON.offer, status: 400 });
    expect(await h.lane.pay({ lock, binding, offer: offer({ asset: USDG }) })).toMatchObject({ reason: BASE_REASON.offer, status: 400 });
    expect(await h.lane.pay({ lock, binding, offer: offer({ scheme: 'escrow' }) })).toMatchObject({ reason: BASE_REASON.offer, status: 400 });
    expect(await h.lane.pay({ lock, binding, offer: offer({ amount: '0' }) })).toMatchObject({ reason: BASE_REASON.offer, status: 400 });
    expect(await h.lane.pay({ lock: { escrow: ESCROW }, binding, offer: offer() })).toMatchObject({ reason: BASE_REASON.payload, status: 400 });
  });

  it('refuses a mandate the factory never made, and a chain it cannot read', async () => {
    const h = harness();
    h.escrow.created = [];
    expect(await h.lane.pay({ lock: openLock(h, 1n), binding, offer: offer() })).toMatchObject({ reason: BASE_REASON.payer });
    h.escrow.fail = true;
    expect(await h.lane.pay({ lock: openLock(h, 2n), binding, offer: offer() })).toMatchObject({ reason: BASE_REASON.unreadable, status: 503 });
  });

  it('counts the first authorization against the float before signing a second', async () => {
    const h = harness({ balance: 1_001_000n });
    const lock = openLock(h, 1n);
    const first = await h.lane.pay({ lock, binding, offer: offer() });
    expect(first.refused).toBeUndefined();
    const second = await h.lane.pay({ lock: openLock(h, 2n), binding, offer: offer() });
    expect(second).toMatchObject({ reason: BASE_REASON.float });
    expect(h.float.signed).toHaveLength(1);
  });
});

describe('the worker', () => {
  async function signedPayment(h: ReturnType<typeof harness>, id = 7n) {
    const lock = openLock(h, id);
    const signed = (await h.lane.pay({ lock, binding, offer: offer() })) as SignedPayment;
    return signed.payment;
  }

  it('settles the lock to the float once USDC reports the nonce used', async () => {
    const h = harness();
    const payment = await signedPayment(h);
    const baseTx: Hex = `0x${'ee'.repeat(32)}`;
    h.float.used.add(payment.nonce);
    h.float.transactions.set(payment.nonce, baseTx);

    expect(await h.lane.reconcile()).toEqual({ checked: 1, settled: 1, returned: 0, pending: 0, failed: 0 });
    expect(h.locks.released).toEqual([{ escrow: ESCROW, id: 7n, outputCommit: keccak256(toBytes(baseTx)), outputURI: `https://basescan.org/tx/${baseTx}` }]);
    expect(await h.ledger.find(payment.id)).toMatchObject({ status: 'settled', baseTransaction: baseTx, rhcTransaction: expect.stringMatching(/^0x5e/) });
    expect(await h.ledger.promised(FLOAT_ACCOUNT.address)).toBe(0n);
  });

  it('leaves a live authorization alone and returns the lock once it has expired unused', async () => {
    const h = harness();
    const payment = await signedPayment(h);

    expect(await h.lane.reconcile()).toMatchObject({ pending: 1 });
    h.tick(300 + AUTHORIZATION_MARGIN_SECONDS + RETURN_GRACE_SECONDS);
    expect(await h.lane.reconcile()).toMatchObject({ pending: 1 });
    h.tick(1);
    expect(await h.lane.reconcile()).toEqual({ checked: 1, settled: 0, returned: 1, pending: 0, failed: 0 });
    expect(h.locks.cancelled).toEqual([{ escrow: ESCROW, id: 7n }]);
    expect(await h.ledger.find(payment.id)).toMatchObject({ status: 'returned' });
    expect(await h.ledger.promised(FLOAT_ACCOUNT.address)).toBe(0n);
  });

  it('keeps a paid row and retries the release, falling back to the reported hash when logs will not answer', async () => {
    const h = harness();
    const payment = await signedPayment(h);
    const reported: Hex = `0x${'dd'.repeat(32)}`;
    await h.lane.outcome(payment.id, { transaction: reported, success: true });
    h.float.used.add(payment.nonce);
    h.float.logsFail = true;
    h.locks.failReleases = 1;

    expect(await h.lane.reconcile()).toMatchObject({ checked: 1, failed: 1 });
    expect(await h.ledger.find(payment.id)).toMatchObject({ status: 'paid', baseTransaction: reported });

    expect(await h.lane.reconcile()).toMatchObject({ settled: 1 });
    expect(h.locks.released[0]).toMatchObject({ id: 7n, outputURI: `https://basescan.org/tx/${reported}` });
  });

  it('reports the float as the operator sees it', async () => {
    const h = harness({ balance: 1_500_000n });
    await signedPayment(h);
    expect(await h.lane.status()).toMatchObject({
      lane: 'base',
      float: FLOAT_ACCOUNT.address,
      balanceMicro: '1500000',
      promisedMicro: '1000',
      availableMicro: '1499000',
      minimumMicro: '1000000',
      open: 1,
      stuck: 0,
      healthy: true,
    });
    h.tick(2_000);
    expect(await h.lane.status()).toMatchObject({ stuck: 1, healthy: false });
  });
});
