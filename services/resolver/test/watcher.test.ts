import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { DisputeStatus } from '../src/chain.js';
import { NO_VALIDATORS } from '../src/evidence.js';
import { openMemoryJournal } from '../src/journal.js';
import { createVoter } from '../src/voter.js';
import { createWatcher } from '../src/watcher.js';
import { FakeChain, HOUR, REGISTRY, SERVED, tableFetcher } from './support/fake-chain.js';
import { captureAlerts, silentLogger, testKeys } from './support/keys.js';

const payee = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const PAYER = '0x877c349EFb5926082C413833E8055F0991185c61' as const;

async function setup(options: { minGasWei?: bigint } = {}) {
  const chain = new FakeChain();
  const keys = testKeys(3);
  for (const key of keys) chain.bond(key.address);
  const journal = await openMemoryJournal();
  const alerts = captureAlerts();
  const logger = silentLogger();
  const voter = createVoter({ chain, journal, alerts, logger, keys, chainId: 4663, fetcher: tableFetcher({}), validators: NO_VALIDATORS, operatorAddresses: [] });
  let clock = 0;
  const watcher = createWatcher({
    chain,
    journal,
    voter,
    served: [SERVED],
    keys,
    logger,
    alerts,
    pollMs: 30_000,
    blockRange: 5_000n,
    minGasWei: options.minGasWei ?? 1n,
    heartbeatMs: 86_400_000,
    now: () => clock,
  });
  return { chain, journal, alerts, watcher, tick: (ms: number) => (clock += ms) };
}

describe('watcher', () => {
  it('carries a dispute it finds by log through to finalized', async () => {
    const { chain, watcher } = await setup();
    await watcher.poll();
    const { disputeId } = chain.openDispute({ payer: PAYER, payee: payee.address });

    const until = chain.time + 13n * HOUR;
    while (chain.time < until) {
      chain.advance(10n * 60n);
      await watcher.poll();
    }
    expect(chain.disputes.get(disputeId)?.status).toBe(DisputeStatus.Finalized);
    expect(watcher.health().open).toBe(0);
  });

  it('finds a dispute whose log it never saw, through the reconcile pass', async () => {
    const { chain, watcher, journal } = await setup();
    const { disputeId } = chain.openDispute({ payer: PAYER, payee: payee.address });
    chain.logs.length = 0;
    await journal.setCursor(REGISTRY, chain.block + 1n);

    await watcher.poll();
    expect(watcher.health().open).toBe(1);
    expect(watcher.health().served[0]).toMatchObject({ registry: REGISTRY, open: 1 });
    expect(watcher.health().served[0]?.lastScannedBlock).not.toBeNull();
    expect(await journal.get(REGISTRY, disputeId)).toBeDefined();
  });

  it('moves the log cursor forward and keeps it in the journal', async () => {
    const { chain, watcher, journal } = await setup();
    await watcher.poll();
    chain.advance(HOUR);
    await watcher.poll();
    expect(await journal.cursor(REGISTRY)).toBe(chain.block - 5n + 1n);
  });

  it('sends a heartbeat at start and a warning for a key under the gas floor', async () => {
    const { watcher, alerts } = await setup({ minGasWei: 10n ** 18n });
    await watcher.poll();
    const events = alerts.sent.map((alert) => `${alert.level}:${alert.event}`);
    expect(events.filter((event) => event === 'WARN:key_check')).toHaveLength(3);
    expect(events).toContain('INFO:heartbeat');
  });

  it('does not send a second heartbeat inside the day', async () => {
    const { watcher, alerts, tick } = await setup();
    await watcher.poll();
    tick(3_600_000);
    await watcher.poll();
    expect(alerts.sent.filter((alert) => alert.event === 'heartbeat')).toHaveLength(1);
  });
});
