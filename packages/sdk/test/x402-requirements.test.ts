import { describe, expect, it } from 'vitest';

import {
  canonicalNetwork,
  encodeBase64Json,
  parseChallenge,
  sameNetwork,
  selectRequirement,
} from '../src/x402/requirements.js';
import { usdg } from '../src/money.js';

const RHC = 'eip155:4663';
const USDG_RHC = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const PAY_TO = '0x2222222222222222222222222222222222222222';

const V1_BODY = {
  x402Version: 1,
  error: 'payment required',
  accepts: [
    {
      scheme: 'exact',
      network: RHC,
      maxAmountRequired: '2500000',
      asset: USDG_RHC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      resource: 'https://api.example/render',
      description: 'one render',
      extra: { name: 'USDG', version: '2' },
    },
  ],
};

function challenge(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 402, headers });
}

describe('parseChallenge', () => {
  it('reads a v1 offer out of the body', async () => {
    const parsed = await parseChallenge(challenge(V1_BODY));

    expect(parsed.version).toBe(1);
    expect(parsed.error).toBe('payment required');
    expect(parsed.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: RHC,
      amount: 2_500_000n,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: { name: 'USDG', version: '2' },
    });
  });

  it('reads a v2 offer out of the header, where v2 moved it', async () => {
    const response = challenge(
      { error: 'unpaid' },
      {
        'payment-required': encodeBase64Json({
          x402Version: 2,
          accepts: [{ scheme: 'exact', network: RHC, amount: '1000', asset: USDG_RHC, payTo: PAY_TO }],
        }),
      },
    );

    const parsed = await parseChallenge(response);

    expect(parsed.version).toBe(2);
    expect(parsed.accepts[0]?.amount).toBe(1_000n);
  });

  it('takes the amount from whichever field the version uses', async () => {
    const v2 = await parseChallenge(
      challenge({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network: RHC, amount: '750', asset: USDG_RHC, payTo: PAY_TO }],
      }),
    );

    expect(v2.accepts[0]?.amount).toBe(750n);
  });

  it('drops an entry it cannot read rather than guessing at it', async () => {
    const parsed = await parseChallenge(
      challenge({
        accepts: [
          { scheme: 'exact', network: RHC, asset: USDG_RHC, payTo: PAY_TO },
          { scheme: 'exact', network: RHC, amount: '-1', asset: USDG_RHC, payTo: PAY_TO },
          { scheme: 'exact', network: RHC, amount: '1', asset: 'not-an-address', payTo: PAY_TO },
          V1_BODY.accepts[0],
        ],
      }),
    );

    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0]?.amount).toBe(2_500_000n);
  });

  it('says so when a 402 carries no offer at all', async () => {
    await expect(parseChallenge(new Response('nope', { status: 402 }))).rejects.toThrow(
      /answered 402 with no payment offer/,
    );
  });
});

/**
 * One protocol question, one answer. `@bursar/x402` answers it for the facilitator and the
 * sidecar; these are the same four cases, asserted here so the two cannot drift apart again
 * without a suite going red.
 */
describe('network identity', () => {
  it('normalizes packaging and rewrites nothing', () => {
    expect(canonicalNetwork(RHC)).toBe(RHC);
    expect(canonicalNetwork('  EIP155:4663 ')).toBe(RHC);
    expect(canonicalNetwork('Base')).toBe('base');
  });

  it('compares two CAIP-2 ids by the chain they parse to', () => {
    expect(sameNetwork('eip155:4663', 'EIP155:4663')).toBe(true);
    expect(sameNetwork('eip155:4663', 'eip155:04663')).toBe(true);
    expect(sameNetwork(RHC, 'eip155:8453')).toBe(false);
  });

  it('does not map a chain name onto a chain id it was never told about', () => {
    expect(sameNetwork('base', 'eip155:8453')).toBe(false);
  });

  it('matches nothing to a network nobody named, including another one', () => {
    expect(sameNetwork('', '')).toBe(false);
    expect(sameNetwork(undefined, null)).toBe(false);
  });
});

describe('selectRequirement', () => {
  const parsed = {
    version: 1 as const,
    error: undefined,
    accepts: [
      { ...base(), amount: usdg('3.00') },
      { ...base(), amount: usdg('2.00') },
      { ...base(), network: 'eip155:8453', amount: usdg('0.10') },
      { ...base(), asset: '0x9999999999999999999999999999999999999999' as const, amount: usdg('0.01') },
      { ...base(), scheme: 'upto', amount: usdg('0.01') },
    ],
  };

  it('takes the cheapest offer it can settle', () => {
    expect(selectRequirement(parsed, { network: RHC, asset: USDG_RHC })?.amount).toBe(2_000_000n);
  });

  it('leaves an offer on another chain, in another asset, or under another scheme alone', () => {
    const chosen = selectRequirement(parsed, { network: RHC, asset: USDG_RHC });

    expect(chosen?.network).toBe(RHC);
    expect(chosen?.asset).toBe(USDG_RHC);
    expect(chosen?.scheme).toBe('exact');
  });

  it('refuses everything above the ceiling the caller set', () => {
    expect(selectRequirement(parsed, { network: RHC, asset: USDG_RHC, maxAmount: usdg('1.00') }))
      .toBeUndefined();
  });
});

function base() {
  return {
    scheme: 'exact',
    network: RHC,
    payTo: PAY_TO as `0x${string}`,
    asset: USDG_RHC as `0x${string}`,
    amount: usdg('1.00'),
    maxTimeoutSeconds: 60,
    resource: undefined,
    description: undefined,
    extra: undefined,
    raw: {},
  };
}
