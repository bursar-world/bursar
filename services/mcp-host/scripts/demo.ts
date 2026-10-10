#!/usr/bin/env -S npx tsx
/**
 * The owner's side of the hosted-assistant demo, from a terminal: creates a mandate from a
 * keystore, allows the demo provider and one capability, funds it, opens a connection on a
 * running host, seats the agent the host made, and gives that agent a little ETH for fees.
 *
 *   source ~/Projects/bursar-ops/ops/rhc-env.sh          # leaves the keystore password file in ETH_PASSWORD
 *   BURSAR_DEMO_OWNER_KEYSTORE=~/.config/bursar/keystore/film-owner \
 *   BURSAR_DEMO_FUNDER_KEYSTORE=~/.config/bursar/keystore/payer \
 *   MCP_HOST_URL=http://127.0.0.1:8410 RHC_RPC_PRIMARY=https://robinhood.drpc.org \
 *     npx tsx scripts/demo.ts [--mandate 0x…]
 *
 * --mandate reuses a mandate the owner already created and skips straight to the connection. The
 * token is printed once, to this terminal, and written to BURSAR_DEMO_OUT when that is set. Keys
 * are decrypted in memory and never printed.
 *
 * --mandate 0x… --revoke <connection id | stale> cuts one connection, or every active one whose
 * agent is not seated on the mandate, and does nothing else.
 */
import { createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { RHC_MAINNET, viemChain } from '@bursar/core';
import { assistantConnectMessage, assistantDisconnectMessage, deployMandate, mandateAccount, usdg } from '@bursar/sdk';
import { createWalletClient, http, keccak256, parseAbi, parseEther } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PROVIDER: Address = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const CAPABILITY = 'gpu.render:1';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const FUNDING = usdg('0.30');
const FEE_FLOAT = parseEther('0.0001');

const expand = (path: string): string => path.replace(/^~/u, homedir());
const env = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`set ${name}`);
  return value;
};

function readKeystore(path: string): Hex {
  const store = JSON.parse(readFileSync(expand(path), 'utf8')) as {
    crypto: { cipher: string; cipherparams: { iv: string }; ciphertext: string; kdf: string; kdfparams: { dklen: number; n: number; p: number; r: number; salt: string }; mac: string };
  };
  if (store.crypto.kdf !== 'scrypt' || store.crypto.cipher !== 'aes-128-ctr') throw new Error(`${path}: only scrypt and aes-128-ctr keystores are read`);
  const password = readFileSync(expand(env('ETH_PASSWORD')), 'utf8').trim();
  const { n, r, p, dklen, salt } = store.crypto.kdfparams;
  const derived = scryptSync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'hex'), dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
  const ciphertext = Buffer.from(store.crypto.ciphertext, 'hex');
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext]));
  if (mac.slice(2).toLowerCase() !== store.crypto.mac.toLowerCase()) throw new Error(`${path} did not open: wrong password`);
  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(store.crypto.cipherparams.iv, 'hex'));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return `0x${key.toString('hex')}`;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const rpc = [process.env.RHC_RPC_PRIMARY, process.env.RHC_RPC_FALLBACK].map((url) => url?.trim()).filter((url): url is string => Boolean(url));
if (rpc.length === 0) throw new Error('set RHC_RPC_PRIMARY');
const hostUrl = env('MCP_HOST_URL').replace(/\/+$/u, '');
const ownerKey = readKeystore(env('BURSAR_DEMO_OWNER_KEYSTORE'));
const owner = privateKeyToAccount(ownerKey);
const chain = viemChain(RHC_MAINNET);
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

log(`owner ${owner.address}`);

let mandateAddress = flag('--mandate') as Address | undefined;
const transactions: Record<string, string> = {};

const revoke = flag('--revoke');
if (revoke !== undefined) {
  if (mandateAddress === undefined) throw new Error('--revoke needs --mandate');
  const listed = (await (await fetch(`${hostUrl}/connections?mandate=${mandateAddress}`)).json()) as {
    connections: { id: string; agent: Address; status: string; label: string | null }[];
  };
  const seated = await (await mandateAccount(mandateAddress, { rpc })).status();
  const targets = listed.connections.filter((c) =>
    c.status === 'active' && (revoke === 'stale' ? c.agent.toLowerCase() !== seated.agent.toLowerCase() : c.id === revoke),
  );
  for (const target of targets) {
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')}` as Hex;
    const fields = { mandate: mandateAddress, owner: owner.address, chainId: 4663, nonce, issuedAt: new Date().toISOString(), connection: target.id };
    const signature = await owner.signMessage({ message: assistantDisconnectMessage(fields) });
    const response = await fetch(`${hostUrl}/connections/${target.id}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, signature }),
    });
    log(`${response.ok ? 'revoked' : 'could not revoke'} ${target.id} (${target.label ?? 'no label'}, agent ${target.agent})`);
  }
  if (targets.length === 0) log('nothing to revoke');
  process.exit(0);
}

if (mandateAddress === undefined) {
  const deployed = await deployMandate(
    { rpc, account: ownerKey },
    {
      principal: owner.address,
      agent: ZERO,
      limits: {
        perCallCap: usdg('0.50'),
        dailyCap: usdg('1.00'),
        monthlyCap: usdg('5.00'),
        dailyWindow: 86_400,
        monthlyWindow: 2_592_000,
        approvalThreshold: usdg('0.50'),
        classes: ['service'],
      },
    },
  );
  mandateAddress = deployed.address;
  transactions['create'] = deployed.hash;
  log(`mandate ${deployed.address} created in ${deployed.hash}`);

  const mandate = await mandateAccount(mandateAddress, { rpc, account: ownerKey });
  transactions['allowProvider'] = (await mandate.setMerchant(PROVIDER, true)).hash;
  transactions['allowCapability'] = (await mandate.setCapability(CAPABILITY, true)).hash;
  log(`allowed ${PROVIDER} and ${CAPABILITY}`);

  const funderPath = process.env.BURSAR_DEMO_FUNDER_KEYSTORE?.trim();
  if (funderPath) {
    const funder = privateKeyToAccount(readKeystore(funderPath));
    const wallet = createWalletClient({ account: funder, chain, transport: http(rpc[0]) });
    transactions['fund'] = await wallet.writeContract({
      address: RHC_MAINNET.usdg,
      abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args: [mandateAddress, FUNDING],
    });
    log(`funded with 0.30 USDG from ${funder.address} in ${transactions['fund']}`);
  }
}

const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')}` as Hex;
const fields = { mandate: mandateAddress, owner: owner.address, chainId: 4663, nonce, issuedAt: new Date().toISOString(), label: 'Claude Code' };
const signature = await owner.signMessage({ message: assistantConnectMessage(fields) });
const response = await fetch(`${hostUrl}/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...fields, signature }),
});
const created = (await response.json()) as { connection: { id: string; agent: Address }; token: string; settings: { endpoint: string } };
if (!response.ok) throw new Error(`host refused the connection: ${JSON.stringify(created)}`);
log(`connection ${created.connection.id} opened; agent ${created.connection.agent}`);

const mandate = await mandateAccount(mandateAddress, { rpc, account: ownerKey });
transactions['seat'] = (await mandate.setAgent(created.connection.agent)).hash;
log(`seated ${created.connection.agent} in ${transactions['seat']}`);

const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc[0]) });
transactions['feeFloat'] = await ownerWallet.sendTransaction({ to: created.connection.agent, value: FEE_FLOAT });
log(`sent 0.0001 ETH to the agent in ${transactions['feeFloat']}`);

const out = {
  mandate: mandateAddress,
  owner: owner.address,
  agent: created.connection.agent,
  connection: created.connection.id,
  endpoint: created.settings.endpoint,
  token: created.token,
  transactions,
};
const outPath = process.env.BURSAR_DEMO_OUT?.trim();
if (outPath) writeFileSync(expand(outPath), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...out, token: '<printed to the out file>' }, null, 2)}\n`);
