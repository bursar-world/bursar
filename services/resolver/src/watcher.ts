import { formatEther } from 'viem';

import type { Alerter } from './alert.js';
import { ResolverStatus } from './chain.js';
import type { ChainPort, Head } from './chain.js';
import type { Served } from './config.js';
import type { Journal } from './journal.js';
import type { ResolverKey } from './keys.js';
import { describeError } from './log.js';
import type { Logger } from './log.js';
import type { Voter } from './voter.js';

/**
 * How far behind the head the log scan stops. The head and the logs can come from different
 * providers, and one a few blocks behind answers "no logs" for blocks it has not seen yet. The
 * reconcile pass would catch a dispute missed that way; this keeps it from having to.
 */
export const SCAN_CONFIRMATIONS = 5n;

/** A chain nobody can reach is not answered by asking it every few seconds. */
const MAX_BACKOFF_MS = 300_000;

export type WatcherOptions = {
  readonly chain: ChainPort;
  readonly journal: Journal;
  readonly voter: Voter;
  readonly served: readonly Served[];
  readonly keys: readonly ResolverKey[];
  readonly logger: Logger;
  readonly alerts: Alerter;
  readonly pollMs: number;
  readonly blockRange: bigint;
  readonly startBlock?: bigint | undefined;
  readonly minGasWei: bigint;
  readonly heartbeatMs: number;
  readonly now?: () => number;
};

/** One registry this process votes on, as far as the log scan has read it. */
export type ServedHealth = {
  readonly name: string;
  readonly contractSet: Served['contractSet'];
  readonly registry: Served['registry'];
  readonly escrow: Served['escrow'];
  /** The last block the `DisputeOpened` scan covered. Null until the first scan finishes. */
  readonly lastScannedBlock: bigint | null;
  readonly open: number;
};

export type Health = {
  readonly lastPollAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly open: number;
  readonly served: readonly ServedHealth[];
};

export type Watcher = {
  poll(): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  health(): Health;
  /** The daily key checks and the heartbeat, on demand. */
  heartbeat(): Promise<void>;
};

/**
 * Finds disputes two ways and hands each to the voter.
 *
 * `DisputeOpened` logs are the fast path. The reconcile pass walks every dispute id the registry
 * has issued and keeps any still in a voting phase, so a log a provider dropped, a cursor that
 * jumped, or a journal that was lost costs nothing: the dispute is picked up on the next pass.
 */
export function createWatcher(options: WatcherOptions): Watcher {
  const { chain, journal, voter, served, logger, alerts } = options;
  const now = options.now ?? (() => Date.now());

  const tracked = new Map<string, { served: Served; disputeId: bigint }>();
  const done = new Set<string>();
  let lastPollAt: number | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  let nextHeartbeat = 0;
  const scanned = new Map<string, bigint>();

  const key = (entry: Served, disputeId: bigint): string => `${entry.registry}:${disputeId}`;

  async function scan(entry: Served, head: Head): Promise<void> {
    const latest = head.number > SCAN_CONFIRMATIONS ? head.number - SCAN_CONFIRMATIONS : 0n;
    let from = (await journal.cursor(entry.registry)) ?? options.startBlock ?? latest;

    while (from <= latest) {
      const to = latest - from < options.blockRange ? latest : from + options.blockRange - 1n;
      for (const log of await chain.disputeOpenedLogs(entry.registry, from, to)) {
        const id = key(entry, log.disputeId);
        if (done.has(id) || tracked.has(id)) continue;
        tracked.set(id, { served: entry, disputeId: log.disputeId });
        logger.info('dispute_seen', { registry: entry.registry, disputeId: log.disputeId, escrowId: log.escrowId, block: log.blockNumber });
      }
      from = to + 1n;
      await journal.setCursor(entry.registry, from);
    }
    if (from > 0n) scanned.set(entry.registry, from - 1n);
  }

  async function reconcile(entry: Served): Promise<void> {
    const next = await chain.nextDisputeId(entry.registry);
    for (let disputeId = 1n; disputeId < next; disputeId += 1n) {
      const id = key(entry, disputeId);
      if (!done.has(id) && !tracked.has(id)) tracked.set(id, { served: entry, disputeId });
    }
  }

  async function poll(): Promise<void> {
    const head = await chain.head();

    for (const entry of served) {
      await scan(entry, head);
      await reconcile(entry);
    }

    for (const [id, { served: entry, disputeId }] of tracked) {
      try {
        if ((await voter.step(entry, disputeId, head)) === 'done') {
          tracked.delete(id);
          done.add(id);
        }
      } catch (error) {
        // One dispute failing is retried on the next pass and must not hold up the others.
        logger.error('dispute_step_failed', { registry: entry.registry, disputeId, reason: describeError(error) });
      }
    }

    if (now() >= nextHeartbeat) {
      nextHeartbeat = now() + options.heartbeatMs;
      await heartbeat();
    }
  }

  /**
   * Checks each key the way the chain will when it next has to vote, and says so once a day even
   * when nothing is wrong. A pager that only speaks on failure cannot be told apart from one that
   * has stopped working.
   */
  async function heartbeat(): Promise<void> {
    const problems: string[] = [];
    const records = await journal.list();

    for (const entry of served) {
      for (const resolverKey of options.keys) {
        try {
          const [balance, standing, openVotes] = await Promise.all([
            chain.balance(resolverKey.address),
            chain.resolver(entry.registry, resolverKey.address),
            chain.openVotes(entry.registry, resolverKey.address),
          ]);
          const bondable = standing.status === ResolverStatus.Active && (await chain.bondable(entry.registry, resolverKey.address, standing.bond));

          if (balance < options.minGasWei) {
            problems.push(`${resolverKey.name} holds ${formatEther(balance)} ETH, under the ${formatEther(options.minGasWei)} ETH floor. Top it up from the deployer.`);
          }
          if (!bondable) problems.push(`${resolverKey.name} cannot vote: it is not active or its bond is below the floor.`);
          if (standing.slashes > 0) problems.push(`${resolverKey.name} has been slashed ${standing.slashes} times.`);

          const expected = records.filter(
            (record) =>
              record.registry === entry.registry &&
              record.outcome === null &&
              record.votes.some((vote) => vote.address.toLowerCase() === resolverKey.address.toLowerCase()),
          ).length;
          if (openVotes !== expected) {
            problems.push(`${resolverKey.name} has ${openVotes} open votes on chain and ${expected} in the journal.`);
          }
        } catch (error) {
          problems.push(`${resolverKey.name} could not be checked: ${describeError(error)}`);
        }
      }
    }

    for (const problem of problems) await alerts.send('WARN', 'key_check', problem);
    await alerts.send('INFO', 'heartbeat', `Resolver service is running. ${tracked.size} disputes open, ${problems.length} key problems.`, {
      keys: options.keys.map((resolverKey) => resolverKey.name).join(','),
      lastPollAt: lastPollAt === null ? 'never' : new Date(lastPollAt).toISOString(),
    });
  }

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await poll();
        lastPollAt = now();
        lastError = null;
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        lastError = describeError(error);
        logger.error('poll_failed', { reason: lastError, consecutiveFailures });
      }

      const wait = consecutiveFailures === 0 ? options.pollMs : Math.min(options.pollMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
      await sleep(wait, signal);
    }
  }

  return {
    poll: async () => {
      await poll();
      lastPollAt = now();
    },
    run,
    heartbeat,
    health: () => ({
      lastPollAt,
      lastError,
      consecutiveFailures,
      open: tracked.size,
      served: served.map((entry) => ({
        name: entry.name,
        contractSet: entry.contractSet,
        registry: entry.registry,
        escrow: entry.escrow,
        lastScannedBlock: scanned.get(entry.registry) ?? null,
        open: [...tracked.values()].filter((item) => item.served.registry === entry.registry).length,
      })),
    }),
  };
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
