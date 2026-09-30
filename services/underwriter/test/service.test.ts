import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { RHC_MAINNET, toMicro } from '@bursar/core';

import { loadUnderwriterConfig } from '../src/config.js';
import { ChainUnavailableError } from '../src/errors.js';
import { createUnderwriterService } from '../src/service.js';
import type { UnderwriterService } from '../src/service.js';
import type { ApiRequest, ApiResponse } from '../src/http/io.js';
import { errorResponse } from '../src/http/routes.js';
import { merchantLeaf } from '../src/merkle.js';
import { ACCOUNT, CAPABILITY, MERCHANT, NOW_ISO, fakeChain } from './support/fake-chain.js';

/**
 * The process, composed from configuration and asked for a decision.
 *
 * The chain is the one thing injected, because what is under test is the wiring:
 * `underwriter.test.ts` already covers what the verdict is for every account state.
 */

const RPC = {
  RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
  RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
};

describe('the underwriter process', () => {
  const dirs: string[] = [];
  const running: UnderwriterService[] = [];

  afterEach(async () => {
    for (const service of running.splice(0)) await service.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bursar-service-'));
    dirs.push(dir);
    return dir;
  }

  async function start(
    env: Record<string, string | undefined>,
    chain = fakeChain(),
  ): Promise<UnderwriterService> {
    const service = createUnderwriterService({
      config: loadUnderwriterConfig({ ...RPC, UNDERWRITER_JOURNAL_DIR: scratch(), ...env }),
      chain,
    });
    running.push(service);
    await service.bind();
    return service;
  }

  const spend = (amountMicros: bigint, requestId: string) => ({
    requestId,
    subject: 'agent-1',
    action: 'doc.summarize',
    amountMicros: toMicro(amountMicros),
    at: NOW_ISO,
    merchant: MERCHANT,
    capabilityId: CAPABILITY,
  });

  it('decides for the agent named in chain mode, and for nobody else', async () => {
    const service = await start({
      MANDATE_DOCUMENT_SOURCE: 'chain',
      MANDATE_ACCOUNT: ACCOUNT,
      MANDATE_SUBJECT: 'agent-1',
    });

    const port = await service.lookup('agent-1');
    expect(port?.account).toBe(ACCOUNT);
    expect(await service.lookup('someone-else')).toBeNull();

    const answered = await port?.authorize(spend(100_000n, 'svc-1'));
    expect(answered?.decision).toEqual({ decision: 'allow' });
    expect(answered?.quote?.documentHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  /**
   * This used to repeat the id with a larger amount and expect the first decision back. It was
   * written to prove a retry is free and it proved something else: that the recorded verdict is
   * handed to whatever spend arrives under that id. The caller applies it to the request it sent,
   * so the second call was an allow for nine times the money nothing had underwritten. The
   * identical retry is what has to be free, and that is what is asserted now.
   */
  it('returns the decision it already took when a request id repeats', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });
    const port = await service.lookup('agent-1');

    const first = await port?.authorize(spend(100_000n, 'svc-retry'));
    const again = await port?.authorize(spend(100_000n, 'svc-retry'));

    expect(again?.idempotent).toBe(true);
    expect(again?.decision).toEqual(first?.decision);
  });

  it('refuses a repeated request id that asks for a different amount', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });
    const port = await service.lookup('agent-1');

    await port?.authorize(spend(100_000n, 'svc-replay'));

    await expect(port?.authorize(spend(900_000n, 'svc-replay'))).rejects.toMatchObject({
      code: 'underwriter_request_replayed',
    });
  });

  it('takes one decision at a time per account, so two arriving together cannot collide', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });
    const port = await service.lookup('agent-1');

    // Both decisions are measured, appended and committed against the same journal. Interleaved,
    // they build against the same sequence number and the second append breaks the chain on disk.
    const answered = await Promise.all([
      port?.authorize(spend(100_000n, 'race-a')),
      port?.authorize(spend(100_000n, 'race-b')),
    ]);

    expect(answered.map((result) => result?.decision)).toEqual([{ decision: 'allow' }, { decision: 'allow' }]);

    const journal = await route(service, 'GET', '/v1/journal/agent-1');
    const view = journal.body as { intact: boolean; entries: { seq: number }[] };
    expect(view.intact).toBe(true);
    expect(view.entries.map((entry) => entry.seq)).toEqual([0, 1]);
  });

  it('reads a written mandate from a file and enforces the ceiling the account has no concept of', async () => {
    const path = join(scratch(), 'mandate.json');
    writeFileSync(
      path,
      JSON.stringify({
        subject: 'agent-1',
        account: ACCOUNT,
        chain_id: 4663,
        expires_at: '2099-01-01T00:00:00.000Z',
        rules: [{ pattern: 'doc.*', effect: 'allow' }],
        ceiling_micros: 150_000,
        per_call_cap_micros: 1_000_000,
      }),
    );

    const service = await start({ MANDATE_DOCUMENT_SOURCE: 'file', MANDATE_DOCUMENT_PATH: path });
    const port = await service.lookup('agent-1');

    expect((await port?.authorize(spend(100_000n, 'file-1')))?.decision).toEqual({ decision: 'allow' });
    // 100k is committed against a 150k lifetime ceiling, so the next 100k does not fit.
    expect((await port?.authorize(spend(100_000n, 'file-2')))?.decision).toEqual({
      decision: 'refuse',
      reason: 'over_cumulative_ceiling',
    });
    // An action the mandate never mentions is outside it, which the account has no view on.
    const outside = await port?.authorize({ ...spend(10_000n, 'file-3'), action: 'wire.transfer' });
    expect(outside?.decision).toEqual({ decision: 'refuse', reason: 'outside_mandate' });
  });

  it('answers health, readiness and a decision over the route table', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });

    const health = await route(service, 'GET', '/healthz');
    expect(health.status).toBe(200);
    expect((health.body as Record<string, unknown>)['status']).toBe('ok');

    const ready = await route(service, 'GET', '/readyz');
    expect(ready.status).toBe(200);
    const readiness = ready.body as Record<string, unknown>;
    expect(readiness['ready']).toBe(true);

    // The probe names the chain it read, so a 503 on the wrong network is one glance from being
    // recognised as one.
    expect(readiness['chainId']).toBe(RHC_MAINNET.chainId);
    expect((readiness['chain'] as { name: string }).name).toBe(RHC_MAINNET.name);
    expect(readiness['network']).toBe('eip155:4663');

    const decided = await route(service, 'POST', '/v1/underwrite', {
      subject: 'agent-1',
      requestId: 'route-1',
      action: 'doc.summarize',
      amountMicros: '100000',
      at: NOW_ISO,
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    });
    expect(decided.status).toBe(200);
    const body = decided.body as Record<string, unknown>;
    expect(body['decision']).toEqual({ decision: 'allow' });
    expect(body['account']).toBe(ACCOUNT);
    expect(body['entryHash']).toMatch(/^[0-9a-f]{64}$/);

    // The journal is readable, so the facilitator's rows can be reconciled against the record the
    // decision was taken on.
    const journal = await route(service, 'GET', '/v1/journal/agent-1');
    expect(journal.status).toBe(200);
    expect((journal.body as { intact: boolean; root: string }).intact).toBe(true);
    expect((journal.body as { root: string }).root).toBe(body['root']);
  });

  it('puts the token issuer\'s condition on the wire, address and all', async () => {
    const chain = fakeChain();
    chain.state.issuer.frozen.add(ACCOUNT.toLowerCase());
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' }, chain);

    const answered = await route(service, 'POST', '/v1/underwrite', {
      subject: 'agent-1',
      requestId: 'route-frozen-1',
      action: 'doc.summarize',
      amountMicros: '100000',
      at: NOW_ISO,
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    });

    const body = answered.body as Record<string, unknown>;
    expect(body['decision']).toEqual({ decision: 'refuse', reason: 'payer_frozen' });

    // The code says which condition; the quote says whose address it is and who can lift it. A
    // console that only had the code would have to go and find the address itself.
    const quote = body['quote'] as Record<string, unknown>;
    expect(quote['source']).toBe('asset');
    expect(quote['assetCondition']).toMatchObject({ party: ACCOUNT, reason: 'payer_frozen' });
  });

  it('refuses a subject it holds no mandate for rather than inventing one', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });

    const answered = await route(service, 'POST', '/v1/underwrite', {
      subject: 'agent-2',
      requestId: 'route-2',
      action: 'doc.summarize',
      amountMicro: '100000',
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    });

    expect(answered.status).toBe(404);
    expect((answered.body as Record<string, unknown>)['error']).toBe('no_mandate_for_subject');
  });

  it('refuses an amount that is not an integer count of micro-USD', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });

    const answered = await route(service, 'POST', '/v1/underwrite', {
      subject: 'agent-1',
      requestId: 'route-3',
      action: 'doc.summarize',
      amountMicro: 100_000,
    });

    expect(answered.status).toBe(400);
    expect((answered.body as Record<string, unknown>)['error']).toBe('underwriter_request_invalid');
  });

  it('reports every unusable field in one answer, the way a startup refusal does', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });

    const answered = await route(service, 'POST', '/v1/underwrite', { subject: 'agent-1', merchant: '0xnope' });

    expect(answered.status).toBe(400);
    const body = answered.body as { error: string; detail: string; details: { problems: { field: string }[] } };
    expect(body.error).toBe('underwriter_request_invalid');
    expect(body.details.problems.map((problem) => problem.field).sort()).toEqual([
      'action',
      'amountMicro',
      'merchant',
      'requestId',
    ]);
    // Each one says what it expected, so the caller can fix all four without sending a fifth.
    expect(body.detail).toContain('requestId: missing (expected a non-empty string)');
    expect(body.detail).toContain('amountMicro: missing (expected a decimal string of atomic micro-USD');
  });

  it('takes the amount under one name across both services, and still accepts the old one', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });

    const current = await route(service, 'POST', '/v1/underwrite', {
      subject: 'agent-1',
      requestId: 'name-1',
      action: 'doc.summarize',
      amountMicro: '100000',
      at: NOW_ISO,
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    });
    expect(current.status).toBe(200);
    expect((current.body as Record<string, unknown>)['decision']).toEqual({ decision: 'allow' });

    const deprecated = await route(service, 'POST', '/v1/underwrite', {
      subject: 'agent-1',
      requestId: 'name-2',
      action: 'doc.summarize',
      amountMicros: '100000',
      at: NOW_ISO,
      merchant: MERCHANT,
      capabilityId: CAPABILITY,
    });
    expect(deprecated.status).toBe(200);
    expect((deprecated.body as Record<string, unknown>)['decision']).toEqual({ decision: 'allow' });
  });

  it('answers a subject nobody can decode as a bad request, not a fault of its own', async () => {
    const service = await start({
      MANDATE_DOCUMENT_SOURCE: 'chain',
      MANDATE_ACCOUNT: ACCOUNT,
      MANDATE_SUBJECT: 'agent-1',
    });

    for (const path of ['/v1/journal/%E0%A4%A', '/v1/mandates/%']) {
      const answered = await route(service, 'GET', path);
      expect(answered.status).toBe(400);
    }
  });

  it('pages the journal and says where the next page starts', async () => {
    const service = await start({
      MANDATE_DOCUMENT_SOURCE: 'chain',
      MANDATE_ACCOUNT: ACCOUNT,
      MANDATE_SUBJECT: 'agent-1',
    });

    for (let index = 0; index < 4; index += 1) {
      await route(service, 'POST', '/v1/underwrite', {
        ...spend(100_000n, `page-${index}`),
        amountMicro: '100000',
      });
    }

    const first = await route(service, 'GET', '/v1/journal/agent-1', {}, { limit: '2' });
    const page = first.body as { total: number; from: number; nextFrom: number | null; entries: unknown[] };
    expect(page).toMatchObject({ total: 4, from: 0, nextFrom: 2 });
    expect(page.entries).toHaveLength(2);

    const second = await route(service, 'GET', '/v1/journal/agent-1', {}, { from: '2', limit: '2' });
    expect(second.body).toMatchObject({ from: 2, nextFrom: null });
  });

  /**
   * `details` is written for whoever made the request. A journal already held names the file it is
   * on and the host and process id holding it, which is written for an operator reading this
   * service's log and describes the inside of a machine the caller is not on.
   */
  it('keeps a lock file path, a host and a process id out of what a caller is told', async () => {
    const directory = scratch();
    const first = await start({
      MANDATE_DOCUMENT_SOURCE: 'chain',
      MANDATE_ACCOUNT: ACCOUNT,
      MANDATE_SUBJECT: 'agent-1',
      UNDERWRITER_JOURNAL_DIR: directory,
    });
    expect(first.registry.mandates()).toHaveLength(1);

    const second = createUnderwriterService({
      config: loadUnderwriterConfig({
        ...RPC,
        MANDATE_DOCUMENT_SOURCE: 'chain',
        MANDATE_ACCOUNT: ACCOUNT,
        MANDATE_SUBJECT: 'agent-1',
        UNDERWRITER_JOURNAL_DIR: directory,
      }),
      chain: fakeChain(),
    });
    running.push(second);

    const held = await second.bind().catch((error: unknown) => errorResponse(error));
    const body = (held as ApiResponse).body as { error: string; detail: string; details?: Record<string, unknown> };
    expect(body.error).toBe('underwriter_journal_held');
    expect(body.details?.['lockPath']).toBeUndefined();
    expect(body.details?.['holder']).toBeUndefined();
    expect(body.details?.['account']).toBe(ACCOUNT);
  });

  it('is not ready while the account it speaks for answers nothing', async () => {
    const chain = fakeChain();
    const service = createUnderwriterService({
      config: loadUnderwriterConfig({
        ...RPC,
        UNDERWRITER_JOURNAL_DIR: scratch(),
        MANDATE_ACCOUNT: ACCOUNT,
        MANDATE_SUBJECT: 'agent-1',
      }),
      chain: {
        ...chain,
        readAccount: async () => {
          throw new ChainUnavailableError(`could not read MandateAccount ${ACCOUNT}: no contract answers there`);
        },
      },
    });
    running.push(service);
    await service.bind();

    const ready = await route(service, 'GET', '/readyz');

    // The mandate is bound and the chain answers a block, which is every check this probe used to
    // make. A decision would still come back a refusal, so this is not a process to take traffic.
    expect(ready.status).toBe(503);
    const body = ready.body as {
      ready: boolean;
      chain: { reachable: boolean; name: string; chainId: number };
      accounts: { subject: string; answers: boolean; detail: string }[];
    };
    expect(body.ready).toBe(false);
    expect(body.chain.reachable).toBe(true);
    expect(body.chain.name).toBe(RHC_MAINNET.name);
    expect(body.chain.chainId).toBe(RHC_MAINNET.chainId);
    expect(body.accounts).toEqual([
      expect.objectContaining({ subject: 'agent-1', account: ACCOUNT, answers: false }),
    ]);
    expect(body.accounts[0]?.detail).toContain('no contract answers there');
  });

  it('takes the merchant proof with an approval, for an account behind a Merkle gate', async () => {
    const chain = fakeChain({ merchantGate: { kind: 'merkleRoot', root: merchantLeaf(MERCHANT) } });
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' }, chain);

    const held = await route(service, 'POST', '/v1/underwrite', {
      ...spend(600_000n, 'gated-1'),
      amountMicros: '600000',
      merchantProof: [],
    });
    expect((held.body as { decision: { decision: string } }).decision.decision).toBe('hold');

    const approved = await route(service, 'POST', '/v1/settlements', {
      subject: 'agent-1',
      requestId: 'gated-1',
      resolution: 'approve',
      at: NOW_ISO,
      merchantProof: [],
    });
    expect(approved.status).toBe(200);
    expect((approved.body as { decision: unknown }).decision).toEqual({ decision: 'allow' });
  });

  it('refuses a refund that does not name the escrow lock it came from', async () => {
    const service = await start({ MANDATE_ACCOUNT: ACCOUNT, MANDATE_SUBJECT: 'agent-1' });
    await route(service, 'POST', '/v1/underwrite', { ...spend(100_000n, 'refund-1'), amountMicros: '100000' });

    const refused = await route(service, 'POST', '/v1/refunds', {
      subject: 'agent-1',
      requestId: 'refund-1',
      amountMicro: '100000',
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('escrowId');
  });

  it('will not listen against a settlement asset that is not six decimals', async () => {
    const chain = fakeChain();
    chain.state.decimals = 18;
    const service = createUnderwriterService({
      config: loadUnderwriterConfig({
        ...RPC,
        UNDERWRITER_JOURNAL_DIR: scratch(),
        MANDATE_ACCOUNT: ACCOUNT,
        MANDATE_SUBJECT: 'agent-1',
      }),
      chain,
    });
    running.push(service);

    await expect(service.start()).rejects.toThrow(/18-decimal/);
  });
});

/** The router plus the error mapping the HTTP server applies, which is the whole request path. */
async function route(
  service: UnderwriterService,
  method: string,
  path: string,
  body: unknown = {},
  query: Record<string, string> = {},
): Promise<ApiResponse> {
  const request: ApiRequest = { method, path, query: new URLSearchParams(query), body };
  try {
    return await service.router(request);
  } catch (error) {
    return errorResponse(error);
  }
}
