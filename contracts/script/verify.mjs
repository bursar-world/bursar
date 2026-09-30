#!/usr/bin/env node
// Source verification for deployed contracts on Sourcify and Blockscout, from one manifest.
//
//   node script/verify.mjs [--manifest verification/manifest.json] [--only name,name] [--status]
//                          [--hours 6] [--no-submit]
//
// Each contract is submitted to Sourcify, to Blockscout's shared verification store and to the
// Robinhood Chain explorer, then the explorer is polled until it shows the source. The explorer's
// edge answers 500 to uploads over about 64 KiB even when the upload was accepted, and it also
// imports sources from the shared store on its own schedule, so a 500 is treated as "submitted"
// and the poll decides. BLOCKSCOUT_API_KEY must be set for the explorer calls.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAIN = '4663';
const SOURCIFY = 'https://sourcify.dev/server';
const STORE = 'https://eth-bytecode-db.services.blockscout.com/api/v2';
const EXPLORER = `https://api.blockscout.com/${CHAIN}/api/v2`;
const RPC = process.env.RHC_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const manifestPath = resolve(HERE, '..', flag('--manifest', 'verification/manifest.json'));
const only = flag('--only', '')
  .split(',')
  .filter(Boolean);
const statusOnly = args.includes('--status');
const submit = !args.includes('--no-submit');
const hours = Number(flag('--hours', '6'));
const key = process.env.BLOCKSCOUT_API_KEY;
if (!key) {
  console.error('BLOCKSCOUT_API_KEY is not set');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = Object.entries(manifest.contracts ?? manifest).filter(([name]) => only.length === 0 || only.includes(name));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function explorerVerified(address) {
  const r = await fetch(`${EXPLORER}/smart-contracts/${address}?apikey=${key}`);
  if (!r.ok) return null;
  const d = await r.json();
  return Boolean(d.source_code || d.is_verified);
}

function inputFor(name, entry) {
  const file = resolve(dirname(manifestPath), `${name}.json`);
  if (!existsSync(file)) throw new Error(`${name}: no input at ${file}`);
  const input = JSON.parse(readFileSync(file, 'utf8'));
  if (entry.libraries && Object.keys(entry.libraries).length > 0) {
    const libraries = {};
    for (const [qualified, address] of Object.entries(entry.libraries)) {
      const at = qualified.lastIndexOf(':');
      (libraries[qualified.slice(0, at)] ??= {})[qualified.slice(at + 1)] = address;
    }
    input.settings = { ...input.settings, libraries };
  }
  return input;
}

async function sourcify(entry, input) {
  const r = await fetch(`${SOURCIFY}/v2/verify/${CHAIN}/${entry.address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stdJsonInput: input,
      compilerVersion: entry.compiler.replace(/^v/, ''),
      contractIdentifier: entry.contract,
    }),
  });
  const text = await r.text();
  if (r.status === 409) return 'already';
  return `${r.status} ${text.slice(0, 80)}`;
}

async function store(entry, input) {
  const creation = await fetch(`${EXPLORER}/addresses/${entry.address}?apikey=${key}`).then((r) => r.json());
  const hash = creation.creation_transaction_hash ?? creation.creation_tx_hash;
  // A contract a factory created has no creation input of its own in the transaction, so the store
  // gets its deployed code instead.
  let bytecode = null;
  let bytecodeType = 'DEPLOYED_BYTECODE';
  if (hash) {
    const tx = await fetch(`${EXPLORER}/transactions/${hash}?apikey=${key}`).then((r) => r.json());
    if (!tx.to) {
      bytecode = tx.raw_input;
      bytecodeType = 'CREATION_INPUT';
    }
  }
  if (!bytecode) {
    const code = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [entry.address, 'latest'] }),
    }).then((r) => r.json());
    bytecode = code.result;
  }
  const r = await fetch(`${STORE}/verifier/solidity/sources:verify-standard-json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bytecode: bytecode ?? '0x',
      bytecodeType,
      compilerVersion: entry.compiler,
      input: JSON.stringify(input),
      metadata: { chainId: CHAIN, contractAddress: entry.address },
    }),
  });
  const d = await r.json().catch(() => ({}));
  return d.status ?? `${r.status}`;
}

async function explorer(entry, input, name) {
  const form = new FormData();
  form.append('compiler_version', entry.compiler);
  form.append('contract_name', entry.contract.split(':').pop());
  form.append('license_type', 'mit');
  if (entry.constructorArgs) {
    form.append('autodetect_constructor_args', 'false');
    form.append('constructor_args', entry.constructorArgs);
  } else {
    form.append('autodetect_constructor_args', 'true');
  }
  form.append('files[0]', new Blob([JSON.stringify(input)], { type: 'application/json' }), `${name}.json`);
  const r = await fetch(`${EXPLORER}/smart-contracts/${entry.address}/verification/via/standard-input?apikey=${key}`, {
    method: 'POST',
    body: form,
  });
  return r.status;
}

const pending = new Map();
for (const [name, entry] of entries) {
  const done = await explorerVerified(entry.address);
  if (done) {
    console.log(`ok   ${name} ${entry.address}`);
    continue;
  }
  pending.set(name, entry);
  if (statusOnly || !submit) {
    console.log(`NO   ${name} ${entry.address}`);
    continue;
  }
  try {
    const input = inputFor(name, entry);
    const [s, b, e] = [await sourcify(entry, input), await store(entry, input), await explorer(entry, input, name)];
    console.log(`sent ${name} sourcify=${s} store=${b} explorer=${e}`);
  } catch (error) {
    console.log(`fail ${name} ${error.message}`);
  }
  await sleep(15_000);
}

if (statusOnly || pending.size === 0) process.exit(pending.size === 0 ? 0 : 1);

const deadline = Date.now() + hours * 3_600_000;
while (pending.size > 0 && Date.now() < deadline) {
  await sleep(60_000);
  for (const [name, entry] of pending) {
    if (await explorerVerified(entry.address)) {
      console.log(`ok   ${name} ${entry.address} (${new Date().toISOString()})`);
      pending.delete(name);
    }
    await sleep(1_500);
  }
}
for (const [name, entry] of pending) console.log(`NO   ${name} ${entry.address} still unverified`);
process.exit(pending.size === 0 ? 0 : 1);
