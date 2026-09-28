#!/usr/bin/env node
import { isBursarError } from '@bursar/core';

import { loadUnderwriterConfig } from './config.js';
import { createUnderwriterService } from './service.js';

/*
 * Configuration is read and checked first, before anything binds a port: a listener that came up
 * on the wrong address has already been reachable by the time a later line of config fails. The
 * journals are claimed next, in `start`, so a second process pointed at an account another one is
 * already underwriting dies at startup, before it can reserve against the same lifetime ceiling.
 *
 * Listens on 8403 by default, one above the facilitator, so the pair runs on one host without an
 * argument. `GET /healthz` says the process is serving; `GET /readyz` says it can decide.
 */

/**
 * How long releasing the journals may take before the process gives up and exits anyway. A
 * database that stopped answering would otherwise hold the shutdown open until the supervisor
 * kills it, and a supervisor's kill does not say why.
 */
const STOP_TIMEOUT_MS = 15_000;

const log = (line: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
};

async function run(): Promise<void> {
  const service = createUnderwriterService({ config: loadUnderwriterConfig(), log });
  await service.start();

  const shutdown = (signal: string): void => {
    log(`${signal} received, releasing journals`);
    setTimeout(() => {
      log(`shutdown did not finish within ${STOP_TIMEOUT_MS} ms; exiting with the journals unreleased`);
      process.exit(1);
    }, STOP_TIMEOUT_MS).unref();
    void service
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

run().catch((error: unknown) => {
  if (isBursarError(error)) {
    log(`startup refused [${error.code}] ${error.message}`);
  } else {
    log(`startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  process.exit(1);
});
