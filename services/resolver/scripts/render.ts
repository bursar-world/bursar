/**
 * Stands up the resolver service on Render as a private service with a persistent disk, and points
 * the console at it.
 *
 *   pnpm --filter @bursar/resolver render --dry-run   # print the plan, touch nothing
 *   pnpm --filter @bursar/resolver render             # create or update, then deploy
 *
 * A private service, not a background worker: a worker cannot receive requests on Render's private
 * network, and this one has to, because the console forwards evidence to it and reads published
 * rulings from it. It is the same always-on process with no public address. The disk keeps the
 * journal across deploys and pins the service to one instance, and one instance is what a voter
 * holding three keys has to be.
 *
 * The three resolver keys are decrypted in this process from the local keystores, with the
 * password read from the macOS Keychain, and go from memory into Render's API. They are never
 * printed and never written to disk here. Safe to run again: the service is found by name, its
 * environment is replaced whole, and a new deploy is started.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAddress } from 'viem';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { openKeystoreKey, passwordFromKeychain } from '../src/keys.js';

const OWNER = 'tea-daseuj60tbcc73f4bbf0';
const REGION = 'frankfurt';
const REPO = 'https://github.com/bursar-world/bursar';
const SERVICE = 'bursar-resolver';
const CONSOLE = 'bursar-app';
const PORT = '10000';
const DISK_PATH = '/var/data';
const CONFIG = join(homedir(), '.config', 'bursar');
const KEYSTORES = join(CONFIG, 'keystore');
const KEYCHAIN_ITEM = 'bursar-rh-deployer/keystore';
const RESOLVER_KEYS = ['resolver-1', 'resolver-2', 'resolver-3'];
/** Keys the operator pays and gets paid from in its own drills. Their disputes are never overridden. */
const OPERATOR_KEYSTORES = ['payer', 'payee'];
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/**
 * The records the service votes for, newest first, as paths from the repository root. The service
 * starts from that root on Render, so the same relative paths resolve there.
 */
const RECORDS = ['contracts/deployments/rhc-mainnet-v2.json', 'contracts/deployments/rhc-mainnet.json'];

const dryRun = process.argv.includes('--dry-run');
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function fromFile(file: string, key: string): string | undefined {
  const path = join(CONFIG, file);
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
}

function required(file: string, key: string): string {
  const value = fromFile(file, key);
  if (value === undefined) throw new Error(`${key} is not in ${join(CONFIG, file)}`);
  return value;
}

/**
 * Generated once and kept in ~/.config/bursar/resolver.env, mode 600, the one place the operator
 * reads it from to send an override. Not a key: it moves no money and signs nothing.
 */
function operatorToken(): string {
  const existing = fromFile('resolver.env', 'RESOLVER_OPERATOR_TOKEN');
  if (existing !== undefined) return existing;
  const value = randomBytes(32).toString('hex');
  if (!dryRun) {
    const path = join(CONFIG, 'resolver.env');
    const kept = existsSync(path) ? readFileSync(path, 'utf8').replace(/\n?$/, '\n') : '';
    writeFileSync(path, `${kept}RESOLVER_OPERATOR_TOKEN=${value}\n`, { mode: 0o600 });
  }
  return value;
}

type OperatorRecord = {
  deployer: string;
  roles: { timelockSigners: string[]; guardian: string; treasury: string; slashSink: string };
  exampleMandate?: { address: string; principal: string; agent: string };
  resolvers?: { bonded?: string[] };
};

/** One record's roles, example mandate and bonded resolvers. */
function recordAddresses(record: OperatorRecord): string[] {
  return [
    record.deployer,
    ...record.roles.timelockSigners,
    record.roles.guardian,
    record.roles.treasury,
    record.roles.slashSink,
    ...(record.exampleMandate === undefined ? [] : [record.exampleMandate.address, record.exampleMandate.principal, record.exampleMandate.agent]),
    ...(record.resolvers?.bonded ?? []),
  ];
}

/**
 * Every address the operator controls as a payer or a payee: each served deployment's roles, its
 * public example mandate and whoever holds it, the resolver keys, the drill keys, and anything
 * listed in RESOLVER_OPERATOR_EXTRA in ~/.config/bursar/resolver.env.
 */
function operatorAddresses(resolvers: readonly Address[], password: string): Address[] {
  const records = RECORDS.map((path) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as OperatorRecord);
  const drill = OPERATOR_KEYSTORES.filter((name) => existsSync(join(KEYSTORES, name))).map(
    (name) => privateKeyToAccount(openKeystoreKey(KEYSTORES, name, password)).address,
  );
  const extra = (fromFile('resolver.env', 'RESOLVER_OPERATOR_EXTRA') ?? '').split(',').filter((entry) => entry.trim() !== '');

  const all = [
    ...records.flatMap(recordAddresses),
    ...resolvers,
    ...drill,
    ...extra,
  ].map((address) => getAddress(address.trim()));
  return [...new Set(all)];
}

type EnvVar = { key: string; value: string };

function environment(): { vars: EnvVar[]; secret: ReadonlySet<string>; addresses: Address[] } {
  const password = passwordFromKeychain(KEYCHAIN_ITEM)();
  const keys = RESOLVER_KEYS.map((name) => openKeystoreKey(KEYSTORES, name, password));
  const resolvers = keys.map((key) => privateKeyToAccount(key).address);
  RESOLVER_KEYS.forEach((name, index) => out(`key ${name} ${resolvers[index] ?? ''}`));

  const webhook = process.env['BURSAR_ALERT_WEBHOOK'] ?? fromFile('resolver.env', 'BURSAR_ALERT_WEBHOOK');
  if (webhook === undefined) out('BURSAR_ALERT_WEBHOOK is not set: CRITICAL pages will reach the service log only');

  const addresses = operatorAddresses(resolvers, password);
  const vars: Record<string, string> = {
    NODE_VERSION: '22',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    RHC_NETWORK: 'mainnet',
    RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
    RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
    RESOLVER_DEPLOYMENTS: RECORDS.join(','),
    RESOLVER_KEYS: keys.join(','),
    RESOLVER_KEYS_ORDER: RESOLVER_KEYS.join(','),
    RESOLVER_HTTP_HOST: '0.0.0.0',
    RESOLVER_HTTP_PORT: PORT,
    RESOLVER_JOURNAL_PATH: `${DISK_PATH}/resolver-journal.json`,
    RESOLVER_OPERATOR_TOKEN: operatorToken(),
    RESOLVER_OPERATOR_ADDRESSES: addresses.join(','),
    ...(webhook === undefined ? {} : { BURSAR_ALERT_WEBHOOK: webhook }),
  };

  return {
    vars: Object.entries(vars).map(([key, value]) => ({ key, value })),
    secret: new Set(['RESOLVER_KEYS', 'RESOLVER_OPERATOR_TOKEN', 'BURSAR_ALERT_WEBHOOK']),
    addresses,
  };
}

const render = dryRun ? '' : required('render.env', 'RENDER_API_KEY');

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${render}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  // The request body can hold the keys, so it is never echoed. Render's answer does not.
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

type Service = { id: string; slug: string; name: string };

async function find(name: string): Promise<Service | undefined> {
  const found = await api<{ service: Service }[]>('GET', `/services?name=${name}&ownerId=${OWNER}`);
  return found.find((entry) => entry.service.name === name)?.service;
}

async function upsert(vars: EnvVar[]): Promise<Service> {
  const existing = await find(SERVICE);
  if (existing !== undefined) {
    await api('PUT', `/services/${existing.id}/env-vars`, vars);
    await api('POST', `/services/${existing.id}/deploys`, {});
    return existing;
  }

  const created = await api<{ service: Service }>('POST', '/services', {
    type: 'private_service',
    name: SERVICE,
    ownerId: OWNER,
    repo: REPO,
    branch: 'main',
    autoDeploy: 'yes',
    envVars: vars,
    serviceDetails: {
      runtime: 'node',
      plan: 'starter',
      region: REGION,
      disk: { name: 'resolver-journal', mountPath: DISK_PATH, sizeGB: 1 },
      envSpecificDetails: {
        buildCommand: 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @bursar/resolver... build',
        startCommand: 'node services/resolver/dist/main.js',
      },
    },
  });
  return created.service;
}

/** The console reaches the service over the private network, by the service's slug. */
async function pointConsole(service: Service): Promise<string> {
  const url = `http://${service.slug}:${PORT}`;
  const console = await find(CONSOLE);
  if (console === undefined) throw new Error(`No Render service named ${CONSOLE}.`);
  await api('PUT', `/services/${console.id}/env-vars/BURSAR_RESOLVER_URL`, { value: url });
  await api('POST', `/services/${console.id}/deploys`, {});
  return url;
}

const plan = environment();
for (const entry of plan.vars) out(`env ${entry.key}=${plan.secret.has(entry.key) ? '<secret>' : entry.value}`);
out(`operator addresses: ${plan.addresses.length}`);

if (dryRun) {
  out(`dry run: would create or update ${SERVICE} (private service, ${REGION}, 1 GB disk at ${DISK_PATH}) and set BURSAR_RESOLVER_URL on ${CONSOLE}`);
} else {
  const service = await upsert(plan.vars);
  out(`${SERVICE} ${service.id} is deploying`);
  out(`${CONSOLE} now reads rulings from ${await pointConsole(service)} and is redeploying`);
  out('check: https://app.bursar.world/api/rulings/health answers {"status":"ok"} once the first poll lands');
}
