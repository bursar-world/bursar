/**
 *   bursar-relayer run   serve /v1/quote and /v1/relay
 *
 * Environment: RHC_RPC_URL (default the public endpoint); RELAYER_PRIVATE_KEY, or
 * RELAYER_KEYSTORE and RELAYER_PASSWORD_FILE; PORT (default 4321); RELAYER_HOST (default every
 * interface); RELAYER_ALLOWED_ORIGINS (default https://app.bursar.world); RELAYER_FEE_BPS
 * (default 50); RELAYER_FEE_RECIPIENT (default the relayer address); RELAYER_GAS_DROP_ETH (default
 * 0.00015); RELAYER_GAS_DROPS_PER_DAY (default 50); RELAYER_DATA_DIR to keep the gas-drop ledger
 * across restarts; RELAYER_MIN_WITHDRAWAL (atomic USDG, default the pool's minimum deposit from the
 * deployment record).
 */
import { join } from 'node:path';
import process from 'node:process';

import { privacyDeployment, rhcChain, viemChain } from '@bursar/core';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, parseEther } from 'viem';

import { originPolicy } from './cors.js';
import { GasDropLedger } from './drops.js';
import { serve } from './http.js';
import { Relayer } from './relay.js';
import { signerFromEnv } from './signer.js';

const chain = viemChain(rhcChain('mainnet'));
const rpc = process.env['RHC_RPC_URL'] ?? chain.rpcUrls.default.http[0];
const client = createPublicClient({ chain, transport: http(rpc) });

function run() {
  const deployment = privacyDeployment(chain.id)?.shielded;
  if (!deployment) throw new Error(`No shielded pool is recorded for chain ${chain.id}.`);
  const account = signerFromEnv('RELAYER');
  if (!account) throw new Error('Set RELAYER_PRIVATE_KEY, or RELAYER_KEYSTORE and RELAYER_PASSWORD_FILE.');
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const env = process.env;
  const feeBps = Number(env['RELAYER_FEE_BPS'] ?? 50);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > deployment.maxRelayFeeBps) {
    throw new Error(`RELAYER_FEE_BPS must be an integer from 0 to ${deployment.maxRelayFeeBps}.`);
  }
  if (env['RELAYER_GAS_DROPS_PER_HOUR'] !== undefined) {
    throw new Error('RELAYER_GAS_DROPS_PER_HOUR is no longer read. Gas drops are counted per day: set RELAYER_GAS_DROPS_PER_DAY.');
  }
  const gasDropsPerDay = Number(env['RELAYER_GAS_DROPS_PER_DAY'] ?? 50);
  if (!Number.isInteger(gasDropsPerDay) || gasDropsPerDay < 0) throw new Error('RELAYER_GAS_DROPS_PER_DAY must be a whole number.');
  const host = env['RELAYER_HOST'];
  const origins = originPolicy('RELAYER_ALLOWED_ORIGINS', env['RELAYER_ALLOWED_ORIGINS'], host);
  const dataDir = env['RELAYER_DATA_DIR'];
  const drops = new GasDropLedger(dataDir ? join(dataDir, 'gas-drops.jsonl') : null);
  const log = (line: string) => console.error(line);
  const relayer = new Relayer(
    client,
    wallet,
    chain,
    {
      chainId: chain.id,
      relay: deployment.ShieldedRelay,
      pool: deployment.ShieldedPool,
      entrypoint: deployment.Entrypoint,
      registry: deployment.AccessRegistry,
      scope: BigInt(deployment.scope),
      feeRecipient: getAddress(env['RELAYER_FEE_RECIPIENT'] ?? account.address),
      feeBps,
      gasDropWei: parseEther(env['RELAYER_GAS_DROP_ETH'] ?? '0.00015'),
      gasDropsPerDay,
      minWithdrawal: BigInt(env['RELAYER_MIN_WITHDRAWAL'] ?? deployment.minimumDeposit),
    },
    drops,
    log,
  );
  const port = Number(env['PORT'] ?? 4321);
  serve(relayer, {
    port,
    host,
    origins,
    log,
    health: async () => {
      const balance = await client.getBalance({ address: account.address });
      return { ok: balance > parseEther('0.0005'), relayer: account.address, relay: deployment.ShieldedRelay, balanceEth: formatEther(balance) };
    },
  });
  console.log(
    `relayer ${account.address} serving on ${host ?? '*'}:${port}, relay ${deployment.ShieldedRelay}, fee ${feeBps} bps, ` +
      `${gasDropsPerDay} gas drops a day${dataDir ? ` recorded under ${dataDir}` : ' kept in memory'}`,
  );
}

const [command] = process.argv.slice(2);
try {
  if (command !== 'run') throw new Error('usage: bursar-relayer run');
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
