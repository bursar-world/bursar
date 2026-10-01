import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { SetStore, originPolicy, serve, type AspView } from '../src/index.js';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A view whose chain read fails with a message carrying the endpoint, which no caller should see. */
function start(options: { host?: string; origins?: string; chainRoot?: () => Promise<bigint | null> } = {}) {
  const view: AspView = {
    store: new SetStore(null),
    chainRoot:
      options.chainRoot ??
      (async () => {
        throw new Error('HTTP request failed. URL: https://rpc.example/v2/secret-key');
      }),
    health: () => ({ ok: true }),
  };
  const logged: string[] = [];
  const server = serve(view, {
    port: 0,
    host: '127.0.0.1',
    origins: originPolicy('ASP_ALLOWED_ORIGINS', options.origins, options.host),
    log: (line) => logged.push(line),
  });
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return new Promise<{ url: string; logged: string[] }>((resolve) => {
    server.once('listening', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logged }));
  });
}

describe('the http server', () => {
  it('echoes an allowed origin and withholds the header from any other', async () => {
    const { url } = await start({ chainRoot: async () => null });
    const allowed = await fetch(`${url}/v1/association-set`, { headers: { origin: 'https://app.bursar.world' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.bursar.world');
    expect(allowed.headers.get('vary')).toBe('origin');

    const other = await fetch(`${url}/v1/association-set`, { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();

    const bare = await fetch(`${url}/health`);
    expect(bare.status).toBe(200);
    expect(bare.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows a local page when bound to loopback, and a listed origin anywhere', async () => {
    const local = await start({ host: '127.0.0.1', chainRoot: async () => null });
    expect((await fetch(`${local.url}/health`, { headers: { origin: 'http://localhost:4310' } })).headers.get('access-control-allow-origin')).toBe('http://localhost:4310');

    const listed = await start({ origins: 'https://ops.example', chainRoot: async () => null });
    expect((await fetch(`${listed.url}/health`, { headers: { origin: 'https://ops.example' } })).headers.get('access-control-allow-origin')).toBe('https://ops.example');
    expect((await fetch(`${listed.url}/health`, { headers: { origin: 'https://app.bursar.world' } })).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps the detail of a fault in the log and gives the client a fixed sentence', async () => {
    const { url, logged } = await start();
    const response = await fetch(`${url}/v1/association-set`);
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { error: string; detail: string };
    expect(body).toEqual({ error: 'internal', detail: 'The association set could not be read right now. Try again shortly.' });
    expect(JSON.stringify(body)).not.toContain('secret-key');
    expect(logged[0]).toMatch(/GET \/v1\/association-set failed: .*secret-key/);
  });
});
