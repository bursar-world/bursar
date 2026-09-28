import { describe, expect, it } from 'vitest';
import { createHttpSink } from '../src/trust/http-sink.js';
import type { OutboxMessage, TrustEventPayload } from '../src/trust/types.js';

function message(eventId: string): OutboxMessage {
  const payload: TrustEventPayload = {
    eventId,
    eventType: 'repayment_received',
    subject: 'agent-1',
    occurredAt: '2026-09-11T00:00:00.000Z',
    lane: 'collateral',
    poolId: 'collateral-main',
    network: 'eip155:4663',
    amountMicro: '90071992547409',
    currency: 'USDG',
    txHash: null,
    referenceId: 'ref-1',
    settlementId: null,
    reservationId: null,
    debtId: 'debt-1',
    payerWallet: null,
    repayWallet: null,
    merchantWallet: null,
    collateralAccount: null,
    assetId: null,
    metadata: {},
  };
  return { id: eventId, eventId, offset: 1n, topic: 't', eventKey: 'agent-1', payload, attemptCount: 1 };
}

function stub(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (...args: Parameters<typeof fetch>) =>
    handler(String(args[0]), args[1] ?? {})) as typeof fetch;
}

describe('http sink', () => {
  it('accepts the whole batch on a bare 2xx', async () => {
    const sink = createHttpSink({ url: 'https://trust.test/events', fetchFn: stub(() => new Response(null, { status: 204 })) });
    const result = await sink.deliver([message('a'), message('b')]);
    expect(result).toMatchObject({ delivered: ['a', 'b'], statusCode: 204, error: null });
  });

  it('takes only what the consumer names when it names any', async () => {
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(() => Response.json({ accepted: ['a', 'unknown'] })),
    });
    const result = await sink.deliver([message('a'), message('b')]);
    expect(result.delivered).toEqual(['a']);
    expect(result.error).toBe('consumer accepted 1 of 2');
  });

  it('does not read an unparseable JSON answer as acceptance', async () => {
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(
        () => new Response('{"accepted": [', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    });
    const result = await sink.deliver([message('a'), message('b')]);

    // Treating it as the whole batch drops every event in it, permanently, on the word of a body
    // nobody could read. A consumer that meant to answer in the documented shape and did not is a
    // delivery to try again.
    expect(result.delivered).toEqual([]);
    expect(result.permanent).toBe(false);
    expect(result.error).toMatch(/declared as JSON/);
  });

  it('refuses an accepted field that is not a list of event ids', async () => {
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(() => Response.json({ accepted: 'a' })),
    });
    expect(await sink.deliver([message('a')])).toMatchObject({ delivered: [], permanent: false });
  });

  it('still accepts a consumer that answers a plain 200 with plain text', async () => {
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(() => new Response('OK', { status: 200, headers: { 'content-type': 'text/plain' } })),
    });
    expect((await sink.deliver([message('a')])).delivered).toEqual(['a']);
  });

  it('accepts a JSON answer that says nothing about individual events', async () => {
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(() => Response.json({ ok: true })),
    });
    expect((await sink.deliver([message('a')])).delivered).toEqual(['a']);
  });

  it('treats a 4xx the consumer will repeat as poison', async () => {
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(() => new Response('schema rejected', { status: 422 })),
    });
    const result = await sink.deliver([message('a')]);
    expect(result).toMatchObject({ delivered: [], statusCode: 422, permanent: true });
    expect(result.error).toContain('schema rejected');
  });

  it('retries the 4xx codes that are about timing rather than content', async () => {
    for (const status of [408, 429]) {
      const sink = createHttpSink({
        url: 'https://trust.test/events',
        fetchFn: stub(() => new Response(null, { status })),
      });
      expect((await sink.deliver([message('a')])).permanent).toBe(false);
    }
  });

  it('retries a 5xx', async () => {
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(() => new Response(null, { status: 503 })),
    });
    expect(await sink.deliver([message('a')])).toMatchObject({ statusCode: 503, permanent: false });
  });

  it('retries a transport failure, which says nothing about the message', async () => {
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(() => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    expect(await sink.deliver([message('a')])).toMatchObject({
      statusCode: null,
      error: 'connect ECONNREFUSED',
      permanent: false,
    });
  });

  it('sends the token when one is configured and nothing when it is not', async () => {
    const seen: (string | undefined)[] = [];
    const capture = stub((_url, init) => {
      seen.push((init.headers as Record<string, string> | undefined)?.authorization);
      return new Response(null, { status: 200 });
    });

    await createHttpSink({ url: 'https://trust.test/e', token: 'abc', fetchFn: capture }).deliver([message('a')]);
    await createHttpSink({ url: 'https://trust.test/e', fetchFn: capture }).deliver([message('a')]);
    expect(seen).toEqual(['Bearer abc', undefined]);
  });

  it('carries amounts as strings, because a double cannot hold one', async () => {
    let body = '';
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub((_url, init) => {
        body = String(init.body);
        return new Response(null, { status: 200 });
      }),
    });
    await sink.deliver([message('a')]);
    expect(body).toContain('"amountMicro":"90071992547409"');
  });

  it('does nothing at all for an empty batch', async () => {
    let called = false;
    const sink = createHttpSink({
      url: 'https://trust.test/events',
      fetchFn: stub(() => {
        called = true;
        return new Response(null, { status: 200 });
      }),
    });
    expect(await sink.deliver([])).toMatchObject({ delivered: [] });
    expect(called).toBe(false);
  });
});
