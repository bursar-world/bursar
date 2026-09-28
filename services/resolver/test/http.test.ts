import { describe, expect, it } from 'vitest';

import { NO_VALIDATORS } from '../src/evidence.js';
import { createHandler, serve } from '../src/http.js';
import { openMemoryJournal } from '../src/journal.js';
import { createVoter } from '../src/voter.js';
import { FakeChain, SERVED, tableFetcher } from './support/fake-chain.js';
import { captureAlerts, silentLogger, testKeys } from './support/keys.js';

async function handler(lastPollAt: number | null) {
  const chain = new FakeChain();
  const journal = await openMemoryJournal();
  const logger = silentLogger();
  const voter = createVoter({ chain, journal, alerts: captureAlerts(), logger, keys: testKeys(3), chainId: 4663, fetcher: tableFetcher({}), validators: NO_VALIDATORS, operatorAddresses: [] });
  return createHandler({
    chain,
    journal,
    voter,
    served: [SERVED],
    chainId: 4663,
    operatorToken: null,
    operatorAddresses: [],
    health: () => ({ lastPollAt, lastError: null, consecutiveFailures: 0, open: 0 }),
    pollMs: 30_000,
    logger,
    now: () => 100_000,
  });
}

const get = (path: string) => ({ method: 'GET', path, query: new URLSearchParams(), body: undefined, token: null });

describe('http', () => {
  it('answers health 200 while polling and 503 once three polls are missed', async () => {
    expect((await (await handler(90_000))(get('/health'))).status).toBe(200);
    expect((await (await handler(1_000))(get('/health'))).status).toBe(503);
    expect((await (await handler(null))(get('/health'))).status).toBe(503);
  });

  it('answers 404 for a dispute it holds no record of', async () => {
    expect((await (await handler(90_000))(get('/rulings/7'))).status).toBe(404);
  });

  it('refuses overrides outright when no token is configured', async () => {
    const answer = await (await handler(90_000))({ method: 'POST', path: '/override', query: new URLSearchParams(), body: {}, token: 'x' });
    expect(answer.status).toBe(403);
  });

  it('refuses evidence that is not a submission', async () => {
    const answer = await (await handler(90_000))({ method: 'POST', path: '/evidence', query: new URLSearchParams(), body: { kind: 'delivery' }, token: null });
    expect(answer.status).toBe(400);
  });

  it('serves over HTTP and caps the body', async () => {
    const running = await serve(await handler(90_000), { host: '127.0.0.1', port: 0, logger: silentLogger() });
    try {
      const health = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get('cache-control')).toBe('no-store');

      const large = await fetch(`http://127.0.0.1:${running.port}/evidence`, { method: 'POST', body: 'x'.repeat(70_000) });
      expect(large.status).toBe(413);

      const garbled = await fetch(`http://127.0.0.1:${running.port}/evidence`, { method: 'POST', body: '{' });
      expect(garbled.status).toBe(400);
    } finally {
      await running.close();
    }
  });
});
