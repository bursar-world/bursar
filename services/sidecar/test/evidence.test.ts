import { micro } from '@bursar/core';
import { parseEvidence, verifyEvidence } from '@bursar/sdk';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { canonicalStringify, capabilityId, commitCanonical } from '../src/commit.js';
import { LockStatus } from '../src/escrow.js';
import { EvidenceRejected, createEvidencePoster } from '../src/evidence.js';
import type { Delivered, EvidencePoster } from '../src/evidence.js';
import type { ExecutionOutcome } from '../src/executor.js';
import { createWatcher } from '../src/watcher.js';
import type { WatcherOptions } from '../src/watcher.js';
import { ESCROW, PAYEE, TERMS, createFakeChain, createFakeFetch, createMemoryStateStore, createRecordingLogger, dataURI, lockRecord, txReceipt } from './fakes.js';
import type { FakeChainOptions } from './fakes.js';

const payee = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const INPUT = { city: 'Paris' };
const OUTPUT = { tempC: 21 };
const DEADLINE = 1_900_000_000n;

const LOCKED = lockRecord({
  capabilityId: capabilityId('weather.get:1'),
  inputCommit: commitCanonical(INPUT),
  inputURI: dataURI(INPUT),
  deadline: DEADLINE,
});

const EXECUTED: ExecutionOutcome = {
  kind: 'executed',
  outputCommit: commitCanonical(OUTPUT),
  outputURI: dataURI(OUTPUT),
  outputBytes: canonicalStringify(OUTPUT).length,
};

describe('evidence poster', () => {
  const delivered: Delivered = { id: 7n, inputCommit: LOCKED.inputCommit, outputCommit: EXECUTED.outputCommit, outputURI: EXECUTED.outputURI };

  it('posts delivery evidence the payee signed for this escrow and chain', async () => {
    const { fetch, calls } = createFakeFetch(() => new Response('{}', { status: 202 }));
    const post = createEvidencePoster({ url: 'https://resolver.example.com/evidence', account: payee, escrow: ESCROW, chainId: 4663, fetch, timeoutMs: 1_000, now: () => 5n });

    await post(delivered);

    const submission = parseEvidence(JSON.parse(String(calls[0]?.init.body)));
    expect(submission).toMatchObject({ kind: 'delivery', chainId: 4663, evidence: { escrowId: 7n, outputURI: EXECUTED.outputURI, deliveredAt: 5n } });
    expect(await verifyEvidence(submission, payee.address)).toBe(true);
  });

  it('treats a 4xx as final and a 5xx as worth another try', async () => {
    const refused = createEvidencePoster({ url: 'https://r.example.com', account: payee, escrow: ESCROW, chainId: 4663, fetch: createFakeFetch(() => new Response('no', { status: 403 })).fetch, timeoutMs: 1_000 });
    await expect(refused(delivered)).rejects.toBeInstanceOf(EvidenceRejected);

    const down = createEvidencePoster({ url: 'https://r.example.com', account: payee, escrow: ESCROW, chainId: 4663, fetch: createFakeFetch(() => new Response('', { status: 503 })).fetch, timeoutMs: 1_000 });
    await expect(down(delivered)).rejects.not.toBeInstanceOf(EvidenceRejected);
  });

  it('refuses to send a commitment with nowhere to fetch the output', async () => {
    const { fetch, calls } = createFakeFetch(() => new Response('{}'));
    const post = createEvidencePoster({ url: 'https://r.example.com', account: payee, escrow: ESCROW, chainId: 4663, fetch, timeoutMs: 1_000 });

    await expect(post({ ...delivered, outputURI: '' })).rejects.toBeInstanceOf(EvidenceRejected);
    expect(calls).toHaveLength(0);
  });
});

describe('evidence on a disputed lock', () => {
  async function harness(evidence: EvidencePoster | undefined, chainOptions: FakeChainOptions = {}, overrides: Partial<WatcherOptions> = {}) {
    const chain = createFakeChain(chainOptions);
    const log = createRecordingLogger();
    let clock = 1_000;
    const watcher = await createWatcher({
      confirmations: 0n,
      chain: chain.port,
      payee: PAYEE,
      terms: TERMS,
      logger: log.logger,
      state: createMemoryStateStore(),
      startBlock: 5n,
      pollMs: 1,
      finalizeReleases: true,
      execute: async () => EXECUTED,
      evidence,
      now: () => clock,
      ...overrides,
    });
    return { watcher, chain, log, advance: (ms: number) => (clock += ms) };
  }

  /**
   * The payer freezes the lock while the job runs: the release reverts, and the pass after it reads
   * the lock as disputed with the output already computed.
   */
  async function frozenMidJob(evidence: EvidencePoster) {
    let chain: ReturnType<typeof createFakeChain> | undefined;
    const made = await harness(evidence, {
      onWrite: (call) => {
        chain?.locks.set(1n, { ...LOCKED, status: LockStatus.Disputed, disputer: LOCKED.payer, disputedAt: 1n });
        return { ...txReceipt(call.action, call.id), status: 'reverted' as const };
      },
    });
    chain = made.chain;
    made.chain.publish(1n, LOCKED);
    await made.watcher.poll();
    made.advance(120_000);
    return made;
  }

  it('sends what it delivered when the payer disputes before the release', async () => {
    const sent: Delivered[] = [];
    const { watcher, log } = await frozenMidJob(async (delivered) => {
      sent.push(delivered);
    });

    await watcher.poll();

    expect(sent).toEqual([{ id: 1n, inputCommit: LOCKED.inputCommit, outputCommit: EXECUTED.outputCommit, outputURI: EXECUTED.outputURI }]);
    expect(log.events()).toContain('evidence_sent');
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  it('retries evidence the resolver could not take, and lets a rejection go', async () => {
    let calls = 0;
    const { watcher, log, advance } = await frozenMidJob(async () => {
      calls += 1;
      if (calls === 1) throw new Error('resolver unreachable');
      throw new EvidenceRejected('The resolver answered 409');
    });

    await watcher.poll();
    expect(log.events()).toContain('evidence_failed');
    expect(watcher.snapshot().tracked).toEqual([1n]);

    advance(120_000);
    await watcher.poll();
    expect(log.events()).toContain('evidence_abandoned');
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  it('sends nothing for a lock contested after it was paid', async () => {
    const sent: Delivered[] = [];
    const { watcher, chain, log } = await harness(async (delivered) => {
      sent.push(delivered);
    });
    chain.publish(1n, { ...LOCKED, status: LockStatus.Disputed, releasedAt: 5n, disputer: LOCKED.payer });

    await watcher.poll();
    expect(sent).toEqual([]);
    expect(log.events()).toContain('lock_disputed');
  });

  it('sends nothing for a lock this sidecar never delivered', async () => {
    const sent: Delivered[] = [];
    const { watcher, chain, log } = await harness(async (delivered) => {
      sent.push(delivered);
    });
    chain.publish(1n, { ...LOCKED, status: LockStatus.Disputed, disputer: LOCKED.payer });

    await watcher.poll();
    expect(sent).toEqual([]);
    expect(log.find('lock_disputed')?.fields['evidence']).toMatch(/never delivered/);
  });

  it('follows its own escalation with the evidence for it', async () => {
    const sent: Delivered[] = [];
    const { watcher, chain, advance } = await harness(
      async (delivered) => {
        sent.push(delivered);
      },
      {
        allowance: micro(1_000_000n),
        onWrite: (call) => {
          if (call.action === 'release') throw new Error('rpc down');
          return txReceipt(call.action, call.id);
        },
      },
      { escalate: { maxBond: micro(100_000n) } },
    );
    chain.publish(1n, LOCKED);
    await watcher.poll();
    chain.setHead({ timestamp: DEADLINE + 1n });
    advance(120_000);
    await watcher.poll();
    expect(chain.writes.map((write) => write.action)).toContain('dispute');

    advance(120_000);
    await watcher.poll();
    expect(sent.map((delivered) => delivered.id)).toEqual([1n]);
  });
});
