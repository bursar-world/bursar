import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { allowedOrigin, originPolicy, serve, type Relayer } from '../src/index.js';

/** A relayer that quotes, and whose relay path falls over with a message nobody outside should read. */
const relayer = {
  quote: () => ({ relay: '0x', feeRecipient: '0x', feeBps: 50, gasDropWei: '0', chainId: 4663 }),
  relay: async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.7:8545 (RELAYER_PRIVATE_KEY 0xsecret)');
  },
} as unknown as Relayer;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function start(options: { host?: string; origins?: string } = {}) {
  const logged: string[] = [];
  const server = serve(relayer, {
    port: 0,
    host: '127.0.0.1',
    origins: originPolicy('RELAYER_ALLOWED_ORIGINS', options.origins, options.host),
    health: async () => ({ ok: true }),
    log: (line) => logged.push(line),
  });
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return new Promise<{ url: string; logged: string[] }>((resolve) => {
    server.once('listening', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logged }));
  });
}

describe('the origin policy', () => {
  it('allows the console by default, and the operator’s list otherwise', () => {
    const byDefault = originPolicy('RELAYER_ALLOWED_ORIGINS', undefined, undefined);
    expect(allowedOrigin(byDefault, 'https://app.bursar.world')).toBe('https://app.bursar.world');
    expect(allowedOrigin(byDefault, 'https://evil.example')).toBeNull();
    expect(allowedOrigin(byDefault, 'http://localhost:4310')).toBeNull();

    const listed = originPolicy('RELAYER_ALLOWED_ORIGINS', ' https://App.Example/ ,http://ops.example:8080', '0.0.0.0');
    expect(allowedOrigin(listed, 'https://app.example')).toBe('https://app.example');
    expect(allowedOrigin(listed, 'http://ops.example:8080')).toBe('http://ops.example:8080');
    expect(allowedOrigin(listed, 'https://app.bursar.world')).toBeNull();
    expect(allowedOrigin(listed, undefined)).toBeNull();
    expect(allowedOrigin(listed, 'null')).toBeNull();
  });

  it('lets pages served from this machine call a loopback listener', () => {
    const loopback = originPolicy('RELAYER_ALLOWED_ORIGINS', undefined, '127.0.0.1');
    expect(allowedOrigin(loopback, 'http://localhost:4310')).toBe('http://localhost:4310');
    expect(allowedOrigin(loopback, 'http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(allowedOrigin(loopback, 'http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(allowedOrigin(loopback, 'http://localhost.evil.example')).toBeNull();
  });

  it('refuses an entry that is not an origin, naming the variable', () => {
    for (const bad of ['app.example', 'https://app.example/path', 'ftp://app.example', 'https://app.example?x=1']) {
      expect(() => originPolicy('RELAYER_ALLOWED_ORIGINS', bad, undefined)).toThrow(/RELAYER_ALLOWED_ORIGINS/);
    }
  });
});

describe('the http server', () => {
  it('echoes an allowed origin and withholds the header from any other', async () => {
    const { url } = await start();
    const allowed = await fetch(`${url}/v1/quote`, { headers: { origin: 'https://app.bursar.world' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.bursar.world');
    expect(allowed.headers.get('vary')).toBe('origin');

    const other = await fetch(`${url}/v1/quote`, { headers: { origin: 'https://evil.example' } });
    expect(other.status).toBe(200);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await fetch(`${url}/v1/relay`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.headers.get('access-control-allow-methods')).toBeNull();

    const bare = await fetch(`${url}/v1/quote`);
    expect(bare.status).toBe(200);
    expect(bare.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows a local page when bound to loopback', async () => {
    const { url } = await start({ host: '127.0.0.1' });
    const local = await fetch(`${url}/v1/quote`, { headers: { origin: 'http://localhost:4310' } });
    expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:4310');
  });

  it('keeps the detail of a fault in the log and gives the client a fixed sentence', async () => {
    const { url, logged } = await start();
    const response = await fetch(`${url}/v1/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body).toEqual({
      error: 'internal',
      detail: 'The relayer could not finish this request. Check whether the note is still unspent before sending it again.',
    });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(logged[0]).toMatch(/POST \/v1\/relay failed: .*ECONNREFUSED/);
  });

  it('still answers its own refusals in full', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/relay`, { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_json', detail: 'The body is not JSON.' });
  });
});
