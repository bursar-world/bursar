/**
 *   bursar-relayer run   serve /v1/quote and /v1/relay
 *
 * Environment: RHC_RPC_URL (default the public endpoint); RELAYER_PRIVATE_KEY, or
 * RELAYER_KEYSTORE and RELAYER_PASSWORD_FILE; PORT (default 4321); RELAYER_FEE_BPS (default 50);
 * RELAYER_FEE_RECIPIENT (default the relayer address); RELAYER_GAS_DROP_ETH (default 0.00015);
 * RELAYER_GAS_DROPS_PER_HOUR (default 20); RELAYER_MIN_WITHDRAWAL (atomic USDG, default the pool's
 * minimum deposit from the deployment record).
 */
import process from 'node:process';

import { privacyDeployment, rhcChain, viemChain } from '@bursar/core';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, parseEther } from 'viem';

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
  const relayer = new Relayer(client, wallet, chain, {
    chainId: chain.id,
    relay: deployment.ShieldedRelay,
    pool: deployment.ShieldedPool,
    entrypoint: deployment.Entrypoint,
    registry: deployment.AccessRegistry,
    scope: BigInt(deployment.scope),
    feeRecipient: getAddress(env['RELAYER_FEE_RECIPIENT'] ?? account.address),
    feeBps,
    gasDropWei: parseEther(env['RELAYER_GAS_DROP_ETH'] ?? '0.00015'),
    gasDropsPerHour: Number(env['RELAYER_GAS_DROPS_PER_HOUR'] ?? 20),
    minWithdrawal: BigInt(env['RELAYER_MIN_WITHDRAWAL'] ?? deployment.minimumDeposit),
  });
  const port = Number(env['PORT'] ?? 4321);
  serve(relayer, port, async () => {
    const balance = await client.getBalance({ address: account.address });
    return { ok: balance > parseEther('0.0005'), relayer: account.address, relay: deployment.ShieldedRelay, balanceEth: formatEther(balance) };
  });
  console.log(`relayer ${account.address} serving on :${port}, relay ${deployment.ShieldedRelay}, fee ${feeBps} bps`);
}

const [command] = process.argv.slice(2);
try {
  if (command !== 'run') throw new Error('usage: bursar-relayer run');
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
