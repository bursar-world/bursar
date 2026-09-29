import { describe, expect, it } from 'vitest';
import { capabilityId, deriveNonce, toMicro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { SettlementBudget } from '../src/x402/budget.js';
import { hashRequest } from '../src/x402/binding.js';
import { authorizationNonce } from '../src/x402/contract.js';
import type { PaymentPayload, PaymentRequirements, PaymentScheme } from '../src/x402/contract.js';
import {
  ESCROW_REASON,
  createEscrowLockScheme,
  lockReference,
  routeSchemes,
} from '../src/x402/escrow-lock.js';
import type { EscrowChain, EscrowLock } from '../src/x402/escrow-lock.js';
import { Facilitator } from '../src/x402/facilitator.js';
import { FakeLedger, ScriptedScheme } from './support/doubles.js';

const ESCROW: Address = '0x4315F8be7C9661345710910577Ec31cb867f3c20';
const FACTORY: Address = '0xe9f8cc653fF40E346e0591f353Be58DF0533cfD0';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const MANDATE: Address = '0x420BeB507F72173E7d78e0f956968f64fb508356';
const PRINCIPAL: Address = '0x877c349EFb5926082C413833E8055F0991185c61';
const PAYEE: Address = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const TX: Hex = `0x${'ab'.repeat(32)}`;
const SALT: Hex = `0x${'5a'.repeat(32)}`;
const BODY = '{"prompt":"hello"}';
const NOW = 1_800_000_000n;

const requestHash = hashRequest(BODY);
const commit = deriveNonce({ requestHash, salt: SALT });

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

describe('escrow lock scheme', () => {
  it('accepts an open lock the mandate opened for this offer and names the mandate as payer', async () => {
    await expect(scheme().verify(payload(), requirements)).resolves.toMatchObject({ isValid: true, payer: MANDATE });
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
    await expect(scheme(c).verify(payload(), requirements)).resolves.toMatchObject({ isValid: false, invalidReason: reason });
  });

  it('refuses an escrow this deployment does not know', async () => {
    const result = await scheme().verify(payload({ escrow: PAYEE }), requirements);
    expect(result).toMatchObject({ isValid: false, invalidReason: ESCROW_REASON.escrow });
  });

  it('refuses an offer under another scheme or network', async () => {
    await expect(scheme().verify(payload(), { ...requirements, scheme: 'exact' })).resolves.toMatchObject({
      invalidReason: ESCROW_REASON.scheme,
    });
    await expect(scheme().verify(payload(), { ...requirements, network: 'eip155:1' })).resolves.toMatchObject({
      invalidReason: ESCROW_REASON.network,
    });
  });

  it('settles without broadcasting and reports the transaction that opened the lock', async () => {
    await expect(scheme().settle(payload(), requirements)).resolves.toMatchObject({
      success: true,
      settled: true,
      broadcast: false,
      payer: MANDATE,
      transaction: TX,
    });
  });

  it('reads the lock reference and its commitment as the payment nonce', () => {
    expect(lockReference(payload())).toMatchObject({ id: 7n, mandate: MANDATE });
    expect(lockReference(payload({ id: '-1' }))).toBeNull();
    expect(authorizationNonce(payload())).toBe(commit.toLowerCase());
  });

  it('routes offers by scheme', async () => {
    const exact = new ScriptedScheme({ verify: { isValid: false, invalidReason: 'from_exact' } });
    const routed: PaymentScheme = routeSchemes(exact, scheme());
    await expect(routed.verify(payload(), requirements)).resolves.toMatchObject({ isValid: true });
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
    const budget = new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 });
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

  it('binds the lock to the request it was opened for', async () => {
    const { facilitator } = build();
    await expect(
      facilitator.verify({ paymentPayload: payload(), paymentRequirements: requirements, requestHash }),
    ).resolves.toMatchObject({ isValid: true, payer: MANDATE });
    await expect(
      facilitator.verify({ paymentPayload: payload(), paymentRequirements: requirements, requestHash: hashRequest('{}') }),
    ).resolves.toMatchObject({ isValid: false });
  });

  it('records the lock once, charges no relay fee and keeps the claim so it cannot be redeemed again', async () => {
    const { ledger, facilitator } = build();
    const result = await facilitator.settle({ paymentPayload: payload(), paymentRequirements: requirements, requestHash });
    expect(result).toMatchObject({ success: true, transaction: TX, feeMicro: '0' });
    expect(ledger.calls.some((call) => call.kind === 'release')).toBe(false);

    // The replay guard holds the claim, so a second redemption of the same lock records nothing.
    const again = await facilitator.settle({ paymentPayload: payload(), paymentRequirements: requirements, requestHash });
    expect(again.settlementId).toBeUndefined();
    expect(ledger.calls.filter((call) => call.kind === 'direct')).toHaveLength(1);
  });
});
