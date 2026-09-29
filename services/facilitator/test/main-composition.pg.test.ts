import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EnvSource } from '@bursar/core';
import { createUnderwriterService, loadUnderwriterConfig } from '@bursar/underwriter';

import { compose } from '../src/main.js';
import type { Composed } from '../src/main.js';
import { ACCOUNT, ACCOUNT_V2, AGENT_WALLET, CAPABILITY, MERCHANT, USDG, startRhcNode } from './support/rhc-node.js';
import type { RhcNode } from './support/rhc-node.js';
import { TEST_DATABASE_URL } from './support/postgres.js';

/**
 * The seam, driven through the entry point that ships.
 *
 * The first live run passed because the harness built the underwriter itself and handed it to
 * `createFacilitatorService`. Nothing in the binary did that, so `POST /underwrite` answered 501 in
 * every real deployment. This starts `compose`, which is what `main` runs, from an environment and
 * nothing else, and asks it for a decision over a socket.
 *
 * Everything outside the two services is real: a Postgres server, an HTTP listener, a chain client
 * on two providers, viem, and JSON-RPC over a socket to the node in `support/rhc-node.ts`.
 */

const AGENT = 'composed-agent-1';
const POOL = 'prefund-main';
const RELAYER_KEY = `0x${'11'.repeat(32)}` as const;
const GAS_FLOAT = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' as const;

describe.skipIf(!TEST_DATABASE_URL)('the composition the binary runs', () => {
  let rhc: RhcNode;
  let database: string;
  let journalDir: string;
  const running: Composed[] = [];
  const scratchDirs: string[] = [];

  beforeAll(async () => {
    rhc = await startRhcNode();
    database = await scratchDatabase();
  }, 60_000);

  // A journal per test. The lifetime ceiling is replayed from it, so a directory shared across
  // tests would have each one start against the reservations the last one made.
  beforeEach(() => {
    journalDir = scratch('bursar-journal-');
  });

  afterEach(async () => {
    for (const composed of running.splice(0)) await composed.stop();
    // The issuer's controls are the token's, not this deployment's, so a test that moves them puts
    // them back. Leaving one frozen would refuse every decision in the tests that follow.
    rhc.fixture.usdg = { paused: false, frozen: new Set<string>(), facetRemoved: false };
  });

  afterAll(async () => {
    await rhc?.close();
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    await dropDatabase();
  });

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  function env(overrides: Record<string, string | undefined> = {}): EnvSource {
    return {
      FACILITATOR_HOST: '127.0.0.1',
      // Overridden with a port the operating system just handed back wherever one is bound.
      FACILITATOR_PORT: '8402',
      DATABASE_URL: database,
      RHC_NETWORK: 'mainnet',
      RHC_RPC_PRIMARY: rhc.urls[0],
      RHC_RPC_FALLBACK: rhc.urls[1],
      FACILITATOR_GAS_FLOAT: GAS_FLOAT,
      FACILITATOR_SETTLEMENT: '0x3E9CF4ef0C0A0F1b2A5B4a1F6c0d7e8F9a0bB8a8',
      FACILITATOR_COLLATERAL: '0x139FC6Df0b5C8a9E2d3F4a5B6c7D8e9F0a1b8c18',
      FACILITATOR_TREASURY: '0x7F97980568AD3bFe77B2150b5cdD98eB5f271718',
      FACILITATOR_RELAYER_KEY: RELAYER_KEY,
      FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '0.0001',
      FACILITATOR_FEE_BPS: '100',
      FACILITATOR_FEE_FLOOR_MICRO: '1900',
      MANDATE_DOCUMENT_SOURCE: 'chain',
      MANDATE_ACCOUNT: ACCOUNT,
      MANDATE_SUBJECT: AGENT,
      UNDERWRITER_JOURNAL_DIR: journalDir,
      // A simulated `spend` needs a deadline the facilitator's route does not send, so the extra
      // eth_call would never run. Off, so the test says what it exercises.
      UNDERWRITER_SIMULATE: 'false',
      ...overrides,
    };
  }

  async function start(overrides: Record<string, string | undefined> = {}): Promise<{
    composed: Composed;
    call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  }> {
    const account = overrides['MANDATE_ACCOUNT'] ?? ACCOUNT;
    const composed = await compose(env({ FACILITATOR_PORT: String(await freePort()), ...overrides }));
    running.push(composed);
    const server = await composed.service.start();
    const base = `http://127.0.0.1:${server.port}`;

    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    await call('POST', '/accounts', {
      agentId: AGENT,
      payerWallet: AGENT_WALLET,
      repayWallet: AGENT_WALLET,
      networks: ['eip155:4663'],
      mandateAccount: account,
    });
    await call('POST', '/pools', { poolId: POOL, lane: 'prefund', maxSingleMicro: '5000000' });
    await call('POST', `/lanes/${AGENT}/prefund`, {
      poolId: POOL,
      referenceId: `deposit-${Date.now()}`,
      eventType: 'deposit',
      amountMicro: '5000000',
    });

    return { composed, call };
  }

  const spend = (amountMicro: string, nonce: string): Record<string, unknown> => ({
    agentId: AGENT,
    payerWallet: AGENT_WALLET,
    repayWallet: AGENT_WALLET,
    requestNonce: nonce,
    network: 'eip155:4663',
    lane: 'prefund',
    poolId: POOL,
    subject: AGENT,
    action: 'doc.summarize',
    amountMicro,
    merchant: MERCHANT,
    capabilityId: CAPABILITY,
  });

  // Both builds are live on 4663 and answer `limits` in different shapes, so the decision is taken
  // against one account of each.
  const builds = [
    { build: 'v1', account: ACCOUNT },
    { build: 'v2', account: ACCOUNT_V2 },
  ] as const;

  it.each(builds)('answers POST /underwrite with a real decision against a $build account', async ({ build, account }) => {
    const { call } = await start({ MANDATE_ACCOUNT: account });

    const answered = await call('POST', '/underwrite', spend('1000000', `compose-allow-${build}`));

    expect(answered.status).toBe(201);
    expect(answered.body['decision']).toEqual({ decision: 'allow' });
    expect(answered.body['mandateAccount']).toBe(account);

    // The decision has to survive into the ledger in a form a reservation can be opened against,
    // which is the half of the seam the route is there for.
    const authorization = answered.body['authorization'] as Record<string, unknown>;
    expect(authorization['approved']).toBe(true);
    expect(authorization['approvedMicro']).toBe('1000000');

    const reserved = await call('POST', '/reservations', {
      authorizationId: authorization['id'],
      merchantWallet: MERCHANT,
      amountMicro: '1000000',
    });
    expect(reserved.status).toBe(201);

    // The account's own answer decided it: `limits` and `previewSpend` were read over the socket.
    expect(rhc.calls).toContain(`${account.toLowerCase()}.limits`);
    expect(rhc.calls).toContain(`${account.toLowerCase()}.previewSpend`);
  }, 30_000);

  it.each(builds)('refuses a spend a $build account refuses, and names the limit', async ({ build, account }) => {
    const { call } = await start({ MANDATE_ACCOUNT: account });

    const answered = await call('POST', '/underwrite', spend('2500000', `compose-refuse-${build}`));

    expect(answered.status).toBe(201);
    expect(answered.body['decision']).toEqual({ decision: 'refuse', reason: 'daily_cap_exceeded' });
    expect((answered.body['authorization'] as Record<string, unknown>)['approved']).toBe(false);
  }, 30_000);

  it('refuses a spend the token issuer has frozen, and says whose address it is', async () => {
    const { call } = await start();
    rhc.fixture.usdg.frozen.add(ACCOUNT.toLowerCase());

    const answered = await call('POST', '/underwrite', spend('1000000', 'compose-frozen-1'));

    // The account would allow this spend. USDG would refuse the pull inside `Escrow.lock`, and
    // without the read that refusal arrives as a limit nobody reached.
    expect(answered.status).toBe(201);
    expect(answered.body['decision']).toEqual({ decision: 'refuse', reason: 'payer_frozen' });
    expect(rhc.calls).toContain(`${USDG.toLowerCase()}.isFrozen`);
  }, 30_000);

  it('tells a control the token no longer routes from one that did not answer', async () => {
    const { call } = await start();
    rhc.fixture.usdg.facetRemoved = true;

    const answered = await call('POST', '/underwrite', spend('1000000', 'compose-facetless-1'));

    // USDG is a diamond and a facet can be removed. Either way the spend is refused, because an
    // issuer control that cannot be read is never taken as clear; the two are named apart because
    // one is somebody going to look at the token and the other is waiting for the chain.
    expect(answered.body['decision']).toEqual({ decision: 'refuse', reason: 'asset_control_absent' });
  }, 30_000);

  it('reserves the lifetime ceiling in one place: the journal, on disk, once', async () => {
    const { call } = await start();
    await call('POST', '/underwrite', spend('1000000', 'compose-journal-1'));

    const journal = readFileSync(join(journalDir, `${ACCOUNT.toLowerCase()}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { body: { request_id: string; amount_micros: string } });

    expect(journal).toHaveLength(1);
    expect(journal[0]?.body.request_id).toBe('compose-journal-1');
    expect(journal[0]?.body.amount_micros).toBe('1000000');
  }, 30_000);

  it('refuses to start a second underwriter against an account another one is holding', async () => {
    await start();

    const second = createUnderwriterService({ config: loadUnderwriterConfig(env()) });
    await expect(second.bind()).rejects.toMatchObject({ code: 'underwriter_journal_held' });
    await second.stop().catch(() => undefined);
  }, 30_000);

  it('reaches an underwriter over HTTP when BURSAR_UNDERWRITER_URL is set', async () => {
    // A second journal directory, because this underwriter is a separate process in every sense
    // except the one this test can arrange.
    const remoteJournal = scratch('bursar-remote-journal-');
    const remote = createUnderwriterService({
      config: loadUnderwriterConfig({
        ...env(),
        UNDERWRITER_PORT: String(await freePort()),
        UNDERWRITER_JOURNAL_DIR: remoteJournal,
      }),
    });
    const listener = await remote.start();

    try {
      const { call } = await start({
        MANDATE_DOCUMENT_SOURCE: undefined,
        MANDATE_ACCOUNT: undefined,
        MANDATE_SUBJECT: undefined,
        BURSAR_UNDERWRITER_URL: `http://127.0.0.1:${listener.port}`,
      });

      const answered = await call('POST', '/underwrite', spend('1000000', 'compose-remote-1'));
      expect(answered.status).toBe(201);
      expect(answered.body['decision']).toEqual({ decision: 'allow' });
      expect(answered.body['mandateAccount']).toBe(ACCOUNT);

      const ready = await call('GET', '/readyz');
      expect(ready.status).toBe(200);

      // An underwriter URL routinely carries a key in its userinfo, its path or its query, which
      // is why `envVar.url` declares one secret. Readiness names the host and stops there.
      const underwriter = ready.body['underwriter'] as Record<string, unknown>;
      expect(underwriter).toMatchObject({
        mode: 'remote',
        underwriter: `http://127.0.0.1:${listener.port}`,
      });
      expect(underwriter['url']).toBeUndefined();
    } finally {
      await remote.stop();
    }
  }, 30_000);

  it('refuses to start when nothing says where decisions come from', async () => {
    await expect(
      compose(env({ MANDATE_DOCUMENT_SOURCE: undefined, MANDATE_ACCOUNT: undefined, MANDATE_SUBJECT: undefined })),
    ).rejects.toMatchObject({ code: 'underwriter_unconfigured' });
  }, 30_000);

  it('refuses a wrong database password by the variable that holds it', async () => {
    const wrong = new URL(database);
    wrong.password = 'not-the-password';

    const refusal = await compose(env({ DATABASE_URL: wrong.toString() })).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ code: 'database_unreachable' });
    const message = (refusal as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toMatch(/password authentication failed/);
    expect(message).not.toContain('not-the-password');
  }, 30_000);

  it('answers the readiness contract its sibling answers, on the same path', async () => {
    const { call } = await start();

    const ready = await call('GET', '/readyz');

    expect(ready.status).toBe(200);
    expect(ready.body['ready']).toBe(true);
    expect(ready.body['database']).toMatchObject({ ready: true });
    expect(ready.body['underwriter']).toMatchObject({ ready: true, mode: 'in-process' });
    expect(ready.body['chain']).toMatchObject({ ready: true, reachable: true });
  }, 30_000);

  describe('the schema a starting process is allowed to write', () => {
    let empty: string;

    beforeEach(async () => {
      empty = await emptyDatabase();
    });

    // Stopped before the database goes, because dropping it with FORCE closes connections a
    // running service still holds and the failure lands in whatever runs next.
    afterEach(async () => {
      for (const composed of running.splice(0)) await composed.stop();
      await dropEmptyDatabase();
    });

    it('refuses to start against a schema it was told only to verify', async () => {
      await expect(compose(env({ DATABASE_URL: empty, FACILITATOR_MIGRATE: 'verify' }))).rejects.toMatchObject({
        code: 'schema_behind',
      });

      expect(await tableCount(empty)).toBe(0);
    });

    it('starts without touching a schema it was told to leave alone', async () => {
      const composed = await compose(env({ DATABASE_URL: empty, FACILITATOR_MIGRATE: 'off' }));
      running.push(composed);

      expect(await tableCount(empty)).toBe(0);

      // Started, and not ready: the right pair of answers for a process pointed at a schema
      // somebody else owns and has not created yet.
      const readiness = await composed.service.ready();
      expect(readiness.ready).toBe(false);
    });

    it('applies what is pending when that is what the deployment asked for', async () => {
      const composed = await compose(env({ DATABASE_URL: empty, FACILITATOR_MIGRATE: 'on-start' }));
      running.push(composed);

      expect(await tableCount(empty)).toBeGreaterThan(10);
    });
  });

  it('answers 501 only where an operator asked for a facilitator that does not decide', async () => {
    const { call } = await start({
      FACILITATOR_UNDERWRITER: 'none',
      MANDATE_DOCUMENT_SOURCE: undefined,
      MANDATE_ACCOUNT: undefined,
      MANDATE_SUBJECT: undefined,
    });

    const answered = await call('POST', '/underwrite', spend('1000000', 'compose-none-1'));
    expect(answered.status).toBe(501);
    expect(answered.body['error']).toBe('underwriter_not_configured');
  }, 30_000);
});

/** A database of this suite's own, inside the server the URL names. */
async function scratchDatabase(): Promise<string> {
  const { createPostgres } = await import('../src/db/postgres.js');
  const admin = createPostgres({ url: TEST_DATABASE_URL });
  await admin.query('DROP DATABASE IF EXISTS bursar_compose_test WITH (FORCE)');
  await admin.query('CREATE DATABASE bursar_compose_test');
  await admin.close();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = '/bursar_compose_test';
  return url.toString();
}

async function dropDatabase(): Promise<void> {
  const { createPostgres } = await import('../src/db/postgres.js');
  const admin = createPostgres({ url: TEST_DATABASE_URL });
  await admin.query('DROP DATABASE IF EXISTS bursar_compose_test WITH (FORCE)');
  await admin.close();
}

/** A database with nothing in it, for the three things a start may do to a schema. */
async function emptyDatabase(): Promise<string> {
  const { createPostgres } = await import('../src/db/postgres.js');
  const admin = createPostgres({ url: TEST_DATABASE_URL });
  await admin.query('DROP DATABASE IF EXISTS bursar_migrate_test WITH (FORCE)');
  await admin.query('CREATE DATABASE bursar_migrate_test');
  await admin.close();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = '/bursar_migrate_test';
  return url.toString();
}

async function dropEmptyDatabase(): Promise<void> {
  const { createPostgres } = await import('../src/db/postgres.js');
  const admin = createPostgres({ url: TEST_DATABASE_URL });
  await admin.query('DROP DATABASE IF EXISTS bursar_migrate_test WITH (FORCE)');
  await admin.close();
}

async function tableCount(url: string): Promise<number> {
  const { createPostgres } = await import('../src/db/postgres.js');
  const db = createPostgres({ url });
  try {
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return Number(rows[0]?.count ?? '0');
  } finally {
    await db.close();
  }
}

/** A port the operating system just handed back, so two suites cannot collide on a fixed one. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
