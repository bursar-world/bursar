#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRhcClient, settlementAssetAbi } from '@bursar/core';
import type { RpcPoolEvent } from '@bursar/core';

import { loadConfig } from './config.js';
import type { EscrowWatch, SidecarConfig } from './config.js';
import { createEscrowPort, hasResolver } from './escrow.js';
import { createEvidencePoster } from './evidence.js';
import { createOutputReader, createOutputWriter, executeJob, readRoutes } from './executor.js';
import type { LockJob } from './executor.js';
import { createGasMonitor, readGasBalance } from './gas.js';
import type { BalanceReader, GasMonitor } from './gas.js';
import { createLogger } from './log.js';
import type { Logger } from './log.js';
import { reportStartupFailure } from './refusal.js';
import { createSigner } from './signer.js';
import { claimState, createFileStateStore } from './state.js';
import type { StateStore } from './state.js';
import { createWatcher } from './watcher.js';

/** Room past one confirmation window for the loop to notice, persist and return. */
const SHUTDOWN_GRACE_MS = 5_000;

async function start(config: SidecarConfig, payeeKey: `0x${string}`, logger: Logger): Promise<void> {
  const routes = await readRoutes(config.capabilitiesPath);

  const shutdown = new AbortController();
  let claimLost = false;

  const stop = (): void => {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    // One confirmation may already be in flight and is worth waiting out. Anything past that is
    // a process the supervisor kills instead, which is how a cursor gets lost.
    setTimeout(() => {
      logger.error('shutdown_timeout', { afterMs: config.confirmTimeoutMs + SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, config.confirmTimeoutMs + SHUTDOWN_GRACE_MS).unref();
  };

  // Before anything is read or signed, and for every escrow before any of them starts. Two
  // sidecars on one payee run every job twice, sign from one key at the same nonce and overwrite
  // each other's cursor, and the cheapest moment to find that out is the one before either of them
  // has done any of it.
  const claims: Claim[] = [];
  try {
    for (const watch of config.escrows) {
      claims.push(
        await claimState(watch.statePath, {
          // Found later, the same answer applies: the other one keeps the payee and this one stops
          // before it signs anything else, on every escrow it was answering.
          onLost: (holder) => {
            claimLost = true;
            logger.error('claim_lost', {
              holder,
              escrow: watch.escrow,
              statePath: watch.statePath,
              action: 'stopping; another sidecar now holds this payee, and this one exits non-zero',
            });
            stop();
          },
        }),
      );
    }
  } catch (error) {
    await Promise.all(claims.map((claim) => claim.release()));
    throw error;
  }

  try {
    const { client, pool } = createRhcClient({
      chain: config.chain,
      providers: config.providers,
      onEvent: (event) => reportRpc(logger, event),
    });

    // One signer, and so one nonce manager, for every escrow: they all sign from the payee key.
    const signer = createSigner({ key: payeeKey, chain: config.chain, pool });
    const gas = gasMonitor(config, client, signer.address, logger);

    await reportUnscoped(config, logger);

    const watchers = [];
    for (const [index, watch] of config.escrows.entries()) {
      watchers.push(
        await startEscrow(config, watch, {
          client,
          signer,
          routes,
          logger,
          lost: () => claimLost,
          // The gas floor is one balance, so one watcher checks it.
          gas: index === 0 ? gas : undefined,
          holder: claims[index]?.holder ?? 'unknown',
        }),
      );
    }

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        logger.info('shutting_down', { signal });
        stop();
      });
    }

    // One escrow failing stops the rest, so the process exits the way a single-escrow one would.
    await Promise.all(
      watchers.map((watcher) =>
        watcher.run(shutdown.signal).catch((error: unknown) => {
          stop();
          throw error;
        }),
      ),
    );

    if (claimLost) {
      process.exitCode = 1;
      return;
    }
    logger.info('stopped', { payee: signer.address, escrows: config.escrows.length });
  } finally {
    await Promise.all(claims.map((claim) => claim.release()));
  }
}

type Claim = Awaited<ReturnType<typeof claimState>>;

type Shared = {
  readonly client: ReturnType<typeof createRhcClient>['client'];
  readonly signer: ReturnType<typeof createSigner>;
  readonly routes: Awaited<ReturnType<typeof readRoutes>>;
  readonly logger: Logger;
  readonly lost: () => boolean;
  readonly gas: GasMonitor | undefined;
  readonly holder: string;
};

/** The watcher for one escrow: its own port, terms, outputs and cursor. */
async function startEscrow(config: SidecarConfig, watch: EscrowWatch, shared: Shared) {
  const { client, signer, routes, logger } = shared;

  const chain = createEscrowPort({
    client,
    wallet: signer.wallet,
    address: watch.escrow,
    confirmTimeoutMs: config.confirmTimeoutMs,
    minFeeCap: config.chain.minFeeCap,
  });

  const terms = await chain.terms();

  // Every amount in this service is six-decimal micro-USD. An escrow settling in a token with a
  // different scale would be off by orders of magnitude in silence, so the assumption is checked
  // against the token itself, not taken from the deployment record.
  const decimals = await client.readContract({
    address: terms.settlementAsset,
    abi: settlementAssetAbi,
    functionName: 'decimals',
  });
  if (decimals !== 6) {
    throw new Error(`Escrow ${watch.escrow} settles in a ${decimals}-decimal asset; this sidecar handles six.`);
  }

  const outputDir = join(config.outputDir, watch.outputScope);
  const writeOutput = createOutputWriter(outputDir);
  const outputPolicy = {
    maxInlineOutputBytes: config.maxInlineOutputBytes,
    // The directory is served as a whole, so the scope is part of the public path too.
    outputBaseUrl: config.outputBaseUrl === undefined ? undefined : `${config.outputBaseUrl}/${watch.outputScope}`,
  };

  const watcher = await createWatcher({
    chain,
    payee: signer.address,
    terms,
    logger,
    state: guardedState(createFileStateStore(watch.statePath), shared.lost),
    pollMs: config.pollMs,
    confirmTimeoutMs: config.confirmTimeoutMs,
    startBlock: config.startBlock,
    blockRange: config.blockRange,
    finalizeReleases: config.finalizeReleases,
    readExecuted: createOutputReader(outputDir, outputPolicy),
    escalate: config.escalateExpired && config.escalateMaxBond !== undefined ? { maxBond: config.escalateMaxBond } : undefined,
    evidence:
      config.evidenceUrl === undefined || !hasResolver(terms)
        ? undefined
        : createEvidencePoster({
            url: config.evidenceUrl,
            account: signer.wallet.account,
            escrow: watch.escrow,
            chainId: config.chain.chainId,
            fetch: globalThis.fetch,
            timeoutMs: config.fetchTimeoutMs,
          }),
    gas: shared.gas,
    execute: (job: LockJob, signal?: AbortSignal) =>
      executeJob(
        job,
        {
          routes,
          apiBase: config.apiBase,
          allowedHosts: config.allowedHosts,
          fetch: globalThis.fetch,
          fetchTimeoutMs: config.fetchTimeoutMs,
          maxBodyBytes: config.maxBodyBytes,
          ...outputPolicy,
          writeOutput,
        },
        signal,
      ),
  });

  const cursor = watcher.snapshot();
  logger.info('started', {
    payee: signer.address,
    holder: shared.holder,
    chain: config.chain.name,
    chainId: config.chain.chainId,
    escrow: watch.escrow,
    outputDir,
    // Each bare label is routed under three ids, so count what the file configures, not the aliases.
    capabilities: new Set([...routes.values()].map((route) => route.capability)).size,
    nextBlock: cursor.nextBlock,
    resuming: cursor.tracked.length,
    feeBps: terms.feeBps,
    disputeWindow: terms.disputeWindow,
    disputeBondBps: terms.disputeBondBps,
    resolver: hasResolver(terms) ? terms.resolver : 'none',
    finalizeReleases: config.finalizeReleases,
    evidence: config.evidenceUrl === undefined ? 'off' : 'on',
    pollMs: config.pollMs,
  });

  return watcher;
}

/**
 * The cursor belongs to whoever holds the claim. Once another sidecar has it, the write this one
 * makes on its way out would replace that sidecar's position with a stale one.
 */
function guardedState(store: StateStore, lost: () => boolean): StateStore {
  return {
    read: () => store.read(),
    write: async (next) => {
      if (lost()) throw new Error('the claim on this payee was lost, so the cursor belongs to the sidecar holding it');
      await store.write(next);
    },
  };
}

/**
 * Outputs and a cursor written before they were scoped to a chain and an escrow. They are not
 * read, because nothing says which escrow's locks they answered, and they are not moved, because
 * moving them would be the guess this layout exists to stop making. The operator is told once.
 */
async function reportUnscoped(config: SidecarConfig, logger: Logger): Promise<void> {
  let names: string[];
  try {
    names = await readdir(config.outputDir);
  } catch {
    return;
  }

  const inUse = new Set(config.escrows.map((entry) => resolve(entry.statePath)));
  const legacy = names.filter(
    (name) => /^\d+\.json$/.test(name) || (name === 'cursor.json' && !inUse.has(resolve(config.outputDir, name))),
  );
  if (legacy.length === 0) return;

  logger.warn('unscoped_outputs_ignored', {
    outputDir: config.outputDir,
    files: legacy.length,
    scope: config.escrows.map((entry) => entry.outputScope).join(','),
    action: 'files directly under OUTPUT_DIR are not read; see the sidecar README on upgrading',
  });
}

function gasMonitor(
  config: SidecarConfig,
  client: BalanceReader,
  address: `0x${string}`,
  logger: Logger,
): GasMonitor | undefined {
  if (config.minGasWei === undefined) return undefined;

  return createGasMonitor({
    address,
    read: () => readGasBalance(client, address),
    minimum: config.minGasWei,
    intervalMs: config.gasCheckMs,
    logger,
  });
}

/** Provider names, never provider URLs: the pool redacts those and the log should not undo it. */
function reportRpc(logger: Logger, event: RpcPoolEvent): void {
  switch (event.type) {
    case 'request_failed':
      logger.warn('rpc_request_failed', { provider: event.provider, method: event.method, reason: event.reason });
      return;
    case 'breaker_opened':
      logger.error('rpc_breaker_opened', { provider: event.provider, consecutiveFailures: event.consecutiveFailures });
      return;
    case 'breaker_closed':
      logger.info('rpc_breaker_closed', { provider: event.provider });
      return;
    case 'fallback_used':
      logger.warn('rpc_fallback_used', {
        provider: event.provider,
        method: event.method,
        skipped: event.skipped.join(','),
      });
      return;
    case 'all_providers_down':
      logger.error('rpc_all_providers_down', {
        method: event.method,
        attempts: event.attempts.map((attempt) => `${attempt.provider}: ${attempt.reason}`).join('; '),
      });
      return;
  }
}

const logger = createLogger();

try {
  const { config, payeeKey } = loadConfig(process.env);
  await start(config, payeeKey, logger);
} catch (error) {
  reportStartupFailure(logger, error);
  process.exitCode = 1;
}
