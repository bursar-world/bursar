import { RHC_MAINNET } from '@bursar/core';
import { keccak256, toHex } from 'viem';
import { describe, expect, test } from 'vitest';

import { TRANSFER_WITH_AUTHORIZATION_TYPES } from '../src/eip3009.js';
import { createExactEvm, type ExactEvmOptions } from '../src/exact-evm.js';
import { controlFailure, issuerRefusal, revertText, simulationRefusal } from '../src/issuer.js';
import type { IssuerControls } from '../src/ports.js';
import type { PaymentPayload, PaymentRequirements } from '../src/types.js';
import {
  NOW,
  PAYER,
  PAY_TO,
  PRICE,
  USDG,
  USDG_ASSET,
  balanceKey,
  fakeChain,
  fakeSigner,
  type FakeChainState,
} from './support.js';

/**
 * The settlement asset's own controls, on the path that decides.
 *
 * USDG carries two of them and both answered when the token was read on 2026-09-22: `paused()`
 * stops every transfer, `isFrozen(address)` stops one address's. Neither belongs to this
 * facilitator and neither belongs to the payer, so what matters here is that they are named
 * separately from everything a retry can fix, and that a control which refuses to answer is
 * refused rather than assumed clear.
 */

const DOMAIN = {
  name: USDG_ASSET.name,
  version: USDG_ASSET.version,
  chainId: RHC_MAINNET.chainId,
  verifyingContract: USDG,
} as const;

const NONCE = keccak256(toHex('issuer-control-test'));

function requirements(overrides: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:4663',
    amount: '300000',
    asset: USDG,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

async function signed(): Promise<PaymentPayload> {
  const authorization = {
    from: PAYER.address,
    to: PAY_TO,
    value: PRICE,
    validAfter: BigInt(NOW - 60),
    validBefore: BigInt(NOW + 600),
    nonce: NONCE,
  } as const;

  const signature = await PAYER.signTypedData({
    domain: DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });

  return {
    x402Version: 2,
    accepted: requirements(),
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };
}

function build(state: FakeChainState = {}, options: Partial<ExactEvmOptions> = {}) {
  const funded: FakeChainState = { balances: balanceKey(PAYER.address, 1_000_000n), ...state };
  const client = fakeChain(funded);
  const signer = fakeSigner();
  const evm = createExactEvm({
    networks: [{ chain: RHC_MAINNET, client, assets: [USDG_ASSET], signer }],
    requireBinding: false,
    ...options,
  });
  return { evm, client, signer };
}

describe('the conditions the token issuer owns', () => {
  test('a frozen payer is named as frozen, not as a bad transaction state', async () => {
    const { evm } = build({ frozen: [PAYER.address] });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'payer_frozen',
      payer: PAYER.address,
    });
    if (!result.isValid) {
      expect(result.detail).toContain('token issuer');
      expect(result.detail).toContain(PAYER.address);
    }
  });

  test('a replayed nonce and a frozen payer no longer read the same', async () => {
    const replayed = await build({ spentNonces: [NONCE] }).evm.verify(await signed(), requirements(), {
      now: NOW,
    });
    const frozen = await build({ frozen: [PAYER.address] }).evm.verify(await signed(), requirements(), {
      now: NOW,
    });

    expect(replayed).toMatchObject({ isValid: false, invalidReason: 'invalid_transaction_state' });
    expect(frozen).toMatchObject({ isValid: false, invalidReason: 'payer_frozen' });
  });

  test('a frozen payee has its own refusal, because money cannot reach them either', async () => {
    const { evm } = build({ frozen: [PAY_TO] });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ isValid: false, invalidReason: 'payee_frozen' });
    if (!result.isValid) expect(result.detail).toContain(PAY_TO);
  });

  test('a paused asset refuses every payment in it', async () => {
    const { evm } = build({ paused: true });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ isValid: false, invalidReason: 'asset_paused' });
    if (!result.isValid) expect(result.detail).toContain('token issuer');
  });

  test('a frozen payer is refused before the signer is ever asked to broadcast', async () => {
    const { evm, signer } = build({ frozen: [PAYER.address] });
    const result = await evm.settle(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({
      success: false,
      settled: false,
      broadcast: false,
      errorReason: 'payer_frozen',
    });
    expect(signer.sent).toHaveLength(0);
  });

  test('a frozen payer is refused whatever their balance is', async () => {
    const { evm } = build({ frozen: [PAYER.address], balances: balanceKey(PAYER.address, 1n) });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    // Short and frozen at once. The balance is the one of the two the payer can do something
    // about, and saying so would send them to top up an address that cannot move the funds.
    expect(result).toMatchObject({ isValid: false, invalidReason: 'payer_frozen' });
  });
});

describe('a control that does not answer', () => {
  test('a removed facet is refused as absent, not as a chain that is down', async () => {
    const { evm } = build({ controlFailure: { kind: 'absent' } });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ isValid: false, invalidReason: 'asset_control_absent' });
    if (!result.isValid) expect(result.detail).toContain('FacetNotFound');
  });

  test('a read that times out is refused as unreadable', async () => {
    const { evm } = build({ controlFailure: { kind: 'unreadable' } });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ isValid: false, invalidReason: 'asset_control_unreadable' });
  });

  test('the two failures are told apart rather than sharing one label', async () => {
    const absent = await build({ controlFailure: { kind: 'absent' } }).evm.verify(
      await signed(),
      requirements(),
      { now: NOW },
    );
    const unreadable = await build({ controlFailure: { kind: 'unreadable' } }).evm.verify(
      await signed(),
      requirements(),
      { now: NOW },
    );

    expect(absent).toMatchObject({ invalidReason: 'asset_control_absent' });
    expect(unreadable).toMatchObject({ invalidReason: 'asset_control_unreadable' });
  });

  test('an unread control never settles, however good the rest of the payment is', async () => {
    const { evm, signer } = build({ controlFailure: { kind: 'unreadable', on: 'frozen' } });
    const result = await evm.settle(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ success: false, broadcast: false, errorReason: 'asset_control_unreadable' });
    expect(signer.sent).toHaveLength(0);
  });

  test('an answer beats an absence: a frozen payer is reported even when the pause read failed', async () => {
    const { evm } = build({ frozen: [PAYER.address], controlFailure: { kind: 'unreadable', on: 'paused' } });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ isValid: false, invalidReason: 'payer_frozen' });
  });
});

describe('what the read costs', () => {
  test('both parties are asked about in the batch the balance read already made', async () => {
    const { evm, client } = build();
    await evm.verify(await signed(), requirements(), { now: NOW });

    expect(client.issuerReads).toHaveLength(1);
    expect(client.issuerReads[0]?.token).toBe(USDG);
    expect(client.issuerReads[0]?.parties).toEqual([PAYER.address, PAY_TO]);
  });

  test('a payment refused before the chain is read costs no issuer read at all', async () => {
    const { evm, client } = build();
    await evm.verify(await signed(), requirements({ network: 'eip155:1' }), { now: NOW });

    expect(client.issuerReads).toHaveLength(0);
  });
});

describe('reading a revert', () => {
  test('the diamond selector is recognised wherever in the error chain it landed', () => {
    const nested = new Error('call failed', { cause: { data: '0x800ab12c' } });
    expect(controlFailure(nested).state).toBe('absent');
  });

  test('a decoded FacetNotFound is recognised by name too', () => {
    expect(controlFailure(new Error('execution reverted: FacetNotFound')).state).toBe('absent');
  });

  test('anything else is unreadable, and keeps what the chain said', () => {
    const reading = controlFailure(new Error('the request timed out after 10000 ms'));
    expect(reading.state).toBe('unreadable');
    if (reading.state !== 'read') expect(reading.detail).toContain('timed out');
  });

  test('revert text gathers the fields viem and the pool each put the answer in', () => {
    const error = { shortMessage: 'Execution reverted', cause: { data: { data: '0x800AB12C' } } };
    expect(revertText(error)).toContain('0x800ab12c');
  });
});

describe('the simulation, which stays where it was', () => {
  test('it names a pause the token reported rather than reporting a generic state', async () => {
    const { evm } = build({ simulateError: new Error('execution reverted: TokenPaused()') });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ isValid: false, invalidReason: 'asset_paused' });
  });

  test('it names the frozen party when the token put the address in the revert', () => {
    const error = new Error(`execution reverted: AccountFrozen(${PAYER.address})`);
    const refusal = simulationRefusal(error, USDG_ASSET, { payer: PAYER.address, payee: PAY_TO });

    expect(refusal.reason).toBe('payer_frozen');
  });

  test('a freeze it cannot attribute stays a transaction state, with the token\'s own words', () => {
    const refusal = simulationRefusal(new Error('USDG: account is frozen'), USDG_ASSET, {
      payer: PAYER.address,
      payee: PAY_TO,
    });

    expect(refusal.reason).toBe('invalid_transaction_state');
    expect(refusal.detail).toContain('token issuer');
  });

  test('a revert that is about none of this keeps the label it always had', async () => {
    const { evm } = build({ simulateError: new Error('execution reverted: invalid signature') });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_transaction_state' });
  });
});

describe('the verdict on its own', () => {
  const clear: IssuerControls = {
    asset: USDG,
    paused: { state: 'read', value: false },
    parties: [
      { address: PAYER.address, frozen: { state: 'read', value: false } },
      { address: PAY_TO, frozen: { state: 'read', value: false } },
    ],
  };

  test('a clear reading of both parties permits the payment to be tried', () => {
    expect(issuerRefusal(USDG_ASSET, clear, { payer: PAYER.address, payee: PAY_TO })).toBeNull();
  });

  test('a party nobody read is a party nobody cleared', () => {
    const short: IssuerControls = { ...clear, parties: [clear.parties[0]!] };
    const refusal = issuerRefusal(USDG_ASSET, short, { payer: PAYER.address, payee: PAY_TO });

    expect(refusal?.reason).toBe('asset_control_unreadable');
    expect(refusal?.detail).toContain(PAY_TO);
  });
});
