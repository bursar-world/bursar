import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, ok } from '../src/http/io.js';
import type { ApiRequest } from '../src/http/io.js';
import { createHttpServer, listen } from '../src/http/server.js';
import type { RunningServer } from '../src/http/server.js';

/** The socket-level half: the token guard, body limits, and the shapes that reach the router. */

let running: RunningServer | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(options: { authToken?: string | null } = {}): Promise<{
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
    host: '127.0.0.1',
    port: 0,
    authToken: options.authToken ?? null,
  });
  running = await listen(server, '127.0.0.1', 0);
  return { url: `http://127.0.0.1:${running.port}`, seen };
}

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

  it('answers every route without a token on loopback', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it('guards every route once a token is configured, health included', async () => {
    const token = 'a'.repeat(32);
    const { url } = await start({ authToken: token });

    expect((await fetch(`${url}/healthz`)).status).toBe(401);
    expect((await fetch(`${url}/healthz`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${url}/healthz`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('says nothing about an unexpected fault beyond that there was one', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/boom`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('reports its own port when told to pick one', async () => {
    await start();
    expect(running?.port).toBeGreaterThan(0);
  });
});
