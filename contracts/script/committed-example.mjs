#!/usr/bin/env node
// The committed example mandate's terms, for `MigrateExamples.s.sol --sig "create()"`: written,
// committed to and sealed to the payer's viewing key with the SDK, the way the console does it for
// a private mandate.
//
//   node script/committed-example.mjs message <payer>
//   node script/committed-example.mjs terms <payer> <signature>
//
// `message` prints the text the payer signs to derive its viewing key. `terms` takes that
// signature and prints the three variables create() reads, as export lines. It reads the committed
// mandate factory from BURSAR_RECORD, asks the chain at RHC_RPC_URL where create() will put the
// account the sealed copy is bound to, and lets the example pay one counterparty,
// BURSAR_EXAMPLE_PAYEE. The SDK has to be built, with the workspace packages it imports:
// pnpm install, then pnpm --filter "@bursar/sdk..." build, from the repository root.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SDK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'sdk');
const load = (path) => import(pathToFileURL(path).href);

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const [command, payer, signature] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(payer ?? '')) {
  fail('usage: committed-example.mjs message <payer> | terms <payer> <signature>');
}

let sdk;
try {
  sdk = await load(join(SDK, 'dist', 'index.js'));
} catch {
  fail('The SDK is not built: run pnpm install, then pnpm --filter "@bursar/sdk..." build, from the repository root.');
}

if (command === 'message') {
  process.stdout.write(sdk.viewingKeyMessage(payer));
  process.exit(0);
}
if (command !== 'terms' || !/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) {
  fail('usage: committed-example.mjs terms <payer> <signature from cast wallet sign>');
}

// viem as the SDK resolves it, so the client is the one its calls expect.
const viemManifest = createRequire(join(SDK, 'package.json')).resolve('viem/package.json');
const viem = await load(join(dirname(viemManifest), JSON.parse(readFileSync(viemManifest, 'utf8')).exports['.'].import));

const need = (name) => process.env[name] || fail(`${name} is not set: source script/env/rhc-mainnet-v4.env`);
const record = JSON.parse(readFileSync(need('BURSAR_RECORD'), 'utf8'));
const factory = record.privacy?.CommittedMandateFactory ?? fail('The record names no CommittedMandateFactory yet: step 1 deploys it.');
const payee = need('BURSAR_EXAMPLE_PAYEE');

// The public example's terms, held behind the commitment: 0.10 USDG a call, 0.50 a day, 1.00 in
// all, to the registered payee, for a year.
const terms = sdk.writeTerms({
  perCallCap: 100_000n,
  periodCap: 500_000n,
  periodLen: 86_400,
  totalCap: 1_000_000n,
  capabilities: ['service:gpu.render:1'],
  counterparties: [payee],
  expiry: Math.floor(Date.now() / 1000) + 365 * 86_400,
  label: 'Bursar committed example',
});
const commitment = sdk.commit(terms);
// MigrateExamples.s.sol creates the account under this salt, derived from the record's name, with
// the payer as principal and agent.
const salt = viem.keccak256(viem.toBytes(`bursar.committed-mandate.${record.network}`));
const client = viem.createPublicClient({ transport: viem.http(need('RHC_RPC_URL')) });
const account = await sdk.predictAccount(client, factory, { principal: payer, agent: payer, salt, commitment });
const sealed = await sdk.sealTerms(sdk.deriveViewingKey(signature).termsKey, { account, version: 1 }, terms);

console.error(`The committed example will be ${account}. Its terms, which the payer can reopen with its viewing key:`);
console.error(JSON.stringify(terms, null, 2));
console.log(`export BURSAR_COMMITTED_TERMS=${commitment.termsCommitment}`);
console.log(`export BURSAR_COMMITTED_COUNTER=${commitment.counter}`);
console.log(`export BURSAR_COMMITTED_CIPHERTEXT=${sealed}`);
