import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { micro } from '@bursar/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalStringify, capabilityId, commitCanonical } from '../src/commit.js';
import { LockStatus } from '../src/escrow.js';
import { createOutputReader, createOutputWriter, executeJob, parseRoutes } from '../src/executor.js';
import type { ExecutionOutcome, LockJob } from '../src/executor.js';
import { EXECUTION_CONCURRENCY, SCAN_CONFIRMATIONS, createWatcher } from '../src/watcher.js';
import type { Watcher, WatcherOptions } from '../src/watcher.js';
import {
  DEFAULT_HEAD,
  OTHER_PAYEE,
  PAYEE,
  TERMS,
  ZERO_ADDRESS,
  createFakeChain,
  createFakeFetch,
  createMemoryStateStore,
  createRecordingLogger,
  dataURI,
  droppedWrite,
  jsonResponse,
  lockRecord,
  pendingWrite,
  txReceipt,
} from './fakes.js';
import type { FakeChainOptions, FetchCall, MemoryStateStore, WriteCall } from './fakes.js';

const WEATHER = 'weather.get:1';
const INPUT = { city: 'Paris' };
const OUTPUT = { tempC: 21 };
const DEADLINE = 1_900_000_000n;
const API_BASE = 'http://127.0.0.1:8787';

const LOCKED = lockRecord({
  capabilityId: capabilityId(WEATHER),
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

/** The production executor over fake transport, so the loop is proved against the real rules. */
function realExecutor(): { execute: (job: LockJob) => Promise<ExecutionOutcome>; calls: FetchCall[] } {
  const routes = parseRoutes({ [WEATHER]: { method: 'POST', path: '/v1/weather' } });
  const { fetch, calls } = createFakeFetch(() => jsonResponse(JSON.stringify(OUTPUT)));

  return {
    calls,
    execute: (job) =>
      executeJob(job, {
        routes,
        apiBase: API_BASE,
        allowedHosts: new Set(['127.0.0.1']),
        fetch,
        fetchTimeoutMs: 1_000,
        maxBodyBytes: 1_024,
        maxInlineOutputBytes: 4_096,
        outputBaseUrl: undefined,
        writeOutput: async () => undefined,
      }),
  };
}

type Harness = {
  watcher: Watcher;
  chain: ReturnType<typeof createFakeChain>;
  log: ReturnType<typeof createRecordingLogger>;
  state: MemoryStateStore;
  jobs: LockJob[];
};

async function harness(
  execute: (job: LockJob) => Promise<ExecutionOutcome> = async () => EXECUTED,
  chainOptions: FakeChainOptions = {},
  overrides: Partial<WatcherOptions> = {},
): Promise<Harness> {
  const chain = createFakeChain(chainOptions);
  const log = createRecordingLogger();
  const state = createMemoryStateStore();
  const jobs: LockJob[] = [];

  const watcher = await createWatcher({
    confirmations: 0n,
    chain: chain.port,
    payee: PAYEE,
    terms: chainOptions.terms ?? TERMS,
    logger: log.logger,
    state,
    startBlock: 5n,
    pollMs: 1,
    finalizeReleases: true,
    execute: (job) => {
      jobs.push(job);

      return execute(job);
    },
    ...overrides,
  });

  return { watcher, chain, log, state, jobs };
}

function actions(writes: readonly WriteCall[]): string[] {
  return writes.map((write) => `${write.action}:${write.id}`);
}

/**
 * A clock the test moves by hand.
 *
 * Every wait in the watcher is measured in milliseconds, not in passes around the loop, so a test
 * that polls twenty times in the same millisecond is asserting about one moment. Five attempts
 * inside ten seconds was never five confirmation windows.
 */
function stopwatch(): { now: () => number; advance: (ms: number) => void } {
  let ms = 1_000;
  return { now: () => ms, advance: (by) => { ms += by; } };
}

/** Longer than any wait the watcher sets, so the next poll is always allowed to act. */
const PAST_EVERY_WAIT_MS = 120_000;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('answering a lock', () => {
  it('releases once for a lock addressed to this payee', async () => {
    const { watcher, chain, log } = await harness();
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(chain.writes).toEqual([
      { action: 'release', id: 1n, outputCommit: EXECUTED.outputCommit, outputURI: EXECUTED.outputURI },
    ]);
    expect(log.find('released')?.fields).toMatchObject({
      id: 1n,
      amount: '$1.00',
      fee: '$0.01',
      net: '$0.99',
      published: true,
    });
  });

  it('never releases twice when a provider is still reporting the lock open', async () => {
    const { watcher, chain } = await harness(async () => EXECUTED, { settleOnWrite: false });
    chain.publish(1n, LOCKED, 10n);

    await watcher.poll();
    chain.setHead({ number: 12n });
    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
  });

  it('verifies the commitment before it releases anything', async () => {
    const { execute, calls } = realExecutor();
    const { watcher, chain, log } = await harness(execute);
    chain.publish(1n, { ...LOCKED, inputURI: dataURI({ city: 'Berlin' }) });

    await watcher.poll();

    expect(calls).toHaveLength(0);
    expect(chain.writes).toHaveLength(0);
    expect(log.events()).toContain('job_rejected');
  });

  it('runs the routed capability and releases what it committed to', async () => {
    const { execute, calls } = realExecutor();
    const { watcher, chain } = await harness(execute);
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(calls[0]?.url).toBe(`${API_BASE}/v1/weather`);
    expect(chain.writes[0]).toMatchObject({ action: 'release', outputCommit: commitCanonical(OUTPUT) });
  });

  it('re-sends the bytes it already committed to rather than running the job again', async () => {
    let runs = 0;
    let releases = 0;
    const clock = stopwatch();
    const { watcher, chain, jobs } = await harness(
      async () => {
        runs += 1;

        return EXECUTED;
      },
      {
        onWrite: (call) => {
          if (call.action === 'release') {
            releases += 1;
            if (releases === 1) droppedWrite();
          }

          return txReceipt(call.action, call.id);
        },
      },
      { now: clock.now },
    );
    chain.publish(1n, LOCKED);

    await watcher.poll();
    clock.advance(PAST_EVERY_WAIT_MS);
    await watcher.poll();

    expect(runs).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(actions(chain.writes)).toEqual(['release:1', 'release:1']);
  });

  it('ignores a lock addressed to another payee', async () => {
    const { watcher, chain, jobs } = await harness();
    chain.publish(1n, lockRecord({ payee: OTHER_PAYEE }));

    await watcher.poll();

    expect(jobs).toHaveLength(0);
    expect(chain.writes).toHaveLength(0);
  });

  it.each([
    ['timed out', LockStatus.TimedOut],
    ['cancelled', LockStatus.Cancelled],
    ['resolved', LockStatus.Resolved],
  ])('drops a lock that is already %s', async (_label, status) => {
    const { watcher, chain, log, jobs } = await harness();
    chain.publish(1n, lockRecord({ status, counted: true }));

    await watcher.poll();

    expect(jobs).toHaveLength(0);
    expect(chain.writes).toHaveLength(0);
    expect(log.events()).toContain('lock_settled');
  });

  it('leaves a contested lock to the resolver', async () => {
    const { watcher, chain, log } = await harness();
    chain.publish(1n, lockRecord({ status: LockStatus.Disputed, disputer: LOCKED.payer }));

    await watcher.poll();

    expect(chain.writes).toHaveLength(0);
    expect(log.find('lock_disputed')?.fields).toMatchObject({ id: 1n, amount: '$1.00' });
  });

  it('retries a job that failed for a transient reason, once it has backed off', async () => {
    const outcomes: ExecutionOutcome[] = [{ kind: 'failed', reason: 'fetch failed' }, EXECUTED];
    let clock = 0;
    const { watcher, chain, log, jobs } = await harness(async () => outcomes.shift() ?? EXECUTED, {}, {
      now: () => clock,
    });
    chain.publish(1n, LOCKED);

    await watcher.poll();
    expect(chain.writes).toHaveLength(0);

    // A capability that is down is not asked again every two seconds for the whole TTL, and each
    // ask costs a fresh fetch of the committed input.
    await watcher.poll();
    expect(jobs).toHaveLength(1);

    clock += 60_000;
    await watcher.poll();

    expect(jobs).toHaveLength(2);
    expect(actions(chain.writes)).toEqual(['release:1']);
    expect(log.find('job_failed')?.fields).toMatchObject({ reason: 'fetch failed' });
  });

  it('stops signing releases once a lock has had every confirmation window it is worth', async () => {
    const clock = stopwatch();
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      {
        settleOnWrite: false,
        // What `confirmTimeoutMs` looks like from here: the transaction got out and may well be
        // mined a moment later.
        onWrite: (call) => (call.action === 'release' ? pendingWrite(call.action, call.id) : txReceipt(call.action, call.id)),
      },
      { now: clock.now, confirmTimeoutMs: 60_000 },
    );
    chain.publish(1n, LOCKED);

    for (let pass = 0; pass < 8; pass += 1) {
      await watcher.poll();
      clock.advance(PAST_EVERY_WAIT_MS);
    }

    expect(actions(chain.writes)).toEqual(Array.from({ length: 5 }, () => 'release:1'));
    expect(log.find('release_abandoned')?.fields).toMatchObject({ id: 1n, attempts: 5 });
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  it('re-sends the output it committed before a restart instead of running the job again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bursar-sidecar-'));
    directories.push(directory);

    const policy = { maxInlineOutputBytes: 4_096, outputBaseUrl: undefined };
    const routes = parseRoutes({ [WEATHER]: { method: 'POST', path: '/v1/weather' } });
    // The capability answers differently the second time, which is the whole hazard: the
    // commitment on chain names the first answer.
    const answers = [OUTPUT, { tempC: 99 }];
    const { fetch } = createFakeFetch(() => jsonResponse(JSON.stringify(answers.shift() ?? OUTPUT)));
    const execute = (job: LockJob): Promise<ExecutionOutcome> =>
      executeJob(job, {
        routes,
        apiBase: API_BASE,
        allowedHosts: new Set(['127.0.0.1']),
        fetch,
        fetchTimeoutMs: 1_000,
        maxBodyBytes: 1_024,
        ...policy,
        writeOutput: createOutputWriter(directory),
      });

    const chain = createFakeChain({ settleOnWrite: false });
    chain.publish(1n, LOCKED);
    const state = createMemoryStateStore();
    const log = createRecordingLogger();
    const shared = {
      confirmations: 0n,
      chain: chain.port,
      payee: PAYEE,
      terms: TERMS,
      logger: log.logger,
      state,
      pollMs: 1,
      finalizeReleases: true,
      execute,
      readExecuted: createOutputReader(directory, policy),
    };

    const before = await createWatcher({ ...shared, startBlock: 5n });
    await before.poll();

    // The release never lands, the process restarts, and the lock still reads as locked.
    const after = await createWatcher(shared);
    await after.poll();

    const commitments = chain.writes.map((write) => write.outputCommit);
    expect(commitments).toEqual([commitCanonical(OUTPUT), commitCanonical(OUTPUT)]);
    expect(log.events()).toContain('output_recovered');
  });

  it('stops walking locks the moment it is asked to shut down, and signs nothing after', async () => {
    const shutdown = new AbortController();
    const { watcher, chain, state, jobs } = await harness(async (job) => {
      if (job.id === 1n) shutdown.abort();
      return EXECUTED;
    });
    for (const id of [1n, 2n, 3n, 4n, 5n, 6n]) chain.publish(id, LOCKED);

    await watcher.poll(shutdown.signal);

    // Each release blocks for a confirmation window, which is a shutdown no supervisor waits out,
    // and the cursor is written by the line after the loop. The locks already being worked on
    // finish their jobs; none of them signs, and nothing past them is started.
    expect(jobs.map((job) => job.id)).toEqual([1n, 2n, 3n, 4n]);
    expect(chain.writes).toEqual([]);
    expect(watcher.snapshot().tracked).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(state.writes).toHaveLength(1);
  });

  it('treats a reverted release as a failure and reads the status back', async () => {
    const { watcher, chain, log } = await harness(async () => EXECUTED, {
      onWrite: (call) => ({ ...txReceipt(call.action, call.id), status: 'reverted' }),
    });
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(log.events()).toContain('release_reverted');
    expect(watcher.snapshot().tracked).toEqual([1n]);
  });
});

describe('scanning', () => {
  it('scans forward from the last block it read', async () => {
    const { watcher, chain } = await harness();

    await watcher.poll();
    chain.setHead({ number: 12n });
    await watcher.poll();

    expect(chain.scans).toEqual([
      { fromBlock: 5n, toBlock: 10n },
      { fromBlock: 11n, toBlock: 12n },
    ]);
  });

  it('reads a wide backlog in spans no provider will refuse', async () => {
    const { watcher, chain } = await harness(async () => EXECUTED, {}, { blockRange: 2n });
    chain.publish(1n, LOCKED, 6n);

    await watcher.poll();

    expect(chain.scans).toEqual([
      { fromBlock: 5n, toBlock: 6n },
      { fromBlock: 7n, toBlock: 8n },
      { fromBlock: 9n, toBlock: 10n },
    ]);
    expect(chain.writes).toHaveLength(1);
  });

  /**
   * The head and the logs can come from different providers. A provider behind the one that named
   * the head answers the newest blocks with no logs, and the cursor moves past a lock that was in
   * them for good.
   */
  it('stays short of the head, so a provider a few blocks behind cannot hide a lock', async () => {
    const { watcher, chain } = await harness(async () => EXECUTED, {}, { confirmations: undefined });
    chain.publish(1n, LOCKED, 8n);

    await watcher.poll();
    expect(chain.scans).toEqual([{ fromBlock: 5n, toBlock: 10n - SCAN_CONFIRMATIONS }]);
    expect(chain.writes).toHaveLength(0);

    chain.setHead({ number: 8n + SCAN_CONFIRMATIONS });
    await watcher.poll();
    expect(chain.scans.at(-1)).toEqual({ fromBlock: 11n - SCAN_CONFIRMATIONS, toBlock: 8n });
    expect(actions(chain.writes)).toEqual(['release:1']);
  });
});

describe('working several locks at once', () => {
  /** A job that finishes when the test says so. */
  function gate(): { execute: (job: LockJob) => Promise<ExecutionOutcome>; running: () => number; peak: () => number; open: () => void } {
    let running = 0;
    let peak = 0;
    const waiting: Array<() => void> = [];
    return {
      running: () => running,
      peak: () => peak,
      open: () => {
        for (const resume of waiting.splice(0)) resume();
      },
      execute: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resume) => waiting.push(resume));
        running -= 1;
        return EXECUTED;
      },
    };
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  /**
   * One slow capability call used to hold every other lock in the pass behind it, some of them
   * with deadlines closer than its own.
   */
  it('runs up to four jobs together and no more', async () => {
    const jobs = gate();
    const { watcher, chain } = await harness(jobs.execute);
    for (const id of [1n, 2n, 3n, 4n, 5n, 6n]) chain.publish(id, LOCKED);

    const pass = watcher.poll();
    await settle();
    expect(jobs.running()).toBe(EXECUTION_CONCURRENCY);

    for (let round = 0; round < 3; round += 1) {
      jobs.open();
      await settle();
    }
    await pass;

    expect(jobs.peak()).toBe(EXECUTION_CONCURRENCY);
    expect(chain.writes).toHaveLength(6);
  });

  it('never has two transactions in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const { watcher, chain } = await harness(async () => EXECUTED, {
      onWrite: async (call) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return txReceipt(call.action, call.id);
      },
    });
    for (const id of [1n, 2n, 3n, 4n]) chain.publish(id, LOCKED);

    await watcher.poll();

    expect(chain.writes).toHaveLength(4);
    expect(peak).toBe(1);
  });

  /**
   * The deadline was read before the job ran. A job that runs past it, or a release that waited
   * behind another write until past it, signs a transaction the escrow reverts.
   */
  it('reads the deadline again after the job, and does not sign a release past it', async () => {
    const { watcher, chain, log } = await harness(async () => {
      chain.setHead({ timestamp: DEADLINE + 1n });
      return EXECUTED;
    });
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(chain.writes).toEqual([]);
    expect(log.find('deadline_passed')?.fields).toMatchObject({ id: 1n });
  });
});

describe('an output already on disk', () => {
  const stored = (inputCommit: `0x${string}` | null) => async () => ({ ...EXECUTED, inputCommit });

  /**
   * An output directory carried across a redeployed escrow, or from one chain to another, holds
   * answers for other locks under the same ids. Re-sending one commits to work the payer never
   * asked for.
   */
  it('is re-sent only for the input it was computed from', async () => {
    const other = commitCanonical({ city: 'Berlin' });
    const { watcher, chain, log, jobs } = await harness(async () => EXECUTED, {}, { readExecuted: stored(other) });
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(chain.writes).toEqual([]);
    expect(jobs).toEqual([]);
    expect(log.find('output_input_mismatch')?.fields).toMatchObject({ id: 1n, recorded: other });
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  it('is not re-sent when nothing recorded which input it answered', async () => {
    const { watcher, chain, log } = await harness(async () => EXECUTED, {}, { readExecuted: stored(null) });
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(chain.writes).toEqual([]);
    expect(log.events()).toContain('output_input_mismatch');
  });

  it('is re-sent when the input matches', async () => {
    const { watcher, chain, jobs } = await harness(async () => EXECUTED, {}, {
      readExecuted: stored(LOCKED.inputCommit),
    });
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(jobs).toEqual([]);
    expect(actions(chain.writes)).toEqual(['release:1']);
  });

  it('that will not read is reported once and asked about again after a wait', async () => {
    const clock = stopwatch();
    let reads = 0;
    const { watcher, chain, log } = await harness(async () => EXECUTED, {}, {
      now: clock.now,
      readExecuted: async () => {
        reads += 1;
        throw new Error('The stored output for lock 1 is not json');
      },
    });
    chain.publish(1n, LOCKED);

    await watcher.poll();
    await watcher.poll();
    expect(reads).toBe(1);

    clock.advance(PAST_EVERY_WAIT_MS);
    await watcher.poll();

    expect(reads).toBe(2);
    expect(log.events().filter((event) => event === 'output_unreadable')).toHaveLength(1);
    expect(log.events()).not.toContain('lock_error');
    expect(chain.writes).toEqual([]);
  });
});

describe('the dispute window', () => {
  it('waits out the window, then writes the counter that raises the payee cap', async () => {
    const { watcher, chain, log } = await harness();
    chain.publish(1n, LOCKED);

    await watcher.poll();
    expect(actions(chain.writes)).toEqual(['release:1']);

    // Still contestable. Nothing to do, and the lock stays tracked.
    chain.setHead({ number: 11n, timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow });
    await watcher.poll();
    expect(actions(chain.writes)).toEqual(['release:1']);
    expect(watcher.snapshot().tracked).toEqual([1n]);

    chain.setHead({ number: 12n, timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow + 1n });
    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1', 'finalizeRelease:1']);
    expect(log.events()).toContain('release_finalized');
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  it('spends a finalisation attempt on a revert, never on a transport that did not deliver', async () => {
    let thrown = 0;
    let clock = 0;
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      {
        onWrite: (call) => {
          if (call.action === 'finalizeRelease' && thrown < 3) {
            thrown += 1;
            throw new Error('rpc down');
          }
          return txReceipt(call.action, call.id);
        },
      },
      { now: () => clock },
    );
    chain.publish(1n, LOCKED);

    await watcher.poll();
    chain.setHead({ timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow + 1n });
    for (let pass = 0; pass < 4; pass += 1) {
      await watcher.poll();
      clock += 60_000;
    }

    // The ceiling is there for a contract that keeps saying no, and three unlucky moments on the
    // wire are not that.
    expect(log.events()).toContain('release_finalized');
    expect(log.events()).not.toContain('finalize_abandoned');
  });

  /**
   * A `finalizeRelease` the wire dropped is a transaction that may still be in flight, which is
   * the hazard the release path spends its own ceiling on. Signing another every two seconds
   * races the nonce already out there and pays for both.
   */
  it('does not re-sign a finalisation while the last one may still be in flight', async () => {
    let clock = 0;
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      {
        onWrite: (call) => {
          if (call.action === 'finalizeRelease') throw new Error('timed out waiting for a receipt');
          return txReceipt(call.action, call.id);
        },
      },
      { now: () => clock },
    );
    chain.publish(1n, LOCKED);

    await watcher.poll();
    chain.setHead({ timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow + 1n });
    for (let pass = 0; pass < 5; pass += 1) await watcher.poll();

    expect(actions(chain.writes).filter((action) => action.startsWith('finalize'))).toHaveLength(1);
    expect(log.find('finalize_failed')?.fields).toMatchObject({ id: 1n, retryInMs: 2 });

    // The lock is not given up on. It is waiting, and the wait is what ends.
    expect(watcher.snapshot().tracked).toEqual([1n]);
    clock += 60_000;
    await watcher.poll();
    expect(actions(chain.writes).filter((action) => action.startsWith('finalize'))).toHaveLength(2);
  });

  /**
   * The counter behind a payee's cap is written seconds to days after the money moves, and nobody
   * is obliged to write it. A release followed by silence reads the same whether this process is
   * waiting out the window or has washed its hands of the lock, and those are different answers to
   * "does somebody else have to make this call".
   */
  it('reports that a release is waiting on the window, once, and then finalises it', async () => {
    const { watcher, chain, log } = await harness();
    chain.publish(1n, LOCKED);

    await watcher.poll();
    await watcher.poll();
    await watcher.poll();

    const pending = log.events().filter((event) => event === 'finalize_pending');
    expect(pending).toHaveLength(1);
    expect(log.find('finalize_pending')?.fields).toMatchObject({
      id: 1n,
      countedAfter: DEFAULT_HEAD.timestamp + TERMS.disputeWindow,
      waitSeconds: TERMS.disputeWindow,
    });

    chain.setHead({ timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow + 1n });
    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1', 'finalizeRelease:1']);
    expect(log.events()).toContain('release_finalized');
  });

  it('needs no second call when the escrow counts the release itself', async () => {
    const { watcher, chain, log } = await harness(async () => EXECUTED, { terms: { ...TERMS, disputeWindow: 0n } });
    chain.publish(1n, LOCKED);

    await watcher.poll();
    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
    expect(log.events()).toContain('release_counted');
  });

  it('leaves the counter alone when something else finalises', async () => {
    const { watcher, chain, log } = await harness(async () => EXECUTED, {}, { finalizeReleases: false });
    chain.publish(1n, LOCKED);

    await watcher.poll();
    chain.setHead({ timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow + 1n });
    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
    expect(log.events()).toContain('release_left_uncounted');
  });

  it('stops paying for a finalisation that keeps reverting', async () => {
    const clock = stopwatch();
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      {
        onWrite: (call) =>
          call.action === 'finalizeRelease'
            ? { ...txReceipt(call.action, call.id), status: 'reverted' }
            : txReceipt(call.action, call.id),
      },
      { now: clock.now },
    );
    chain.publish(1n, LOCKED);

    await watcher.poll();
    chain.setHead({ timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow + 1n });
    for (let pass = 0; pass < 5; pass += 1) {
      await watcher.poll();
      clock.advance(PAST_EVERY_WAIT_MS);
    }

    expect(actions(chain.writes).filter((action) => action.startsWith('finalize'))).toHaveLength(3);
    expect(log.events()).toContain('finalize_abandoned');
  });
});

describe('a deadline that ran out', () => {
  const expired = { timestamp: DEADLINE + 1n };

  it('drops the lock and spends nothing when escalation is off', async () => {
    const { watcher, chain, log } = await harness();
    chain.publish(1n, LOCKED);
    chain.setHead(expired);

    await watcher.poll();

    expect(chain.writes).toHaveLength(0);
    expect(log.find('deadline_passed')?.fields).toMatchObject({ id: 1n, amount: '$1.00' });
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  /** Work delivered, the release lost to an RPC fault, and the deadline gone while retrying. */
  async function expiredAfterDelivery(
    overrides: Partial<WatcherOptions> = {},
    chainOptions: FakeChainOptions = {},
  ): Promise<Harness> {
    const result = await harness(
      async () => EXECUTED,
      {
        onWrite: (call) => {
          if (call.action === 'release') throw new Error('rpc down');

          return txReceipt(call.action, call.id);
        },
        ...chainOptions,
      },
      { escalate: { maxBond: micro(100_000n) }, ...overrides },
    );

    result.chain.publish(1n, LOCKED);
    await result.watcher.poll();
    result.chain.setHead(expired);

    return result;
  }

  it('contests the lock so the delivered work can still be paid', async () => {
    const { watcher, chain, log } = await expiredAfterDelivery({}, { allowance: micro(1_000_000n) });

    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1', 'dispute:1']);
    expect(log.find('dispute_opened')?.fields).toMatchObject({
      id: 1n,
      bond: '$0.05',
      resolverFee: '$0.02',
      outputCommit: EXECUTED.outputCommit,
    });
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  it('refuses to post a bond larger than the ceiling it was given', async () => {
    const { watcher, chain, log } = await expiredAfterDelivery(
      { escalate: { maxBond: micro(10_000n) } },
      { allowance: micro(1_000_000n) },
    );

    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
    expect(log.find('escalation_skipped')?.fields['reason']).toContain('above the ceiling');
  });

  it('refuses when the escrow cannot pull the bond', async () => {
    const { watcher, chain, log } = await expiredAfterDelivery({}, { allowance: micro(0n) });

    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
    expect(log.find('escalation_skipped')?.fields['reason']).toContain('does not cover the bond');
  });

  it('refuses when no resolver can hear the dispute', async () => {
    const { watcher, chain, log } = await expiredAfterDelivery(
      {},
      { terms: { ...TERMS, resolver: ZERO_ADDRESS }, allowance: micro(1_000_000n) },
    );

    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
    expect(log.find('escalation_skipped')?.fields['reason']).toContain('no resolver');
  });

  // A v3 escrow refuses a dispute after the deadline, so sending one would only burn gas and, in
  // a retry loop, keep burning it.
  it('does not contest on an escrow that refuses a dispute after the deadline', async () => {
    const { watcher, chain, log } = await expiredAfterDelivery(
      {},
      { terms: { ...TERMS, lateDisputes: false }, allowance: micro(1_000_000n) },
    );

    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
    expect(log.find('escalation_skipped')?.fields['reason']).toContain('takes no dispute after the deadline');
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  it('does not contest a lock it never delivered work for', async () => {
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      { allowance: micro(1_000_000n) },
      { escalate: { maxBond: micro(100_000n) } },
    );
    chain.publish(1n, LOCKED);
    chain.setHead(expired);

    await watcher.poll();

    expect(chain.writes).toHaveLength(0);
    expect(log.events()).toContain('deadline_passed');
  });
});

describe('the cursor', () => {
  it('records the scan position and the locks still in flight', async () => {
    const { watcher, chain, state } = await harness();
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(state.current()).toEqual({ nextBlock: 11n, tracked: [1n] });
  });

  it('resumes a release that was waiting out its window when the process stopped', async () => {
    const chain = createFakeChain();
    const log = createRecordingLogger();
    const state = createMemoryStateStore({ nextBlock: 11n, tracked: [1n] });

    chain.locks.set(1n, {
      ...LOCKED,
      status: LockStatus.Released,
      releasedAt: DEFAULT_HEAD.timestamp,
      outputCommit: EXECUTED.outputCommit,
    });
    chain.setHead({ number: 11n, timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow + 1n });

    const watcher = await createWatcher({
      confirmations: 0n,
      chain: chain.port,
      payee: PAYEE,
      terms: TERMS,
      logger: log.logger,
      state,
      pollMs: 1,
      finalizeReleases: true,
      execute: async () => EXECUTED,
    });

    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['finalizeRelease:1']);
    // The Locked event for this id is long behind the cursor, so only the stored id found it.
    expect(chain.scans).toEqual([{ fromBlock: 11n, toBlock: 11n }]);
  });

  it('starts at the head when there is nothing stored and no replay was asked for', async () => {
    const chain = createFakeChain({ head: { number: 61_540_100n, timestamp: DEFAULT_HEAD.timestamp } });
    const log = createRecordingLogger();

    const watcher = await createWatcher({
      confirmations: 0n,
      chain: chain.port,
      payee: PAYEE,
      terms: TERMS,
      logger: log.logger,
      state: createMemoryStateStore(),
      pollMs: 1,
      finalizeReleases: true,
      execute: async () => EXECUTED,
    });

    expect(watcher.snapshot().nextBlock).toBe(61_540_100n);
  });

  it('lets an explicit replay block override the stored cursor', async () => {
    const chain = createFakeChain();
    const log = createRecordingLogger();

    const watcher = await createWatcher({
      confirmations: 0n,
      chain: chain.port,
      payee: PAYEE,
      terms: TERMS,
      logger: log.logger,
      state: createMemoryStateStore({ nextBlock: 99n, tracked: [] }),
      startBlock: 5n,
      pollMs: 1,
      finalizeReleases: true,
      execute: async () => EXECUTED,
    });

    expect(watcher.snapshot().nextBlock).toBe(5n);
  });

  it('keeps the position it last wrote when the store rejects a write', async () => {
    const chain = createFakeChain();
    const log = createRecordingLogger();
    let failing = true;
    const state = createMemoryStateStore(undefined, () => {
      if (failing) throw new Error('disk full');
    });

    const watcher = await createWatcher({
      confirmations: 0n,
      chain: chain.port,
      payee: PAYEE,
      terms: TERMS,
      logger: log.logger,
      state,
      startBlock: 5n,
      pollMs: 1,
      finalizeReleases: true,
      execute: async () => EXECUTED,
    });

    await watcher.poll();
    expect(log.events()).toContain('state_write_failed');
    expect(state.current()).toBeUndefined();

    failing = false;
    await watcher.poll();

    expect(state.current()).toEqual({ nextBlock: 11n, tracked: [] });
  });
});

describe('run', () => {
  it('polls until the signal aborts', async () => {
    const { watcher, chain } = await harness();
    chain.publish(1n, LOCKED);

    const shutdown = new AbortController();
    const running = watcher.run(shutdown.signal);
    setTimeout(() => shutdown.abort(), 5);
    await running;

    expect(actions(chain.writes)).toContain('release:1');
  });

  it('survives a poll that throws', async () => {
    const log = createRecordingLogger();
    const watcher = await createWatcher({
      confirmations: 0n,
      chain: {
        latestBlock: async () => {
          throw new Error('rpc down');
        },
        terms: async () => TERMS,
        lockedLogs: async () => [],
        getLock: async () => LOCKED,
        bondAllowance: async () => micro(0n),
        release: async () => txReceipt('release', 1n),
        finalizeRelease: async () => txReceipt('finalizeRelease', 1n),
        dispute: async () => txReceipt('dispute', 1n),
      },
      payee: PAYEE,
      terms: TERMS,
      logger: log.logger,
      state: createMemoryStateStore({ nextBlock: 1n, tracked: [] }),
      pollMs: 1,
      finalizeReleases: true,
      execute: async () => EXECUTED,
    });

    const shutdown = new AbortController();
    const running = watcher.run(shutdown.signal);
    setTimeout(() => shutdown.abort(), 5);
    await running;

    expect(log.entries[0]).toMatchObject({ event: 'poll_failed', fields: { reason: 'rpc down' } });
  });

  it('spaces out its passes while the chain is unreachable', async () => {
    vi.useFakeTimers();

    try {
      const log = createRecordingLogger();
      let attempts = 0;
      const watcher = await createWatcher({
        confirmations: 0n,
        chain: {
          latestBlock: async () => {
            attempts += 1;
            throw new Error('rpc down');
          },
          terms: async () => TERMS,
          lockedLogs: async () => [],
          getLock: async () => LOCKED,
          bondAllowance: async () => micro(0n),
          release: async () => txReceipt('release', 1n),
          finalizeRelease: async () => txReceipt('finalizeRelease', 1n),
          dispute: async () => txReceipt('dispute', 1n),
        },
        payee: PAYEE,
        terms: TERMS,
        logger: log.logger,
        state: createMemoryStateStore({ nextBlock: 1n, tracked: [] }),
        pollMs: 1_000,
        finalizeReleases: true,
        execute: async () => EXECUTED,
      });

      const shutdown = new AbortController();
      const running = watcher.run(shutdown.signal);
      await vi.advanceTimersByTimeAsync(10_000);
      shutdown.abort();
      await running;

      // A second per pass for ten seconds is ten more calls at an endpoint that is already down.
      expect(attempts).toBeLessThan(5);
      expect(attempts).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling when the gas check cannot reach the chain', async () => {
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      {},
      {
        gas: {
          check: async () => {
            throw new Error('rpc down');
          },
        },
      },
    );
    chain.publish(1n, LOCKED);

    await watcher.poll();

    expect(log.events()).toContain('gas_check_failed');
    expect(actions(chain.writes)).toEqual(['release:1']);
  });
});

/**
 * Every budget in the loop is a number of chances a lock gets before the payee walks away from
 * work it has already done. Counted in passes around a two-second loop, all of them run out in
 * seconds: five release attempts inside ten seconds, a lock abandoned four polls after a fallback
 * provider fell a block behind, a bonded dispute re-signed on every pass until somebody restarts
 * the process. The escrow measures its own patience in minutes and hours.
 */
describe('what a lock is given before it is let go', () => {
  it('does not spend a release attempt on a call that never produced a transaction', async () => {
    const clock = stopwatch();
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      {
        settleOnWrite: false,
        onWrite: (call) => (call.action === 'release' ? droppedWrite() : txReceipt(call.action, call.id)),
      },
      { now: clock.now },
    );
    chain.publish(1n, LOCKED);

    // Ten passes, and the provider is having a bad minute rather than mining anything. Nothing is
    // in flight, nothing is racing a nonce, and the lock is still inside its own deadline.
    for (let pass = 0; pass < 10; pass += 1) {
      await watcher.poll();
      clock.advance(PAST_EVERY_WAIT_MS);
    }

    expect(log.events()).not.toContain('release_abandoned');
    expect(watcher.snapshot().tracked).toEqual([1n]);
  });

  it('gives a signed release a confirmation window before signing another', async () => {
    const clock = stopwatch();
    const { watcher, chain } = await harness(
      async () => EXECUTED,
      {
        settleOnWrite: false,
        onWrite: (call) =>
          call.action === 'release' ? pendingWrite(call.action, call.id) : txReceipt(call.action, call.id),
      },
      { now: clock.now, confirmTimeoutMs: 60_000 },
    );
    chain.publish(1n, LOCKED);

    // Twenty passes of a two-second loop is forty seconds, which is less than one window.
    for (let pass = 0; pass < 20; pass += 1) {
      await watcher.poll();
      clock.advance(2_000);
    }

    expect(actions(chain.writes)).toEqual(['release:1']);
  });

  it('keeps a lock a lagging provider cannot see for longer than four passes', async () => {
    const clock = stopwatch();
    const { watcher, chain, log } = await harness(async () => EXECUTED, {}, { now: clock.now, pollMs: 2_000 });
    chain.publish(1n, lockRecord({ status: LockStatus.None }));

    // The log came from the head and the struct came from a node behind it. Six passes at two
    // seconds is twelve seconds, and a provider catching up takes blocks.
    for (let pass = 0; pass < 6; pass += 1) {
      await watcher.poll();
      clock.advance(2_000);
    }

    expect(log.events()).not.toContain('lock_unknown');
    expect(watcher.snapshot().tracked).toEqual([1n]);

    chain.locks.set(1n, LOCKED);
    clock.advance(PAST_EVERY_WAIT_MS);
    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
  });

  it('does not re-sign a bonded dispute on every pass', async () => {
    const clock = stopwatch();
    const { watcher, chain } = await harness(
      async () => EXECUTED,
      {
        allowance: micro(1_000_000n),
        onWrite: (call) => {
          if (call.action === 'release' || call.action === 'dispute') droppedWrite();
          return txReceipt(call.action, call.id);
        },
      },
      { escalate: { maxBond: micro(100_000n) }, now: clock.now, pollMs: 2_000 },
    );

    chain.publish(1n, LOCKED);
    await watcher.poll();
    chain.setHead({ timestamp: DEADLINE + 1n });

    for (let pass = 0; pass < 6; pass += 1) {
      clock.advance(2_000);
      await watcher.poll();
    }

    // Six passes of a two-second loop, and the wait after each failure doubles from four seconds.
    // Without one, this is six bonded transactions signed in twelve seconds.
    expect(actions(chain.writes).filter((action) => action.startsWith('dispute'))).toHaveLength(2);
  });

  it('stops contesting a lock the wire will not take, rather than trying forever', async () => {
    const clock = stopwatch();
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      {
        allowance: micro(1_000_000n),
        onWrite: (call) => {
          if (call.action === 'release' || call.action === 'dispute') droppedWrite();
          return txReceipt(call.action, call.id);
        },
      },
      { escalate: { maxBond: micro(100_000n) }, now: clock.now, pollMs: 2_000 },
    );

    chain.publish(1n, LOCKED);
    await watcher.poll();
    chain.setHead({ timestamp: DEADLINE + 1n });

    for (let pass = 0; pass < 14; pass += 1) {
      await watcher.poll();
      clock.advance(PAST_EVERY_WAIT_MS);
    }

    expect(log.events()).toContain('escalation_abandoned');
    expect(watcher.snapshot().tracked).toEqual([]);
  });

  /**
   * `finalizeRelease` is what writes the reputation counter this payee's next cap is read from. On
   * one shared counter, a provider a block behind spent the budget before the contract had said
   * anything, and the counter was abandoned on its first real attempt.
   */
  it('gives a reverting finalisation its own attempts, whatever a lagging provider used up', async () => {
    const clock = stopwatch();
    const { watcher, chain, log } = await harness(
      async () => EXECUTED,
      {
        onWrite: (call) =>
          call.action === 'finalizeRelease'
            ? { ...txReceipt(call.action, call.id), status: 'reverted' }
            : txReceipt(call.action, call.id),
      },
      { now: clock.now },
    );

    chain.publish(1n, lockRecord({ status: LockStatus.None }));
    for (let pass = 0; pass < 2; pass += 1) {
      await watcher.poll();
      clock.advance(PAST_EVERY_WAIT_MS);
    }
    expect(log.events()).toContain('lock_not_yet_visible');

    chain.locks.set(1n, LOCKED);
    await watcher.poll();
    chain.setHead({ timestamp: DEFAULT_HEAD.timestamp + TERMS.disputeWindow + 1n });

    for (let pass = 0; pass < 5; pass += 1) {
      clock.advance(PAST_EVERY_WAIT_MS);
      await watcher.poll();
    }

    expect(actions(chain.writes).filter((action) => action.startsWith('finalize'))).toHaveLength(3);
    expect(log.events()).toContain('finalize_abandoned');
  });
});

describe('lock identity', () => {
  it('keeps a lock a lagging provider cannot see yet, and pays it when it appears', async () => {
    const { watcher, chain, log } = await harness();
    // The log came from the head and the struct came from a node a block behind it, which answers
    // a lock that exists with a zeroed one.
    chain.publish(1n, lockRecord({ status: LockStatus.None }));

    await watcher.poll();

    expect(log.events()).toContain('lock_not_yet_visible');
    expect(watcher.snapshot().tracked).toEqual([1n]);

    chain.locks.set(1n, LOCKED);
    await watcher.poll();

    expect(actions(chain.writes)).toEqual(['release:1']);
  });

  it('drops an id no provider has a record of after the attempts run out', async () => {
    const clock = stopwatch();
    const { watcher, chain, log } = await harness(async () => EXECUTED, {}, { now: clock.now });
    chain.publish(1n, lockRecord({ status: LockStatus.None }));

    for (let pass = 0; pass < 7; pass += 1) {
      await watcher.poll();
      clock.advance(PAST_EVERY_WAIT_MS);
    }

    expect(log.events()).toContain('lock_unknown');
    expect(watcher.snapshot().tracked).toEqual([]);
  });
});
