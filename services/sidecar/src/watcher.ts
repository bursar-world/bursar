import { compareMicro, formatMicro, isPositiveMicro, mulBps, subMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address } from 'viem';

import { LockStatus, hasResolver, inFlightHash, lockStatusName } from './escrow.js';
import type { BlockRef, EscrowPort, EscrowTerms, LockRecord, TxOutcome } from './escrow.js';
import { EvidenceRejected } from './evidence.js';
import type { EvidencePoster } from './evidence.js';
import type { CommittedOutput, ExecutionOutcome, LockJob, OutputReader, StoredOutput } from './executor.js';
import type { GasMonitor } from './gas.js';
import { describeError } from './log.js';
import type { Logger } from './log.js';
import type { StateStore, WatcherState } from './state.js';

/** Inside the `eth_getLogs` span public RPCs accept. `MAX_BLOCK_RANGE` lowers it. */
export const DEFAULT_BLOCK_RANGE = 1_000n;

/**
 * How far behind the head the log scan stops.
 *
 * The head and the logs can come from different providers in the pool, and a provider a few
 * blocks behind the one that answered the head returns no logs for blocks it has not seen. The
 * cursor moves past those blocks all the same, and a lock in them is never looked at again. Staying
 * this many blocks short means the scan only asks about blocks a lagging provider has had time to
 * catch up on. The cost is that a lock is noticed this many blocks later.
 */
export const SCAN_CONFIRMATIONS = 5n;

/**
 * How many locks are worked on at once.
 *
 * A capability call can take seconds, and one at a time a single slow job holds up every other
 * lock in the pass, some of them with deadlines closer than its own. More than a few at once is a
 * burst the operator's capability API did not sign up for. Writes stay one at a time regardless;
 * see `exclusive`.
 */
export const EXECUTION_CONCURRENCY = 4;

/** How many finished ids stay remembered, so a long-lived process holds a bounded amount. */
const DEFAULT_SETTLED_ID_LIMIT = 4_096;

/**
 * A `finalizeRelease` or a `dispute` that reverts three times in a row is not going to start
 * working. Both are one-shot and neither has a deadline to stop the retry, so without a ceiling a
 * mispaired deployment would spend the payee's fee budget one reverted transaction per poll.
 */
const MAX_TERMINAL_ATTEMPTS = 3;

/**
 * How many times a lock the chain does not yet show is asked about again.
 *
 * A provider behind the one that served the log answers a lock that exists with a zeroed struct.
 * It clears in a block or two, and the wait between attempts is what turns this into a number of
 * blocks rather than a number of passes around a two-second loop.
 */
const MAX_UNSEEN_ATTEMPTS = 5;

/**
 * `release` is the call that moves the money, and a `release` that left a transaction on the wire
 * may still be mined. Each of those attempts costs a confirmation window, so five of them is
 * already the escrow's minimum TTL. Past that the lock is going to time out and refund the payer,
 * and another signature is a second transaction racing the first.
 *
 * Only a broadcast counts against it. A call that never produced a transaction spent no
 * confirmation window and is racing nothing, and spending the budget on those is how a provider
 * having a bad minute abandons a lock the payee has already done the work for.
 */
const MAX_RELEASE_ATTEMPTS = 5;

/** The ceiling on every backoff here. Wait longer and a lock's deadline decides the outcome. */
const MAX_BACKOFF_MS = 60_000;

/** How long a transaction on the wire is left alone, when nothing says how long to wait. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * How many failures of any kind a `finalizeRelease` or a `dispute` is worth before the id is let
 * go.
 *
 * A release is bounded by the lock's own deadline, which arrives and hands the id to the expiry
 * path. These two have no deadline to stop them, so without a ceiling an endpoint that never
 * answers keeps every id it touched tracked for the life of the process.
 */
const MAX_FAILURES = 10;

/** When a call that failed may be made again, and how many times it has failed, by lock id. */
type Schedule = Map<bigint, { failures: number; at: number }>;

/** The four things a lock can be waiting on, each with a count and a wait of its own. */
type Action = 'unseen' | 'release' | 'finalize' | 'dispute';

/**
 * Contesting a deadline the payee already delivered against. Off unless an operator turns it on,
 * because it posts a bond that a ruling against the payee keeps.
 */
export type Escalation = {
  /** The largest bond this payee will post. A lock priced above it runs to timeout instead. */
  readonly maxBond: Micro;
};

export type WatcherOptions = {
  readonly chain: EscrowPort;
  readonly payee: Address;
  readonly terms: EscrowTerms;
  /** `signal` is the shutdown signal, so a capability call does not outlive the process. */
  readonly execute: (job: LockJob, signal?: AbortSignal) => Promise<ExecutionOutcome>;
  /** The output already committed for a lock, so a restart re-sends it instead of re-running it. */
  readonly readExecuted?: OutputReader | undefined;
  readonly logger: Logger;
  readonly state: StateStore;
  readonly pollMs: number;
  /** Set to replay. It overrides the stored cursor. */
  readonly startBlock?: bigint | undefined;
  readonly blockRange?: bigint | undefined;
  /** Blocks the scan stays behind the head. `SCAN_CONFIRMATIONS` unless a test says otherwise. */
  readonly confirmations?: bigint | undefined;
  readonly finalizeReleases: boolean;
  readonly escalate?: Escalation | undefined;
  /** Sends signed delivery evidence to the resolvers when a lock this payee delivered is disputed. */
  readonly evidence?: EvidencePoster | undefined;
  readonly gas?: GasMonitor | undefined;
  /** How long the chain layer waits for a receipt, so a retry never lands inside that window. */
  readonly confirmTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
};

export type Watcher = {
  poll(signal?: AbortSignal): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  snapshot(): WatcherState;
};

/**
 * Watches `Locked` for this payee and carries each lock to a terminal state.
 *
 * An id stays tracked until it is finished, so a transient fault is retried on the next pass even
 * after the scan window moves past its block. Finished means the money and the counter have both
 * settled. The reputation counter that sets this payee's next cap is written by `finalizeRelease`
 * once the dispute window closes, so a release on its own leaves the lock tracked.
 */
export async function createWatcher(options: WatcherOptions): Promise<Watcher> {
  const { chain, execute, logger, state, terms, finalizeReleases, escalate, evidence, gas } = options;
  const payeeAddress = options.payee;
  /** Compared against, never sent. Every address the chain hands back is compared case-blind. */
  const payee = payeeAddress.toLowerCase();
  const blockRange = options.blockRange ?? DEFAULT_BLOCK_RANGE;
  const confirmations = options.confirmations ?? SCAN_CONFIRMATIONS;
  const readExecuted = options.readExecuted;
  const now = options.now ?? (() => Date.now());
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;

  const tracked = new Set<bigint>();
  const settled = new Set<bigint>();
  /** Committed output per id, so a retried release re-sends the bytes it already committed to. */
  const executed = new Map<bigint, CommittedOutput>();
  /** Ids this process has released. Guards against a lagging provider reporting them still open. */
  const releasedLocally = new Set<bigint>();

  /**
   * How many times each action has been answered the same unusable way, by lock.
   *
   * One counter per action, never one shared. A provider a block behind the one that served the
   * log, a `finalizeRelease` the contract reverts and a `dispute` it reverts are three different
   * faults with three different fixes, and the first of them is the one that resolves itself. On a
   * shared counter it exhausted the budget before either of the others had its first retry, and
   * `finalizeRelease` is the call that writes the reputation counter this payee's next cap is
   * computed from.
   */
  const attempts: Record<Action, Map<bigint, number>> = {
    unseen: new Map(),
    release: new Map(),
    finalize: new Map(),
    dispute: new Map(),
  };

  /**
   * When each action may be tried again, by lock. Held apart for the same reason the counts are:
   * a capability that failed four times before it delivered should not leave the release that
   * follows it waiting a minute on its first attempt.
   */
  const retry: Record<Action | 'capability' | 'evidence', Schedule> = {
    capability: new Map(),
    evidence: new Map(),
    unseen: new Map(),
    release: new Map(),
    finalize: new Map(),
    dispute: new Map(),
  };
  /** Ids already reported as waiting on the dispute window, so that line is written once each. */
  const announced = new Set<bigint>();
  /** Ids whose stored output would not read, so that line is written once each too. */
  const unreadable = new Set<bigint>();

  /**
   * One write at a time. Every write is signed from the same key and confirmed before the next is
   * prepared, because a provider that never saw the previous transaction hands out a stale nonce.
   * Locks are worked on in parallel; their transactions are not.
   */
  let writing: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const turn = writing.then(work);
    writing = turn.catch(() => undefined);
    return turn;
  }

  const stored = await state.read();
  for (const id of stored?.tracked ?? []) tracked.add(id);

  let nextBlock = options.startBlock ?? stored?.nextBlock ?? confirmed((await chain.latestBlock()).number);
  let dirty = stored === undefined || options.startBlock !== undefined;

  function forget(id: bigint): void {
    tracked.delete(id);
    executed.delete(id);
    releasedLocally.delete(id);
    for (const counter of Object.values(attempts)) counter.delete(id);
    for (const schedule of Object.values(retry)) schedule.delete(id);
    announced.delete(id);
    unreadable.delete(id);
    remember(settled, id, DEFAULT_SETTLED_ID_LIMIT);
    dirty = true;
  }

  /** True once an action has been answered the same unusable way as often as it is worth asking. */
  function spent(action: Action, id: bigint, ceiling: number): boolean {
    return (attempts[action].get(id) ?? 0) >= ceiling;
  }

  function countAttempt(action: Action, id: bigint): void {
    attempts[action].set(id, (attempts[action].get(id) ?? 0) + 1);
  }

  /** A failing call is worth trying again, but not every two seconds for the whole TTL. */
  function backOff(schedule: Schedule, id: bigint): number {
    const failures = (schedule.get(id)?.failures ?? 0) + 1;
    const wait = Math.min(options.pollMs * 2 ** failures, MAX_BACKOFF_MS);
    schedule.set(id, { failures, at: now() + wait });
    return wait;
  }

  /**
   * Leaves a transaction that may still be mined alone for at least a confirmation window.
   *
   * The budget for a signed release is counted in confirmation windows, and it is only a budget if
   * something makes the windows pass. Counted in polls, five attempts land inside ten seconds of a
   * two-second loop and the lock is abandoned with almost all of its TTL unused, after the
   * provider has already done the work.
   */
  function holdOff(schedule: Schedule, id: bigint): number {
    const failures = (schedule.get(id)?.failures ?? 0) + 1;
    const wait = Math.max(confirmTimeoutMs, Math.min(options.pollMs * 2 ** failures, MAX_BACKOFF_MS));
    schedule.set(id, { failures, at: now() + wait });
    return wait;
  }

  function waiting(schedule: Schedule, id: bigint): boolean {
    const pending = schedule.get(id);
    return pending !== undefined && now() < pending.at;
  }

  /** How many times this action has failed for any reason, whatever the chain had to do with it. */
  function failures(schedule: Schedule, id: bigint): number {
    return schedule.get(id)?.failures ?? 0;
  }

  function giveUp(id: bigint, event: string, fields: Record<string, string | number | bigint | boolean>): void {
    forget(id);
    logger.warn(event, fields);
  }

  /** The newest block the scan will ask about, given the head. */
  function confirmed(head: bigint): bigint {
    return head > confirmations ? head - confirmations : 0n;
  }

  /**
   * Reads the backlog in spans no wider than `blockRange` and advances after each one, so a cursor
   * far behind the head catches up instead of repeating one oversized query every pass.
   */
  async function collect(latest: bigint): Promise<void> {
    while (nextBlock <= latest) {
      const toBlock = latest - nextBlock < blockRange ? latest : nextBlock + blockRange - 1n;

      for (const entry of await chain.lockedLogs(nextBlock, toBlock)) {
        if (entry.payee.toLowerCase() !== payee) continue;
        if (tracked.has(entry.id) || settled.has(entry.id)) continue;

        tracked.add(entry.id);
        logger.info('lock_seen', { id: entry.id, block: entry.blockNumber });
      }

      nextBlock = toBlock + 1n;
      dirty = true;
    }
  }

  async function handle(id: bigint, head: BlockRef, signal: AbortSignal | undefined): Promise<void> {
    const lock = await chain.getLock(id);

    if (lock.status === LockStatus.None) {
      // The log said this lock exists. A provider a block behind the one that served the log
      // answers it with a zeroed struct, and forgetting the id here would abandon a payable lock
      // on a disagreement between two providers that resolves itself in a block.
      if (waiting(retry.unseen, id)) return;

      if (spent('unseen', id, MAX_UNSEEN_ATTEMPTS)) {
        giveUp(id, 'lock_unknown', { id, attempts: MAX_UNSEEN_ATTEMPTS });
        return;
      }

      countAttempt('unseen', id);
      // On a rising wait. Four passes of a two-second loop is eight seconds, and a fallback
      // provider takes blocks to catch up.
      logger.warn('lock_not_yet_visible', { id, retryInMs: backOff(retry.unseen, id) });
      return;
    }

    if (lock.payee.toLowerCase() !== payee) {
      giveUp(id, 'lock_other_payee', { id, payee: lock.payee });
      return;
    }

    switch (lock.status) {
      case LockStatus.Locked:
        await handleLocked(id, lock, head, signal);
        return;

      case LockStatus.Released:
        await handleReleased(id, lock, head);
        return;

      case LockStatus.Disputed:
        await handleDisputed(id, lock);
        return;

      default:
        forget(id);
        logger.info('lock_settled', { id, status: lockStatusName(lock.status), counted: lock.counted });
        return;
    }
  }

  async function handleLocked(
    id: bigint,
    lock: LockRecord,
    head: BlockRef,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (releasedLocally.has(id)) {
      // This process has a receipt for the release, so the provider answering the read is behind.
      logger.info('release_not_yet_visible', { id });
      return;
    }

    if (head.timestamp > lock.deadline) {
      await handleExpired(id, lock);
      return;
    }

    // Nothing to send and the capability is still cooling off from its last failure.
    if (!executed.has(id) && waiting(retry.capability, id)) return;

    let previous = executed.get(id);
    if (previous === undefined) {
      const recovered = await committed(id, lock);
      if (recovered === 'unusable') return;
      previous = recovered ?? undefined;
    }

    const outcome =
      previous ??
      (await execute(
        {
          id,
          capabilityId: lock.capabilityId,
          inputCommit: lock.inputCommit,
          inputURI: lock.inputURI,
        },
        signal,
      ));

    if (outcome.kind === 'rejected') {
      // The input or the capability is wrong and no retry changes that. The lock runs to its own
      // timeout, which refunds the payer without either side paying for a dispute.
      giveUp(id, 'job_rejected', { id, reason: outcome.reason });
      return;
    }

    if (outcome.kind === 'failed') {
      logger.error('job_failed', { id, reason: outcome.reason, retryInMs: backOff(retry.capability, id) });
      return;
    }

    executed.set(id, outcome);

    // A transaction that may still be mining is left alone until its confirmation window is out.
    if (waiting(retry.release, id)) return;

    if (spent('release', id, MAX_RELEASE_ATTEMPTS)) {
      // Each of those attempts was a signed transaction that may still be pending. Signing another
      // races the nonce already in flight, and the lock's own timeout refunds the payer from here.
      giveUp(id, 'release_abandoned', { id, attempts: MAX_RELEASE_ATTEMPTS });
      return;
    }

    let receipt: TxOutcome | 'stopping' | 'expired';
    try {
      receipt = await exclusive(async (): Promise<TxOutcome | 'stopping' | 'expired'> => {
        // Nothing new is signed once the process is stopping. The output is on disk, and the next
        // start re-sends it if the deadline still allows.
        if (signal?.aborted) return 'stopping';
        // The job may have run for a while, and the wait for the write before this one adds to it.
        // A release past the deadline reverts and pays for the gas, and the expiry path is the only
        // one that can still do anything for this lock.
        const now = await chain.latestBlock();
        return now.timestamp > lock.deadline ? 'expired' : chain.release(id, outcome.outputCommit, outcome.outputURI);
      });
    } catch (error) {
      // A release that already landed reverts on a non-locked status, and the next pass reads that
      // status and moves on. The uncomfortable case is a transaction broadcast and then lost track
      // of, and that is the one the budget is for: it is spent only when a transaction got out,
      // and the next attempt waits a confirmation window. A call that produced no transaction
      // spends neither.
      const inFlight = inFlightHash(error);
      if (inFlight === null) {
        logger.error('release_failed', { id, reason: describeError(error), retryInMs: backOff(retry.release, id) });
        return;
      }

      countAttempt('release', id);
      logger.error('release_failed', {
        id,
        hash: inFlight,
        reason: describeError(error),
        attempt: attempts.release.get(id) ?? 1,
        retryInMs: holdOff(retry.release, id),
      });
      return;
    }

    if (receipt === 'stopping') return;
    if (receipt === 'expired') {
      await handleExpired(id, lock);
      return;
    }

    if (receipt.status === 'reverted') {
      countAttempt('release', id);
      logger.error('release_reverted', {
        id,
        hash: receipt.hash,
        gasUsed: receipt.gasUsed,
        retryInMs: backOff(retry.release, id),
      });
      return;
    }

    releasedLocally.add(id);

    const fee = mulBps(lock.amount, terms.feeBps);
    logger.info('released', {
      id,
      hash: receipt.hash,
      outputCommit: outcome.outputCommit,
      outputBytes: outcome.outputBytes,
      published: outcome.outputURI !== '',
      amount: usd(lock.amount),
      fee: usd(fee),
      net: usd(subMicro(lock.amount, fee)),
      gasUsed: receipt.gasUsed,
    });
  }

  /**
   * The output this payee already published for a lock, read back once per id.
   *
   * `executed` is memory, and the release that names it is on chain. After a restart the two have
   * to be put back together or the job runs a second time and commits to an answer the first
   * release never named.
   *
   * An output is only reused for the input it was computed from. One recorded for another input,
   * or with no input recorded at all, is never sent, and cannot be replaced either because the
   * writer never overwrites: the lock is let go and runs to its own timeout. A file that will not
   * read is said once and asked about again on the capability's backoff, because it is somebody's
   * disk to fix and every pass in between would say the same thing.
   */
  async function committed(id: bigint, lock: LockRecord): Promise<CommittedOutput | null | 'unusable'> {
    if (readExecuted === undefined) return null;

    let stored: StoredOutput | null;
    try {
      stored = await readExecuted(id);
    } catch (error) {
      const retryInMs = backOff(retry.capability, id);
      if (!unreadable.has(id)) {
        unreadable.add(id);
        logger.error('output_unreadable', { id, reason: describeError(error), retryInMs });
      }
      return 'unusable';
    }
    unreadable.delete(id);
    if (stored === null) return null;

    if (stored.inputCommit === null || stored.inputCommit.toLowerCase() !== lock.inputCommit.toLowerCase()) {
      giveUp(id, 'output_input_mismatch', {
        id,
        recorded: stored.inputCommit ?? 'none',
        inputCommit: lock.inputCommit,
      });
      return 'unusable';
    }

    const output: CommittedOutput = {
      kind: 'executed',
      outputCommit: stored.outputCommit,
      outputURI: stored.outputURI,
      outputBytes: stored.outputBytes,
    };
    executed.set(id, output);
    logger.info('output_recovered', { id, outputCommit: output.outputCommit, outputBytes: output.outputBytes });
    return output;
  }

  /**
   * A release only becomes history once the dispute window shuts. Until then the same lock can
   * still be contested, and the escrow refuses to count a job twice. The counter is what the
   * reputation cap is computed from, and the cap is what bounds the next lock a payer may open
   * with this payee, so a payee that never finalises quietly holds its own ceiling down.
   */
  async function handleReleased(id: bigint, lock: LockRecord, head: BlockRef): Promise<void> {
    if (lock.counted) {
      forget(id);
      logger.info('release_counted', { id });
      return;
    }

    if (!finalizeReleases) {
      giveUp(id, 'release_left_uncounted', { id });
      return;
    }

    const countedAfter = lock.releasedAt + terms.disputeWindow;
    if (head.timestamp <= countedAfter) {
      // Said once, then the id sits quiet until the window shuts. A release followed by nothing at
      // all is the state a payee cannot read: it looks the same whether the counter is queued or
      // whether this process has washed its hands of it, and those decide whether anyone else has
      // to make the call.
      if (!announced.has(id)) {
        announced.add(id);
        logger.info('finalize_pending', { id, countedAfter, waitSeconds: countedAfter - head.timestamp });
      }
      return;
    }

    // Every attempt below is a signed transaction that may still be in flight. Re-signing one each
    // poll races its own nonce, which is the same hazard the release path spends its ceiling on.
    if (waiting(retry.finalize, id)) return;

    if (spent('finalize', id, MAX_TERMINAL_ATTEMPTS) || failures(retry.finalize, id) >= MAX_FAILURES) {
      giveUp(id, 'finalize_abandoned', {
        id,
        reverts: attempts.finalize.get(id) ?? 0,
        failures: failures(retry.finalize, id),
      });
      return;
    }

    let receipt;
    try {
      receipt = await exclusive(() => chain.finalizeRelease(id));
    } catch (error) {
      // A transport that never delivered the call is not the contract answering. Spending the
      // ceiling on it would abandon the counter over three unlucky moments on the wire, so this
      // backs off instead and keeps the id tracked. One that did get out waits a confirmation
      // window, because the transaction it left behind may still be mined.
      const inFlight = inFlightHash(error);
      logger.error('finalize_failed', {
        id,
        reason: describeError(error),
        ...(inFlight === null ? {} : { hash: inFlight }),
        retryInMs: inFlight === null ? backOff(retry.finalize, id) : holdOff(retry.finalize, id),
      });
      return;
    }

    if (receipt.status === 'reverted') {
      countAttempt('finalize', id);
      logger.error('finalize_reverted', {
        id,
        hash: receipt.hash,
        gasUsed: receipt.gasUsed,
        retryInMs: backOff(retry.finalize, id),
      });
      return;
    }

    forget(id);
    logger.info('release_finalized', { id, hash: receipt.hash, gasUsed: receipt.gasUsed });
  }

  /**
   * The deadline passed on a lock that still holds the money. `release` reverts from here, so the
   * only way the payee is paid for work it did deliver is to contest the lock before someone calls
   * `timeout` and refunds the payer. Contesting costs a bond and a share of the resolver fee, so
   * an operator has to turn it on.
   */
  async function handleExpired(id: bigint, lock: LockRecord): Promise<void> {
    const deadline = { id, deadline: lock.deadline, amount: usd(lock.amount) };

    const delivered = executed.get(id);
    if (!escalate || !delivered) {
      giveUp(id, 'deadline_passed', deadline);
      return;
    }

    if (!hasResolver(terms)) {
      giveUp(id, 'escalation_skipped', { ...deadline, reason: 'no resolver is wired to this escrow' });
      return;
    }

    const bond = mulBps(lock.amount, terms.disputeBondBps);
    if (compareMicro(bond, escalate.maxBond) > 0) {
      giveUp(id, 'escalation_skipped', {
        ...deadline,
        reason: `bond ${usd(bond)} is above the ceiling ${usd(escalate.maxBond)}`,
      });
      return;
    }

    if (isPositiveMicro(bond)) {
      const allowance = await chain.bondAllowance(terms.settlementAsset, payeeAddress);
      if (compareMicro(allowance, bond) < 0) {
        giveUp(id, 'escalation_skipped', {
          ...deadline,
          reason: `settlement allowance ${usd(allowance)} does not cover the bond ${usd(bond)}`,
        });
        return;
      }
    }

    // A dispute posts a bond and signs a transaction, and this path had neither a wait nor a
    // ceiling on the throw: a failure before anything reached the wire re-signed a bonded
    // transaction on every pass until somebody restarted the process.
    if (waiting(retry.dispute, id)) return;

    if (spent('dispute', id, MAX_TERMINAL_ATTEMPTS) || failures(retry.dispute, id) >= MAX_FAILURES) {
      giveUp(id, 'escalation_abandoned', {
        ...deadline,
        reverts: attempts.dispute.get(id) ?? 0,
        failures: failures(retry.dispute, id),
      });
      return;
    }

    let receipt;
    try {
      receipt = await exclusive(() => chain.dispute(id));
    } catch (error) {
      const inFlight = inFlightHash(error);
      if (inFlight !== null) countAttempt('dispute', id);
      logger.error('dispute_failed', {
        id,
        reason: describeError(error),
        ...(inFlight === null ? {} : { hash: inFlight }),
        retryInMs: inFlight === null ? backOff(retry.dispute, id) : holdOff(retry.dispute, id),
      });
      return;
    }

    if (receipt.status === 'reverted') {
      countAttempt('dispute', id);
      logger.error('dispute_reverted', {
        id,
        hash: receipt.hash,
        gasUsed: receipt.gasUsed,
        retryInMs: backOff(retry.dispute, id),
      });
      return;
    }

    // Kept tracked when there is evidence to send: the next pass reads the lock as disputed and
    // hands the resolvers what this payee delivered, which is the whole point of contesting it.
    if (evidence === undefined) forget(id);
    logger.warn('dispute_opened', {
      id,
      hash: receipt.hash,
      bond: usd(bond),
      resolverFee: usd(mulBps(lock.amount, terms.resolverFeeBps)),
      outputCommit: delivered.outputCommit,
    });
  }

  /**
   * The ruling belongs to the resolvers now. What this payee can still do is show them the work.
   *
   * A lock contested after release was paid in the release and no resolver votes on it, and a
   * lock this sidecar never delivered has nothing to show. Everything else gets signed evidence,
   * retried on a backoff, because without it the resolvers read the lock as undelivered.
   */
  async function handleDisputed(id: bigint, lock: LockRecord): Promise<void> {
    const contested = { id, disputer: lock.disputer, amount: usd(lock.amount) };

    if (evidence === undefined || lock.releasedAt !== 0n) {
      giveUp(id, 'lock_disputed', contested);
      return;
    }

    let delivered = executed.get(id);
    if (delivered === undefined) {
      const recovered = await committed(id, lock);
      if (recovered === 'unusable') return;
      delivered = recovered ?? undefined;
    }
    if (delivered === undefined) {
      giveUp(id, 'lock_disputed', { ...contested, evidence: 'none; this sidecar never delivered the job' });
      return;
    }

    if (waiting(retry.evidence, id)) return;

    try {
      await evidence({ id, inputCommit: lock.inputCommit, outputCommit: delivered.outputCommit, outputURI: delivered.outputURI });
    } catch (error) {
      if (error instanceof EvidenceRejected || failures(retry.evidence, id) + 1 >= MAX_FAILURES) {
        giveUp(id, 'evidence_abandoned', { ...contested, reason: describeError(error) });
        return;
      }
      logger.error('evidence_failed', { id, reason: describeError(error), retryInMs: backOff(retry.evidence, id) });
      return;
    }

    forget(id);
    logger.info('evidence_sent', { ...contested, outputCommit: delivered.outputCommit });
  }

  async function persist(): Promise<void> {
    if (!dirty) return;

    try {
      await state.write({ nextBlock, tracked: [...tracked] });
      dirty = false;
    } catch (error) {
      // Left dirty so the next poll tries again. Until it succeeds a restart replays from the
      // last cursor that did land, which costs duplicate reads and no duplicate payments.
      logger.error('state_write_failed', { reason: describeError(error) });
    }
  }

  async function poll(signal?: AbortSignal): Promise<void> {
    if (gas) {
      try {
        await gas.check();
      } catch (error) {
        logger.warn('gas_check_failed', { reason: describeError(error) });
      }
    }

    const head = await chain.latestBlock();
    await collect(confirmed(head.number));

    const queue = [...tracked];
    const worker = async (): Promise<void> => {
      for (;;) {
        // Every lock below this line can sign a transaction and then wait a confirmation window
        // for it. Carrying on through twenty of them after SIGTERM is a shutdown no runtime waits
        // out, and the cursor never reaches disk.
        if (signal?.aborted) return;
        const id = queue.shift();
        if (id === undefined) return;

        try {
          await handle(id, head, signal);
        } catch (error) {
          logger.error('lock_error', { id, reason: describeError(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXECUTION_CONCURRENCY, queue.length) }, worker));

    await persist();
  }

  async function run(signal: AbortSignal): Promise<void> {
    let failures = 0;

    while (!signal.aborted) {
      try {
        await poll(signal);
        failures = 0;
      } catch (error) {
        failures += 1;
        logger.error('poll_failed', { reason: describeError(error) });
      }

      // A chain nobody can reach is not answered by asking it every two seconds.
      await sleep(failures === 0 ? options.pollMs : Math.min(options.pollMs * 2 ** failures, MAX_BACKOFF_MS), signal);
    }
  }

  return {
    poll,
    run,
    snapshot: () => ({ nextBlock, tracked: [...tracked] }),
  };
}

function usd(value: Micro): string {
  return formatMicro(value, { symbol: true });
}

/**
 * Keeps the newest `limit` ids and drops the oldest past that. The scan cursor only moves forward
 * and is persisted, so an evicted id is not re-read from the chain in the first place.
 */
function remember(ids: Set<bigint>, id: bigint, limit: number): void {
  ids.delete(id);
  ids.add(id);

  while (ids.size > limit) {
    const oldest = ids.values().next();
    if (oldest.done) return;
    ids.delete(oldest.value);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
