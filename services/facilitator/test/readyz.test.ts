import { describe, expect, it } from 'vitest';
import { RHC_MAINNET, createRhcClient } from '@bursar/core';
import type { RhcClient } from '@bursar/core';

import { loadConfig } from '../src/config.js';
import type { FacilitatorConfig } from '../src/config.js';
import { defaultMigrationsDir, loadMigrations } from '../src/db/migrate.js';
import { createFacilitatorService } from '../src/service.js';
import type { Check } from '../src/http/routes.js';
import type { ApiRequest } from '../src/http/io.js';
import { RecordingDatabase, ScriptedScheme } from './support/doubles.js';

/**
 * `/readyz` on the facilitator, which had no readiness route at all.
 *
 * Its two siblings answer the same shape on the same path, and this one is answerable only over
 * its three dependencies: the ledger it writes to, the source of its spend decisions, and the
 * chain it settles on. Anything else is a health question.
 */

const RELAYER_KEY = `0x${'11'.repeat(32)}`;
const RELAYER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

function config(overrides: Record<string, string> = {}): FacilitatorConfig {
  return loadConfig({
    DATABASE_URL: 'postgres://mandate:secret@127.0.0.1:55501/mandate',
    RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
    RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
    FACILITATOR_GAS_FLOAT: RELAYER,
    FACILITATOR_SETTLEMENT: '0x2222222222222222222222222222222222222222',
    FACILITATOR_COLLATERAL: '0x3333333333333333333333333333333333333333',
    FACILITATOR_TREASURY: '0x4444444444444444444444444444444444444444',
    FACILITATOR_RELAYER_KEY: RELAYER_KEY,
    FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '0.005',
    FACILITATOR_FEE_BPS: '100',
    FACILITATOR_FEE_FLOOR_MICRO: '1900',
    ...overrides,
  });
}

/** A node that answers, or one that does not, over the pool and transport that ship. */
function rhcNode(answers: boolean): RhcClient {
  return createRhcClient({
    chain: RHC_MAINNET,
    providers: [{ name: 'primary', url: 'https://one.invalid' }],
    requireRedundancy: false,
    retry: { maxPasses: 1, sleep: async () => undefined },
    fetchFn: async (_input, init) => {
      if (!answers) throw new Error('connect ECONNREFUSED');
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result =
        request.method === 'eth_getBalance' ? '0x2386f26fc10000' : `0x${RHC_MAINNET.chainId.toString(16)}`;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

async function schemaOf(db: RecordingDatabase, applied: 'current' | 'behind'): Promise<RecordingDatabase> {
  const names = (await loadMigrations(defaultMigrationsDir())).map((migration) => ({ name: migration.name }));
  return db
    .answer(/to_regclass/, [{ current: true, previous: false }])
    .answer(/FROM bursar_migrations/, applied === 'current' ? names : names.slice(0, -1));
}

async function probe(options: {
  schema?: 'current' | 'behind';
  chain?: boolean;
  underwriter?: Check;
  /** The reserve to judge the float against, in ETH. The node answers 0.01 ETH. */
  minimumEth?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = await schemaOf(new RecordingDatabase(), options.schema ?? 'current');
  const service = createFacilitatorService({
    config: config(options.minimumEth ? { FACILITATOR_GAS_FLOAT_MINIMUM_ETH: options.minimumEth } : {}),
    scheme: new ScriptedScheme(),
    db,
    rhc: rhcNode(options.chain ?? true),
    underwriterFor: async () => null,
    underwriterReady: async () => options.underwriter ?? { ready: true, mode: 'remote' },
  });

  const request: ApiRequest = {
    method: 'GET',
    path: '/readyz',
    query: new URLSearchParams(),
    headers: {},
    body: {},
    bytes: new Uint8Array(),
  };
  const response = await service.router(request);
  await service.stop();
  return { status: response.status, body: response.body as Record<string, unknown> };
}

describe('readiness', () => {
  it('answers ready over the database, the underwriter and the chain', async () => {
    const { status, body } = await probe({});

    expect(status).toBe(200);
    expect(body['ready']).toBe(true);
    expect(body['database']).toMatchObject({ ready: true, database: '127.0.0.1:55501/mandate' });
    expect(body['underwriter']).toMatchObject({ ready: true });
    // The same shape the underwriter answers on the same path, chain named on both.
    expect(body['chainId']).toBe(RHC_MAINNET.chainId);
    expect(body['chain']).toMatchObject({
      ready: true,
      reachable: true,
      name: RHC_MAINNET.name,
      chainId: RHC_MAINNET.chainId,
    });
  });

  it('is not ready while the schema is behind the build, and names what is missing', async () => {
    const { status, body } = await probe({ schema: 'behind' });

    expect(status).toBe(503);
    expect(body['ready']).toBe(false);
    const database = body['database'] as { ready: boolean; pending: string[]; detail: string };
    expect(database.ready).toBe(false);
    expect(database.pending).toHaveLength(1);
    expect(database.detail).toContain('bursar-facilitator-migrate');
  });

  it('is not ready while the chain cannot be read, and says so in its own words', async () => {
    const { status, body } = await probe({ chain: false });

    expect(status).toBe(503);
    expect(body['chain']).toMatchObject({ ready: false, reachable: false });

    // The transport library's message names its own version and links its documentation. That
    // belongs in this service's log, not in a field an operator is reading.
    const chain = JSON.stringify(body['chain']);
    expect(chain).toContain('RHC_RPC_PRIMARY');
    expect(chain).not.toContain('viem@');
    expect(chain).not.toContain('viem.sh');
  });

  it('is not ready while the source of its decisions is not', async () => {
    const { status, body } = await probe({
      underwriter: { ready: false, mode: 'remote', detail: 'the underwriter at http://127.0.0.1:8403 did not answer' },
    });

    expect(status).toBe(503);
    expect(body['underwriter']).toMatchObject({ ready: false });
  });

  it('reports the gas float without letting it decide, because a dry relayer still serves', async () => {
    // 0.01 ETH against a 0.05 ETH reserve: unhealthy, and not a reason to pull the process out of
    // rotation while it can still verify, decide and answer every ledger route.
    const { status, body } = await probe({ minimumEth: '0.05' });

    expect(status).toBe(200);
    expect(body['chain']).toMatchObject({ gasFloat: { healthy: false } });
  });

  it('measures the gas float in wei, because the float is ETH and the ledger is not', async () => {
    const { body } = await probe({});
    const gasFloat = (body['chain'] as { gasFloat: Record<string, unknown> }).gasFloat;

    // 0.01 ETH exactly as the node reported it. Divided into micro-USD it would read as 10,000,
    // which is a number the ledger would accept and no operator could act on.
    expect(gasFloat).toEqual({
      healthy: true,
      balanceWei: '10000000000000000',
      minimumWei: '5000000000000000',
    });
  });
});
