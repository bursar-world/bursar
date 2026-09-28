import { describe, expect, test } from 'vitest';
import { RHC_MAINNET } from '@bursar/core';
import { bindingMessage, deriveNonce, hashRequest, type PaymentBinding } from '../src/binding.js';
import { PERMIT_TYPES, permitPaymentRef } from '../src/eip2612.js';
import { createExactEvm, type ExactEvmOptions } from '../src/exact-evm.js';
import {
  nonceIsSpent,
  noncePosition,
  PERMIT2_ADDRESS,
  PERMIT_TRANSFER_FROM_TYPES,
  permit2Domain,
} from '../src/permit2.js';
import type { PaymentPayload, PaymentRequirements } from '../src/types.js';
import {
  USDG_ASSET,
  NOW,
  PAY_TO,
  PAYER,
  PRICE,
  RELAYER,
  USDG,
  allowanceKey,
  balanceKey,
  fakeChain,
  fakeSigner,
  type FakeChainState,
} from './support.js';

const TOKEN_DOMAIN = {
  name: USDG_ASSET.name,
  version: USDG_ASSET.version,
  chainId: RHC_MAINNET.chainId,
  verifyingContract: USDG,
} as const;

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

/**
 * Both permit paths are off unless a deployment asks for them, so every case here opts in the way
 * an operator would. What that opt-in buys is exactly what these tests describe.
 */
function build(state: FakeChainState = {}, options: Partial<ExactEvmOptions> = {}) {
  const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n), ...state });
  const signer = fakeSigner({ hashes: [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`] });
  const evm = createExactEvm({
    networks: [
      {
        chain: RHC_MAINNET,
        client,
        assets: [USDG_ASSET],
        signer,
        methods: ['eip3009', 'eip2612', 'permit2'],
      },
    ],
    requireBinding: false,
    ...options,
  });
  return { evm, client, signer };
}

describe('eip2612', () => {
  type Permit = {
    owner: `0x${string}`;
    spender: `0x${string}`;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  };

  async function signedPermit(overrides: Partial<Permit> = {}): Promise<PaymentPayload> {
    const permit: Permit = {
      owner: PAYER.address,
      spender: RELAYER,
      value: PRICE,
      nonce: 0n,
      deadline: BigInt(NOW + 600),
      ...overrides,
    };
    const signature = await PAYER.signTypedData({
      domain: TOKEN_DOMAIN,
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: permit,
    });
    return {
      x402Version: 2,
      payload: {
        method: 'eip2612',
        signature,
        permit: {
          owner: permit.owner,
          spender: permit.spender,
          value: permit.value.toString(),
          nonce: permit.nonce.toString(),
          deadline: permit.deadline.toString(),
        },
      },
    };
  }

  test('a permit for the asking price, naming the relayer as spender, is valid', async () => {
    const { evm } = build();
    const result = await evm.verify(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: true, payer: PAYER.address, method: 'eip2612' });
  });

  test('a permit that names another spender is not a payment to this facilitator', async () => {
    const { evm } = build();
    const stranger = '0x000000000000000000000000000000000000dEaD';
    const result = await evm.verify(await signedPermit({ spender: stranger }), requirements(), {
      now: NOW,
    });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_permit_spender' });
  });

  test('a stale nonce is refused with the one the token expects', async () => {
    const { evm } = build({ permitNonces: { [`${USDG.toLowerCase()}:${PAYER.address.toLowerCase()}`]: 4n } });
    const result = await evm.verify(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_permit_nonce' });
    if (!result.isValid) expect(result.detail).toContain('4');
  });

  test('a deadline that does not outlive the work is refused up front', async () => {
    const { evm } = build();
    const result = await evm.verify(
      await signedPermit({ deadline: BigInt(NOW + 30) }),
      requirements({ maxTimeoutSeconds: 600 }),
      { now: NOW },
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
  });

  test('settlement is a permit and then a pull, in that order', async () => {
    const { evm, signer } = build();
    const result = await evm.settle(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({ success: true, settled: true, broadcast: true, method: 'eip2612' });
    expect(signer.sent).toHaveLength(2);
    // The reported hash is the transaction that moved the money, not the one that authorised it.
    expect(result.transaction).toBe(`0x${'bb'.repeat(32)}`);
  });

  test('a pull that would revert after the permit landed reports gas spent and nothing moved', async () => {
    const { evm, signer } = build({ failSimulateFrom: 1 });
    const result = await evm.settle(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({ success: false, settled: false, broadcast: true });
    expect(signer.sent).toHaveLength(1);
  });

  test('a pull simulation the chain never answered is not reported as a bad transaction', async () => {
    const { evm, signer } = build({ failSimulateFrom: 1, simulateError: new Error('request timed out after 10000 ms') });
    const result = await evm.settle(await signedPermit(), requirements(), { now: NOW });
    // The permit landed, so the broadcast stands; the payer's authorisation is not what failed.
    expect(result).toMatchObject({
      success: false,
      settled: false,
      broadcast: true,
      errorReason: 'facilitator_unavailable',
      transaction: `0x${'aa'.repeat(32)}`,
    });
    expect(signer.sent).toHaveLength(1);
  });

  test('a permit simulation the chain never answered refuses nothing and sends nothing', async () => {
    const { evm, signer } = build({ simulateError: new Error('socket hang up') });
    await expect(evm.verify(await signedPermit(), requirements(), { now: NOW })).rejects.toThrow(/socket hang up/);
    const result = await evm.settle(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({ broadcast: false, errorReason: 'facilitator_unavailable' });
    expect(signer.sent).toHaveLength(0);
  });

  test('a relayer configured in lowercase still matches the spender a payer signed', async () => {
    const { evm } = build({}, {
      networks: [
        {
          chain: RHC_MAINNET,
          client: fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) }),
          assets: [USDG_ASSET],
          signer: fakeSigner(),
          relayer: RELAYER.toLowerCase() as `0x${string}`,
          methods: ['eip2612'],
        },
      ],
    });
    const result = await evm.verify(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: true, method: 'eip2612' });
  });

  test('a frozen payer is refused before the permit costs the relayer anything', async () => {
    const { evm, signer } = build({ frozen: [PAYER.address] });
    const result = await evm.settle(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({ success: false, broadcast: false, errorReason: 'payer_frozen' });
    expect(signer.sent).toHaveLength(0);
  });

  test('a paused asset is refused, since the pull would revert after the permit had landed', async () => {
    const { evm } = build({ paused: true });
    const result = await evm.verify(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'asset_paused' });
  });

  test('a freeze that lands between the permit and the pull is named, not left as a state', async () => {
    // The permit simulates and broadcasts; the pull is simulated afterwards, because until the
    // permit lands there is no allowance to pull against. It is the one place a settlement meets
    // an issuer condition with the relayer's gas already spent, and it says which condition.
    const { evm, signer } = build({
      failSimulateFrom: 1,
      simulateError: new Error(`execution reverted: AccountFrozen(${PAYER.address})`),
    });

    const result = await evm.settle(await signedPermit(), requirements(), { now: NOW });

    expect(result).toMatchObject({ success: false, broadcast: true, errorReason: 'payer_frozen' });
    expect(signer.sent).toHaveLength(1);
  });

  test('a verifier with no relayer cannot judge a permit at all', async () => {
    const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) });
    const evm = createExactEvm({
      networks: [{ chain: RHC_MAINNET, client, assets: [USDG_ASSET] }],
      requireBinding: false,
    });
    const result = await evm.verify(await signedPermit(), requirements(), { now: NOW });
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'unsupported_asset_transfer_method',
    });
  });

  describe('binding', () => {
    const binding: PaymentBinding = {
      requestHash: hashRequest('{"command":"settle"}'),
      salt: `0x${'11'.repeat(32)}`,
    };

    async function bound(requestHash: string): Promise<PaymentPayload> {
      const payload = await signedPermit();
      const signature = await PAYER.signMessage({
        message: bindingMessage(permitPaymentRef(USDG, PAYER.address, 0n), requestHash),
      });
      return { ...payload, payload: { ...payload.payload, bindingSignature: signature } };
    }

    test('a permit signed for this request settles', async () => {
      const { evm } = build({}, { requireBinding: true });
      const result = await evm.verify(await bound(binding.requestHash), requirements(), {
        now: NOW,
        binding,
      });
      expect(result.isValid).toBe(true);
    });

    test('a permit signed for another request does not settle', async () => {
      const { evm } = build({}, { requireBinding: true });
      const result = await evm.verify(await bound(hashRequest('{"command":"drain"}')), requirements(), {
        now: NOW,
        binding,
      });
      expect(result).toMatchObject({ isValid: false, invalidReason: 'payment_not_bound_to_request' });
    });

    test('a permit with no binding signature does not settle', async () => {
      const { evm } = build({}, { requireBinding: true });
      const result = await evm.verify(await signedPermit(), requirements(), { now: NOW, binding });
      expect(result).toMatchObject({ isValid: false, invalidReason: 'payment_not_bound_to_request' });
    });
  });
});

describe('permit2', () => {
  const DOMAIN = permit2Domain(PERMIT2_ADDRESS, RHC_MAINNET.chainId);
  const approved = allowanceKey(PAYER.address, PERMIT2_ADDRESS, 10_000_000n);

  type Transfer = {
    owner: `0x${string}`;
    token: `0x${string}`;
    spender: `0x${string}`;
    amount: bigint;
    nonce: bigint;
    deadline: bigint;
  };

  async function signedTransfer(overrides: Partial<Transfer> = {}): Promise<PaymentPayload> {
    const transfer: Transfer = {
      owner: PAYER.address,
      token: USDG,
      spender: RELAYER,
      amount: PRICE,
      nonce: 7n,
      deadline: BigInt(NOW + 600),
      ...overrides,
    };
    const signature = await PAYER.signTypedData({
      domain: DOMAIN,
      types: PERMIT_TRANSFER_FROM_TYPES,
      primaryType: 'PermitTransferFrom',
      message: {
        permitted: { token: transfer.token, amount: transfer.amount },
        spender: transfer.spender,
        nonce: transfer.nonce,
        deadline: transfer.deadline,
      },
    });
    return {
      x402Version: 2,
      payload: {
        method: 'permit2',
        signature,
        permit: {
          owner: transfer.owner,
          token: transfer.token,
          spender: transfer.spender,
          amount: transfer.amount.toString(),
          nonce: transfer.nonce.toString(),
          deadline: transfer.deadline.toString(),
        },
      },
    };
  }

  test('a signed transfer against an approved Permit2 is valid', async () => {
    const { evm } = build({ allowances: approved });
    const result = await evm.verify(await signedTransfer(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: true, payer: PAYER.address, method: 'permit2' });
  });

  test('without the one-off approval the refusal says which approval is missing', async () => {
    const { evm } = build();
    const result = await evm.verify(await signedTransfer(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'permit2_not_approved' });
  });

  test('a used bitmap bit is a replay', async () => {
    const { word, bit } = noncePosition(7n);
    const { evm } = build({
      allowances: approved,
      bitmaps: {
        [`${PERMIT2_ADDRESS.toLowerCase()}:${PAYER.address.toLowerCase()}:${word.toString()}`]: 1n << bit,
      },
    });
    const result = await evm.verify(await signedTransfer(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_transaction_state' });
  });

  test('Permit2 is a spender, not an exemption from the token\'s own controls', async () => {
    const { evm } = build({ allowances: approved, frozen: [PAYER.address] });
    const result = await evm.verify(await signedTransfer(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'payer_frozen' });
  });

  test('a permit naming a different token is not a payment for this one', async () => {
    const { evm } = build({ allowances: approved });
    const other = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
    const result = await evm.verify(await signedTransfer({ token: other }), requirements(), {
      now: NOW,
    });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_payment_requirements' });
  });

  test('settlement is a single call to Permit2', async () => {
    const { evm, signer } = build({ allowances: approved });
    const result = await evm.settle(await signedTransfer(), requirements(), { now: NOW });
    expect(result).toMatchObject({ success: true, settled: true, method: 'permit2' });
    expect(signer.sent).toHaveLength(1);
    expect(signer.sent[0]?.to).toBe(PERMIT2_ADDRESS);
  });

  test('the nonce carries the request, so the binding is enforced by the bitmap', async () => {
    const binding: PaymentBinding = {
      requestHash: hashRequest('{"command":"settle"}'),
      salt: `0x${'11'.repeat(32)}`,
    };
    const { evm } = build({ allowances: approved }, { requireBinding: true });

    const good = await signedTransfer({ nonce: BigInt(deriveNonce(binding)) });
    expect((await evm.verify(good, requirements(), { now: NOW, binding })).isValid).toBe(true);

    const other = { ...binding, requestHash: hashRequest('{"command":"drain"}') };
    const bad = await signedTransfer({ nonce: BigInt(deriveNonce(other)) });
    expect(await evm.verify(bad, requirements(), { now: NOW, binding })).toMatchObject({
      isValid: false,
      invalidReason: 'payment_not_bound_to_request',
    });
  });
});

describe('the permit2 nonce bitmap', () => {
  test('the high bits pick the word and the low eight pick the bit', () => {
    expect(noncePosition(0n)).toEqual({ word: 0n, bit: 0n });
    expect(noncePosition(255n)).toEqual({ word: 0n, bit: 255n });
    expect(noncePosition(256n)).toEqual({ word: 1n, bit: 0n });
    expect(noncePosition(513n)).toEqual({ word: 2n, bit: 1n });
  });

  test('a set bit means spent, and its neighbours are untouched', () => {
    const bitmap = 1n << 5n;
    expect(nonceIsSpent(bitmap, 5n)).toBe(true);
    expect(nonceIsSpent(bitmap, 6n)).toBe(false);
    expect(nonceIsSpent(0n, 5n)).toBe(false);
  });
});
