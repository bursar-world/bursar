import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashRequest, randomSalt, requestCommit, requestDocument, requestURI } from '@bursar/core';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalStringify, capabilityId, commitCanonical } from '../src/commit.js';
import {
  createOutputReader,
  createOutputWriter,
  executeJob,
  outputURI,
  parseRoutes,
  readRoutes,
} from '../src/executor.js';
import type { ExecutorOptions, LockJob } from '../src/executor.js';
import { createFakeFetch, dataURI, jsonResponse, rawDataURI } from './fakes.js';
import type { FetchCall } from './fakes.js';

const WEATHER = 'weather.get:1';
const ROUTES = parseRoutes({
  [WEATHER]: { method: 'POST', path: '/v1/weather' },
  'quote.get:1': { path: '/v1/quotes/spot' },
});

const API_BASE = 'http://127.0.0.1:8787';
const INPUT = { units: 'metric', city: 'Paris' };
const CANONICAL_INPUT = '{"city":"Paris","units":"metric"}';
const OUTPUT = { tempC: 21, city: 'Paris' };
const COMMIT_A = `0x${'aa'.repeat(32)}` as const;
const COMMIT_B = `0x${'bb'.repeat(32)}` as const;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Harness = {
  options: ExecutorOptions;
  fetches: FetchCall[];
  writes: Array<{ id: bigint; canonical: string }>;
};

type Handler = (call: FetchCall) => Response | Promise<Response>;

const weatherApi: Handler = () => jsonResponse(JSON.stringify(OUTPUT));

function harness(handler: Handler = weatherApi, overrides: Partial<ExecutorOptions> = {}): Harness {
  const { fetch, calls } = createFakeFetch(handler);
  const writes: Array<{ id: bigint; canonical: string }> = [];

  return {
    fetches: calls,
    writes,
    options: {
      routes: ROUTES,
      apiBase: API_BASE,
      allowedHosts: new Set(['localhost', '127.0.0.1']),
      fetch,
      fetchTimeoutMs: 1_000,
      maxBodyBytes: 1_024,
      maxInlineOutputBytes: 4_096,
      outputBaseUrl: undefined,
      writeOutput: async (id, canonical) => {
        writes.push({ id, canonical });
      },
      ...overrides,
    },
  };
}

function job(overrides: Partial<LockJob> = {}): LockJob {
  return {
    id: 7n,
    capabilityId: capabilityId(WEATHER),
    inputCommit: commitCanonical(INPUT),
    inputURI: dataURI(INPUT),
    ...overrides,
  };
}

describe('executeJob', () => {
  it('verifies a data URI input and answers with the output commitment', async () => {
    const { options, writes } = harness();

    const outcome = await executeJob(job(), options);

    expect(outcome).toEqual({
      kind: 'executed',
      outputCommit: commitCanonical(OUTPUT),
      outputURI: dataURI(OUTPUT),
      outputBytes: canonicalStringify(OUTPUT).length,
    });
    expect(writes).toEqual([{ id: 7n, canonical: canonicalStringify(OUTPUT) }]);
  });

  it('posts the canonical form of the fetched input to the routed path', async () => {
    const { options, fetches } = harness();

    await executeJob(job({ inputURI: rawDataURI(JSON.stringify(INPUT)) }), options);

    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.url).toBe(`${API_BASE}/v1/weather`);
    expect(fetches[0]?.init.method).toBe('POST');
    expect(fetches[0]?.init.body).toBe(CANONICAL_INPUT);
  });

  it('carries the canonical input on whichever method the route names', async () => {
    const { options, fetches } = harness(weatherApi, {
      routes: parseRoutes({ [WEATHER]: { method: 'put', path: '/v1/weather' } }),
    });

    await executeJob(job(), options);

    expect(fetches[0]?.init.method).toBe('PUT');
    expect(fetches[0]?.init.body).toBe(CANONICAL_INPUT);
  });

  it('routes each capability to its own path', async () => {
    const { options, fetches } = harness();

    await executeJob(
      job({
        capabilityId: capabilityId('quote.get:1'),
        inputCommit: commitCanonical({}),
        inputURI: dataURI({}),
      }),
      options,
    );

    expect(fetches[0]?.url).toBe(`${API_BASE}/v1/quotes/spot`);
  });

  it('rejects an input that does not hash to the escrowed commitment', async () => {
    const { options, fetches, writes } = harness();

    const outcome = await executeJob(job({ inputCommit: commitCanonical({ city: 'Berlin' }) }), options);

    expect(outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('commitment mismatch') });
    expect(fetches).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('rejects a capability that is not routed', async () => {
    const { options, fetches } = harness();

    const outcome = await executeJob({ ...job(), capabilityId: capabilityId('weather.get:2') }, options);

    expect(outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('unknown capability') });
    expect(fetches).toHaveLength(0);
  });

  it('rejects input that is not valid JSON', async () => {
    const { options } = harness();

    const outcome = await executeJob(job({ inputURI: rawDataURI('{not json') }), options);

    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'input is not valid JSON' });
  });

  it('rejects an oversized data URI without decoding past the cap', async () => {
    const { options } = harness();
    const oversized = rawDataURI(JSON.stringify({ blob: 'x'.repeat(2_000) }));

    expect(await executeJob(job({ inputURI: oversized }), options)).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('exceeds 1024 bytes'),
    });
  });
});

describe('input URI policy', () => {
  it('leaves a lock that pays for an x402 call to the server that served it', async () => {
    const { options, fetches, writes } = harness();
    const binding = { requestHash: hashRequest('{"q":1}'), salt: randomSalt() };
    const document = requestDocument({ method: 'POST', url: 'https://api.provider.dev/render', binding });

    const outcome = await executeJob(job({ inputCommit: requestCommit(document), inputURI: requestURI(document) }), options);

    // The description of a request is not a job. Nothing is fetched, called or written, and the
    // log says whose lock it is.
    expect(outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('serves itself') });
    expect(fetches).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['file:///etc/passwd', 'scheme file: is not allowed'],
    ['ftp://127.0.0.1/input.json', 'scheme ftp: is not allowed'],
    ['http://inputs.example.com/input.json', 'host inputs.example.com is not allowed'],
    ['https://127.0.0.1.example.com/input.json', 'host 127.0.0.1.example.com is not allowed'],
    ['http://agent:secret@127.0.0.1:8787/input.json', 'carries credentials'],
    ['data:text/plain;base64,e30=', 'scheme data: is not allowed'],
    ['not a uri', 'input URI is not a URI'],
  ])('refuses %s', async (inputURI, reason) => {
    const { options, fetches } = harness();

    const outcome = await executeJob(job({ inputURI }), options);

    expect(outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining(reason) });
    expect(fetches).toHaveLength(0);
  });

  it('fetches an allowlisted host', async () => {
    const { options, fetches } = harness((call) =>
      call.url === 'https://inputs.example.com/input.json' ? jsonResponse(CANONICAL_INPUT) : jsonResponse(JSON.stringify(OUTPUT)),
    );

    const outcome = await executeJob(job({ inputURI: 'https://inputs.example.com/input.json' }), {
      ...options,
      allowedHosts: new Set(['localhost', '127.0.0.1', 'inputs.example.com']),
    });

    expect(outcome).toMatchObject({ kind: 'executed' });
    expect(fetches.map((call) => call.url)).toEqual(['https://inputs.example.com/input.json', `${API_BASE}/v1/weather`]);
  });

  /**
   * The input URI is the payer's. Loopback allowed by default hands every payer a way to make this
   * host call what it serves only to itself.
   */
  it.each(['http://127.0.0.1:9000/input.json', 'http://localhost/input.json', 'http://[::1]/input.json'])(
    'refuses loopback that nobody listed: %s',
    async (inputURI) => {
      const { options, fetches } = harness();

      const outcome = await executeJob(job({ inputURI }), { ...options, allowedHosts: new Set(['inputs.example.com']) });

      expect(outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('is not allowed') });
      expect(fetches).toHaveLength(0);
    },
  );

  it('matches an IPv6 literal against the address it was listed as', async () => {
    const { options, fetches } = harness((call) =>
      call.url.startsWith('http://[::1]') ? jsonResponse(CANONICAL_INPUT) : jsonResponse(JSON.stringify(OUTPUT)),
    );

    const outcome = await executeJob(job({ inputURI: 'http://[::1]:9000/input.json' }), {
      ...options,
      allowedHosts: new Set(['::1']),
    });

    expect(outcome).toMatchObject({ kind: 'executed' });
    expect(fetches[0]?.url).toBe('http://[::1]:9000/input.json');
  });
});

describe('http hardening', () => {
  const httpJob = job({ inputURI: 'http://127.0.0.1:9000/input.json' });

  it('refuses to follow redirects and aborts on the configured timeout', async () => {
    const { options, fetches } = harness(() => jsonResponse(CANONICAL_INPUT));

    await executeJob(httpJob, options);

    const init = fetches[0]?.init;
    expect(init?.redirect).toBe('error');
    expect(init?.signal?.aborted).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('abandons a request when the process is shutting down', async () => {
    const { options, fetches } = harness(() => jsonResponse(CANONICAL_INPUT));
    const shutdown = new AbortController();

    await executeJob(httpJob, options, shutdown.signal);
    shutdown.abort();

    expect(fetches[0]?.init.signal?.aborted).toBe(true);
  });

  it('rejects a response that followed a redirect', async () => {
    const { options } = harness(() => {
      const response = jsonResponse(CANONICAL_INPUT);
      Object.defineProperty(response, 'redirected', { value: true });

      return response;
    });

    expect(await executeJob(httpJob, options)).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('redirected'),
    });
  });

  it('rejects a body that is not application/json', async () => {
    const { options } = harness(() => jsonResponse(CANONICAL_INPUT, { contentType: 'text/plain' }));

    expect(await executeJob(httpJob, options)).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('content-type text/plain'),
    });
  });

  it('rejects a declared content-length over the cap without reading the body', async () => {
    const { options } = harness(() => jsonResponse(CANONICAL_INPUT, { headers: { 'content-length': '1048576' } }));

    expect(await executeJob(httpJob, options)).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('declares more than 1024 bytes'),
    });
  });

  it('stops reading and cancels a body that passes the cap', async () => {
    let pulls = 0;
    let cancelled = false;
    const { options } = harness(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(256).fill(0x20));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );

    expect(await executeJob(httpJob, options)).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('exceeds 1024 bytes'),
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(8);
  });

  it('treats a server fault as transient and a client fault as final', async () => {
    const server = harness(() => jsonResponse('{}', { status: 503 }));
    const throttled = harness(() => jsonResponse('{}', { status: 429 }));
    const client = harness(() => jsonResponse('{}', { status: 404 }));

    expect(await executeJob(httpJob, server.options)).toMatchObject({ kind: 'failed' });
    expect(await executeJob(httpJob, throttled.options)).toMatchObject({ kind: 'failed' });
    expect(await executeJob(httpJob, client.options)).toMatchObject({ kind: 'rejected' });
  });

  /**
   * The capability API belongs to the operator. A 404 from it is a deployment mid-roll, a gateway
   * that has not picked up the route yet, a container restarting. Read as the payer's fault, eight
   * seconds of that permanently abandoned every lock held at the time and the payee lost work it
   * could have delivered a moment later.
   */
  it('treats the operator api being away as transient, not as the payer\'s fault', async () => {
    for (const status of [404, 502, 408, 409, 429, 503]) {
      const { options } = harness(() => jsonResponse('{}', { status }));

      expect(await executeJob(job(), options)).toMatchObject({ kind: 'failed' });
    }
  });

  it('still treats the capability refusing the input itself as final', async () => {
    for (const status of [400, 422]) {
      const { options } = harness(() => jsonResponse('{}', { status }));

      expect(await executeJob(job(), options)).toMatchObject({ kind: 'rejected' });
    }
  });

  it('reports a network fault as transient', async () => {
    const { options } = harness(() => {
      throw new TypeError('fetch failed');
    });

    expect(await executeJob(httpJob, options)).toMatchObject({ kind: 'failed', reason: 'fetch failed' });
  });
});

describe('output delivery', () => {
  const policy = { maxInlineOutputBytes: 32, outputBaseUrl: undefined };

  it('inlines an output that fits the calldata budget', () => {
    expect(outputURI(7n, canonicalStringify({ ok: true }), policy)).toBe(dataURI({ ok: true }));
  });

  it('points at the published copy when the output is too large to carry', () => {
    const large = canonicalStringify({ blob: 'x'.repeat(100) });

    expect(outputURI(7n, large, { ...policy, outputBaseUrl: 'https://outputs.example.com/jobs' })).toBe(
      'https://outputs.example.com/jobs/7.json',
    );
  });

  it('travels as a bare commitment when nothing publishes it', () => {
    expect(outputURI(7n, canonicalStringify({ blob: 'x'.repeat(100) }), policy)).toBe('');
  });

  it('keeps the commitment when the output is too large to inline', async () => {
    const output = { blob: 'x'.repeat(5_000) };
    const { options, writes } = harness(() => jsonResponse(JSON.stringify(output)), { maxBodyBytes: 1_048_576 });

    const outcome = await executeJob(job(), options);

    expect(outcome).toMatchObject({ kind: 'executed', outputCommit: commitCanonical(output), outputURI: '' });
    expect(writes[0]?.canonical).toBe(canonicalStringify(output));
  });

  it('writes the canonical output to <id>.json', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bursar-sidecar-'));
    directories.push(directory);

    await createOutputWriter(join(directory, 'out'))(42n, CANONICAL_INPUT, COMMIT_A);

    expect(await readFile(join(directory, 'out', '42.json'), 'utf8')).toBe(CANONICAL_INPUT);
  });

  it('keeps the bytes a release already committed to rather than publishing new ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bursar-sidecar-'));
    directories.push(directory);
    const write = createOutputWriter(directory);

    await write(42n, CANONICAL_INPUT, COMMIT_A);
    await write(42n, CANONICAL_INPUT, COMMIT_A);

    // The commitment on chain names the first bytes, so a published copy that answers with the
    // second is a payer who can no longer verify what they paid for.
    await expect(write(42n, '{"different":true}', COMMIT_A)).rejects.toThrow(/already has an output/);
    expect(await readFile(join(directory, '42.json'), 'utf8')).toBe(CANONICAL_INPUT);
  });

  it('leaves nothing but the output behind, so a kill cannot strand a lock under a half file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bursar-sidecar-'));
    directories.push(directory);

    await createOutputWriter(directory)(42n, CANONICAL_INPUT, COMMIT_A);

    // The bytes are staged and linked into place. A file under `<id>.json` is always whole, and
    // the staging copy is not left to be mistaken for one.
    expect((await readdir(directory)).sort()).toEqual(['42.input', '42.json']);
  });

  /**
   * A lock id is a counter on one escrow. The same id on a redeployed escrow, or an output
   * directory carried from one chain to another, names a different lock with a different input,
   * and re-sending the stored answer commits to work the payer never asked for.
   */
  it('keeps the input an output answered, and will not record it for another', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bursar-sidecar-'));
    directories.push(directory);
    const write = createOutputWriter(directory);
    const read = createOutputReader(directory, { maxInlineOutputBytes: 4_096, outputBaseUrl: undefined });

    await write(42n, CANONICAL_INPUT, COMMIT_A);
    expect((await read(42n))?.inputCommit).toBe(COMMIT_A);

    await expect(write(42n, CANONICAL_INPUT, COMMIT_B)).rejects.toThrow(/already has an output recorded for input/);
  });

  it('names the lock and the file when a stored output cannot be read back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bursar-sidecar-'));
    directories.push(directory);
    await writeFile(join(directory, '42.json'), '{"tempC":2', 'utf8');

    // A bare SyntaxError from inside a poll says nothing about which lock or which file, and the
    // lock is unrecoverable from both ends until somebody works that out.
    await expect(createOutputReader(directory, { maxInlineOutputBytes: 4_096, outputBaseUrl: undefined })(42n))
      .rejects.toThrow(/lock 42 at .*42\.json is not JSON/);
  });

  it('reads a committed output back as the outcome a release re-sends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bursar-sidecar-'));
    directories.push(directory);
    const policy = { maxInlineOutputBytes: 4_096, outputBaseUrl: undefined };
    const read = createOutputReader(directory, policy);

    expect(await read(42n)).toBeNull();

    const output = { tempC: 21 };
    await createOutputWriter(directory)(42n, canonicalStringify(output), COMMIT_A);

    expect(await read(42n)).toEqual({
      kind: 'executed',
      outputCommit: commitCanonical(output),
      outputURI: outputURI(42n, canonicalStringify(output), policy),
      outputBytes: canonicalStringify(output).length,
      inputCommit: COMMIT_A,
    });
  });
});

describe('parseRoutes', () => {
  it('keys routes by capability id and defaults the method to POST', () => {
    expect(ROUTES.get(capabilityId('quote.get:1'))).toEqual({
      capability: 'quote.get:1',
      method: 'POST',
      path: '/v1/quotes/spot',
    });
  });

  it('serves a bare label under its own id and under the service and hire namespaces', () => {
    const route = { capability: 'quote.get:1', method: 'POST', path: '/v1/quotes/spot' };

    expect(ROUTES.get(capabilityId('quote.get:1'))).toEqual(route);
    expect(ROUTES.get(capabilityId('service:quote.get:1'))).toEqual(route);
    expect(ROUTES.get(capabilityId('hire:quote.get:1'))).toEqual(route);
    expect(ROUTES.get(capabilityId('rwa:quote.get:1'))).toBeUndefined();
  });

  it('serves a namespaced label under that id only, ahead of a bare alias', () => {
    const routes = parseRoutes({
      'service:render:1': { path: '/v1/render/service' },
      'render:1': { path: '/v1/render' },
      'hire:review:1': { path: '/v1/review' },
    });

    expect(routes.get(capabilityId('service:render:1'))?.path).toBe('/v1/render/service');
    expect(routes.get(capabilityId('hire:render:1'))?.path).toBe('/v1/render');
    expect(routes.get(capabilityId('render:1'))?.path).toBe('/v1/render');
    expect(routes.get(capabilityId('hire:review:1'))?.capability).toBe('hire:review:1');
    expect(routes.get(capabilityId('review:1'))).toBeUndefined();
    expect(routes.get(capabilityId('service:review:1'))).toBeUndefined();
  });

  it.each([
    ['a list', []],
    ['a path without a leading slash', { 'weather.get:1': { path: 'v1/weather' } }],
    ['a missing path', { 'weather.get:1': { method: 'POST' } }],
    ['a route that is not an object', { 'weather.get:1': '/v1/weather' }],
  ])('refuses %s', (_label, source) => {
    expect(() => parseRoutes(source)).toThrow();
  });

  it.each(['GET', 'head'])('refuses %s, which cannot carry the verified input', (method) => {
    expect(() => parseRoutes({ [WEATHER]: { method, path: '/v1/weather' } })).toThrow(/cannot be routed over/);
  });

  it('reads the shipped example file', async () => {
    const path = fileURLToPath(new URL('../capabilities.example.json', import.meta.url));

    expect((await readRoutes(path)).get(capabilityId(WEATHER))).toEqual({
      capability: WEATHER,
      method: 'POST',
      path: '/v1/weather',
    });
  });

  /**
   * The route table is as required as any variable. A bare missing-file error gives an operator no
   * way to guess what the file holds.
   */
  it('names the path it looked in and the example to copy', async () => {
    const failure = readRoutes('does-not-exist.json');

    await expect(failure).rejects.toThrow(/No capabilities file at does-not-exist.json/);
    await expect(failure).rejects.toThrow(/capabilities.example.json/);
    await expect(failure).rejects.toThrow(/CAPABILITIES_PATH/);
  });

  it('separates a file that is not there from one that is not JSON', async () => {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const broken = join(await mkdtemp(join(tmpdir(), 'bursar-caps-')), 'capabilities.json');
    await writeFile(broken, '{ not json', 'utf8');

    await expect(readRoutes(broken)).rejects.toThrow(/is not valid JSON/);
    // A readable file in the wrong shape is a third thing again, and keeps its own message.
    await expect(readRoutes(path)).rejects.toThrow(/must map to an object/);
  });
});
