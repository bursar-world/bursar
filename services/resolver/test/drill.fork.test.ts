/**
 * The M0 drill, against a fork of Robinhood Chain mainnet.
 *
 *   BURSAR_RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com pnpm --filter @bursar/resolver drill
 *
 * Skipped unless that variable names a 4663 endpoint. The fork is taken at the latest block, so a
 * full node serves it; an archive node is not needed.
 *
 * The live escrow, registry and staking pool are used as they stand. Three drill keys bond BRSR
 * into the live registry on the fork, because the salt is a signature and an impersonated address
 * cannot sign. One live bonded resolver is impersonated as the third party that commits and never
 * reveals. Every case walks the real service: the chain layer, the watcher, the voter and the HTTP
 * routes, with only the clock moved by hand.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentRegistryAbi,
  canonicalStringify,
  commitCanonical,
  deployment,
  escrowAbi,
  oracleRegistryAbi,
  rhcChain,
  settlementAssetAbi,
  toDataUri,
  viemChain,
} from '@bursar/core';
import { encodeEvidence, signDeliveryEvidence } from '@bursar/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, getAddress, http, maxUint256 } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';

import { createChain } from '../src/chain.js';
import type { Served } from '../src/config.js';
import { NO_VALIDATORS, createFetcher } from '../src/evidence.js';
import { createHandler, serve } from '../src/http.js';
import type { RunningServer } from '../src/http.js';
import { openFileJournal, openMemoryJournal } from '../src/journal.js';
import type { Journal } from '../src/journal.js';
import { createVoter } from '../src/voter.js';
import { createWatcher } from '../src/watcher.js';
import type { Watcher } from '../src/watcher.js';
import { balanceSlot, setTokenBalance, startFork } from './support/anvil.js';
import type { Anvil } from './support/anvil.js';
import { captureAlerts, silentLogger, testKeys } from './support/keys.js';

const FORK = process.env['BURSAR_RHC_FORK_RPC'];

const HOUR = 3_600n;
const MINUTE = 60n;
const LOCK_AMOUNT = 100_000n;
const BOND = 25_000n * 10n ** 18n;
/** A port nothing listens on, standing in for a primary RPC that has gone down. */
const DEAD_RPC = 'http://127.0.0.1:9';
/** A live bonded resolver on 4663, impersonated as the third party. */
const THIRD_PARTY: Address = '0x7062A480732EC7B0F00a3D0c968356e1671dd356';

// The v1 set: the drill was written against its refund-on-failure rules.
const record = deployment('rhc-mainnet');
const ESCROW = getAddress(record.contracts.Escrow);
const REGISTRY = getAddress(record.contracts.OracleRegistry);
const AGENTS = getAddress(record.contracts.AgentRegistry);
const USDG = getAddress(record.settlementAsset);
const SERVED: Served = { name: 'rhc-mainnet', escrow: ESCROW, registry: REGISTRY, contractSet: 'v1' };

const chain = rhcChain('mainnet');
const keys = testKeys(3);
const payee = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const payer = privateKeyToAccount(`0x${'b2'.repeat(32)}`);

const JOB = { task: 'Summarise the attached ledger', input: { rows: 12 } };
const OUTPUT = { summary: 'Twelve rows, all reconciled.' };

type Service = { watcher: Watcher; server: RunningServer; journal: Journal; alerts: ReturnType<typeof captureAlerts> };

describe.skipIf(FORK === undefined)('fork drill', () => {
  let anvil: Anvil;
  let client: PublicClient;
  let forkBlock: bigint;
  const running: Service[] = [];

  const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain: viemChain(chain), transport: http(anvil.url) });

  async function send(account: PrivateKeyAccount, request: Parameters<ReturnType<typeof wallet>['writeContract']>[0]): Promise<void> {
    const hash = await wallet(account).writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${request.functionName} reverted`);
  }

  async function now(): Promise<bigint> {
    return (await client.getBlock({ blockTag: 'latest' })).timestamp;
  }

  async function service(options: { providers: readonly string[]; journal: Journal }): Promise<Service> {
    const logger = silentLogger();
    const alerts = captureAlerts();
    const { port } = createChain({
      chain,
      providers: options.providers.map((url, index) => ({ name: index === 0 ? 'primary' : `fallback-${index}`, url })),
      writeUrls: options.providers,
      confirmTimeoutMs: 20_000,
      // One anvil under two names is one host. It is a fork, and this is where that is said.
      requireRedundancy: false,
      receiptPollMs: 100,
    });
    const voter = createVoter({
      chain: port,
      journal: options.journal,
      alerts,
      logger,
      keys,
      chainId: chain.chainId,
      fetcher: createFetcher({ timeoutMs: 5_000 }),
      validators: NO_VALIDATORS,
      operatorAddresses: [],
    });
    const watcher = createWatcher({
      chain: port,
      journal: options.journal,
      voter,
      served: [SERVED],
      keys,
      logger,
      alerts,
      pollMs: 30_000,
      blockRange: 5_000n,
      startBlock: forkBlock,
      minGasWei: 1n,
      heartbeatMs: 86_400_000,
    });
    const server = await serve(
      createHandler({
        chain: port,
        journal: options.journal,
        voter,
        served: [SERVED],
        chainId: chain.chainId,
        operatorToken: null,
        operatorAddresses: [],
        health: () => watcher.health(),
        pollMs: 30_000,
        logger,
      }),
      { host: '127.0.0.1', port: 0, logger },
    );
    const started = { watcher, server, journal: options.journal, alerts };
    running.push(started);
    return started;
  }

  async function openCase(): Promise<{ escrowId: bigint; disputeId: bigint }> {
    const escrowId = await client.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'nextId' });
    await send(payer, {
      address: ESCROW,
      abi: escrowAbi,
      functionName: 'lock',
      args: [payee.address, `0x${'0d'.repeat(32)}`, commitCanonical(JOB), toDataUri(canonicalStringify(JOB)), LOCK_AMOUNT, (await now()) + 3n * HOUR],
    });
    await send(payer, { address: ESCROW, abi: escrowAbi, functionName: 'dispute', args: [escrowId] });
    const disputeId = await client.readContract({ address: REGISTRY, abi: oracleRegistryAbi, functionName: 'disputeIdOf', args: [escrowId] });
    return { escrowId, disputeId };
  }

  async function deliver(target: Service, escrowId: bigint, outputCommit: Hex): Promise<Response> {
    const submission = await signDeliveryEvidence(payee, ESCROW, chain.chainId, {
      escrowId,
      inputCommit: commitCanonical(JOB),
      outputCommit,
      outputURI: toDataUri(canonicalStringify(OUTPUT)),
      deliveredAt: await now(),
    });
    return fetch(`http://127.0.0.1:${target.server.port}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(encodeEvidence(submission)),
    });
  }

  async function at(target: Service, timestamp: bigint): Promise<void> {
    await anvil.warpTo(timestamp);
    // Twice: a commit or a reveal lands in the first pass, and what it enables in the second.
    await target.watcher.poll();
    await target.watcher.poll();
  }

  const dispute = (id: bigint) => client.readContract({ address: REGISTRY, abi: oracleRegistryAbi, functionName: 'getDispute', args: [id] });
  const lock = (id: bigint) => client.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'getLock', args: [id] });
  const usdg = (who: Address) => client.readContract({ address: USDG, abi: settlementAssetAbi, functionName: 'balanceOf', args: [who] });
  const ruling = async (target: Service, id: bigint) =>
    (await fetch(`http://127.0.0.1:${target.server.port}/rulings/${id}`)).json() as Promise<Record<string, unknown>>;

  beforeAll(async () => {
    anvil = await startFork(FORK ?? '');
    client = createPublicClient({ chain: viemChain(chain), transport: http(anvil.url) });
    forkBlock = await client.getBlockNumber();

    for (const address of [...keys.map((key) => key.address), payee.address, payer.address, THIRD_PARTY]) {
      await anvil.rpc('anvil_setBalance', [address, '0xde0b6b3a7640000']);
    }

    const brsr = await client.readContract({ address: REGISTRY, abi: oracleRegistryAbi, functionName: 'bondAsset' });
    const brsrSlot = await balanceSlot(anvil, brsr, REGISTRY);
    for (const key of keys) {
      await setTokenBalance(anvil, brsr, brsrSlot, key.address, BOND);
      await send(key.account, { address: brsr, abi: settlementAssetAbi, functionName: 'approve', args: [REGISTRY, BOND] });
      await send(key.account, { address: REGISTRY, abi: oracleRegistryAbi, functionName: 'register', args: [BOND] });
    }

    const usdgSlot = await balanceSlot(anvil, USDG, ESCROW);
    await setTokenBalance(anvil, USDG, usdgSlot, payee.address, 10_000_000n);
    await setTokenBalance(anvil, USDG, usdgSlot, payer.address, 10_000_000n);
    await send(payee, { address: USDG, abi: settlementAssetAbi, functionName: 'approve', args: [AGENTS, 5_000_000n] });
    await send(payee, { address: AGENTS, abi: agentRegistryAbi, functionName: 'register', args: ['drill_payee', 5_000_000n] });
    await send(payer, { address: USDG, abi: settlementAssetAbi, functionName: 'approve', args: [ESCROW, maxUint256] });
  }, 300_000);

  afterAll(async () => {
    for (const started of running) await started.server.close();
    await anvil?.stop();
  });

  it(
    'rules no evidence, valid evidence and invalid evidence, with the primary RPC dead, and waits out a silent third party',
    async () => {
      const service1 = await service({ providers: [DEAD_RPC, anvil.url], journal: await openMemoryJournal() });

      const none = await openCase();
      const valid = await openCase();
      const invalid = await openCase();
      const silent = await openCase();
      const opened = (await dispute(none.disputeId)).openedAt;

      // The third party seals a score and will never open it.
      await anvil.rpc('anvil_impersonateAccount', [THIRD_PARTY]);
      await createWalletClient({ account: THIRD_PARTY, chain: viemChain(chain), transport: http(anvil.url) }).writeContract({
        address: REGISTRY,
        abi: oracleRegistryAbi,
        functionName: 'commitVote',
        args: [silent.disputeId, `0x${'5e'.repeat(32)}`],
      });

      await at(service1, opened + MINUTE);
      expect((await deliver(service1, valid.escrowId, commitCanonical(OUTPUT))).status).toBe(202);
      expect((await deliver(service1, invalid.escrowId, commitCanonical({ summary: 'something else' }))).status).toBe(202);

      await at(service1, opened + 3n * HOUR + MINUTE);
      await at(service1, opened + 3n * HOUR + 31n * MINUTE);
      for (const { disputeId } of [none, valid, invalid, silent]) {
        expect((await dispute(disputeId)).commitCount).toBeGreaterThanOrEqual(2);
      }

      // Acceptance 4: at T+6h nobody can refund the payer through failDispute.
      await anvil.warpTo(opened + 6n * HOUR);
      await expect(
        client.simulateContract({ account: payer.address, address: REGISTRY, abi: oracleRegistryAbi, functionName: 'failDispute', args: [none.disputeId] }),
      ).rejects.toThrow(/RevealWindowOpen/);

      const payeeBefore = await usdg(payee.address);
      const payerBefore = await usdg(payer.address);

      await at(service1, opened + 6n * HOUR + MINUTE);

      expect(await dispute(none.disputeId)).toMatchObject({ status: 3, medianScore: 0, refundBps: 10_000 });
      expect(await dispute(valid.disputeId)).toMatchObject({ status: 3, medianScore: 90, refundBps: 0 });
      expect(await dispute(invalid.disputeId)).toMatchObject({ status: 3, medianScore: 0, refundBps: 10_000 });
      for (const { escrowId } of [none, valid, invalid]) expect((await lock(escrowId)).status).toBe(6);

      // 0.10 locked: 0.0005 resolver fee, 0.0995 to split. Score 90 pays it all to the payee less
      // the 1% protocol fee, 0.098505. Score 0 refunds 0.0995 to the payer and returns the bond.
      expect((await usdg(payee.address)) - payeeBefore).toBe(98_505n);
      expect((await usdg(payer.address)) - payerBefore).toBe(2n * (99_500n + 5_000n));

      expect(await ruling(service1, none.disputeId)).toMatchObject({ status: 'published', rule: 'P2', score: 0 });
      expect(await ruling(service1, valid.disputeId)).toMatchObject({ status: 'published', rule: 'P5', score: 90 });
      expect(await ruling(service1, invalid.disputeId)).toMatchObject({ status: 'published', rule: 'P3', score: 0 });

      // The third party's silence holds the vote open until the reveal window shuts.
      expect((await dispute(silent.disputeId)).status).toBe(2);
      await at(service1, opened + 12n * HOUR + MINUTE);
      expect(await dispute(silent.disputeId)).toMatchObject({ status: 3, medianScore: 0, revealCount: 2, commitCount: 3 });

      for (const key of keys) {
        const standing = await client.readContract({ address: REGISTRY, abi: oracleRegistryAbi, functionName: 'getResolver', args: [key.address] });
        expect(standing.slashes).toBe(0);
      }
      expect(service1.alerts.sent.filter((alert) => alert.level === 'CRITICAL')).toEqual([]);
    },
    600_000,
  );

  it(
    'reveals and finalizes after the service restarts with an empty journal',
    async () => {
      const journalPath = join(mkdtempSync(join(tmpdir(), 'resolver-drill-')), 'journal.json');
      const before = await service({ providers: [anvil.url, anvil.url.replace('127.0.0.1', 'localhost')], journal: await openFileJournal(journalPath) });

      const job = await openCase();
      const opened = (await dispute(job.disputeId)).openedAt;
      await at(before, opened + MINUTE);
      expect((await deliver(before, job.escrowId, commitCanonical(OUTPUT))).status).toBe(202);
      await at(before, opened + 3n * HOUR + 31n * MINUTE);
      expect((await dispute(job.disputeId)).commitCount).toBe(2);
      expect(await ruling(before, job.disputeId)).toMatchObject({ status: 'sealed' });

      // Killed after the commits. The next process has the keystores and nothing else.
      await before.server.close();
      running.splice(running.indexOf(before), 1);
      const after = await service({ providers: [anvil.url], journal: await openMemoryJournal() });

      await at(after, opened + 6n * HOUR + MINUTE);
      expect(await dispute(job.disputeId)).toMatchObject({ status: 3, medianScore: 90, revealCount: 2 });
      expect((await lock(job.escrowId)).status).toBe(6);
      const published = await ruling(after, job.disputeId);
      expect(published).toMatchObject({ status: 'published', score: 90 });
      expect(String(published['note'])).toMatch(/recovered from the chain/);
    },
    600_000,
  );
});
