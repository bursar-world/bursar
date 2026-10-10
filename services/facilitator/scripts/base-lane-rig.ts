/**
 * The Base lane, end to end, with the facilitator in this process.
 *
 *   npx tsx scripts/base-lane-rig.ts mainnet [serviceUrl]   # lock on Robinhood Chain, pay a live Base service
 *   npx tsx scripts/base-lane-rig.ts local                   # both chains forked, a local service, the full settle
 *
 * `mainnet` opens a real lock on Robinhood Chain 4663 from the example mandate and sends the
 * facilitator's signed authorization to a real x402 service on Base. The facilitator's Base side runs
 * against a fork of Base on this machine, where the lane's address is handed USDC for the quote; the
 * real address holds none, so the service's facilitator refuses the transfer and the lock returns to
 * the mandate once the authorization has expired. That is the whole path up to the Base transfer.
 *
 * `local` forks both chains, runs a service that settles on the Base fork, and shows the lock
 * released to the lane's address once the USDC has moved.
 *
 * Keys open from the Web3 keystores named in BURSAR_AGENT_KEYSTORE (the mandate's agent) and
 * BURSAR_FLOAT_KEYSTORE (the lane's address), with the password in the file ETH_PASSWORD names.
 * Nothing here prints a key. The run writes what happened to BURSAR_RIG_OUT (default
 * /tmp/base-lane-rig/<mode>.json).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BASE_MAINNET, RHC_MAINNET, baseViemChain, capabilityId, deploymentsForChain, escrowAbi, mandateAccountAbi, settlementAssetAbi, viemChain } from '@bursar/core';
import { BaseLaneRefusedError, PaymentRejectedError, mandateAccount } from '@bursar/sdk';
import { createPublicClient, createWalletClient, http, parseAbiItem, verifyTypedData } from 'viem';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { decryptKeystore } from '../src/collateral/keystore.js';
import { compose } from '../src/main.js';

const mode = process.argv[2] === 'local' ? 'local' : 'mainnet';
const SERVICE_URL = process.argv[3] ?? 'https://api.402rates.com/v1/ping';
const OUT = process.env['BURSAR_RIG_OUT'] ?? join('/tmp', 'base-lane-rig', `${mode}.json`);
const KEYSTORES = join(homedir(), '.config', 'bursar', 'keystore');
const RHC_RPC = process.env['RHC_RPC_PRIMARY'] ?? 'https://robinhood.drpc.org';
const RHC_RPC_FALLBACK = process.env['RHC_RPC_FALLBACK'] ?? RHC_MAINNET.rpcUrl;
const BASE_FORK_URL = process.env['BASE_FORK_URL'] ?? BASE_MAINNET.rpcUrl;
const BASE_PORT = 8546;
const RHC_PORT = 8547;
const FACILITATOR_PORT = 8412;
const SERVICE_PORT = 18403;
const CAPABILITY = 'service:demo.x402:1';
const FLOAT_USDC = 5_000_000n;
const live = deploymentsForChain(4663)[0];
if (!live?.examples.mandate) throw new Error('no live record names an example mandate');
const MANDATE = live.examples.mandate;
const ESCROW = live.contracts.Escrow as Address;

const log: Record<string, unknown> = {};
const children: ChildProcess[] = [];
const record = (key: string, value: unknown) => {
  log[key] = value;
  console.log(`${key}: ${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
};
const save = () => {
  mkdirSync(join(OUT, '..'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
};

function keyOf(envName: string, fallback: string): Hex {
  const path = process.env[envName] ?? join(KEYSTORES, fallback);
  const passwordFile = process.env['ETH_PASSWORD'];
  if (!passwordFile) throw new Error('ETH_PASSWORD must name the file holding the keystore password (source ops/rhc-env.sh)');
  return decryptKeystore(readFileSync(path, 'utf8'), readFileSync(passwordFile, 'utf8').trim());
}

async function anvil(port: number, forkUrl: string, chainId: number): Promise<string> {
  const child = spawn('anvil', ['--port', String(port), '--fork-url', forkUrl, '--chain-id', String(chainId), '--silent', '--no-rate-limit', '--retries', '5', '--timeout', '45000'], { stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const body = (await response.json()) as { result?: string };
      if (body.result && Number(body.result) === chainId) return url;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`anvil on ${port} did not come up`);
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Hands the lane's address USDC on the Base fork, from whoever holds the most of it lately. */
async function fundFloat(baseUrl: string, float: Address): Promise<{ from: Address; balance: bigint }> {
  const client = createPublicClient({ chain: baseViemChain(baseUrl), transport: http(baseUrl) });
  const head = await client.getBlockNumber();
  const logs = await client.getLogs({ address: BASE_MAINNET.usdc, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), fromBlock: head - 30n, toBlock: head });
  const holders = [...new Set(logs.map((entry) => entry.args.to as Address))];
  const balances = await Promise.all(holders.slice(0, 40).map(async (holder) => ({ holder, balance: await client.readContract({ address: BASE_MAINNET.usdc, abi: settlementAssetAbi, functionName: 'balanceOf', args: [holder] }) })));
  const richest = balances.sort((a, b) => (a.balance > b.balance ? -1 : 1))[0];
  if (!richest || richest.balance < FLOAT_USDC) throw new Error('no recent USDC holder on the fork holds enough to lend the float');
  await rpc(baseUrl, 'anvil_impersonateAccount', [richest.holder]);
  await rpc(baseUrl, 'anvil_setBalance', [richest.holder, '0x1000000000000000000']);
  const data = await rpc(baseUrl, 'eth_sendTransaction', [{ from: richest.holder, to: BASE_MAINNET.usdc, data: encodeTransfer(float, FLOAT_USDC) }]);
  await client.waitForTransactionReceipt({ hash: data as Hex });
  await rpc(baseUrl, 'anvil_stopImpersonatingAccount', [richest.holder]);
  return { from: richest.holder, balance: await client.readContract({ address: BASE_MAINNET.usdc, abi: settlementAssetAbi, functionName: 'balanceOf', args: [float] }) };
}

function encodeTransfer(to: Address, value: bigint): Hex {
  return `0xa9059cbb${to.slice(2).padStart(64, '0')}${value.toString(16).padStart(64, '0')}`;
}

/** An x402 service on the Base fork: 402 with one offer, then verify and settle the authorization itself. */
function localService(baseUrl: string, payTo: Address) {
  const relayer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const chain = baseViemChain(baseUrl);
  const client = createPublicClient({ chain, transport: http(baseUrl) });
  const wallet = createWalletClient({ account: relayer, chain, transport: http(baseUrl) });
  const offer = { scheme: 'exact', network: BASE_MAINNET.network, amount: '1000', asset: BASE_MAINNET.usdc, payTo, maxTimeoutSeconds: 300, resource: `http://127.0.0.1:${SERVICE_PORT}/fact`, extra: { name: 'USD Coin', version: '2' } };
  const settled: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const header = request.headers['payment-signature'];
      if (typeof header !== 'string') {
        response.writeHead(402, { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, error: 'payment required', resource: { url: offer.resource, description: 'one fact' }, accepts: [offer] })).toString('base64') });
        response.end('{}');
        return;
      }
      const envelope = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { payload: { signature: Hex; authorization: Record<string, string> } };
      const a = envelope.payload.authorization;
      const message = { from: a['from'] as Address, to: a['to'] as Address, value: BigInt(a['value'] ?? '0'), validAfter: BigInt(a['validAfter'] ?? '0'), validBefore: BigInt(a['validBefore'] ?? '0'), nonce: a['nonce'] as Hex };
      const valid = await verifyTypedData({
        address: message.from,
        domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_MAINNET.usdc },
        types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
        primaryType: 'TransferWithAuthorization',
        message,
        signature: envelope.payload.signature,
      });
      const reply = (ok: boolean, body: Record<string, unknown>) => {
        const settlement = Buffer.from(JSON.stringify({ success: ok, network: BASE_MAINNET.network, payer: message.from, ...body })).toString('base64');
        response.writeHead(ok ? 200 : 402, { 'content-type': 'application/json', 'payment-response': settlement });
        response.end(JSON.stringify(ok ? { fact: 'a group of flamingos is a flamboyance' } : { error: body['errorReason'] }));
      };
      if (!valid || message.to.toLowerCase() !== payTo.toLowerCase() || message.value !== 1_000n) return reply(false, { errorReason: valid ? 'invalid_payment' : 'invalid_signature' });
      const hash = await wallet.writeContract({ address: BASE_MAINNET.usdc, abi: settlementAssetAbi, functionName: 'transferWithAuthorization', args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, envelope.payload.signature] });
      const receipt = await client.waitForTransactionReceipt({ hash });
      settled.push({ hash, status: receipt.status, block: receipt.blockNumber });
      reply(receipt.status === 'success', { transaction: hash, ...(receipt.status === 'success' ? {} : { errorReason: 'settle_failed' }) });
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  return { server, settled, url: offer.resource };
}

async function windows(client: ReturnType<typeof createPublicClient>) {
  const [daily, monthly, remaining] = await Promise.all([
    client.readContract({ address: MANDATE, abi: mandateAccountAbi, functionName: 'window', args: [0] }),
    client.readContract({ address: MANDATE, abi: mandateAccountAbi, functionName: 'window', args: [1] }),
    client.readContract({ address: MANDATE, abi: mandateAccountAbi, functionName: 'remaining' }),
  ]);
  return { dailySpent: daily.spent, monthlySpent: monthly.spent, remaining: { perCall: remaining[0], daily: remaining[1], monthly: remaining[2] } };
}

async function main(): Promise<void> {
  const agentKey = keyOf('BURSAR_AGENT_KEYSTORE', 'payer');
  const floatKey = keyOf('BURSAR_FLOAT_KEYSTORE', 'payee');
  const agent = privateKeyToAccount(agentKey);
  const float = privateKeyToAccount(floatKey).address;
  record('mode', mode);
  record('mandate', { address: MANDATE, agent: agent.address, escrow: ESCROW, float, capability: CAPABILITY });

  const baseUrl = await anvil(BASE_PORT, BASE_FORK_URL, 8453);
  record('base fork', { url: baseUrl, forkedFrom: BASE_FORK_URL, funded: await fundFloat(baseUrl, float) });

  let rhcPrimary = RHC_RPC;
  let rhcFallback = RHC_RPC_FALLBACK;
  if (mode === 'local') {
    rhcPrimary = await anvil(RHC_PORT, RHC_RPC, 4663);
    rhcFallback = `http://localhost:${RHC_PORT}`;
    record('robinhood chain fork', { url: rhcPrimary, forkedFrom: RHC_RPC });
  }

  const relayer = generatePrivateKey();
  const other = () => privateKeyToAccount(generatePrivateKey()).address;
  const database = process.env['DATABASE_URL'] ?? 'postgres://localhost/bursar_base_rig';
  const env: Record<string, string> = {
    DATABASE_URL: database,
    FACILITATOR_MIGRATE: 'on-start',
    RHC_NETWORK: 'mainnet',
    RHC_RPC_PRIMARY: rhcPrimary,
    RHC_RPC_FALLBACK: rhcFallback,
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: String(FACILITATOR_PORT),
    FACILITATOR_RELAYER_KEY: relayer,
    FACILITATOR_GAS_FLOAT: privateKeyToAccount(relayer).address,
    FACILITATOR_SETTLEMENT: other(),
    FACILITATOR_COLLATERAL: other(),
    FACILITATOR_TREASURY: other(),
    FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '0.0001',
    FACILITATOR_FEE_BPS: '100',
    FACILITATOR_FEE_FLOOR_MICRO: '1900',
    FACILITATOR_UNDERWRITER: 'none',
    FACILITATOR_BASE_KEY: floatKey,
    FACILITATOR_BASE_RPC_URL: baseUrl,
    FACILITATOR_BASE_FEE_BPS: '100',
    FACILITATOR_BASE_FEE_FLOOR_MICRO: '2000',
    FACILITATOR_BASE_FLOAT_MINIMUM_MICRO: '1000000',
    FACILITATOR_BASE_MAX_PAYMENT_MICRO: '5000000',
  };
  const composed = await compose(env);
  await composed.service.start();
  const facilitator = `http://127.0.0.1:${FACILITATOR_PORT}`;
  record('facilitator', { url: facilitator, config: await (await fetch(`${facilitator}/config`)).json(), float: await (await fetch(`${facilitator}/base/float`)).json() });

  const rhc = createPublicClient({ chain: viemChain({ ...RHC_MAINNET, rpcUrl: rhcPrimary }), transport: http(rhcPrimary) });
  const usdg = (who: Address) => rhc.readContract({ address: RHC_MAINNET.usdg, abi: settlementAssetAbi, functionName: 'balanceOf', args: [who] });
  record('before', { windows: await windows(rhc), mandateUsdg: await usdg(MANDATE), floatUsdg: await usdg(float) });

  let serviceUrl = SERVICE_URL;
  let service: ReturnType<typeof localService> | null = null;
  if (mode === 'local') {
    service = localService(baseUrl, other());
    await new Promise<void>((resolve) => service?.server.listen(SERVICE_PORT, '127.0.0.1', resolve));
    serviceUrl = service.url;
  }
  record('service', { url: serviceUrl });

  const mandate = await mandateAccount(MANDATE, { account: agent, rpc: [rhcPrimary, rhcFallback] });
  let paymentId: string | null = null;
  try {
    const paid = await mandate.fetch(serviceUrl, { capability: CAPABILITY, lane: 'base', facilitator });
    paymentId = paid.payment?.base?.paymentId ?? null;
    record('paid', { status: paid.response.status, body: await paid.response.text(), payment: paid.payment });
  } catch (error) {
    if (error instanceof PaymentRejectedError) {
      record('service refused', { reason: error.reason, status: error.status, message: error.message });
      const open = (await (await fetch(`${facilitator}/base/float`)).json()) as { open: number };
      record('float after refusal', open);
    } else if (error instanceof BaseLaneRefusedError) {
      record('facilitator refused', { reason: error.reason, message: error.message });
    } else {
      throw error;
    }
  }

  // The worker decides from the token, on its own timer. Find the row by the mandate and wait it out.
  const list = async () => (await composed.db.query<{ id: string; status: string; lock_id: string; base_tx_hash: string | null; rhc_tx_hash: string | null; valid_before: string }>(
    'SELECT id, status, lock_id, base_tx_hash, rhc_tx_hash, valid_before FROM bursar_base_payments WHERE lower(mandate) = $1 ORDER BY created_at DESC LIMIT 1',
    [MANDATE.toLowerCase()],
  )).rows[0];
  let row = await list();
  record('payment row', row ?? null);
  if (row) {
    paymentId ??= row.id;
    const deadline = Date.now() + 12 * 60_000;
    while (row && (row.status === 'signed' || row.status === 'paid') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      row = await list();
      console.log(`waiting: payment ${row?.id} is ${row?.status} (authorization valid before ${row?.valid_before}, now ${Math.floor(Date.now() / 1000)})`);
    }
    record('payment outcome', row ?? null);
    if (row?.rhc_tx_hash) {
      const receipt = await rhc.getTransactionReceipt({ hash: row.rhc_tx_hash as Hex });
      const lock = await rhc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'getLock', args: [BigInt(row.lock_id.replace(/\.0+$/, ''))] });
      record('lock on robinhood chain', { id: row.lock_id, status: lock.status, payee: lock.payee, amount: lock.amount, outputURI: lock.outputURI, settled: { hash: row.rhc_tx_hash, block: receipt.blockNumber, status: receipt.status }, explorer: `${RHC_MAINNET.explorer}/tx/${row.rhc_tx_hash}` });
    }
  }
  if (service) record('service settled', service.settled);
  record('after', { windows: await windows(rhc), mandateUsdg: await usdg(MANDATE), floatUsdg: await usdg(float), float: await (await fetch(`${facilitator}/base/float`)).json() });
  record('capability id', capabilityId(CAPABILITY));

  service?.server.close();
  await composed.stop();
}

main()
  .catch((error: unknown) => {
    record('failed', error instanceof Error ? { name: error.name, message: error.message } : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    save();
    for (const child of children) child.kill('SIGTERM');
  });
