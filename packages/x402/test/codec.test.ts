import { describe, expect, test } from 'vitest';
import {
  bazaar,
  detect,
  encodePayment,
  parsePayment,
  paymentHeaderName,
  paymentRequired,
  paymentResponse,
  requirementsFor,
} from '../src/codec.js';
import { objectSchema, settlementReceiptExample } from '../src/schemas.js';
import type { PaymentRequirements, SettleResult } from '../src/types.js';
import { PAY_TO, PAYER, USDG } from './support.js';

const base64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const fromBase64 = (value: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, unknown>;

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

describe('payment headers', () => {
  test('v1 and v2 headers decode to the same authorisation', () => {
    const authorization = {
      from: PAYER.address,
      to: PAY_TO,
      value: '300000',
      validAfter: '1',
      validBefore: '2',
      nonce: `0x${'00'.repeat(32)}`,
    };
    const v2 = parsePayment(
      base64({
        x402Version: 2,
        accepted: { scheme: 'exact', network: 'eip155:4663' },
        payload: { signature: '0xab', authorization },
      }),
    );
    const v1 = parsePayment(
      base64({
        x402Version: 1,
        scheme: 'exact',
        network: 'eip155:4663',
        payload: { signature: '0xab', authorization },
      }),
    );
    expect(v2?.payload?.authorization).toEqual(v1?.payload?.authorization);
    expect(v2?.accepted?.scheme).toBe('exact');
    expect(v1?.accepted?.scheme).toBe('exact');
    expect(v1?.accepted?.network).toBe('eip155:4663');
  });

  test('a malformed header is a failed payment, not an absent one', () => {
    expect(parsePayment('not base64 at all !!')).toBeNull();
    expect(parsePayment(base64([]))).toBeNull();
    expect(parsePayment(base64({ payload: {} }))?.x402Version).toBe(1);
  });

  test('detect picks the version from whichever header is present', () => {
    expect(detect({ 'PAYMENT-SIGNATURE': 'abc' })?.version).toBe(2);
    expect(detect({ 'x-payment': 'abc' })?.version).toBe(1);
    expect(detect({ 'X-Payment': 'abc' })?.version).toBe(1);
    expect(detect({})).toBeNull();
    expect(detect(null)).toBeNull();
    // An empty header is not a payment attempt.
    expect(detect({ 'x-payment': '' })).toBeNull();
  });

  test('a payment round-trips through the header a client would send', () => {
    const payload = { x402Version: 2 as const, payload: { signature: '0xab' } };
    const header = encodePayment(payload);
    expect(parsePayment(header)?.payload?.signature).toBe('0xab');
    expect(paymentHeaderName(2)).toBe('PAYMENT-SIGNATURE');
    expect(paymentHeaderName(1)).toBe('X-PAYMENT');
  });
});

describe('requirements', () => {
  test('v1 renames the amount and keeps the chain id', () => {
    const v1 = requirementsFor(1, requirements());
    expect(v1['maxAmountRequired']).toBe('300000');
    expect(v1['amount']).toBeUndefined();
    // The chain has one spelling. Inventing a short name would make two ways to say one chain.
    expect(v1['network']).toBe('eip155:4663');
  });

  test('v2 keeps the amount and strips what describes the resource', () => {
    const v2 = requirementsFor(
      2,
      requirements({ resource: '/settle', description: 'x', mimeType: 'application/json', outputSchema: {} }),
    );
    expect(v2['amount']).toBe('300000');
    for (const key of ['resource', 'description', 'mimeType', 'outputSchema']) {
      expect(v2[key]).toBeUndefined();
    }
  });
});

describe('402 responses', () => {
  test('v1 answers in the body, v2 in a header', () => {
    const accepts = [requirements()];
    const one = paymentRequired(1, { accepts, error: 'payment required' });
    expect(Object.keys(one.headers)).toHaveLength(0);
    expect(one.body['x402Version']).toBe(1);

    const two = paymentRequired(2, { accepts, error: 'payment required' });
    const decoded = fromBase64(two.headers['PAYMENT-REQUIRED'] ?? '');
    expect(decoded['x402Version']).toBe(2);
    expect((decoded['accepts'] as Record<string, unknown>[])[0]?.['amount']).toBe('300000');
  });

  test('a v2 challenge carries the resource as an object', () => {
    const { body } = paymentRequired(2, {
      accepts: [requirements()],
      resource: { url: 'https://example.test/settle', mimeType: 'application/json' },
    });
    expect(typeof body['resource']).toBe('object');
  });

  test('only v2 reports settlement in a header', () => {
    const settlement: SettleResult = {
      success: true,
      settled: true,
      broadcast: true,
      transaction: '0xabc',
      network: 'eip155:4663',
      payer: PAYER.address,
    };
    expect(paymentResponse(1, settlement).headers).toEqual({});
    const decoded = fromBase64(paymentResponse(2, settlement).headers['PAYMENT-RESPONSE'] ?? '');
    expect(decoded['transaction']).toBe('0xabc');
    expect(decoded['success']).toBe(true);
  });

  test('a refusal carries its reason back to the client', () => {
    const settlement: SettleResult = {
      success: false,
      settled: false,
      broadcast: false,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'eip155:4663',
      payer: PAYER.address,
    };
    const decoded = fromBase64(paymentResponse(2, settlement).headers['PAYMENT-RESPONSE'] ?? '');
    expect(decoded['errorReason']).toBe('insufficient_funds');
  });
});

describe('discovery extension', () => {
  const input = objectSchema({ command: { type: 'string' } }, ['command']);

  test('it nests where the readers actually look', () => {
    const { body } = paymentRequired(2, {
      accepts: [requirements()],
      resource: { url: 'https://example.test/settle' },
      schemas: { input, output: objectSchema({ job: { type: 'string' } }) },
    });
    const extensions = body['extensions'] as { bazaar: { schema: Record<string, never> } };
    const properties = (extensions.bazaar.schema as unknown as { properties: Record<string, { properties: Record<string, unknown> }> }).properties;
    expect(properties['input']?.properties['body']).toEqual(input);
    expect(properties['output']?.properties['example']).toMatchObject({ type: 'object' });
  });

  test('bodyType and the four required input keys are what mark it as a body call', () => {
    const extension = bazaar({ input, example: settlementReceiptExample });
    const schema = extension.bazaar.schema as unknown as {
      properties: { input: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(schema.properties.input.required).toEqual(['type', 'method', 'bodyType', 'body']);
    expect(schema.properties.input.properties['bodyType']).toMatchObject({
      enum: ['json', 'form-data', 'text'],
    });
    // info carries samples where schema carries types, and an indexer checks both.
    expect(extension.bazaar.info['output']).toMatchObject({ type: 'json', example: settlementReceiptExample });
  });

  test('an extension with no output declares none rather than an empty one', () => {
    const extension = bazaar({ input });
    expect(extension.bazaar.info['output']).toBeUndefined();
    const schema = extension.bazaar.schema as unknown as { properties: Record<string, unknown> };
    expect(schema.properties['output']).toBeUndefined();
  });
});

describe('the schema module', () => {
  test('publishes the shapes the discovery document actually uses, and nothing else', async () => {
    const module = await import('../src/schemas.js');
    expect(Object.keys(module).sort()).toEqual(['objectSchema', 'settlementReceiptExample']);
  });
});
