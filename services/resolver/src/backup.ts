#!/usr/bin/env node
/**
 * The backup runner: reveals from the keystores alone.
 *
 *   bursar-resolver-backup status <disputeId>
 *   bursar-resolver-backup reveal-now <disputeId>
 *   bursar-resolver-backup reveal-due
 *
 * It holds no journal and needs none. The salt is re-derived from each key and the score is found
 * by trying every score against the commitment on chain, so a machine that has only the encrypted
 * keystores and a password can open every vote the service sealed. Running it beside a live
 * service is safe: a reveal already made is refused in simulation and nothing is sent.
 */
import { BursarError } from '@bursar/core';

import { DisputeStatus, createChain } from './chain.js';
import type { ChainPort, Pricing } from './chain.js';
import { loadConfig } from './config.js';
import type { Served } from './config.js';
import { loadKeys } from './keys.js';
import type { ResolverKey } from './keys.js';
import { createLogger, describeError } from './log.js';
import { reportStartupFailure } from './refusal.js';
import { recoverScore, saltFor } from './salt.js';
import { timeline } from './schedule.js';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

type Context = { readonly chain: ChainPort; readonly keys: readonly ResolverKey[]; readonly chainId: number; readonly served: readonly Served[] };

async function status(context: Context, entry: Served, disputeId: bigint): Promise<void> {
  const dispute = await context.chain.dispute(entry.registry, disputeId);
  const tl = timeline(dispute);
  out(`dispute ${disputeId} on ${entry.registry}: status ${dispute.status}, ${dispute.commitCount} committed, ${dispute.revealCount} revealed`);
  out(`  commit closes ${iso(tl.commitEndsAt)}, reveal closes ${iso(tl.revealEndsAt)}`);

  for (const key of context.keys) {
    const commitment = await context.chain.committedBy(entry.registry, disputeId, key.address);
    if (/^0x0*$/.test(commitment)) {
      out(`  ${key.name} ${key.address}: no commitment`);
      continue;
    }
    const { revealed, score } = await context.chain.revealedBy(entry.registry, disputeId, key.address);
    const salt = await saltFor(key.account, context.chainId, entry.registry, disputeId);
    const sealed = recoverScore({ commitment, disputeId, resolver: key.address, salt });
    out(`  ${key.name} ${key.address}: ${revealed ? `revealed ${score}` : `sealed, opens at ${sealed ?? 'no score (not this derivation)'}`}`);
  }
}

async function revealNow(context: Context, entry: Served, disputeId: bigint): Promise<number> {
  const head = await context.chain.head();
  const dispute = await context.chain.dispute(entry.registry, disputeId);
  if (head.timestamp < dispute.commitEndsAt) {
    out(`dispute ${disputeId}: the reveal window opens at ${iso(dispute.commitEndsAt)}; nothing to do yet`);
    return 0;
  }
  if (head.timestamp >= dispute.revealEndsAt) {
    out(`dispute ${disputeId}: the reveal window closed at ${iso(dispute.revealEndsAt)}`);
    return 0;
  }

  // Past the last-chance mark the price is what gets it in, not what it costs.
  const pricing: Pricing = { feeBps: head.timestamp >= timeline(dispute).lastChance ? 30_000 : 12_500 };
  let failures = 0;

  for (const key of context.keys) {
    const commitment = await context.chain.committedBy(entry.registry, disputeId, key.address);
    if (/^0x0*$/.test(commitment)) continue;
    if ((await context.chain.revealedBy(entry.registry, disputeId, key.address)).revealed) {
      out(`dispute ${disputeId}: ${key.name} already revealed`);
      continue;
    }

    const salt = await saltFor(key.account, context.chainId, entry.registry, disputeId);
    const score = recoverScore({ commitment, disputeId, resolver: key.address, salt });
    if (score === null) {
      out(`dispute ${disputeId}: ${key.name}'s commitment does not open with its derived salt; not revealing`);
      failures += 1;
      continue;
    }

    try {
      const tx = await context.chain.reveal(key, entry.registry, disputeId, score, salt, pricing);
      out(`dispute ${disputeId}: ${key.name} revealed ${score} in ${tx.hash} (${tx.status})`);
      if (tx.status !== 'success') failures += 1;
    } catch (error) {
      out(`dispute ${disputeId}: ${key.name} reveal failed: ${describeError(error)}`);
      failures += 1;
    }
  }

  return failures;
}

async function revealDue(context: Context): Promise<number> {
  const head = await context.chain.head();
  let failures = 0;

  for (const entry of context.served) {
    const next = await context.chain.nextDisputeId(entry.registry);
    for (let disputeId = 1n; disputeId < next; disputeId += 1n) {
      const dispute = await context.chain.dispute(entry.registry, disputeId);
      const voting = dispute.status === DisputeStatus.Committing || dispute.status === DisputeStatus.Revealing;
      if (!voting || head.timestamp < dispute.commitEndsAt || head.timestamp >= dispute.revealEndsAt) continue;
      failures += await revealNow(context, entry, disputeId);
    }
  }

  out(failures === 0 ? 'reveal-due: nothing owed' : `reveal-due: ${failures} reveals still owed`);
  return failures;
}

function iso(seconds: bigint): string {
  return new Date(Number(seconds) * 1_000).toISOString();
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, rawId] = argv;
  const { config, keys: source } = loadConfig(process.env);
  if (source.kind !== 'keystore') {
    throw new BursarError('backup_keystore_only', 'The backup runner opens keystores only. Set RESOLVER_KEYSTORE_DIR, not RESOLVER_KEYS.');
  }

  const { port: chain } = createChain({
    chain: config.chain,
    providers: config.providers,
    writeUrls: config.writeUrls,
    confirmTimeoutMs: config.confirmTimeoutMs,
  });
  const context: Context = { chain, keys: loadKeys(source), chainId: config.chain.chainId, served: config.served };
  const entry = config.served[0];
  if (entry === undefined) throw new BursarError('backup_no_registry', 'No deployment is configured.');

  const disputeId = (): bigint => {
    if (rawId === undefined || !/^\d+$/.test(rawId)) throw new BursarError('backup_usage', `${command ?? 'this command'} takes a dispute id.`);
    return BigInt(rawId);
  };

  switch (command) {
    case 'status':
      await status(context, entry, disputeId());
      return 0;
    case 'reveal-now':
      return (await revealNow(context, entry, disputeId())) === 0 ? 0 : 1;
    case 'reveal-due':
      return (await revealDue(context)) === 0 ? 0 : 1;
    default:
      out('usage: bursar-resolver-backup status <disputeId> | reveal-now <disputeId> | reveal-due');
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  reportStartupFailure(createLogger(), error);
  process.exitCode = 1;
}
