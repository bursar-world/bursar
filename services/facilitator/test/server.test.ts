import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, ok } from '../src/http/io.js';
import type { ApiRequest } from '../src/http/io.js';
import { createHttpServer, listen } from '../src/http/server.js';
import type { RunningServer } from '../src/http/server.js';

/** The socket-level half: the two token guards, body limits, and the shapes that reach the router. */

let running: RunningServer | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

const PROVIDER = 'p'.repeat(32);
const ADMIN = 'a'.repeat(32);

async function start(options: { authToken?: string | null; adminToken?: string | null; host?: string } = {}): Promise<{
  url: string;
  seen: ApiRequest[];
}> {
  const seen: ApiRequest[] = [];
  const server = createHttpServer({
    router: async (request) => {
      seen.push(request);
      if (request.path === '/boom') throw new Error('something gave way');
      return ok({ path: request.path, method: request.method, body: request.body });
    },
    // The host the guard is told about. The socket is always loopback here.
    host: options.host ?? '127.0.0.1',
    port: 0,
    authToken: options.authToken ?? null,
    adminToken: options.adminToken ?? null,
  });
  running = await listen(server, '127.0.0.1', 0);
  return { url: `http://127.0.0.1:${running.port}`, seen };
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('http server', () => {
  it('hands the router a parsed body and the bytes that carried it', async () => {
    const { url, seen } = await start();
    const body = '{"prompt":"hello"}';
    const response = await fetch(`${url}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    expect(seen[0]?.body).toEqual({ prompt: 'hello' });
    expect(Buffer.from(seen[0]?.bytes ?? new Uint8Array()).toString('utf8')).toBe(body);
  });

  it('normalises the path and keeps the query separate', async () => {
    const { url, seen } = await start();
    await fetch(`${url}/accounts/agent-1/transactions/?limit=5`);
    expect(seen[0]?.path).toBe('/accounts/agent-1/transactions');
    expect(seen[0]?.query.get('limit')).toBe('5');
  });

  it('refuses a body that is not JSON', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('refuses a body larger than the limit', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }),
    });
    expect(response.status).toBe(413);
  });

  it('answers 413 rather than resetting the socket when the body arrives in chunks', async () => {
    const { url } = await start();
    const { port } = new URL(url);

    // With no content-length the limit is reached mid-stream, after the headers. Killing the
    // socket there is what left a client with ECONNRESET and no idea why.
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: '127.0.0.1', port: Number(port), method: 'POST', path: '/verify', headers: { 'transfer-encoding': 'chunked' } },
        (incoming) => {
          let text = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => (text += chunk));
          incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: text }));
        },
      );
      outgoing.on('error', reject);
      outgoing.write('x'.repeat(MAX_BODY_BYTES + 1));
      outgoing.end();
    });

    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toMatchObject({ error: 'body_too_large' });
  });

  it('treats an empty body as an empty object', async () => {
    const { url, seen } = await start();
    await fetch(`${url}/supported`);
    expect(seen[0]?.body).toEqual({});
  });

  it('answers every route without a token on a loopback listener that has none', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/accounts`, { method: 'POST' })).status).toBe(200);
  });

  it('guards the provider routes with the provider token, health included', async () => {
    const { url } = await start({ authToken: PROVIDER, adminToken: ADMIN });

    expect((await fetch(`${url}/healthz`)).status).toBe(401);
    expect((await fetch(`${url}/healthz`, bearer('wrong'))).status).toBe(401);
    expect((await fetch(`${url}/healthz`, bearer(PROVIDER))).status).toBe(200);
    for (const path of ['/readyz', '/supported', '/config']) expect((await fetch(`${url}${path}`, bearer(PROVIDER))).status).toBe(200);
    for (const path of ['/verify', '/settle']) expect((await fetch(`${url}${path}`, { method: 'POST', ...bearer(PROVIDER) })).status).toBe(200);
  });

  it('opens the ledger routes to the admin token and never to the provider token', async () => {
    const { url, seen } = await start({ authToken: PROVIDER, adminToken: ADMIN });

    for (const path of ['/accounts', '/pools', '/lanes/agent-1/prefund', '/underwrite', '/reservations', '/settlements/net', '/trust/outbox/redrive']) {
      expect((await fetch(`${url}${path}`, { method: 'POST', ...bearer(PROVIDER) })).status, path).toBe(401);
      expect((await fetch(`${url}${path}`, { method: 'POST' })).status, path).toBe(401);
    }
    expect((await fetch(`${url}/accounts/agent-1`, bearer(PROVIDER))).status).toBe(401);
    expect((await fetch(`${url}/trust/events`, bearer(PROVIDER))).status).toBe(401);
    // Nothing reached the router on those.
    expect(seen).toHaveLength(0);

    expect((await fetch(`${url}/accounts`, { method: 'POST', ...bearer(ADMIN) })).status).toBe(200);
    expect((await fetch(`${url}/trust/events`, bearer(ADMIN))).status).toBe(200);
    expect(await (await fetch(`${url}/accounts/agent-1`, bearer(PROVIDER))).json()).toMatchObject({ error: 'unauthorized' });
  });

  it('keeps the admin token off the provider routes, so each token opens one class of route', async () => {
    const { url } = await start({ authToken: PROVIDER, adminToken: ADMIN });
    expect((await fetch(`${url}/healthz`, bearer(ADMIN))).status).toBe(401);
    expect((await fetch(`${url}/verify`, { method: 'POST', ...bearer(ADMIN) })).status).toBe(401);
  });

  it('refuses the ledger routes by name when the provider token is set and no admin token is', async () => {
    const { url, seen } = await start({ authToken: PROVIDER });
    const response = await fetch(`${url}/accounts`, { method: 'POST', ...bearer(PROVIDER) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'admin_token_unset' });
    expect((await fetch(`${url}/accounts`, { method: 'POST' })).status).toBe(403);
    expect(seen).toHaveLength(0);
    expect((await fetch(`${url}/healthz`, bearer(PROVIDER))).status).toBe(200);
  });

  it('refuses the ledger routes by name off loopback when no admin token is set, whatever else is', async () => {
    const { url, seen } = await start({ host: '0.0.0.0' });
    const response = await fetch(`${url}/pools`, { method: 'POST' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'admin_token_unset' });
    expect(seen).toHaveLength(0);
  });

  it('counts an unknown path as a ledger route, so a probe learns nothing without the admin token', async () => {
    const { url } = await start({ authToken: PROVIDER, adminToken: ADMIN });
    expect((await fetch(`${url}/nope`, bearer(PROVIDER))).status).toBe(401);
    expect((await fetch(`${url}/nope`, bearer(ADMIN))).status).toBe(200);
  });

  it('says nothing about an unexpected fault beyond that there was one', async () => {
    const { url } = await start({ authToken: PROVIDER, adminToken: ADMIN });
    const response = await fetch(`${url}/boom`, bearer(ADMIN));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('reports its own port when told to pick one', async () => {
    await start();
    expect(running?.port).toBeGreaterThan(0);
  });
});
