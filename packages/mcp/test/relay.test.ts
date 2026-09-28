import { describe, expect, it } from 'vitest';

import { createHttpRelay } from '../src/relay.js';
import type { RelaySpendRequest } from '../src/relay.js';
import { isToolError } from '../src/errors.js';

const REQUEST: RelaySpendRequest = {
  mandateAccount: '0x00000000000000000000000000000000000acc01',
  merchant: '0x3333333333333333333333333333333333333333',
  capabilityId: `0x${'11'.repeat(32)}`,
  inputCommit: `0x${'22'.repeat(32)}`,
  inputURI: 'data:application/json;base64,eyJjaXR5IjoiUGFyaXMifQ==',
  amount: '1000000',
  deadline: '1800000300',
  merchantProof: [],
  approval: null,
};

type Call = { url: string; init: RequestInit };

function relayThat(respond: (call: Call) => Response, token?: string) {
  const calls: Call[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);

    return respond(call);
  }) as typeof fetch;

  return {
    calls,
    relay: createHttpRelay({ url: 'https://relay.test/', ...(token === undefined ? {} : { token }), fetchFn }),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('the http relay', () => {
  it('posts the spend and reads back the settlement it opened', async () => {
    const { relay, calls } = relayThat(() => json({ escrowId: '42', txHash: `0x${'cd'.repeat(32)}` }));

    const receipt = await relay.spend(REQUEST);

    expect(receipt).toEqual({ escrowId: 42n, txHash: `0x${'cd'.repeat(32)}` });
    expect(calls[0]?.url).toBe('https://relay.test/v1/spends');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(REQUEST);
  });

  it('carries the bearer token when one is configured, and no header when there is none', async () => {
    const withToken = relayThat(() => json({ escrowId: '1', txHash: `0x${'cd'.repeat(32)}` }), 'a-long-relay-token');
    const without = relayThat(() => json({ escrowId: '1', txHash: `0x${'cd'.repeat(32)}` }));

    await withToken.relay.spend(REQUEST);
    await without.relay.spend(REQUEST);

    expect(headers(withToken.calls[0])['authorization']).toBe('Bearer a-long-relay-token');
    expect(headers(without.calls[0])['authorization']).toBeUndefined();
  });

  it('addresses the dispute route by settlement id', async () => {
    const { relay, calls } = relayThat(() => json({ txHash: `0x${'ef'.repeat(32)}` }));

    await relay.dispute({ mandateAccount: REQUEST.mandateAccount, escrowId: 9n });

    expect(calls[0]?.url).toBe('https://relay.test/v1/spends/9/dispute');
  });

  it('turns a decoded revert into the sentence a quote would have given', async () => {
    const { relay } = relayThat(() =>
      json({ error: 'reverted', message: 'execution reverted', revert: 'MonthlyCapExceeded' }, 422),
    );

    await expect(relay.spend(REQUEST)).rejects.toMatchObject({
      code: 'mandate_refused',
      message: 'The monthly budget does not have room for this spend. It refills at the next monthly reset.',
    });
  });

  it('reports a refusal it cannot decode without inventing a cause', async () => {
    const { relay } = relayThat(() => json({ error: 'nonce_taken', message: 'the signer is busy' }, 409));

    await expect(relay.spend(REQUEST)).rejects.toMatchObject({
      code: 'relay_rejected',
      message: 'the signer is busy',
    });
  });

  it('says nothing was spent when the relay cannot be reached', async () => {
    const { relay } = relayThat(() => {
      throw new Error('socket hang up');
    });

    await expect(relay.spend(REQUEST)).rejects.toMatchObject({ code: 'relay_unreachable' });
  });

  it('does not claim nothing was spent when the relay ran out of time', async () => {
    // The relay signs and submits before it answers, so a timeout leaves a transaction that may
    // well be mining. An agent told nothing was spent sends the payment again.
    const { relay } = relayThat(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const failure = await relay.spend(REQUEST).catch((error: unknown) => error);

    expect(isToolError(failure) && failure.code).toBe('relay_timeout');
    expect(isToolError(failure) && failure.message).toMatch(/Read the settlements for this mandate/);
    expect(isToolError(failure) && failure.message).not.toMatch(/nothing was spent/i);
  });

  it('keeps its own vocabulary when the answer is cut off mid-body', async () => {
    const { relay } = relayThat(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
            },
          }),
        ),
    );

    const failure = await relay.spend(REQUEST).catch((error: unknown) => error);

    expect(isToolError(failure) && failure.code).toBe('relay_timeout');
  });

  it('refuses an answer with no settlement id rather than reporting a payment it cannot name', async () => {
    const { relay } = relayThat(() => json({ txHash: `0x${'cd'.repeat(32)}` }));

    await expect(relay.spend(REQUEST)).rejects.toMatchObject({ code: 'relay_bad_response' });
  });

  it('refuses an answer with no transaction hash', async () => {
    const { relay } = relayThat(() => json({ escrowId: '42' }));

    const failure = await relay.spend(REQUEST).catch((error: unknown) => error);

    expect(isToolError(failure) && failure.code).toBe('relay_bad_response');
  });

  it('refuses a body that is not json', async () => {
    const { relay } = relayThat(() => new Response('<html>502</html>', { status: 200 }));

    await expect(relay.spend(REQUEST)).rejects.toMatchObject({ code: 'relay_bad_response' });
  });

  /**
   * A 2xx means the relay took the request, and it submits before it answers. An answer that
   * cannot be read says nothing about whether the spend went out, so the agent is sent to the
   * settlements rather than back to pay.
   */
  it.each([
    ['a body that is not json', () => new Response('<html>ok</html>', { status: 200 })],
    ['an answer with no transaction hash', () => json({ escrowId: '42' })],
    ['an answer with no settlement id', () => json({ txHash: `0x${'cd'.repeat(32)}` })],
  ])('warns the spend may be on chain after %s', async (_label, respond) => {
    const { relay } = relayThat(respond);

    const failure = await relay.spend(REQUEST).catch((error: unknown) => error);

    expect(isToolError(failure) && failure.code).toBe('relay_bad_response');
    expect(isToolError(failure) && failure.message).toMatch(/may already be on chain/);
    expect(isToolError(failure) && failure.message).toMatch(/Read the settlements for this mandate/);
  });

  it('says nothing was spent when the relay declines with a 4xx', async () => {
    const { relay } = relayThat(() => json({ error: 'bad_request' }, 400));

    const failure = await relay.spend(REQUEST).catch((error: unknown) => error);

    expect(isToolError(failure) && failure.code).toBe('relay_rejected');
    expect(isToolError(failure) && failure.message).toMatch(/Nothing was spent/);
  });

  it('does not claim nothing was spent when the relay fails with a 5xx', async () => {
    const withMessage = relayThat(() => json({ error: 'internal', message: 'the signer crashed' }, 500));
    const bare = relayThat(() => new Response('bad gateway', { status: 502 }));

    for (const { relay } of [withMessage, bare]) {
      const failure = await relay.spend(REQUEST).catch((error: unknown) => error);

      expect(isToolError(failure) && failure.code).toBe('relay_failed');
      expect(isToolError(failure) && failure.message).not.toMatch(/nothing was spent/i);
      expect(isToolError(failure) && failure.message).toMatch(/may already be on chain/);
    }
  });
});

function headers(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

/**
 * A closed set of named actions, never a destination and calldata. This seam is where the
 * operator's key decides what it will do, and an open route would make that decision meaningless.
 */
describe('the routes the two self-acting roles use', () => {
  const RESOLVER = '0x5555555555555555555555555555555555555555' as const;
  const PROVIDER = '0x3333333333333333333333333333333333333333' as const;

  it('posts a resolver action to a route named after it, with the address to sign as', async () => {
    const { relay, calls } = relayThat(() => json({ txHash: `0x${'ab'.repeat(32)}` }));

    const receipt = await relay.resolverCall({
      resolver: RESOLVER,
      action: 'commit',
      disputeId: '4',
      commitment: `0x${'11'.repeat(32)}`,
    });

    expect(receipt).toEqual({ txHash: `0x${'ab'.repeat(32)}` });
    expect(calls[0]?.url).toBe('https://relay.test/v1/resolver/commit');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      resolver: RESOLVER,
      disputeId: '4',
      commitment: `0x${'11'.repeat(32)}`,
    });
  });

  it('posts a provider action the same way', async () => {
    const { relay, calls } = relayThat(() => json({ txHash: `0x${'ab'.repeat(32)}` }));

    await relay.providerCall({ provider: PROVIDER, action: 'register', name: 'render_farm', stake: '25000000' });

    expect(calls[0]?.url).toBe('https://relay.test/v1/provider/register');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      provider: PROVIDER,
      name: 'render_farm',
      stake: '25000000',
    });
  });

  /**
   * `ZeroAmount` means three different things in three different contracts. The relay knows which
   * call it made, so the sentence that comes back is the one for that contract.
   */
  it('reads a revert against the table for the contract that refused it', async () => {
    const resolver = relayThat(() => json({ error: 'reverted', revert: 'ZeroAmount' }, 400));
    const provider = relayThat(() => json({ error: 'reverted', revert: 'ZeroAmount' }, 400));

    const fromResolver = await resolver.relay
      .resolverCall({ resolver: RESOLVER, action: 'bond', amount: '0' })
      .catch((error: unknown) => error);
    const fromProvider = await provider.relay
      .providerCall({ provider: PROVIDER, action: 'add-stake', amount: '0' })
      .catch((error: unknown) => error);

    expect(isToolError(fromResolver) && fromResolver.code).toBe('resolver_refused');
    expect(isToolError(fromResolver) && fromResolver.message).toContain('BRSR');
    expect(isToolError(fromProvider) && fromProvider.code).toBe('provider_refused');
    expect(isToolError(fromProvider) && fromProvider.message).toContain('USDG');
  });

  it('says a resolver window that has shut cannot be retried into working', async () => {
    const { relay } = relayThat(() => json({ error: 'reverted', revert: 'RevealWindowClosed' }, 400));

    const failure = await relay
      .resolverCall({ resolver: RESOLVER, action: 'reveal', disputeId: '4', score: 70, salt: `0x${'11'.repeat(32)}` })
      .catch((error: unknown) => error);

    expect(isToolError(failure) && failure.message).toContain('Nothing recovers it');
  });
});
