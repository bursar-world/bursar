import { describe, expect, test } from 'vitest';
import { keccak256, toHex } from 'viem';
import { RHC_MAINNET } from '@bursar/core';
import { createExactEvm } from '../src/exact-evm.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from '../src/eip3009.js';
import type { PaymentPayload, PaymentRequirements } from '../src/types.js';
import { NOW, PAY_TO, PAYER, PRICE, USDG, USDG_ASSET, balanceKey, fakeChain, fakeSigner } from './support.js';

/**
 * The standard profile is what a stock x402 client meets. Such a client signs `validBefore` as the
 * moment it signed plus the quoted budget, picks a random nonce and sends no request binding, so
 * the one question that matters is whether that payment is accepted there and refused on the
 * bound profile both facilitator surfaces are built from.
 */
const DOMAIN = {
  name: USDG_ASSET.name,
  version: USDG_ASSET.version,
  chainId: RHC_MAINNET.chainId,
  verifyingContract: USDG,
} as const;

const MAX_TIMEOUT = 60;

function requirements(): PaymentRequirements {
  return { scheme: 'exact', network: 'eip155:4663', amount: PRICE.toString(), asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: MAX_TIMEOUT };
}

/** What `@x402/evm`'s client signs: validAfter ten minutes back, validBefore now plus the budget. */
async function stockPayment(signedAt = NOW): Promise<PaymentPayload> {
  const authorization = {
    from: PAYER.address,
    to: PAY_TO,
    value: PRICE,
    validAfter: BigInt(signedAt - 600),
    validBefore: BigInt(signedAt + MAX_TIMEOUT),
    nonce: keccak256(toHex(`stock-${signedAt}`)),
  };
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

function build() {
  const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) });
  const signer = fakeSigner();
  const bound = createExactEvm({
    networks: [{ chain: RHC_MAINNET, client, assets: [USDG_ASSET], signer, relayer: signer.address }],
  });
  return { bound, standard: bound.standard(), signer };
}

describe('the standard profile', () => {
  test('is the protocol as the reference checks it', () => {
    const { bound, standard } = build();
    expect(bound.policy).toEqual({ requireBinding: true, outlive: 'budget' });
    expect(standard.policy).toEqual({ requireBinding: false, outlive: 'margin' });
    expect(standard.standard()).toBe(standard);
    expect(bound.standard()).toBe(standard);
  });

  test('accepts a stock client payment the bound profile refuses', async () => {
    const { bound, standard } = build();
    // Checked two seconds after it was signed, which is every real request.
    const payment = await stockPayment(NOW - 2);

    const refused = await bound.verify(payment, requirements(), { now: NOW });
    expect(refused).toMatchObject({ isValid: false, invalidReason: 'payment_not_bound_to_request' });

    const accepted = await standard.verify(payment, requirements(), { now: NOW });
    expect(accepted).toMatchObject({ isValid: true, payer: PAYER.address, method: 'eip3009', amount: PRICE });
  });

  test('still holds the six-second margin', async () => {
    const { standard } = build();
    const payment = await stockPayment(NOW - MAX_TIMEOUT + 5);
    expect(await standard.verify(payment, requirements(), { now: NOW })).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
  });

  test('settles through the same relayer', async () => {
    const { standard, signer } = build();
    const result = await standard.settle(await stockPayment(NOW - 2), requirements(), { now: NOW });
    expect(result).toMatchObject({ success: true, settled: true, broadcast: true, payer: PAYER.address });
    expect(signer.sent).toHaveLength(1);
  });

  test('publishes the same kinds', () => {
    const { bound, standard } = build();
    expect(standard.supported()).toEqual(bound.supported());
  });
});
