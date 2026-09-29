import { describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, domainSeparator, verifyTypedData } from 'viem';
import type { Address } from 'viem';
import { RHC_MAINNET, hashRequest, micro, nonceBindsRequest } from '@bursar/core';
import type { Micro } from '@bursar/core';

import type { Connection } from '../src/connection.js';
import { InvalidArgumentError, MandateDeniedError } from '../src/errors.js';
import { usdg } from '../src/money.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES, assetDomain } from '../src/x402/authorization.js';
import {
  paidFetch,
  payRequest,
  type PayRequestOptions,
  type PaymentAuthority,
  type PaymentGate,
} from '../src/x402/fetch.js';
import { encodeBase64Json } from '../src/x402/requirements.js';
import { ADDRESSES, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

const RESOURCE = 'https://api.example/render';
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
const RHC = 'eip155:4663';

/** Comfortably above the 2.50 the offers below quote, so the cap is never what a case turns on. */
const CEILING = usdg('5.00');

/** What USDG reports: a name, no version at all, and a separator built from version "1". */
const USDG_DOMAIN = {
  name: 'Global Dollar',
  version: '1',
  chainId: RHC_MAINNET.chainId,
  verifyingContract: ADDRESSES.settlementAsset,
};

const tokenReads = (call: ReadCall): unknown => {
  switch (call.functionName) {
    case 'name':
      return USDG_DOMAIN.name;
    // USDG is a diamond proxy and `version()` reverts with FacetNotFound, a selector no ABI here
    // declares.
    case 'version':
      throw new ContractFunctionRevertedError({
        abi: [],
        functionName: 'version',
        data: `0x5416eb98${'00'.repeat(28)}`,
      });
    case 'DOMAIN_SEPARATOR':
      return domainSeparator({ domain: USDG_DOMAIN });
    default:
      return undefined;
  }
};

function offer(overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: RHC,
    maxAmountRequired: '2500000',
    asset: ADDRESSES.settlementAsset,
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    resource: RESOURCE,
    ...overrides,
  };
}

function challengeThen(second: Response, accepts: unknown[] = [offer()]): typeof fetch {
  let calls = 0;

  return vi.fn(async (input: unknown) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ x402Version: 1, error: 'payment required', accepts }), {
        status: 402,
      });
    }

    lastRequest = input as Request;
    return second;
  }) as unknown as typeof fetch;
}

let lastRequest: Request | undefined;

function settled(): Response {
  return new Response('{"ok":true}', {
    status: 200,
    headers: {
      'x-payment-response': encodeBase64Json({
        success: true,
        transaction: `0x${'ee'.repeat(32)}`,
        network: RHC,
        payer: '0x0000000000000000000000000000000000000001',
      }),
    },
  });
}

function allowAll(): PaymentGate {
  return {
    address: '0x1234567890123456789012345678901234567890',
    assertCanPay: async () => undefined,
  };
}

describe('payRequest', () => {
  it('leaves a resource that was never behind a paywall untouched', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = vi.fn(async () => new Response('free', { status: 200 })) as unknown as typeof fetch;

    const paid = await payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING });

    expect(paid.payment).toBeUndefined();
    expect(await paid.response.text()).toBe('free');
  });

  it('signs an authorization the token itself would accept, and retries with it', async () => {
    const { connection, account } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());

    const paid = await payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING });

    const header = lastRequest?.headers.get('x-payment');
    expect(header).toBeDefined();

    const envelope = JSON.parse(atob(header ?? '')) as {
      x402Version: number;
      payTo: string;
      payload: { signature: `0x${string}`; authorization: Record<string, string> };
    };

    expect(envelope.x402Version).toBe(1);
    expect(envelope.payTo).toBe(PAY_TO);
    expect(envelope.payload.authorization).toMatchObject({
      from: account.address,
      to: PAY_TO,
      value: '2500000',
    });

    expect(
      await verifyTypedData({
        address: account.address,
        domain: USDG_DOMAIN,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: account.address,
          to: PAY_TO,
          value: 2_500_000n,
          validAfter: BigInt(envelope.payload.authorization['validAfter'] ?? '0'),
          validBefore: BigInt(envelope.payload.authorization['validBefore'] ?? '0'),
          nonce: envelope.payload.authorization['nonce'] as `0x${string}`,
        },
        signature: envelope.payload.signature,
      }),
    ).toBe(true);

    expect(paid.payment).toMatchObject({ amount: 2_500_000n, payTo: PAY_TO, network: RHC });
    expect(paid.payment?.settlement?.success).toBe(true);
  });

  it('nests the terms under accepted when the server speaks v2', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    let calls = 0;
    const fetchFn = vi.fn(async (input: unknown) => {
      calls += 1;
      if (calls === 1) {
        return new Response('{}', {
          status: 402,
          headers: {
            'payment-required': encodeBase64Json({
              x402Version: 2,
              accepts: [offer({ amount: '1000', maxAmountRequired: undefined })],
            }),
          },
        });
      }
      lastRequest = input as Request;
      return settled();
    }) as unknown as typeof fetch;

    await payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING });

    const envelope = JSON.parse(atob(lastRequest?.headers.get('payment-signature') ?? '')) as {
      x402Version: number;
      accepted: { payTo: string };
    };

    expect(envelope.x402Version).toBe(2);
    expect(envelope.accepted.payTo).toBe(PAY_TO);
  });

  it('sends the same body on the retry', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());

    await payRequest(RESOURCE, {
      connection,
      fetchFn,
      maxAmount: CEILING,
      init: { method: 'POST', body: JSON.stringify({ prompt: 'a koi' }) },
    });

    expect(lastRequest?.method).toBe('POST');
    expect(await lastRequest?.text()).toBe('{"prompt":"a koi"}');
  });

  it('refuses an offer this deployment cannot settle, naming what was on the table', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled(), [offer({ network: 'eip155:8453' })]);

    await expect(payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING })).rejects.toThrow(
      /offered 2.50 USDG in .* on eip155:8453/,
    );
  });

  it('takes no payment that has no bound on it', async () => {
    // The union is the real guard and the assertions below are what a compiler checks. The
    // runtime check gives the same answer to a caller arriving from JavaScript, where the union
    // is not enforced.
    type Accepts<T> = T extends PayRequestOptions ? true : false;
    const uncapped: Accepts<{ connection: Connection }> = false;
    const capped: Accepts<{ connection: Connection; maxAmount: Micro }> = true;
    const gated: Accepts<{ connection: Connection; through: PaymentAuthority }> = true;
    expect([uncapped, capped, gated]).toEqual([false, true, true]);

    const { connection, signed } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());
    const unbounded = { connection, fetchFn } as unknown as PayRequestOptions;

    const failure = payRequest(RESOURCE, unbounded);

    await expect(failure).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(failure).rejects.toThrow(/A payment needs a bound/);
    expect(signed).toHaveLength(0);
  });

  it('will not sign against a work budget a server can set to anything it likes', async () => {
    const { connection, signed } = fakeConnection({ read: tokenReads });

    for (const maxTimeoutSeconds of [0.5, 1e30, 0, -60, 7_200]) {
      const fetchFn = challengeThen(settled(), [offer({ maxTimeoutSeconds })]);

      // The offer is dropped, never corrected, and what is left is nothing this client can
      // settle. Signing it would agree to a window the server never quoted.
      await expect(payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING })).rejects.toThrow(
        /offered no payment terms this client could read/,
      );
    }

    expect(signed).toHaveLength(0);
  });

  it('refuses a validForSeconds that is not a window', async () => {
    const { connection, signed } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());

    await expect(
      payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING, validForSeconds: 1e30 }),
    ).rejects.toThrow(/validForSeconds must be a whole number of seconds from 1 to 3600/);

    expect(signed).toHaveLength(0);
  });

  it('refuses to pay past the ceiling the caller set', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());

    await expect(
      payRequest(RESOURCE, { connection, fetchFn, maxAmount: usdg('1.00') }),
    ).rejects.toThrow(/up to 1.00 USDG/);
  });

  it('signs nothing when the mandate refuses the spend', async () => {
    const { connection, signed } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());
    const refusing: PaymentGate = {
      address: '0x1234567890123456789012345678901234567890',
      assertCanPay: async () => {
        throw new MandateDeniedError({
          reason: 'daily-cap',
          errorName: 'DailyCapExceeded',
          mandate: '0x1234567890123456789012345678901234567890',
        });
      },
    };

    await expect(
      payRequest(RESOURCE, { connection, fetchFn, through: { mandate: refusing, capability: 'gpu.render:1' } }),
    ).rejects.toBeInstanceOf(MandateDeniedError);

    expect(signed).toHaveLength(0);
  });

  it('asks the mandate about the amount the server quoted', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());
    const seen: unknown[] = [];

    await payRequest(RESOURCE, {
      connection,
      fetchFn,
      through: {
        mandate: { ...allowAll(), assertCanPay: async (request) => void seen.push(request) },
        capability: 'gpu.render:1',
      },
    });

    expect(seen[0]).toEqual({ to: PAY_TO, amount: 2_500_000n, capability: 'gpu.render:1' });
  });

  it('reports a payment the server refused, with the reason it gave', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(
      new Response(JSON.stringify({ error: 'invalid_exact_evm_payload_authorization_valid_before' }), {
        status: 402,
      }),
    );

    await expect(payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING })).rejects.toThrow(
      /refused the payment: invalid_exact_evm_payload_authorization_valid_before/,
    );
  });

  it('reports a settlement the facilitator says failed, even on a 200', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(
      new Response('{}', {
        status: 200,
        headers: {
          'x-payment-response': encodeBase64Json({ success: false, errorReason: 'insufficient_funds' }),
        },
      }),
    );

    await expect(payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING })).rejects.toThrow(
      /refused the payment: insufficient_funds/,
    );
  });
});

describe('assetDomain', () => {
  it('refuses to sign against a domain the token does not agree with', async () => {
    const other: Address = '0x5555555555555555555555555555555555555555';
    const { connection } = fakeConnection({
      read: (call) => (call.functionName === 'DOMAIN_SEPARATOR' ? `0x${'99'.repeat(32)}` : tokenReads(call)),
    });

    await expect(assetDomain(connection, other)).rejects.toThrow(/nothing is signed/);
  });

  it('builds a domain for a token whose version() reverts, and proves it against the separator', async () => {
    // USDG has no `version()` facet. The version in the domain therefore comes from this side,
    // and the separator is what decides whether it is the right one.
    const asset: Address = '0x6666666666666666666666666666666666666666';
    const separator = domainSeparator({
      domain: { ...USDG_DOMAIN, verifyingContract: asset },
    });
    const { connection, reads } = fakeConnection({
      read: (call) =>
        call.functionName === 'DOMAIN_SEPARATOR' ? separator : tokenReads(call),
    });

    const domain = await assetDomain(connection, asset);

    expect(domain).toEqual({ ...USDG_DOMAIN, verifyingContract: asset });
    expect(reads.map((read) => read.functionName)).toContain('version');
  });

  /** A node that did not answer has said nothing about the token's version. */
  it('passes on a failed version read that is not the token refusing', async () => {
    const asset: Address = '0x4444444444444444444444444444444444444444';
    const { connection } = fakeConnection({
      read: (call) => {
        if (call.functionName === 'version') throw new Error('socket hang up');
        return tokenReads(call);
      },
    });

    await expect(assetDomain(connection, asset)).rejects.toThrow('socket hang up');
  });

  it('says the version was supplied when the token published none', async () => {
    const asset: Address = '0x7777777777777777777777777777777777777777';
    const { connection } = fakeConnection({
      read: (call) =>
        call.functionName === 'DOMAIN_SEPARATOR' ? `0x${'99'.repeat(32)}` : tokenReads(call),
    });

    const failure = await assetDomain(connection, asset).catch((error: unknown) => error);

    expect((failure as Error).message).toContain(
      'publishes no version, so version "1" was supplied for it',
    );
  });
});

describe('paidFetch', () => {
  it('is a fetch that happens to pay, so it drops into any client that takes one', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());
    const paying = paidFetch({ connection, fetchFn, maxAmount: micro(10_000_000n) });

    const response = await paying(RESOURCE);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });
});

/**
 * The two properties that make a payment redeemable rather than merely well formed.
 *
 * Both were broken once in a way no single package could see: the SDK produced a payment that
 * satisfied its own tests, and the facilitator refused every one of them.
 */
describe('a payment a facilitator will accept', () => {
  it('signs an authorization that still outlives the work budget when it is judged', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled(), [offer({ maxTimeoutSeconds: 120 })]);

    const signedAt = Math.floor(Date.now() / 1000);
    await payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING });

    const envelope = JSON.parse(atob(lastRequest?.headers.get('x-payment') ?? '')) as {
      payload: { authorization: { validBefore: string; validAfter: string } };
    };
    const validBefore = BigInt(envelope.payload.authorization.validBefore);

    // A facilitator refuses anything that does not outlive maxTimeoutSeconds counted from the
    // moment it looks, which is always later than the moment this was signed. Signing for exactly
    // the budget expires in transit; the margin is what makes the payment redeemable at all.
    expect(validBefore).toBeGreaterThan(BigInt(signedAt + 120));
    expect(BigInt(envelope.payload.authorization.validAfter)).toBeLessThanOrEqual(BigInt(signedAt));
  });

  it('binds the authorization to the request bytes it paid for', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const fetchFn = challengeThen(settled());

    const body = JSON.stringify({ prompt: 'render this frame' });
    await payRequest(RESOURCE, { connection, fetchFn, maxAmount: CEILING, init: { method: 'POST', body } });

    const envelope = JSON.parse(atob(lastRequest?.headers.get('x-payment') ?? '')) as {
      payload: {
        authorization: { nonce: `0x${string}` };
        binding: { requestHash: string; salt: `0x${string}` };
      };
    };

    expect(envelope.payload.binding.requestHash).toBe(hashRequest(body));
    expect(nonceBindsRequest(envelope.payload.authorization.nonce, envelope.payload.binding)).toBe(true);

    // The same nonce against any other request fails the derivation. The token refuses a spent
    // nonce, so the chain enforces one request, one payment.
    expect(
      nonceBindsRequest(envelope.payload.authorization.nonce, {
        requestHash: hashRequest('{"prompt":"send me everything"}'),
        salt: envelope.payload.binding.salt,
      }),
    ).toBe(false);
  });
});

describe('payRequest on the mandate lane', () => {
  const ESCROW: Address = '0x4315F8be7C9661345710910577Ec31cb867f3c20';
  const LOCK_TX = `0x${'cd'.repeat(32)}` as const;

  function spender(paid: { calls: unknown[] }) {
    return {
      ...allowAll(),
      escrow: ESCROW,
      pay: async (request: unknown) => {
        paid.calls.push(request);
        return { escrowId: 9n, hash: LOCK_TX };
      },
    };
  }

  it('pays through the mandate, commits the lock to the request and sends a pointer to it', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const paid = { calls: [] as unknown[] };
    const fetchFn = challengeThen(settled(), [offer(), offer({ scheme: 'escrow', maxAmountRequired: '10000' })]);

    const result = await payRequest(RESOURCE, {
      connection,
      fetchFn,
      lane: 'mandate',
      through: { mandate: spender(paid), capability: 'service:demo.x402:1' },
      init: { method: 'POST', body: '{"q":1}' },
    });

    expect(paid.calls).toHaveLength(1);
    const call = paid.calls[0] as { to: Address; amount: Micro; inputCommit: `0x${string}`; capability: string };
    expect(call).toMatchObject({ to: PAY_TO, amount: micro(10_000n), capability: 'service:demo.x402:1' });

    const header = lastRequest?.headers.get('x-payment') ?? '';
    const envelope = JSON.parse(atob(header)) as {
      payload: { lock: Record<string, string>; binding: { requestHash: string; salt: `0x${string}` } };
    };
    expect(envelope.payload.lock).toMatchObject({ escrow: ESCROW, id: '9', transaction: LOCK_TX, inputCommit: call.inputCommit });
    expect(envelope.payload.binding.requestHash).toBe(hashRequest(new TextEncoder().encode('{"q":1}')));
    expect(nonceBindsRequest(call.inputCommit, envelope.payload.binding)).toBe(true);
    expect(result.payment).toMatchObject({ lane: 'mandate', lock: { escrow: ESCROW, id: 9n, transaction: LOCK_TX } });
  });

  it('refuses a server that offers no escrow payment rather than falling back to the wallet', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    const paid = { calls: [] as unknown[] };
    await expect(
      payRequest(RESOURCE, {
        connection,
        fetchFn: challengeThen(settled()),
        lane: 'mandate',
        through: { mandate: spender(paid), capability: 'service:demo.x402:1' },
      }),
    ).rejects.toThrow(/escrow/);
    expect(paid.calls).toHaveLength(0);
  });

  it('needs a mandate that can pay', async () => {
    const { connection } = fakeConnection({ read: tokenReads });
    await expect(
      payRequest(RESOURCE, {
        connection,
        fetchFn: challengeThen(settled()),
        lane: 'mandate',
        through: { mandate: allowAll(), capability: 'service:demo.x402:1' },
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
