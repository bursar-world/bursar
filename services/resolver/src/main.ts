#!/usr/bin/env node
import { BursarError, privacyDeployment } from '@bursar/core';
import type { RpcPoolEvent } from '@bursar/core';
import { isAddressEqual } from 'viem';
import type { Hex } from 'viem';

import { createAlerter } from './alert.js';
import { ResolverStatus, createChain } from './chain.js';
import { createDisclosureSource, viewingKeyring } from './disclosure.js';
import type { LogReader } from './disclosure.js';
import type { ChainPort } from './chain.js';
import { loadConfig } from './config.js';
import type { ResolverConfig } from './config.js';
import { NO_VALIDATORS, createFetcher } from './evidence.js';
import { createHandler, serve } from './http.js';
import { openFileJournal, openPostgresJournal } from './journal.js';
import type { Journal } from './journal.js';
import { loadKeys } from './keys.js';
import type { KeySource, ResolverKey } from './keys.js';
import { createLogger, describeError } from './log.js';
import type { Logger } from './log.js';
import { reportStartupFailure } from './refusal.js';
import { createVoter } from './voter.js';
import { createWatcher } from './watcher.js';

/**
 * Only used on a chain with no DisclosureRegistry on record, where the scan cannot start at the
 * registry's deploy block. Grants can only be written once the lock is disputed, and the snapshot
 * is taken when this service first sees the dispute, so this covers a watcher that came up late.
 */
const DISCLOSURE_LOOKBACK_BLOCKS = 200_000n;

/** Room for one write already on the wire to be confirmed before the process goes. */
const SHUTDOWN_GRACE_MS = 5_000;

async function start(config: ResolverConfig, source: KeySource, viewingKey: Hex | undefined, logger: Logger): Promise<void> {
  const keys = loadKeys(source);
  const alerts = createAlerter({ webhook: config.alertWebhook, logger });
  if (config.alertWebhook === undefined) {
    logger.warn('alerts_log_only', { action: 'BURSAR_ALERT_WEBHOOK is unset, so a CRITICAL page reaches nobody but this log' });
  }

  const { port: chain, client } = createChain({
    chain: config.chain,
    providers: config.providers,
    writeUrls: config.writeUrls,
    confirmTimeoutMs: config.confirmTimeoutMs,
    onRpcEvent: (event) => reportRpc(logger, event),
  });

  await checkPairing(chain, config);
  await reportStanding(chain, config, keys, logger);

  const journal = await openJournal(config, logger);
  const privacy = privacyDeployment(config.chain.chainId);
  const voter = createVoter({
    chain,
    journal,
    alerts,
    logger,
    keys,
    chainId: config.chain.chainId,
    fetcher: createFetcher({ timeoutMs: config.fetchTimeoutMs }),
    validators: NO_VALIDATORS,
    operatorAddresses: config.operatorAddresses,
    disclosures: {
      source: createDisclosureSource(client as unknown as LogReader, privacy?.DisclosureRegistry),
      keyring: await viewingKeyring(keys, viewingKey),
      ...(privacy === undefined ? {} : { fromBlock: BigInt(privacy.fromBlock) }),
      lookback: DISCLOSURE_LOOKBACK_BLOCKS,
    },
  });
  const watcher = createWatcher({
    chain,
    journal,
    voter,
    served: config.served,
    keys,
    logger,
    alerts,
    pollMs: config.pollMs,
    blockRange: config.blockRange,
    startBlock: config.startBlock,
    minGasWei: config.minGasWei,
    heartbeatMs: config.heartbeatMs,
  });

  const server = await serve(
    createHandler({
      chain,
      journal,
      voter,
      served: config.served,
      chainId: config.chain.chainId,
      operatorToken: config.operatorToken,
      operatorAddresses: config.operatorAddresses,
      health: () => watcher.health(),
      pollMs: config.pollMs,
      logger,
    }),
    { host: config.http.host, port: config.http.port, logger },
  );

  const shutdown = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('shutting_down', { signal });
      shutdown.abort();
      setTimeout(() => {
        logger.error('shutdown_timeout', { afterMs: config.confirmTimeoutMs + SHUTDOWN_GRACE_MS });
        process.exit(1);
      }, config.confirmTimeoutMs + SHUTDOWN_GRACE_MS).unref();
    });
  }

  logger.info('started', {
    chainId: config.chain.chainId,
    served: config.served.map((entry) => `${entry.name}:${entry.registry}`).join(','),
    keys: keys.map((key) => `${key.name}:${key.address}`).join(','),
    journal: journal.describe,
    http: `${config.http.host}:${server.port}`,
    overrides: config.operatorToken !== null && config.operatorAddresses !== null,
    pollMs: config.pollMs,
  });

  try {
    await watcher.run(shutdown.signal);
  } finally {
    await server.close();
    await journal.close();
  }
  logger.info('stopped', {});
}

/**
 * The escrow names the registry that rules on it, and a record that disagrees is stale. Voting on
 * a registry the escrow does not call is voting on nothing, so the service refuses to start.
 */
async function checkPairing(chain: ChainPort, config: ResolverConfig): Promise<void> {
  for (const entry of config.served) {
    const wired = await chain.escrowResolver(entry.escrow);
    if (!isAddressEqual(wired, entry.registry)) {
      throw new BursarError(
        'resolver_pairing',
        `Escrow ${entry.escrow} rules through ${wired}, and the ${entry.name} record names ${entry.registry}. Fix the record before this service votes.`,
        { escrow: entry.escrow, wired, recorded: entry.registry },
      );
    }
  }
}

/** Said at startup, because a key that cannot vote is found out here or on the dispute that needed it. */
async function reportStanding(chain: ChainPort, config: ResolverConfig, keys: readonly ResolverKey[], logger: Logger): Promise<void> {
  for (const entry of config.served) {
    for (const key of keys) {
      const standing = await chain.resolver(entry.registry, key.address);
      const bondable = standing.status === ResolverStatus.Active && (await chain.bondable(entry.registry, key.address, standing.bond));
      (bondable ? logger.info : logger.warn)('key_standing', {
        registry: entry.registry,
        key: key.name,
        address: key.address,
        status: standing.status,
        bondable,
        slashes: standing.slashes,
      });
    }
  }
}

async function openJournal(config: ResolverConfig, logger: Logger): Promise<Journal> {
  if (config.journal.kind === 'file') return openFileJournal(config.journal.path);

  const url = new URL(config.journal.url);
  return openPostgresJournal(config.journal.url, `${url.host}${url.pathname}`, (error) =>
    logger.error('journal_connection_error', { reason: describeError(error) }),
  );
}

/** Provider names only. The pool redacts URLs, and a keyed URL in a log is a leaked key. */
function reportRpc(logger: Logger, event: RpcPoolEvent): void {
  switch (event.type) {
    case 'breaker_opened':
      logger.error('rpc_breaker_opened', { provider: event.provider, consecutiveFailures: event.consecutiveFailures });
      return;
    case 'breaker_closed':
      logger.info('rpc_breaker_closed', { provider: event.provider });
      return;
    case 'fallback_used':
      logger.warn('rpc_fallback_used', { provider: event.provider, method: event.method });
      return;
    case 'all_providers_down':
      logger.error('rpc_all_providers_down', { method: event.method });
      return;
    default:
      return;
  }
}

const logger = createLogger();

try {
  const { config, keys, viewingKey } = loadConfig(process.env);
  await start(config, keys, viewingKey, logger);
} catch (error) {
  reportStartupFailure(logger, error);
  process.exitCode = 1;
}
