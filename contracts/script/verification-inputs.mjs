#!/usr/bin/env node
// Writes the source-verification inputs for a deployment record: one standard-JSON input per
// contract the record names, and its manifest entry, from the logs the deploy scripts left.
//
//   node script/verification-inputs.mjs [--record deployments/rhc-mainnet-v3.json] [--prefix v3]
//                                       [--broadcast broadcast] [--dir verification] [--check]
//
// A contract's creation is found by address in broadcast/<script>/4663/*.json, whether a script
// created it or a factory did inside a call. The input forge writes for it is compiled here with
// the same solc, and has to reproduce the transaction's creation code byte for byte: what follows
// that code in the transaction is the constructor arguments. Libraries a run linked with
// --libraries are part of every contract's metadata from that run, so they go into each of those
// inputs and manifest entries. Addresses the record names that no log created (the roles, the
// assets, the contracts carried over from earlier sets) are left out. --check writes nothing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAIN = '4663';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIPPED_SEGMENTS = new Set(['contracts', 'token', 'rwa', 'privacy', 'shielded', 'collateral', 'address']);
const SVM_HOMES = [process.env.SVM_HOME, join(homedir(), 'Library', 'Application Support', 'svm'), join(homedir(), '.svm')].filter(Boolean);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const recordPath = resolve(ROOT, flag('--record', 'deployments/rhc-mainnet-v3.json'));
const prefix = flag('--prefix', 'v3');
const broadcastDir = resolve(ROOT, flag('--broadcast', 'broadcast'));
const dir = resolve(ROOT, flag('--dir', 'verification'));
const check = args.includes('--check');

const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const strip = (hex) => (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();

// Every address in the sections that name deployed contracts, under the first path it appears at.
const named = new Map();
function collect(value, path) {
  if (typeof value === 'string') {
    if (/^0x[0-9a-fA-F]{40}$/.test(value) && !named.has(value.toLowerCase())) named.set(value.toLowerCase(), { address: value, path });
    return;
  }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, [...path, k]);
}
for (const section of ['contracts', 'token', 'rwa', 'privacy', 'exampleMandate', 'exampleCollateralMandate', 'exampleCommittedMandate']) {
  if (record[section] !== undefined) collect(record[section], [section]);
}

// Creations from the logs, the latest log of each script first, and never from a dry run.
const creations = new Map();
const logs = [];
for (const script of existsSync(broadcastDir) ? readdirSync(broadcastDir) : []) {
  const chainDir = join(broadcastDir, script, CHAIN);
  if (!existsSync(chainDir)) continue;
  for (const file of readdirSync(chainDir)) {
    if (file.endsWith('.json')) logs.push({ file: join(chainDir, file), latest: file.endsWith('-latest.json') });
  }
}
logs.sort((a, b) => Number(b.latest) - Number(a.latest) || b.file.localeCompare(a.file));
for (const { file } of logs) {
  const log = JSON.parse(readFileSync(file, 'utf8'));
  const libraries = (log.libraries ?? []).map((entry) => {
    const at = entry.lastIndexOf(':');
    return { id: entry.slice(0, at), address: entry.slice(at + 1) };
  });
  const add = (address, name, code) => {
    if (!address || !code) return;
    const key = address.toLowerCase();
    if (!creations.has(key)) creations.set(key, { name, code: strip(code), libraries });
  };
  for (const tx of log.transactions ?? []) {
    if (tx.transactionType === 'CREATE' || tx.transactionType === 'CREATE2') add(tx.contractAddress, tx.contractName, tx.transaction?.input);
    for (const extra of tx.additionalContracts ?? []) {
      if (extra.transactionType === 'CREATE' || extra.transactionType === 'CREATE2') add(extra.address, null, extra.initCode);
    }
  }
}

// The compiled artifacts, read once. They name the contract behind a creation and bound its code;
// the compile below, not the artifact, decides whether the input reproduces it.
const artifacts = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'build-info') walk(path);
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    let artifact;
    try {
      artifact = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const object = artifact.bytecode?.object;
    const runtime = artifact.deployedBytecode?.object;
    if (typeof object !== 'string' || object.length <= 2 || typeof runtime !== 'string' || !artifact.metadata) continue;
    const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
    const [[file, contract]] = Object.entries(metadata.settings.compilationTarget);
    artifacts.push({
      name: basename(entry.name, '.json'),
      id: `${file}:${contract}`,
      file,
      contract,
      object: strip(object),
      metadataWindow: metadataWindow(strip(object), strip(runtime)),
      version: metadata.compiler.version,
    });
  }
}
walk(resolve(ROOT, 'out'));

// The runtime code ends in its CBOR metadata and the metadata's two-byte length. The runtime is the
// tail of the creation code, so the metadata sits just before the creation code's end.
function metadataWindow(object, runtime) {
  const cbor = Number.parseInt(runtime.slice(-4), 16);
  return [object.length - (cbor + 2) * 2, object.length];
}

// Equal except inside library link slots and the metadata.
function similar(artifact, code) {
  const { object, metadataWindow: [from, to] } = artifact;
  if (code.length < object.length) return false;
  for (let i = 0; i < object.length; ) {
    if (object.startsWith('__$', i)) {
      i += 40;
      continue;
    }
    if (i >= from && i < to) {
      i = to;
      continue;
    }
    if (object[i] !== code[i]) return false;
    i += 1;
  }
  return true;
}

function solc(version) {
  for (const home of SVM_HOMES) {
    const binary = join(home, version, `solc-${version}`);
    if (existsSync(binary)) return binary;
  }
  throw new Error(`solc ${version} is not installed under ${SVM_HOMES.join(' or ')}; forge build downloads it`);
}

// Compiles the input as an explorer would and answers the creation code it produces.
function compiled(input, artifact) {
  const probe = { ...input, settings: { ...input.settings, outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const output = JSON.parse(execFileSync(solc(artifact.version.split('+')[0]), ['--standard-json'], { input: JSON.stringify(probe), encoding: 'utf8', maxBuffer: 1 << 28 }));
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const out = output.contracts[artifact.file][artifact.contract].evm;
  return { object: strip(out.bytecode.object), runtime: strip(out.deployedBytecode.object) };
}

function nameFor(path) {
  return `${prefix}-${path.filter((segment) => !SKIPPED_SEGMENTS.has(segment)).join('-')}`;
}

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const manifestPath = join(dir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
let failed = false;
const fail = (name, address, why) => {
  console.log(`fail ${name} ${address}: ${why}`);
  failed = true;
};

for (const [key, { address, path }] of named) {
  const creation = creations.get(key);
  if (!creation) continue;
  const name = nameFor(path);
  const candidates = artifacts.filter((a) => (creation.name ? a.name === creation.name : true) && similar(a, creation.code));
  if (candidates.length !== 1) {
    fail(name, address, candidates.length === 0 ? 'no artifact resembles its creation code' : `${candidates.length} artifacts resemble it: ${candidates.map((c) => c.id).join(', ')}`);
    continue;
  }
  const [artifact] = candidates;
  const libraryFlags = creation.libraries.flatMap((l) => ['--libraries', `${l.id}:${l.address}`]);
  const libraries = Object.fromEntries(creation.libraries.map((l) => [l.id, l.address]));

  let input;
  try {
    input = JSON.parse(execFileSync('forge', ['verify-contract', address, artifact.id, '--show-standard-json-input', ...libraryFlags], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }));
  } catch (error) {
    fail(name, address, `forge could not write the input: ${error.message.split('\n')[0]}`);
    continue;
  }
  const serialized = JSON.stringify(input);
  const leaks = [
    ...Object.keys(input.sources).filter((source) => source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)),
    ...(input.settings.remappings ?? []).filter((remapping) => /=(\/|[A-Za-z]:[\\/])/.test(remapping)),
  ];
  if (leaks.length > 0 || /\/(Users|home)\//.test(serialized)) {
    fail(name, address, `the input carries a machine path: ${leaks.join(', ') || 'in a source'}`);
    continue;
  }

  let built;
  try {
    built = compiled(input, artifact);
  } catch (error) {
    fail(name, address, `the input does not compile: ${error.message.split('\n')[0]}`);
    continue;
  }
  if (creation.code.slice(0, built.object.length) !== built.object) {
    const [from, to] = metadataWindow(built.object, built.runtime);
    const outsideMetadata = built.object.slice(0, from) === creation.code.slice(0, from) && built.object.slice(to) === creation.code.slice(to, built.object.length);
    fail(name, address, outsideMetadata ? 'the input reproduces the code but not its metadata: the deployed build had other settings or sources' : 'the input compiles to different code');
    continue;
  }

  const runtimeVersion = artifact.version;
  manifest[name] = {
    address,
    commit,
    contract: artifact.id,
    compiler: `v${runtimeVersion}`,
    optimizer: input.settings.optimizer?.enabled ? `enabled, ${input.settings.optimizer.runs} runs` : 'disabled',
    evmVersion: input.settings.evmVersion,
    libraries,
    constructorArgs: creation.code.slice(built.object.length),
    match: 'exact',
    standardJsonBytes: Buffer.byteLength(serialized),
  };
  console.log(`${check ? 'would' : 'wrote'} ${name} ${address} ${artifact.id} args=${manifest[name].constructorArgs.length / 2}B input=${manifest[name].standardJsonBytes}B`);
  if (check) continue;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), serialized);
}

if (!check && !failed) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.exit(failed ? 1 : 0);
