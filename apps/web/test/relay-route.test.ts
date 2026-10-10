import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as quote } from '@/app/api/relay/quote/route';
import { GET as status } from '@/app/api/relay/intents/status/v3/route';
import { RELAY_KEY_ENV } from '@/app/api/relay/upstream';

/**
 * The route forwards one narrow request to Relay and nothing else: a quote into this
 * deployment's USDG from a chain the console funds from, and a status check by request id.
 * The key stays on this side.
 */
type Call = { readonly url: string; readonly init: RequestInit | undefined };

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function relayAnswering(handler: () => Promise<Response>): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), init: init as RequestInit | undefined });
    return handler();
  }) as typeof fetch;
}

const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: '0x877c349EFb5926082C413833E8055F0991185c61',
    recipient: MANDATE,
    originChainId: 8453,
    destinationChainId: 4663,
    originCurrency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    destinationCurrency: USDG,
    amount: '500000',
    tradeType: 'EXACT_INPUT',
    ...over,
  };
}

function ask(payload: unknown, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }): Promise<Response> {
  return quote(
    new Request('https://bursar.example/api/relay/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }),
  );
}

beforeEach(() => {
  calls = [];
  delete process.env[RELAY_KEY_ENV];
  relayAnswering(async () => new Response('{"requestId":"0xabc","steps":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[RELAY_KEY_ENV];
});

describe('a quote through this app', () => {
  it('reaches Relay as the documented body and nothing more', async () => {
    const answer = await ask(body({ extra: 'ignored' }));
    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.relay.link/quote');
    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(sent).toEqual(body());
    expect(new Headers(calls[0]?.init?.headers).get('x-api-key')).toBeNull();
  });

  it('carries the key when the deployment has one, and never echoes it', async () => {
    process.env[RELAY_KEY_ENV] = 'relay-test-key';
    const answer = await ask(body({ useDepositAddress: true }));
    expect(new Headers(calls[0]?.init?.headers).get('x-api-key')).toBe('relay-test-key');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ useDepositAddress: true });
    expect(await answer.text()).not.toContain('relay-test-key');
  });

  it('refuses a quote into anything but USDG on this chain, before Relay is asked', async () => {
    for (const bad of [
      body({ destinationChainId: 8453 }),
      body({ destinationCurrency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }),
      body({ originChainId: 1 }),
      body({ originCurrency: '0x4200000000000000000000000000000000000006' }),
      body({ recipient: 'not-an-address' }),
      body({ amount: '0' }),
      body({ amount: 500000 }),
      'not json',
    ]) {
      const answer = await ask(bad);
      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { errorCode: string }).errorCode).toBe('REFUSED_HERE');
    }
    expect(calls).toHaveLength(0);
  });

  it('is refused from another site', async () => {
    const answer = await ask(body(), { 'sec-fetch-site': 'cross-site' });
    expect(answer.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("hands Relay's refusal back under Relay's own status", async () => {
    relayAnswering(async () => new Response('{"message":"too small","errorCode":"AMOUNT_TOO_LOW"}', { status: 400 }));
    const answer = await ask(body());
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ message: 'too small', errorCode: 'AMOUNT_TOO_LOW' });
  });

  it('says so when Relay cannot be reached', async () => {
    relayAnswering(async () => {
      throw new TypeError('fetch failed');
    });
    const answer = await ask(body());
    expect(answer.status).toBe(502);
    expect(((await answer.json()) as { errorCode: string }).errorCode).toBe('UNREACHABLE');
  });
});

describe('a status check through this app', () => {
  const ID = '0x1791645784cef635090a4832b08285f5222a0a6ce7756f2a506c708d1a11eeeb';

  it('forwards the request id and nothing else', async () => {
    relayAnswering(async () => new Response('{"status":"waiting"}', { status: 200 }));
    const answer = await status(new Request(`https://bursar.example/api/relay/intents/status/v3?requestId=${ID}&other=1`, { headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(answer.status).toBe(200);
    expect(calls[0]?.url).toBe(`https://api.relay.link/intents/status/v3?requestId=${ID}`);
    expect(await answer.json()).toEqual({ status: 'waiting' });
  });

  it('refuses anything that is not a 32-byte id', async () => {
    const answer = await status(new Request('https://bursar.example/api/relay/intents/status/v3?requestId=0x12', { headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(answer.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
