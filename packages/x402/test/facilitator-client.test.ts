import { describe, expect, test } from 'vitest';
import { micro } from '@bursar/core';
import { createFacilitatorClient } from '../src/facilitator-client.js';
import type { PaymentPayload, PaymentRequirements } from '../src/types.js';
import { PAY_TO, PAYER, USDG } from './support.js';

const REQUIREMENTS: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:4663',
  amount: '300000',
  asset: USDG,
  payTo: PAY_TO,
};

const PAYLOAD: PaymentPayload = {
  x402Version: 2,
  payload: { signature: `0x${'ab'.repeat(65)}`, authorization: { from: PAYER.address } },
};

type Call = { url: string; init: RequestInit };

function stub(
  answer: (call: Call) => { status?: number; body?: unknown; text?: string } | Promise<never>,
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const result = await answer(call);
    const status = result.status ?? 200;
    const text = result.text ?? JSON.stringify(result.body ?? {});
    return new Response(text, { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function client(fetchFn: typeof fetch, timeoutMs = 50) {
  return createFacilitatorClient({ baseUrl: 'https://facilitator.test/', fetchFn, timeoutMs });
}

describe('verify', () => {
  test('a verdict comes back with the payer, the method and the amount', async () => {
    const { fetchFn, calls } = stub(() => ({
      body: { isValid: true, payer: PAYER.address, method: 'eip3009', amount: '300000' },
    }));
    const result = await client(fetchFn).verify(PAYLOAD, REQUIREMENTS);
    expect(result).toMatchObject({ isValid: true, payer: PAYER.address, method: 'eip3009' });
    if (result.isValid) expect(result.amount).toBe(micro(300_000n));
    expect(calls[0]?.url).toBe('https://facilitator.test/verify');
  });

  test('a refusal keeps the reason the client is expected to branch on', async () => {
    const { fetchFn } = stub(() => ({
      body: { isValid: false, invalidReason: 'insufficient_funds', payer: PAYER.address },
    }));
    const result = await client(fetchFn).verify(PAYLOAD, REQUIREMENTS);
    expect(result).toMatchObject({ isValid: false, invalidReason: 'insufficient_funds', payer: PAYER.address });
  });

  test('a facilitator that cannot be reached has said nothing, and verification wrote nothing', async () => {
    const { fetchFn } = stub(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await client(fetchFn).verify(PAYLOAD, REQUIREMENTS);
    expect(result).toMatchObject({ isValid: false, invalidReason: 'facilitator_unavailable' });
  });

  test('an answer that is not a verdict is not a valid payment', async () => {
    const { fetchFn } = stub(() => ({ text: '<html>502 Bad Gateway</html>' }));
    const result = await client(fetchFn).verify(PAYLOAD, REQUIREMENTS);
    expect(result.isValid).toBe(false);
  });
});

describe('settle', () => {
  test('a settlement comes back whole', async () => {
    const { fetchFn } = stub(() => ({
      body: {
        success: true,
        settled: true,
        broadcast: true,
        payer: PAYER.address,
        transaction: `0x${'cd'.repeat(32)}`,
        network: 'eip155:4663',
      },
    }));
    const result = await client(fetchFn).settle(PAYLOAD, REQUIREMENTS);
    expect(result).toMatchObject({ success: true, settled: true, broadcast: true });
    expect(result.transaction).toBe(`0x${'cd'.repeat(32)}`);
  });

  test('a budget refusal arrives as an answer, not as an outage', async () => {
    const { fetchFn } = stub(() => ({
      status: 429,
      body: { success: false, settled: false, broadcast: false, errorReason: 'daily_budget_exhausted', payer: PAYER.address },
    }));
    const result = await client(fetchFn).settle(PAYLOAD, REQUIREMENTS);
    expect(result).toMatchObject({ success: false, settled: false, broadcast: false });
    expect(result.errorReason).toBe('daily_budget_exhausted');
  });

  test('a settle that never answers is unconfirmed, because it may already have been broadcast', async () => {
    const { fetchFn } = stub(() => Promise.reject(new Error('socket hang up')));
    const result = await client(fetchFn).settle(PAYLOAD, REQUIREMENTS);
    // Calling this a failure would serve the resource free against a payment the payer was charged.
    expect(result).toMatchObject({
      success: false,
      settled: null,
      broadcast: true,
      errorReason: 'settlement_unconfirmed',
      network: 'eip155:4663',
    });
  });

  test('a null settled survives the trip intact', async () => {
    const { fetchFn } = stub(() => ({
      body: {
        success: false,
        settled: null,
        broadcast: true,
        errorReason: 'settlement_unconfirmed',
        transaction: `0x${'ef'.repeat(32)}`,
        payer: PAYER.address,
      },
    }));
    const result = await client(fetchFn).settle(PAYLOAD, REQUIREMENTS);
    expect(result.settled).toBeNull();
    expect(result.transaction).toBe(`0x${'ef'.repeat(32)}`);
  });

  test('an older facilitator that reports no settled field is read from its success', async () => {
    const { fetchFn } = stub(() => ({
      body: { success: true, payer: PAYER.address, transaction: '0xabc', network: 'eip155:4663' },
    }));
    const result = await client(fetchFn).settle(PAYLOAD, REQUIREMENTS);
    expect(result.settled).toBe(true);
    expect(result.broadcast).toBe(true);
  });

  test('an answer too large to be a settlement is not treated as one', async () => {
    const { fetchFn } = stub(() => ({ text: 'x'.repeat(40_000) }));
    const result = await client(fetchFn).settle(PAYLOAD, REQUIREMENTS);
    expect(result.errorReason).toBe('settlement_unconfirmed');
    expect(result.detail).toContain('over the');
  });
});

describe('supported', () => {
  test('the kinds come back, and a malformed list is an empty one', async () => {
    const withKinds = stub(() => ({
      body: { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:4663' }] },
    }));
    expect((await client(withKinds.fetchFn).supported()).kinds).toHaveLength(1);
    expect(withKinds.calls[0]?.init.method).toBe('GET');

    const empty = stub(() => ({ body: { kinds: 'all of them' } }));
    expect((await client(empty.fetchFn).supported()).kinds).toEqual([]);
  });
});

describe('transport', () => {
  test('configured headers ride along, and the path never doubles its slash', async () => {
    const { fetchFn, calls } = stub(() => ({ body: { isValid: true, payer: PAYER.address } }));
    const facilitator = createFacilitatorClient({
      baseUrl: 'https://facilitator.test///',
      fetchFn,
      headers: { authorization: 'Bearer test' },
    });
    await facilitator.verify(PAYLOAD, REQUIREMENTS);
    expect(calls[0]?.url).toBe('https://facilitator.test/verify');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test');
    expect(headers['content-type']).toBe('application/json');
  });

  test('a body is measured in bytes, not in the units a string happens to count in', async () => {
    // Valid JSON, valid settlement, 3 bytes per character: under a 100-byte budget by string
    // length and three times over it on the wire.
    const body = {
      success: true,
      payer: PAYER.address,
      transaction: `0x${'ef'.repeat(32)}`,
      network: 'eip155:4663',
      detail: '€'.repeat(100),
    };
    const text = JSON.stringify(body);
    const budget = text.length;
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(budget);

    const { fetchFn } = stub(() => ({ body }));
    const facilitator = createFacilitatorClient({
      baseUrl: 'https://facilitator.test',
      fetchFn,
      maxResponseBytes: budget,
    });

    const result = await facilitator.settle(PAYLOAD, REQUIREMENTS);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe('settlement_unconfirmed');
    expect(result.detail).toContain(`over the ${budget} limit`);
  });

  test('a declared length over the budget is refused on the header alone', async () => {
    const { fetchFn } = stub(() => ({ body: { isValid: true, payer: PAYER.address } }));
    const declaring = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const answer = await fetchFn(input, init);
      return new Response(answer.body, { headers: { 'content-length': '99999' } });
    }) as unknown as typeof fetch;

    const result = await client(declaring).verify(PAYLOAD, REQUIREMENTS);

    expect(result).toMatchObject({ isValid: false, invalidReason: 'facilitator_unavailable' });
    expect(result.isValid ? '' : result.detail).toContain('declared 99999 bytes');
  });

  test('a body that keeps coming is cut off at the budget rather than buffered whole', async () => {
    const chunk = new Uint8Array(1_024);
    let pulled = 0;
    const fetchFn = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled > 100) return controller.close();
            controller.enqueue(chunk);
          },
        }),
      )) as unknown as typeof fetch;

    const facilitator = createFacilitatorClient({
      baseUrl: 'https://facilitator.test',
      fetchFn,
      maxResponseBytes: 4_096,
    });

    const result = await facilitator.verify(PAYLOAD, REQUIREMENTS);

    expect(result).toMatchObject({ isValid: false, invalidReason: 'facilitator_unavailable' });
    expect(pulled).toBeLessThan(100);
  });

  test('a request that hangs is abandoned rather than held open', async () => {
    const slow = ((_input: Parameters<typeof fetch>[0], init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const result = await client(slow, 20).settle(PAYLOAD, REQUIREMENTS);
    expect(result.errorReason).toBe('settlement_unconfirmed');
    expect(result.detail).toContain('20ms');
  });
});

describe('the HTTP status travels with the answer', () => {
  test('a gateway 504 in front of a settle is unconfirmed, whatever its body says', async () => {
    const { fetchFn } = stub(() => ({ status: 504, body: { success: false, error: 'upstream timed out' } }));
    const result = await client(fetchFn).settle(PAYLOAD, REQUIREMENTS);
    // The facilitator broadcasts before it answers, so a proxy timing out says nothing about the
    // transfer. Reading this as broadcast: false would refund a payment that may be mining.
    expect(result).toMatchObject({ settled: null, broadcast: true, errorReason: 'settlement_unconfirmed' });
    expect(result.detail).toContain('504');
  });

  test('a non-2xx settle that says it did not broadcast is taken at its word', async () => {
    const { fetchFn } = stub(() => ({
      status: 500,
      body: { success: false, settled: false, broadcast: false, errorReason: 'facilitator_unavailable' },
    }));
    const result = await client(fetchFn).settle(PAYLOAD, REQUIREMENTS);
    expect(result).toMatchObject({ broadcast: false, errorReason: 'facilitator_unavailable' });
  });

  test('a 401 from an auth proxy is the facilitator being unreachable, not a bad payload', async () => {
    const { fetchFn } = stub(() => ({ status: 401, body: { error: 'unauthorised' } }));
    const result = await client(fetchFn).verify(PAYLOAD, REQUIREMENTS);
    expect(result).toMatchObject({ isValid: false, invalidReason: 'facilitator_unavailable' });
    expect(result).toHaveProperty('detail', expect.stringContaining('401'));
  });

  test('a valid verdict that names no payer is not one a server can charge against', async () => {
    const { fetchFn } = stub(() => ({ body: { isValid: true, method: 'eip3009' } }));
    const result = await client(fetchFn).verify(PAYLOAD, REQUIREMENTS);
    expect(result).toMatchObject({ isValid: false, invalidReason: 'facilitator_unavailable' });
  });
});
