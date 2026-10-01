#!/usr/bin/env node
import { RHC_MAINNET, collateralDeployment } from '@bursar/core';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createKeeperChain, runKeeper } from './keeper.js';

/**
 * One keeper pass over the collateral lane, printed as JSON on stdout.
 *
 *   RHC_RPC_URL                   endpoint (defaults to the public mainnet one)
 *   BURSAR_KEEPER_EXECUTE=1       send readings, liquidations and sweeps; anything else is a dry run
 *   BURSAR_KEEPER_KEY             hex private key that pays gas and takes the bounty; needed to send
 *   BURSAR_KEEPER_SWEEP_MIN_MICRO smallest spread worth sweeping (default 100000, 0.10 USDG)
 *
 * Run it from a scheduler; each pass stands alone. From v4 the pass also keeps the price guard's
 * readings of each collateral pool current, and a draw counts a position only against a reading at
 * least `MIN_OBSERVATION_AGE` and at most `MAX_OBSERVATION_AGE` old (300 s and 3600 s as deployed).
 * So the schedule has to run a pass at least every `(MAX_OBSERVATION_AGE - MIN_OBSERVATION_AGE) / 2`
 * seconds, which is 27 minutes as deployed, and every `MIN_OBSERVATION_AGE` to keep the readings as
 * fresh as the guard allows. `health.observed` in the report is false while a draw is halted for
 * want of a reading in force, which is what a pass that did not run looks like from the vault.
 */
async function main(): Promise<void> {
  const env = process.env;
  const lane = collateralDeployment(RHC_MAINNET.chainId);
  if (lane === undefined) throw new Error(`no collateral lane is recorded for chain ${RHC_MAINNET.chainId}`);

  const chain = defineChain({
    id: RHC_MAINNET.chainId,
    name: RHC_MAINNET.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [env['RHC_RPC_URL'] ?? RHC_MAINNET.rpcUrl] } },
  });
  const transport = http(env['RHC_RPC_URL'] ?? RHC_MAINNET.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  const key = env['BURSAR_KEEPER_KEY'];
  const account = key ? privateKeyToAccount(key as `0x${string}`) : undefined;
  const execute = env['BURSAR_KEEPER_EXECUTE'] === '1';
  if (execute && account === undefined) throw new Error('BURSAR_KEEPER_EXECUTE=1 needs BURSAR_KEEPER_KEY');

  const report = await runKeeper({
    chain: createKeeperChain({
      publicClient,
      lane,
      chain,
      ...(account === undefined ? {} : { account, walletClient: createWalletClient({ account, chain, transport }) }),
    }),
    fromBlock: BigInt(lane.fromBlock),
    execute,
    sweepMinMicro: BigInt(env['BURSAR_KEEPER_SWEEP_MIN_MICRO'] ?? '100000'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`keeper: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
