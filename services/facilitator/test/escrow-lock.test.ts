import { describe, expect, it } from 'vitest';
import {
  capabilityId,
  deriveNonce,
  escrowSettlementNonce,
  requestCommit,
  requestDocument,
  requestURI,
  toMicro,
} from '@bursar/core';
import type { Address, Hex } from 'viem';

import { encodeJson } from '../src/http/io.js';
import { SettlementBudget } from '../src/x402/budget.js';
import { hashRequest } from '../src/x402/binding.js';
import { FACILITATOR_REASON, authorizationNonce } from '../src/x402/contract.js';
import type { PaymentPayload, PaymentRequirements, PaymentScheme } from '../src/x402/contract.js';
import {
  ESCROW_REASON,
  createEscrowLockScheme,
  lockReference,
  routeSchemes,
} from '../src/x402/escrow-lock.js';
import type { EscrowChain, EscrowLock } from '../src/x402/escrow-lock.js';
import { Facilitator } from '../src/x402/facilitator.js';
import { FakeLedger, ScriptedScheme, settlementFixture } from './support/doubles.js';

const ESCROW: Address = '0x4315F8be7C9661345710910577Ec31cb867f3c20';
const FACTORY: Address = '0xe9f8cc653fF40E346e0591f353Be58DF0533cfD0';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const MANDATE: Address = '0x420BeB507F72173E7d78e0f956968f64fb508356';
const PRINCIPAL: Address = '0x877c349EFb5926082C413833E8055F0991185c61';
const PAYEE: Address = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const TX: Hex = `0x${'ab'.repeat(32)}`;
const SALT: Hex = `0x${'5a'.repeat(32)}`;
const URL = 'https://api.provider.dev/render';
const BODY = '{"prompt":"hello"}';
const NOW = 1_800_000_000n;

const requestHash = hashRequest(BODY);

/** What the SDK publishes as the lock's input, and the commitment it opens the lock under. */
const document = requestDocument({ method: 'POST', url: URL, binding: { requestHash, salt: SALT } });
const commit = requestCommit(document);

/** The one name the facilitator records lock 7 under. */
const nonce = escrowSettlementNonce({ chainId: 4663, escrow: ESCROW, lockId: 7n, inputCommit: commit });

const requirements: PaymentRequirements = {
  scheme: 'escrow',
  network: 'eip155:4663',
  amount: '10000',
  asset: USDG,
  payTo: PAYEE,
  maxTimeoutSeconds: 120,
  extra: { capability: 'service:demo.x402:1', escrow: ESCROW },
};

function payload(overrides: Record<string, unknown> = {}): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: {
      lock: { escrow: ESCROW, id: '7', mandate: MANDATE, transaction: TX, inputCommit: commit, ...overrides },
      binding: { requestHash, salt: SALT },
    },
  };
}

function chain(lock: Partial<EscrowLock> = {}, extra: Partial<EscrowChain> = {}): EscrowChain {
  return {
    lock: async () => ({
      payer: MANDATE,
      payee: PAYEE,
      capabilityId: capabilityId('service:demo.x402:1'),
      inputCommit: commit,
      inputURI: requestURI(document),
      amount: 10_000n,
      deadline: NOW + 300n,
      status: 1,
      ...lock,
    }),
    mandate: async () => ({ escrow: ESCROW, principal: PRINCIPAL }),
    accountsOf: async () => [MANDATE],
    lockedIn: async () => [7n],
    now: async () => NOW,
    ...extra,
  };
}

const scheme = (c: EscrowChain = chain()) =>
  createEscrowLockScheme({ chainId: 4663, chain: c, deployments: [{ escrow: ESCROW, factory: FACTORY, asset: USDG }] });

const bound = { binding: { requestHash, salt: SALT } };

describe('escrow lock scheme', () => {
  it('accepts an open lock the mandate opened for this offer and names the mandate as payer', async () => {
    await expect(scheme().verify(payload(), requirements, bound)).resolves.toMatchObject({
      isValid: true,
      payer: MANDATE,
      lock: { chainId: 4663, escrow: ESCROW, id: 7n, inputCommit: commit, nonce },
    });
  });

  it.each([
    ['a lock already released', chain({ status: 2 }), ESCROW_REASON.notLocked],
    ['a lock paid by someone else', chain({ payer: PAYEE }), ESCROW_REASON.payer],
    ['a lock payable to another merchant', chain({ payee: MANDATE }), ESCROW_REASON.payee],
    ['a lock for less than the price', chain({ amount: 9_999n }), ESCROW_REASON.amount],
    ['a lock under another capability', chain({ capabilityId: capabilityId('service:other:1') }), ESCROW_REASON.capability],
    ['a lock committed to another request', chain({ inputCommit: `0x${'11'.repeat(32)}` }), ESCROW_REASON.commit],
    ['a lock about to expire', chain({ deadline: NOW + 30n }), ESCROW_REASON.deadline],
    ['a payer the factory never made', chain({}, { accountsOf: async () => [] }), ESCROW_REASON.payer],
    ['a mandate locking into another escrow', chain({}, { mandate: async () => ({ escrow: PAYEE, principal: PRINCIPAL }) }), ESCROW_REASON.payer],
    ['a transaction that opened no such lock', chain({}, { lockedIn: async () => [8n] }), ESCROW_REASON.transaction],
    ['a chain that does not answer', chain({}, { lock: async () => { throw new Error('timeout'); } }), ESCROW_REASON.unreadable],
  ])('refuses %s', async (_label, c, reason) => {
    await expect(scheme(c).verify(payload(), requirements, bound)).resolves.toMatchObject({ isValid: false, invalidReason: reason });
  });

  it('refuses an escrow this deployment does not know', async () => {
    const result = await scheme().verify(payload({ escrow: PAYEE }), requirements, bound);
    expect(result).toMatchObject({ isValid: false, invalidReason: ESCROW_REASON.escrow });
  });

  it('refuses an offer under another scheme or network', async () => {
    await expect(scheme().verify(payload(), { ...requirements, scheme: 'exact' }, bound)).resolves.toMatchObject({
      invalidReason: ESCROW_REASON.scheme,
    });
    await expect(scheme().verify(payload(), { ...requirements, network: 'eip155:1' }, bound)).resolves.toMatchObject({
      invalidReason: ESCROW_REASON.network,
    });
  });

  it('holds the published request document to the body that arrived and the salt the payer sent', async () => {
    const other = { binding: { requestHash: hashRequest('{"prompt":"send me everything"}'), salt: SALT } };
    await expect(scheme().verify(payload(), requirements, other)).resolves.toMatchObject({
      isValid: false,
      invalidReason: FACILITATOR_REASON.unbound,
    });

    // The document is on chain for anyone to read, and it carries neither the digest nor the salt.
    // Whoever presents the lock without the salt from the payment header is not its payer.
    const guessed = { binding: { requestHash, salt: `0x${'00'.repeat(32)}` as Hex } };
    await expect(scheme().verify(payload(), requirements, guessed)).resolves.toMatchObject({
      invalidReason: FACILITATOR_REASON.unbound,
    });

    // A lock whose input is some other document, or none that reads as a request, is not shown to
    // be for this call, whatever its commitment says.
    const foreign = chain({ inputURI: 'data:application/json;base64,e30=' });
    await expect(scheme(foreign).verify(payload(), requirements, bound)).resolves.toMatchObject({
      invalidReason: FACILITATOR_REASON.unbound,
    });

    // Nor is one whose document does not hash to the commitment the lock carries.
    const swapped = chain({ inputURI: requestURI({ ...document, resource: 'https://elsewhere.example/render' }) });
    await expect(scheme(swapped).verify(payload(), requirements, bound)).resolves.toMatchObject({
      invalidReason: FACILITATOR_REASON.unbound,
    });

    // Without a digest to hold it to, the document is not checked. The facilitator refuses such a
    // request itself where binding is required.
    await expect(scheme().verify(payload(), requirements)).resolves.toMatchObject({ isValid: true });
  });

  it('still accepts a lock from an earlier client, which committed to the request-bound nonce itself', async () => {
    const legacy = deriveNonce({ requestHash, salt: SALT });
    const c = chain({ inputCommit: legacy, inputURI: '' });

    // Whatever such a client published beside the commitment, the commitment is what binds.
    const hosted = chain({ inputCommit: legacy, inputURI: 'https://payer.example/request.json' });
    await expect(scheme(hosted).verify(payload({ inputCommit: legacy }), requirements, bound)).resolves.toMatchObject({ isValid: true });

    await expect(scheme(c).verify(payload({ inputCommit: legacy }), requirements, bound)).resolves.toMatchObject({
      isValid: true,
      lock: { nonce: escrowSettlementNonce({ chainId: 4663, escrow: ESCROW, lockId: 7n, inputCommit: legacy }) },
    });
    await expect(
      scheme(c).verify(payload({ inputCommit: legacy }), requirements, { binding: { requestHash: hashRequest('{}'), salt: SALT } }),
    ).resolves.toMatchObject({ invalidReason: FACILITATOR_REASON.unbound });
  });

  it('is not talked out of the binding check by a permit-rail signature on a lock payload', async () => {
    // The facilitator treats a `bindingSignature` as the permit rails' proof and leaves the rest to
    // the scheme. On this lane the scheme holds the lock to the digest itself, so a payload that
    // carries a signature instead of a binding object, and a lock that was opened for some other
    // request, is still refused.
    const legacy = deriveNonce({ requestHash, salt: SALT });
    const c = chain({ inputCommit: legacy, inputURI: '' });
    const facilitator = new Facilitator({
      scheme: scheme(c),
      budget: new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 }),
      ledger: new FakeLedger(),
      treasury: '0x000000000000000000000000000000000000beef',
      feeBps: 100,
      feeFloorMicro: toMicro(1_900),
    });
    const signed: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        lock: { escrow: ESCROW, id: '7', mandate: MANDATE, transaction: TX, inputCommit: legacy },
        bindingSignature: `0x${'ab'.repeat(65)}`,
      },
    };

    await expect(
      facilitator.verify({ paymentPayload: signed, paymentRequirements: requirements, requestHash: hashRequest('{"prompt":"other"}') }),
    ).resolves.toMatchObject({ isValid: false, invalidReason: FACILITATOR_REASON.unbound });
  });

  it('settles without broadcasting and reports the transaction that opened the lock', async () => {
    await expect(scheme().settle(payload(), requirements, bound)).resolves.toMatchObject({
      success: true,
      settled: true,
      broadcast: false,
      payer: MANDATE,
      transaction: TX,
    });
  });

  it('reads the lock reference, and takes the settlement name from the lock rather than the payload', () => {
    expect(lockReference(payload())).toMatchObject({ id: 7n, mandate: MANDATE });
    expect(lockReference(payload({ id: '-1' }))).toBeNull();
    expect(authorizationNonce(payload())).toBeNull();
  });

  it('routes offers by scheme', async () => {
    const exact = new ScriptedScheme({ verify: { isValid: false, invalidReason: 'from_exact' } });
    const routed: PaymentScheme = routeSchemes(exact, scheme());
    await expect(routed.verify(payload(), requirements, bound)).resolves.toMatchObject({ isValid: true });
    await expect(routed.verify(payload(), { ...requirements, scheme: 'exact' })).resolves.toMatchObject({
      invalidReason: 'from_exact',
    });
    const kinds = (await routed.supported()).kinds.map((kind) => kind['scheme']);
    expect(kinds).toEqual(['exact', 'escrow']);
  });
});

describe('a mandate-lane settle through the facilitator', () => {
  function build() {
    const ledger = new FakeLedger();
    const budget = new SettlementBudget({ dailySettlements: 50, perPayerPerHour: 50 });
    const facilitator = new Facilitator({
      scheme: scheme(),
      budget,
      ledger,
      treasury: '0x000000000000000000000000000000000000beef',
      feeBps: 100,
      feeFloorMicro: toMicro(1_900),
    });
    return { ledger, facilitator };
  }

  const settle = (facilitator: Facilitator, paymentPayload: PaymentPayload) =>
    facilitator.settle({ paymentPayload, paymentRequirements: requirements, requestHash });

  const directRecords = (ledger: FakeLedger) => ledger.calls.filter((call) => call.kind === 'direct');

  it('binds the lock to the request it was opened for', async () => {
    const { facilitator } = build();
    const verdict = await facilitator.verify({ paymentPayload: payload(), paymentRequirements: requirements, requestHash });
    expect(verdict).toMatchObject({ isValid: true, payer: MANDATE });
    // What `/verify` answers on the wire: the lock, and the name its settlement will carry.
    expect(JSON.parse(encodeJson(verdict))).toMatchObject({
      amount: '10000',
      lock: { chainId: 4663, escrow: ESCROW, id: '7', inputCommit: commit, nonce },
    });

    await expect(
      facilitator.verify({ paymentPayload: payload(), paymentRequirements: requirements, requestHash: hashRequest('{}') }),
    ).resolves.toMatchObject({ isValid: false, invalidReason: FACILITATOR_REASON.unbound });
    await expect(facilitator.verify({ paymentPayload: payload(), paymentRequirements: requirements })).resolves.toMatchObject({
      isValid: false,
      invalidReason: FACILITATOR_REASON.unbound,
    });
  });

  it('records the lock once under its derived name, charges no relay fee and keeps the claim', async () => {
    const { ledger, facilitator } = build();
    const result = await settle(facilitator, payload());
    expect(result).toMatchObject({ success: true, transaction: TX, feeMicro: '0' });
    expect(ledger.calls.some((call) => call.kind === 'release')).toBe(false);

    const [recorded] = directRecords(ledger);
    expect(recorded?.kind === 'direct' && recorded.input).toMatchObject({
      nonce,
      lock: { chainId: 4663, escrow: ESCROW, id: 7n },
    });

    // The replay guard holds the claim, so a second redemption of the same lock records nothing.
    const again = await settle(facilitator, payload());
    expect(again.settlementId).toBeUndefined();
    expect(directRecords(ledger)).toHaveLength(1);
  });

  it('takes a payload that names the derived nonce itself', async () => {
    const { facilitator } = build();
    const named: PaymentPayload = { ...payload(), payload: { ...payload().payload, authorization: { nonce } } };
    await expect(settle(facilitator, named)).resolves.toMatchObject({ success: true, transaction: TX });
  });

  /**
   * The same lock, presented under a salt and a nonce of the payer's choosing. This is the shape
   * that used to settle again: the nonce binds the request through the fresh salt, the lock
   * reference is unchanged, and only the name the settlement is recorded under is new.
   */
  const replay = (salt: Hex, inputCommit: Hex = commit): PaymentPayload => ({
    x402Version: 2,
    accepted: requirements,
    payload: {
      lock: { escrow: ESCROW, id: '7', mandate: MANDATE, transaction: TX, inputCommit },
      authorization: { nonce: deriveNonce({ requestHash, salt }) },
      binding: { requestHash, salt },
    },
  });

  /** The honest payload, except that it names the lock under a nonce of its own. */
  const renamed = (name: Hex): PaymentPayload => ({ ...payload(), payload: { ...payload().payload, authorization: { nonce: name } } });

  const salts = Array.from({ length: 5 }, (_, index) => `0x${(index + 1).toString(16).padStart(2, '0').repeat(32)}` as Hex);

  it('settles a lock once, however many fresh nonces are presented for it', async () => {
    const { ledger, facilitator } = build();
    expect((await settle(facilitator, payload())).success).toBe(true);

    for (const salt of salts) {
      expect((await settle(facilitator, replay(salt))).success).toBe(false);
      expect(await settle(facilitator, renamed(deriveNonce({ requestHash, salt })))).toMatchObject({
        success: false,
        errorReason: ESCROW_REASON.nonce,
      });
    }
    expect(directRecords(ledger)).toHaveLength(1);
  });

  it('settles a lock from an earlier client once too, under the same fresh nonces', async () => {
    // The lock as clients opened it before they published an input: no URI, and the commitment is
    // the request-bound nonce itself.
    const legacy = deriveNonce({ requestHash, salt: SALT });
    const ledger = new FakeLedger();
    const facilitator = new Facilitator({
      scheme: scheme(chain({ inputCommit: legacy, inputURI: '' })),
      budget: new SettlementBudget({ dailySettlements: 50, perPayerPerHour: 50 }),
      ledger,
      treasury: '0x000000000000000000000000000000000000beef',
      feeBps: 100,
      feeFloorMicro: toMicro(1_900),
    });

    expect((await settle(facilitator, payload({ inputCommit: legacy }))).success).toBe(true);
    for (const salt of salts) {
      expect((await settle(facilitator, replay(salt, legacy))).success).toBe(false);
    }
    expect(directRecords(ledger)).toHaveLength(1);
  });

  it('yields one success when settles for one lock race each other', async () => {
    const { ledger, facilitator } = build();
    const results = await Promise.all(
      [payload(), payload(), payload(), ...salts.map((salt) => replay(salt)), renamed(salts[0] as Hex)].map((entry) =>
        settle(facilitator, entry),
      ),
    );

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(directRecords(ledger)).toHaveLength(1);
  });

  it('refuses a nonce that is not derived from the lock, before anything is claimed', async () => {
    const { ledger, facilitator } = build();
    const other = renamed(deriveNonce({ requestHash, salt: salts[0] as Hex }));

    await expect(
      facilitator.verify({ paymentPayload: other, paymentRequirements: requirements, requestHash }),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ESCROW_REASON.nonce, payer: MANDATE });
    await expect(settle(facilitator, other)).resolves.toMatchObject({ success: false, errorReason: ESCROW_REASON.nonce });

    // The lock presented under a fresh salt as well does not get as far as its nonce: the salt is
    // part of what the lock committed to.
    await expect(
      facilitator.verify({ paymentPayload: replay(salts[0] as Hex), paymentRequirements: requirements, requestHash }),
    ).resolves.toMatchObject({ isValid: false, invalidReason: FACILITATOR_REASON.unbound });
    expect(ledger.calls).toHaveLength(0);
  });

  it('refuses to verify a lock it has already settled, the way a token refuses a spent nonce', async () => {
    const { ledger, facilitator } = build();
    const request = { paymentPayload: payload(), paymentRequirements: requirements, requestHash };
    await expect(facilitator.verify(request)).resolves.toMatchObject({ isValid: true });

    expect((await settle(facilitator, payload())).success).toBe(true);
    ledger.records.set(`eip155:4663:${MANDATE.toLowerCase()}:${nonce}`, {
      settlement: settlementFixture({ txHash: TX, feeMicro: toMicro(0) }),
      txHash: TX,
      reservationId: null,
    });

    // The lock is still open on chain, because the merchant has not released it yet. A provider
    // that verifies before it serves is told the lock has bought its one call.
    await expect(facilitator.verify(request)).resolves.toMatchObject({
      isValid: false,
      invalidReason: FACILITATOR_REASON.replay,
      payer: MANDATE,
    });

    // The settle that already happened is still answered with its own settlement, and reports no
    // broadcast, because this service never sent one for a lock.
    await expect(settle(facilitator, payload())).resolves.toMatchObject({ success: true, broadcast: false, transaction: TX });
    expect(directRecords(ledger)).toHaveLength(1);
  });

  it('refuses the settle and gives the claim back when the ledger cannot record the lock', async () => {
    const { ledger, facilitator } = build();
    ledger.writesFail = new Error('connection terminated unexpectedly');

    // Nothing was broadcast for a lock, so there is nothing to report as landed. A success here
    // would have the merchant serve a lock this service kept no record of.
    const failed = await settle(facilitator, payload());
    expect(failed).toMatchObject({ success: false, settled: false, broadcast: false, errorReason: FACILITATOR_REASON.unrecorded });
    expect(ledger.kinds()).toEqual(['claim', 'direct', 'release']);

    ledger.writesFail = null;
    await expect(settle(facilitator, payload())).resolves.toMatchObject({ success: true, transaction: TX });
  });

  it('refuses a lock the ledger already holds on another settlement, and gives the claim back', async () => {
    const { ledger, facilitator } = build();
    ledger.redeemed.add(`4663:${ESCROW.toLowerCase()}:7`);

    const result = await settle(facilitator, payload());
    expect(result).toMatchObject({ success: false, errorReason: FACILITATOR_REASON.replay });
    expect(ledger.kinds()).toEqual(['claim', 'direct', 'release']);
  });
});
