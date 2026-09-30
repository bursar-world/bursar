import { beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import { privateKeyToAccount } from 'viem/accounts';
import { SettlementBudget } from '../src/x402/budget.js';
import { deriveNonce } from '@bursar/core';
import { hashRequest } from '../src/x402/binding.js';
import { RECEIPT_WAIT_MS } from '@bursar/x402';
import { CLAIM_MARGIN_MS, Facilitator, readRequest } from '../src/x402/facilitator.js';
import { authorizationNonce } from '../src/x402/contract.js';
import type { PaymentPayload, PaymentRequirements } from '../src/x402/contract.js';
import type { RebateReader } from '../src/x402/rebate.js';
import {
  FakeLedger,
  ScriptedScheme,
  ThrowingScheme,
  reservationFixture,
  settlementFixture,
} from './support/doubles.js';

function nonceOf(payload: PaymentPayload): string {
  return authorizationNonce(payload) ?? '';
}

const payer = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const NONCE = `0x${'7e'.repeat(32)}`;
const SALT = `0x${'5a'.repeat(32)}` as `0x${string}`;
const NETWORK = 'eip155:4663';
const TX = `0x${'ab'.repeat(32)}`;
const FEE_FLOOR = toMicro(1_900);

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: NETWORK,
  amount: '1000000',
  asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  payTo: '0x000000000000000000000000000000000000dEaD',
};

/**
 * A payload bound the way a client binds one: the authorisation nonce is derived from the request
 * digest, so redeeming it against any other request fails the derivation.
 */
function boundPayload(body: string, salt = SALT): PaymentPayload {
  const requestHash = hashRequest(body);
  const nonce = deriveNonce({ requestHash, salt });
  return {
    x402Version: 2,
    accepted: requirements,
    payload: {
      authorization: { from: payer.address, nonce },
      signature: '0xsig',
      binding: { requestHash, salt },
    },
  };
}

const RESERVATION = '33333333-3333-4333-8333-333333333333';

function build(
  overrides: {
    requireBinding?: boolean;
    feeBps?: number;
    rebateOf?: RebateReader;
    log?: (line: string) => void;
  } = {},
) {
  const scheme = new ScriptedScheme({
    verify: { isValid: true, payer: payer.address },
    settle: { success: true, settled: true, broadcast: true, payer: payer.address, transaction: TX, network: NETWORK },
  });
  const ledger = new FakeLedger();
  // The hold the standard terms above would open: same payer, same merchant, same amount.
  ledger.reservation = reservationFixture({
    id: RESERVATION,
    payerWallet: payer.address,
    merchantWallet: String(requirements.payTo),
    amountMicro: toMicro(1_000_000),
    lockedMicro: toMicro(1_000_000),
  });
  const budget = new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 });
  const facilitator = new Facilitator({
    scheme,
    budget,
    ledger,
    treasury: '0x000000000000000000000000000000000000beef',
    feeBps: overrides.feeBps ?? 100,
    feeFloorMicro: FEE_FLOOR,
    rebateOf: overrides.rebateOf,
    requireBinding: overrides.requireBinding ?? true,
    log: overrides.log,
  });
  return { scheme, ledger, budget, facilitator };
}

/** A facilitator wired to a scheme that throws, with binding off so the payload can stay minimal. */
function throwing(error: Error) {
  const ledger = new FakeLedger();
  const budget = new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 });
  return {
    ledger,
    budget,
    facilitator: new Facilitator({
      scheme: new ThrowingScheme(error),
      budget,
      ledger,
      treasury: '0x000000000000000000000000000000000000beef',
      feeBps: 100,
      feeFloorMicro: FEE_FLOOR,
      requireBinding: false,
    }),
  };
}

describe('fee', () => {
  it('takes basis points once they clear the gas floor', () => {
    const { facilitator } = build({ feeBps: 100 });
    expect(facilitator.fee(toMicro(1_000_000))).toEqual({ feeMicro: 10_000n, rebateBps: 0, rebateMicro: 0n });
  });

  it('never charges less than a settled call costs in gas', () => {
    const { facilitator } = build({ feeBps: 100 });
    expect(facilitator.fee(toMicro(10_000)).feeMicro).toBe(FEE_FLOOR);
  });

  it('never charges more than the payment itself', () => {
    const { facilitator } = build({ feeBps: 100 });
    expect(facilitator.fee(toMicro(500)).feeMicro).toBe(500n);
  });

  it('takes a rebate off the part of the fee above the floor, and no further', () => {
    const { facilitator } = build({ feeBps: 100 });
    // 1% of 0.25 USDG is 2,500. 30% off would leave 1,750, under what the broadcast costs.
    expect(facilitator.fee(toMicro(250_000), 3_000)).toEqual({ feeMicro: FEE_FLOOR, rebateBps: 3_000, rebateMicro: 600n });
    // 1% of 0.1 USDG is already under the floor, so a staked payee pays what anyone else does.
    expect(facilitator.fee(toMicro(100_000), 3_000)).toEqual({ feeMicro: FEE_FLOOR, rebateBps: 3_000, rebateMicro: 0n });
  });

  it('rounds the rebated fee toward zero, as the contracts round a fee', () => {
    const { facilitator } = build({ feeBps: 100 });
    // 1% of 1,234,567 is 12,345; 5% off leaves 11,727.75, charged as 11,727.
    expect(facilitator.fee(toMicro(1_234_567), 500)).toEqual({ feeMicro: 11_727n, rebateBps: 500, rebateMicro: 618n });
  });

  it('refuses a fee outside basis points at construction', () => {
    expect(() => build({ feeBps: 10_001 })).toThrow(RangeError);
  });
});

describe('verify', () => {
  it('passes a refusal from the scheme straight back', async () => {
    const { scheme, facilitator } = build();
    scheme.set({ verify: { isValid: false, invalidReason: 'insufficient_funds', payer: payer.address } });
    const result = await facilitator.verify({
      paymentPayload: boundPayload('{}'),
      paymentRequirements: requirements,
      requestHash: hashRequest('{}'),
    });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'insufficient_funds' });
  });

  it('refuses a payment with no proof it was signed for this request', async () => {
    const { facilitator } = build();
    const result = await facilitator.verify({
      paymentPayload: {
        accepted: requirements,
        payload: { authorization: { from: payer.address, nonce: NONCE }, signature: '0xsig' },
      },
      paymentRequirements: requirements,
      requestHash: hashRequest('{}'),
    });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'payment_not_bound_to_request' });
  });

  it('accepts a payment bound to the request that arrived', async () => {
    const { facilitator } = build();
    const body = '{"prompt":"hello"}';
    const result = await facilitator.verify({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });
    expect(result).toEqual({ isValid: true, payer: payer.address });
  });

  it('takes an unbound payment when binding is switched off', async () => {
    const { facilitator } = build({ requireBinding: false });
    const result = await facilitator.verify({
      paymentPayload: { payload: { authorization: { nonce: NONCE } } },
      paymentRequirements: requirements,
    });
    expect(result).toMatchObject({ isValid: true });
  });
});

describe('settle', () => {
  let harness: ReturnType<typeof build>;
  beforeEach(() => {
    harness = build();
  });

  it('refuses before claiming a nonce or spending budget when the scheme says no', async () => {
    harness.scheme.set({ verify: { isValid: false, invalidReason: 'insufficient_funds' } });
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload('{}'),
      paymentRequirements: requirements,
      requestHash: hashRequest('{}'),
    });
    expect(result).toMatchObject({ success: false, errorReason: 'insufficient_funds' });
    expect(harness.ledger.calls).toEqual([]);
    expect(harness.budget.state().settlementsToday).toBe(0);
    expect(harness.scheme.settleCalls).toBe(0);
  });

  it('records a direct settlement and announces it once', async () => {
    const body = '{"prompt":"hello"}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });
    expect(result.success).toBe(true);
    expect(result.settlementId).toBeTruthy();
    expect(result.feeMicro).toBe('10000');

    // The fee row and the trust event are written on the settlement's own transaction, so there is
    // no second call here to lose.
    expect(harness.ledger.kinds()).toEqual(['claim', 'direct']);
  });

  it('closes the named reservation instead of recording a direct payment', async () => {
    const body = '{}';
    await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });
    // Claimed before the broadcast, then consumed and marked paid in one ledger call.
    expect(harness.ledger.kinds()).toEqual(['readHold', 'claim', 'claimHold', 'settleHold']);
  });

  it('claims the hold before broadcasting, and refuses a second settle naming it', async () => {
    // Another settle already holds the claim. Without one taken before the broadcast, both reach
    // the chain and the payer is charged twice for one hold.
    harness.ledger.holdClaims.set(RESERVATION, 'eip155:4663:0xother:0xnonce');
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });

    expect(result).toMatchObject({ success: false, broadcast: false, errorReason: 'reservation_not_claimable' });
    expect(harness.scheme.settleCalls).toBe(0);
    expect(harness.ledger.kinds()).toEqual(['readHold', 'claim', 'claimHold', 'release']);
    expect(harness.budget.state().settlementsToday).toBe(0);
  });

  it('asks for a hold with a receipt wait still to run', async () => {
    const body = '{}';
    await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });
    const claim = harness.ledger.calls.find((call) => call.kind === 'claimHold');
    expect(claim).toMatchObject({ minRemainingMs: CLAIM_MARGIN_MS });
    expect(CLAIM_MARGIN_MS).toBe(RECEIPT_WAIT_MS);
  });

  it('gives the hold back with the nonce when nothing was broadcast', async () => {
    harness.scheme.set({
      verify: { isValid: true, payer: payer.address },
      settle: {
        success: false,
        settled: false,
        broadcast: false,
        errorReason: 'invalid_transaction_state',
        payer: payer.address,
        transaction: '',
        network: NETWORK,
      },
    });
    const body = '{}';
    await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });
    expect(harness.ledger.holdClaims.has(RESERVATION)).toBe(false);
  });

  it('refuses the same authorisation a second time', async () => {
    const body = '{}';
    const request = {
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    };
    expect((await harness.facilitator.settle(request)).success).toBe(true);
    const replay = await harness.facilitator.settle(request);
    expect(replay).toMatchObject({ success: false, errorReason: 'payment_already_used' });
    expect(harness.scheme.settleCalls).toBe(1);
  });

  it('gives back the nonce and the allowance when nothing was broadcast', async () => {
    harness.scheme.set({
      verify: { isValid: true, payer: payer.address },
      settle: {
        success: false,
        settled: false,
        broadcast: false,
        errorReason: 'invalid_transaction_state',
        payer: payer.address,
        transaction: '',
        network: NETWORK,
      },
    });
    const body = '{}';
    await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });
    expect(harness.ledger.kinds()).toEqual(['claim', 'release']);
    expect(harness.budget.state().settlementsToday).toBe(0);
  });

  it('keeps the nonce and the allowance when the broadcast could not be read back', async () => {
    harness.scheme.set({
      verify: { isValid: true, payer: payer.address },
      settle: {
        success: false,
        settled: null,
        broadcast: true,
        errorReason: 'settlement_unconfirmed',
        payer: payer.address,
        transaction: TX,
        network: NETWORK,
      },
    });
    const body = '{}';
    await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });

    // No settlement row is written for an unread broadcast, so the guard row this payment already
    // owns is the only place its hash can live.
    expect(harness.ledger.kinds()).toEqual(['claim', 'keepHash']);
    expect(harness.ledger.calls.at(-1)).toMatchObject({ kind: 'keepHash', txHash: TX });
    expect(harness.budget.state().settlementsToday).toBe(1);
  });

  it('refuses a per-call settlement worth less than its own gas', async () => {
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: { ...requirements, amount: '1000' },
      requestHash: hashRequest(body),
    });
    expect(result).toMatchObject({ errorReason: 'amount_below_settlement_floor' });
    expect(harness.ledger.calls).toEqual([]);
  });

  it('holds a settle naming a reservation to the same floor, since it broadcasts all the same', async () => {
    harness.ledger.reservation = reservationFixture({
      id: RESERVATION,
      payerWallet: payer.address,
      merchantWallet: String(requirements.payTo),
      amountMicro: toMicro(1_000),
      lockedMicro: toMicro(1_000),
    });
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: { ...requirements, amount: '1000' },
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });

    // The relayer pays the same gas for this transfer as for a direct one, and ten micro of fee
    // does not cover it.
    expect(result).toMatchObject({ success: false, errorReason: 'amount_below_settlement_floor' });
    expect(harness.scheme.settleCalls).toBe(0);
    expect(harness.ledger.calls).toEqual([]);
  });

  it('charges the floor on a reservation settle it broadcasts', async () => {
    harness.ledger.reservation = reservationFixture({
      id: RESERVATION,
      payerWallet: payer.address,
      merchantWallet: String(requirements.payTo),
      amountMicro: toMicro(100_000),
      lockedMicro: toMicro(100_000),
    });
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: { ...requirements, amount: '100000' },
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });
    expect(result).toMatchObject({ success: true, feeMicro: FEE_FLOOR.toString() });
  });

  it('gives the nonce back when the budget refuses', async () => {
    const budgetless = new Facilitator({
      scheme: harness.scheme,
      budget: new SettlementBudget({ dailySettlements: 0 }),
      ledger: harness.ledger,
      treasury: '0x000000000000000000000000000000000000beef',
      feeBps: 100,
      feeFloorMicro: FEE_FLOOR,
    });
    const body = '{}';
    const result = await budgetless.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });
    expect(result).toMatchObject({ errorReason: 'daily_budget_exhausted' });
    expect(harness.ledger.kinds()).toEqual(['claim', 'release']);
    expect(harness.scheme.settleCalls).toBe(0);
  });

  it('keeps the nonce and the allowance when a permit landed and the pull reverted', async () => {
    harness.scheme.set({
      verify: { isValid: true, payer: payer.address },
      settle: {
        success: false,
        settled: false,
        broadcast: true,
        errorReason: 'invalid_transaction_state',
        payer: payer.address,
        transaction: TX,
        network: NETWORK,
        method: 'eip2612',
      },
    });
    const body = '{}';
    await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });

    // Gas is spent, the permit nonce has moved and an allowance to the relayer is standing. Giving
    // the budget slot or the claim back would pay for that twice, and the hash of what did land
    // goes on the guard row because nothing else records it.
    expect(harness.ledger.kinds()).toEqual(['claim', 'keepHash']);
    expect(harness.budget.state().settlementsToday).toBe(1);
  });

  it('gives the nonce and the allowance back when the scheme says it never sent anything', async () => {
    const unsent = Object.assign(new Error('no endpoint configured'), { broadcast: false });
    const { ledger, budget, facilitator } = throwing(unsent);

    const result = await facilitator.settle({
      paymentPayload: { payload: { authorization: { nonce: NONCE } } },
      paymentRequirements: requirements,
    });

    expect(result).toMatchObject({
      success: false,
      settled: false,
      broadcast: false,
      errorReason: 'settlement_scheme_unavailable',
    });
    expect(ledger.kinds()).toEqual(['claim', 'release']);
    expect(budget.state().settlementsToday).toBe(0);
  });

  it('hands back the transaction when the payment landed and the ledger write failed', async () => {
    harness.ledger.writesFail = new Error('connection terminated unexpectedly');
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });

    expect(result).toMatchObject({
      success: true,
      settled: true,
      transaction: TX,
      errorReason: 'settlement_not_recorded',
    });
    expect(result.settlementId).toBeUndefined();
    expect(result.detail).not.toContain('connection terminated');

    // The hash goes onto the row this payment already owns, so a transfer that is on chain is not
    // left with nothing pointing at it.
    expect(harness.ledger.kinds()).toEqual(['claim', 'direct', 'keepHash']);
    expect(harness.ledger.calls.at(-1)).toMatchObject({ kind: 'keepHash', txHash: TX });
  });

  it('claims and records the nonce under one spelling of the network', async () => {
    const body = '{}';
    await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: { ...requirements, network: 'EIP155:4663' },
      requestHash: hashRequest(body),
    });

    // The guard is keyed on what is claimed. Claiming `EIP155:...` and recording `eip155:...`
    // leaves two rows for one payment, each good for its own budget slot.
    const claim = harness.ledger.calls.find((call) => call.kind === 'claim');
    const direct = harness.ledger.calls.find((call) => call.kind === 'direct');
    expect(claim).toMatchObject({ network: NETWORK });
    expect(direct?.kind === 'direct' ? direct.input.network : '').toBe(NETWORK);
  });

  it('refuses a replay however the client spells the network', async () => {
    const body = '{}';
    const request = {
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    };
    expect((await harness.facilitator.settle(request)).success).toBe(true);

    const replay = await harness.facilitator.settle({
      ...request,
      paymentRequirements: { ...requirements, network: ' EIP155:4663 ' },
    });
    expect(replay).toMatchObject({ success: false, errorReason: 'payment_already_used' });
    expect(harness.scheme.settleCalls).toBe(1);
  });

  it('keeps the claim when a scheme throws without saying whether it sent anything', async () => {
    const { ledger, budget, facilitator } = throwing(new Error('socket hang up'));

    const result = await facilitator.settle({
      paymentPayload: { payload: { authorization: { nonce: NONCE } } },
      paymentRequirements: requirements,
    });

    // A lost response to an accepted eth_sendRawTransaction is indistinguishable from a send that
    // never happened. Handing the claim back on one would let the same authorisation be submitted
    // again against a transfer that is already mining.
    expect(ledger.kinds()).toEqual(['claim']);
    expect(budget.state().settlementsToday).toBe(1);
    expect(result).toMatchObject({
      success: false,
      settled: null,
      broadcast: true,
      errorReason: 'settlement_scheme_unavailable',
    });
  });

  it('refuses a payment that does not pay the reservation it names, before broadcasting', async () => {
    // Reservation for a million micro to the merchant, payment for five thousand to the attacker.
    // Both the payload and the terms it is checked against come from the caller, so the scheme
    // verifies it happily: the only thing that can catch it is the hold the settle names.
    const attacker = '0x00000000000000000000000000000000000000a7';
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: { ...requirements, amount: '5000', payTo: attacker },
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });

    expect(result).toMatchObject({ success: false, errorReason: 'lane_amount_mismatch' });
    expect(harness.ledger.kinds()).toEqual(['readHold']);
    expect(harness.scheme.settleCalls).toBe(0);
    expect(harness.budget.state().settlementsToday).toBe(0);
  });

  it('refuses a payment from a wallet the reservation was not opened for', async () => {
    const body = '{}';
    harness.ledger.reservation = reservationFixture({
      id: RESERVATION,
      payerWallet: '0x00000000000000000000000000000000000000b0',
      merchantWallet: String(requirements.payTo),
      amountMicro: toMicro(1_000_000),
      lockedMicro: toMicro(1_000_000),
    });

    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });

    expect(result).toMatchObject({ success: false, errorReason: 'lane_amount_mismatch' });
    expect(harness.scheme.settleCalls).toBe(0);
  });

  it('refuses a settle naming a reservation that does not exist', async () => {
    harness.ledger.reservation = null;
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });

    expect(result).toMatchObject({ success: false, errorReason: 'invalid_lane_reference' });
    expect(harness.scheme.settleCalls).toBe(0);
  });

  it('names the mismatch, not a failed write, when the ledger refuses a landed payment', async () => {
    // The check above runs before the broadcast, so reaching the ledger's own check means the hold
    // changed in between. The money has moved by then, and the answer has to say which it was.
    harness.ledger.beforeConsume = () => {
      harness.ledger.reservation = reservationFixture({ id: RESERVATION, amountMicro: toMicro(7) });
    };
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
      reservationId: RESERVATION,
    });

    expect(result).toMatchObject({ errorReason: 'lane_amount_mismatch', transaction: TX });
    expect(harness.ledger.kinds()).toEqual(['readHold', 'claim', 'claimHold', 'settleHold', 'keepHash']);
  });

  it('answers a retry of a landed settle with the settlement it paid for', async () => {
    const body = '{}';
    const request = {
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    };
    const first = await harness.facilitator.settle(request);
    harness.ledger.records.set(`${NETWORK}:${payer.address.toLowerCase()}:${nonceOf(request.paymentPayload)}`, {
      settlement: settlementFixture({ txHash: TX, feeMicro: toMicro(10_000) }),
      txHash: TX,
      reservationId: null,
    });

    // The token reports the nonce spent once the transfer lands, so verification refuses the
    // retry. The caller was owed a success the first time and is owed the same one now.
    harness.scheme.set({
      verify: { isValid: false, invalidReason: 'invalid_transaction_state', payer: payer.address },
    });
    const retry = await harness.facilitator.settle(request);

    expect(retry).toMatchObject({
      success: true,
      settled: true,
      transaction: TX,
      settlementId: first.settlementId,
      feeMicro: '10000',
    });
    expect(harness.scheme.settleCalls).toBe(1);
  });

  it('says a retry is pending when the first settle broadcast and recorded nothing yet', async () => {
    const body = '{}';
    const request = {
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    };
    harness.ledger.records.set(`${NETWORK}:${payer.address.toLowerCase()}:${nonceOf(request.paymentPayload)}`, {
      settlement: null,
      txHash: TX,
      reservationId: null,
    });
    await harness.ledger.claimPaymentNonce({
      network: NETWORK,
      payerWallet: payer.address,
      nonce: nonceOf(request.paymentPayload),
      amountMicro: toMicro(1_000_000),
    });

    const retry = await harness.facilitator.settle(request);
    expect(retry).toMatchObject({
      success: false,
      settled: null,
      broadcast: true,
      errorReason: 'settlement_pending',
      transaction: TX,
    });
    expect(harness.scheme.settleCalls).toBe(0);
  });

  it('refuses rather than throws when giving a claim back fails', async () => {
    harness.ledger.releaseFails = new Error('connection terminated unexpectedly');
    const logged: string[] = [];
    const facilitator = new Facilitator({
      scheme: harness.scheme,
      budget: new SettlementBudget({ dailySettlements: 0 }),
      ledger: harness.ledger,
      treasury: '0x000000000000000000000000000000000000beef',
      feeBps: 100,
      feeFloorMicro: FEE_FLOOR,
      log: (line) => logged.push(line),
    });
    const body = '{}';
    const result = await facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });

    expect(result).toMatchObject({ success: false, errorReason: 'daily_budget_exhausted' });
    expect(logged.some((line) => line.includes('nonce release failed'))).toBe(true);
  });

  it('logs what the scheme threw and tells the caller only the reason', async () => {
    const { facilitator } = throwing(new Error('request to https://rpc.example/v2/SECRETKEY failed'));
    const result = await facilitator.settle({
      paymentPayload: { payload: { authorization: { nonce: NONCE } } },
      paymentRequirements: requirements,
    });
    expect(result.errorReason).toBe('settlement_scheme_unavailable');
    expect(JSON.stringify(result)).not.toContain('SECRETKEY');
  });

  it('does not forward a scheme detail to the caller', async () => {
    harness.scheme.set({
      verify: { isValid: true, payer: payer.address },
      settle: {
        success: false,
        settled: null,
        broadcast: true,
        errorReason: 'settlement_unconfirmed',
        payer: payer.address,
        transaction: TX,
        network: NETWORK,
        detail: 'timed out at https://rpc.example/v2/SECRETKEY',
      },
    });
    const body = '{}';
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    });
    expect(result).toMatchObject({ errorReason: 'settlement_unconfirmed', transaction: TX });
    expect(JSON.stringify(result)).not.toContain('SECRETKEY');
  });

  it('refuses terms that state no price', async () => {
    const body = '{}';
    const { amount, ...priceless } = requirements;
    void amount;
    const result = await harness.facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: priceless,
      requestHash: hashRequest(body),
    });
    expect(result).toMatchObject({ errorReason: 'invalid_payment_requirements' });
  });
});

describe('the staking rebate', () => {
  const PAYEE = String(requirements.payTo);

  function settle(facilitator: Facilitator, amount = '1000000', reservationId?: string) {
    const body = '{}';
    return facilitator.settle({
      paymentPayload: boundPayload(body),
      paymentRequirements: { ...requirements, amount },
      requestHash: hashRequest(body),
      ...(reservationId ? { reservationId } : {}),
    });
  }

  // Each tier the pool can report for a payee: none, then 5%, 10%, 20% and 30% off the fee.
  it.each([
    [0, '10000', '0'],
    [500, '9500', '500'],
    [1_000, '9000', '1000'],
    [2_000, '8000', '2000'],
    [3_000, '7000', '3000'],
  ])('charges a payee at %i basis points its rebated fee', async (tier, fee, rebate) => {
    const asked: string[] = [];
    const { ledger, facilitator } = build({
      rebateOf: async (payee) => {
        asked.push(payee);
        return tier;
      },
    });

    const result = await settle(facilitator);

    expect(result).toMatchObject({ success: true, feeMicro: fee, rebateBps: tier, rebateMicro: rebate });
    expect(ledger.calls.find((call) => call.kind === 'direct')).toMatchObject({
      input: { feeMicro: BigInt(fee), rebateBps: tier, rebateMicro: BigInt(rebate) },
    });
    // The fee comes out of what the payee receives, so the payee's stake is the one that counts.
    expect(asked).toEqual([PAYEE.toLowerCase()]);
  });

  it('ignores the payer\'s stake, which buys nothing off the payee\'s fee', async () => {
    const { facilitator } = build({
      rebateOf: async (party) => (party === payer.address.toLowerCase() ? 3_000 : 0),
    });
    expect(await settle(facilitator)).toMatchObject({ feeMicro: '10000', rebateBps: 0, rebateMicro: '0' });
  });

  it('holds the fee at the floor however large the rebate', async () => {
    const staked = () => build({ rebateOf: async () => 3_000 }).facilitator;
    expect(await settle(staked(), '250000')).toMatchObject({
      success: true,
      feeMicro: FEE_FLOOR.toString(),
      rebateBps: 3_000,
      rebateMicro: '600',
    });
    expect(await settle(staked(), '100000')).toMatchObject({
      success: true,
      feeMicro: FEE_FLOOR.toString(),
      rebateBps: 3_000,
      rebateMicro: '0',
    });
  });

  it('charges the full fee when the pool cannot be read, and logs why', async () => {
    const lines: string[] = [];
    const { facilitator } = build({
      rebateOf: async () => {
        throw new Error('execution reverted');
      },
      log: (line) => lines.push(line),
    });

    expect(await settle(facilitator)).toMatchObject({
      success: true,
      feeMicro: '10000',
      rebateBps: 0,
      rebateMicro: '0',
    });
    expect(lines).toContain(`rebate unread payee=${PAYEE} fee=full reason=execution reverted`);
  });

  it('prices a settle that closes a reservation the same way', async () => {
    const { ledger, facilitator } = build({ rebateOf: async () => 2_000 });
    const result = await settle(facilitator, '1000000', RESERVATION);

    expect(result).toMatchObject({ success: true, feeMicro: '8000', rebateBps: 2_000, rebateMicro: '2000' });
    expect(ledger.calls.find((call) => call.kind === 'settleHold')).toMatchObject({
      feeMicro: 8_000n,
      rebateBps: 2_000,
      rebateMicro: 2_000n,
    });
  });

  it('answers a retry with the rebate the settlement was recorded at', async () => {
    const { scheme, ledger, facilitator } = build({ rebateOf: async () => 3_000 });
    const body = '{}';
    const request = {
      paymentPayload: boundPayload(body),
      paymentRequirements: requirements,
      requestHash: hashRequest(body),
    };
    await facilitator.settle(request);
    ledger.records.set(`${NETWORK}:${payer.address.toLowerCase()}:${nonceOf(request.paymentPayload)}`, {
      settlement: settlementFixture({
        txHash: TX,
        feeMicro: toMicro(7_000),
        rebateBps: 3_000,
        rebateMicro: toMicro(3_000),
      }),
      txHash: TX,
      reservationId: null,
    });

    scheme.set({ verify: { isValid: false, invalidReason: 'invalid_transaction_state', payer: payer.address } });
    expect(await facilitator.settle(request)).toMatchObject({
      success: true,
      feeMicro: '7000',
      rebateBps: 3_000,
      rebateMicro: '3000',
    });
  });

  it('records no fee and no rebate on a lock the mandate lane settles without a broadcast', async () => {
    const { scheme, ledger, facilitator } = build({ rebateOf: async () => 3_000 });
    scheme.set({
      verify: { isValid: true, payer: payer.address },
      settle: { success: true, settled: true, broadcast: false, payer: payer.address, transaction: TX, network: NETWORK },
    });

    expect(await settle(facilitator)).toMatchObject({ success: true, feeMicro: '0', rebateBps: 0, rebateMicro: '0' });
    expect(ledger.calls.find((call) => call.kind === 'direct')).toMatchObject({
      input: { feeMicro: 0n, rebateBps: 0, rebateMicro: 0n },
    });
  });
});

describe('request reading', () => {
  it('refuses a body that is not an object', () => {
    expect(readRequest(null)).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(readRequest('a string')).toEqual({ ok: false, reason: 'invalid_payload' });
  });

  it('separates a missing payload from missing terms', () => {
    expect(readRequest({ paymentRequirements: {} })).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(readRequest({ paymentPayload: {} })).toEqual({
      ok: false,
      reason: 'invalid_payment_requirements',
    });
  });

  it('refuses a request hash that is not a sha256 digest', () => {
    expect(
      readRequest({ paymentPayload: {}, paymentRequirements: {}, requestHash: 'short' }),
    ).toEqual({ ok: false, reason: 'invalid_payload' });
  });

  it('refuses a reservation reference that is not an identifier', () => {
    expect(
      readRequest({ paymentPayload: {}, paymentRequirements: {}, reservationId: 'drop table' }),
    ).toEqual({ ok: false, reason: 'invalid_lane_reference' });
  });

  it('accepts a complete request', () => {
    const parsed = readRequest({
      paymentPayload: { payload: {} },
      paymentRequirements: { network: NETWORK },
      requestHash: hashRequest('{}'),
      reservationId: '33333333-3333-4333-8333-333333333333',
    });
    expect(parsed.ok).toBe(true);
  });
});
