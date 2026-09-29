/**
 *   bursar-solvency post [--dry-run]   snapshot at the confirmed head and post today's epoch
 *   bursar-solvency run                 post now, then once a day at 00:10 UTC
 *   bursar-solvency verify [epoch]      recompute a posted epoch from chain data and compare
 *
 * Environment: RHC_RPC_URL (default the public endpoint), SOLVENCY_LOG (default the deployment
 * record), SOLVENCY_KEYSTORE and SOLVENCY_PASSWORD_FILE for the poster key. Only `post` and `run`
 * need the key.
 */
import process from 'node:process';

import { privacyDeployment, rhcChain, viemChain } from '@bursar/core';
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { EPOCH_SECONDS } from './epoch.js';
import { openKeystore } from './keystore.js';
import { postEpoch } from './post.js';
import { formatVerdict, verifyEpoch } from './verify.js';

const chain = viemChain(rhcChain('mainnet'));
const rpc = process.env['RHC_RPC_URL'] ?? chain.rpcUrls.default.http[0];
const client = createPublicClient({ chain, transport: http(rpc) });

function logAddress(): Address {
  const address = (process.env['SOLVENCY_LOG'] as Address | undefined) ?? privacyDeployment(chain.id)?.SolvencyLog;
  if (!address) throw new Error('No SolvencyLog: set SOLVENCY_LOG or record one in the deployment.');
  return address;
}

function poster() {
  const keystore = process.env['SOLVENCY_KEYSTORE'];
  const passwordFile = process.env['SOLVENCY_PASSWORD_FILE'];
  if (!keystore || !passwordFile) throw new Error('Set SOLVENCY_KEYSTORE and SOLVENCY_PASSWORD_FILE to post.');
  const account = privateKeyToAccount(openKeystore(keystore, passwordFile));
  return { account, wallet: createWalletClient({ account, chain, transport: http(rpc) }) };
}

const usdg = (micros: bigint) => (Number(micros) / 1e6).toFixed(6);

async function post(dryRun: boolean) {
  const signer = dryRun ? {} : poster();
  const result = await postEpoch({ client, log: dryRun ? ('0x' as Address) : logAddress(), chain, ...signer });
  console.log(`epoch ${result.epoch} at block ${result.asOfBlock}`);
  console.log(`root ${result.root}`);
  console.log(`liabilities ${usdg(result.liabilities)} USDG, assets ${usdg(result.assets)} USDG`);
  for (const leaf of result.leaves) console.log(`  ${leaf.id}: owed ${usdg(leaf.liabilities)}, held ${usdg(leaf.assets)}`);
  if (dryRun) console.log('dry run: nothing sent');
  else if (result.skipped) console.log(`skipped: ${result.skipped}`);
  else console.log(`posted ${result.hash}`);
}

function msUntilNextRun(now = Date.now()): number {
  const day = EPOCH_SECONDS * 1000;
  return Math.floor(now / day) * day + day + 10 * 60 * 1000 - now;
}

async function run() {
  for (;;) {
    try {
      await post(false);
    } catch (error) {
      console.error(`post failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, msUntilNextRun()));
  }
}

async function verify(epoch?: string) {
  const verdict = await verifyEpoch(client, logAddress(), epoch === undefined ? undefined : BigInt(epoch));
  console.log(formatVerdict(verdict));
  if (!verdict.match) process.exitCode = 1;
}

const [command, ...rest] = process.argv.slice(2);
const main =
  command === 'post'
    ? post(rest.includes('--dry-run'))
    : command === 'run'
      ? run()
      : command === 'verify'
        ? verify(rest[0])
        : Promise.reject(new Error('usage: bursar-solvency post [--dry-run] | run | verify [epoch]'));

main.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
