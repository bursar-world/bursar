/**
 *   bursar-asp post [--dry-run]   compute the association set and post its root if it changed
 *   bursar-asp run                 serve the set over HTTP and post it on the posting cadence
 *   bursar-asp verify              recompute the set from chain data and compare with the posted root
 *
 * Both `post` and `run` post at most once per POST_CADENCE_SECONDS (ten minutes), counted from the
 * chain's last post, so the deposits that land inside one window share one root.
 *
 * Environment: RHC_RPC_URL (default the public endpoint); ASP_PRIVATE_KEY, or ASP_KEYSTORE and
 * ASP_PASSWORD_FILE, for the postman key (only `post` and `run` send); PORT (default 4320);
 * ASP_INTERVAL_SECONDS (default 30), how often the set is recomputed and served; ASP_DATA_DIR to
 * keep published sets across restarts.
 */
import process from 'node:process';

import { privacyDeployment, rhcChain, viemChain } from '@bursar/core';
import { ASP_POSTMAN_ROLE, shieldedEntrypointAbi } from '@bursar/sdk';
import { createPublicClient, createWalletClient, http } from 'viem';

import { SetStore, serve } from './http.js';
import { cadencedPoster, lastPostedAt, latestRoot } from './post.js';
import { computeSet, type Pool } from './set.js';
import { signerFromEnv } from './signer.js';

const chain = viemChain(rhcChain('mainnet'));
const rpc = process.env['RHC_RPC_URL'] ?? chain.rpcUrls.default.http[0];
const client = createPublicClient({ chain, transport: http(rpc) });

const deployment = privacyDeployment(chain.id)?.shielded;
if (!deployment) throw new Error(`No shielded pool is recorded for chain ${chain.id}.`);
const pool: Pool = {
  chainId: chain.id,
  pool: deployment.ShieldedPool,
  scope: BigInt(deployment.scope),
  registry: deployment.AccessRegistry,
  fromBlock: BigInt(deployment.fromBlock),
};

function postman() {
  const account = signerFromEnv('ASP');
  if (!account) throw new Error('Set ASP_PRIVATE_KEY, or ASP_KEYSTORE and ASP_PASSWORD_FILE, to post.');
  return createWalletClient({ account, chain, transport: http(rpc) });
}

async function assertPostman(wallet: ReturnType<typeof postman>) {
  const allowed = await client.readContract({
    address: deployment!.Entrypoint,
    abi: shieldedEntrypointAbi,
    functionName: 'hasRole',
    args: [ASP_POSTMAN_ROLE, wallet.account.address],
  });
  if (!allowed) throw new Error(`${wallet.account.address} does not hold ASP_POSTMAN on ${deployment!.Entrypoint}.`);
}

const now = () => BigInt(Math.floor(Date.now() / 1000));

async function posterFor(wallet?: ReturnType<typeof postman>) {
  const entrypoint = deployment!.Entrypoint;
  return cadencedPoster({ client, wallet, chain, entrypoint, lastPostedAt: await lastPostedAt(client, entrypoint), now });
}

async function once(store: SetStore, poster: Awaited<ReturnType<typeof posterFor>>) {
  const set = await computeSet(client, pool);
  store.put(set);
  const outcome = await poster.sync(set);
  const summary = `${set.labels.length} admitted, ${set.excluded.length} excluded, through block ${set.throughBlock}`;
  if (outcome.action === 'posted') console.log(`posted root ${outcome.root} (${outcome.cid}) in ${outcome.hash}; ${summary}`);
  else console.log(`root ${outcome.root}: ${outcome.reason}; ${summary}`);
  return set;
}

async function post(dryRun: boolean) {
  const wallet = dryRun ? undefined : postman();
  if (wallet) await assertPostman(wallet);
  const set = await once(new SetStore(null), await posterFor(wallet));
  if (dryRun) console.log(JSON.stringify(set, null, 2));
}

async function run() {
  const wallet = postman();
  await assertPostman(wallet);
  const poster = await posterFor(wallet);
  const store = new SetStore(process.env['ASP_DATA_DIR'] ?? null);
  const intervalMs = Number(process.env['ASP_INTERVAL_SECONDS'] ?? 30) * 1000;
  let last = { at: 0, error: null as string | null };
  const port = Number(process.env['PORT'] ?? 4320);
  serve(
    {
      store,
      chainRoot: () => latestRoot(client, deployment!.Entrypoint),
      health: () => ({
        ok: last.error === null && Date.now() - last.at < intervalMs * 4,
        pool: pool.pool,
        entrypoint: deployment!.Entrypoint,
        postman: wallet.account.address,
        lastRunAt: last.at === 0 ? null : new Date(last.at).toISOString(),
        lastError: last.error,
      }),
    },
    port,
  );
  console.log(`asp serving on :${port}, pool ${pool.pool}`);
  for (;;) {
    try {
      await once(store, poster);
      last = { at: Date.now(), error: null };
    } catch (error) {
      last = { at: Date.now(), error: error instanceof Error ? error.message : String(error) };
      console.error(`asp cycle failed: ${last.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function verify() {
  const [set, root] = await Promise.all([computeSet(client, pool), latestRoot(client, deployment!.Entrypoint)]);
  console.log(`recomputed ${set.root} over ${set.labels.length} deposits (${set.cid})`);
  console.log(`on chain   ${root ?? 'none'}`);
  if (root === null || root.toString() !== set.root) {
    console.log('MISMATCH: the posted root is not the set these rules give now (a deposit since the last post, or a change in the registry).');
    process.exitCode = 1;
  } else console.log('MATCH');
}

const [command, ...rest] = process.argv.slice(2);
const main =
  command === 'post'
    ? post(rest.includes('--dry-run'))
    : command === 'run'
      ? run()
      : command === 'verify'
        ? verify()
        : Promise.reject(new Error('usage: bursar-asp post [--dry-run] | run | verify'));

main.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
