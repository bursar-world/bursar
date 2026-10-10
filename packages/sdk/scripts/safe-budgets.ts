/**
 * A Safe runs one Bursar mandate end to end on Robinhood Chain, with two of its three owners
 * signing every action: deploy the Safe, create the mandate from it, fund it, change a limit, seat
 * an agent, register an approval, then sign an approval off chain the way a Safe does and let the
 * agent pay with it. The Safe pays its own gas: each transaction refunds whoever sent it.
 *
 *   source ops/rhc-env.sh                      # ETH_PASSWORD names the password file
 *   pnpm --filter @bursar/sdk exec tsx scripts/safe-budgets.ts
 *
 * Every transaction lands in SAFE_BUDGETS_RECORD (docs/bullish/safe-budgets/record.json). A rerun
 * reads the record and skips what already happened, so a step that fails is retried without a
 * second Safe or a second mandate.
 */
import { createDecipheriv, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import kit, { estimateSafeTxGas, estimateTxBaseGas } from '@safe-global/protocol-kit';
import { mandateAccountAbi, mandateAccountFactoryAbi, settlementAssetAbi, toCapabilityId } from '@bursar/core';

// protocol-kit declares no module type, so TypeScript reads its types as CommonJS while Node loads
// the ESM build: the class is the default export at runtime and `.default` to the compiler.
type Safe = kit.default;
const Safe = ((kit as unknown as { default?: typeof kit.default }).default ?? kit) as typeof kit.default;
import {
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  formatUnits,
  hashTypedData,
  http,
  keccak256,
  parseEther,
  toHex,
  zeroAddress,
} from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { SPEND_APPROVAL_TYPES, mandateDomain } from '../src/authorization.js';
import { openConnection } from '../src/connection.js';
import { encodeLimits, mandateAccount } from '../src/mandate.js';
import { usdg } from '../src/money.js';
import type { SpendApproval } from '../src/types.js';

const RPC = process.env.BURSAR_RPC ?? 'https://robinhood.drpc.org';
const KEYSTORES = process.env.BURSAR_KEYSTORE_DIR ?? join(homedir(), '.config', 'bursar', 'keystore');
const RECORD = process.env.SAFE_BUDGETS_RECORD ?? join(import.meta.dirname, '../../../docs/bullish/safe-budgets/record.json');
const SALT = process.env.SAFE_BUDGETS_SALT ?? 'bursar-safe-budgets-1';
const EXPLORER = 'https://robinhoodchain.blockscout.com';

const SAFE_GAS = parseEther('0.0002');
const AGENT_GAS = parseEther('0.00002');
const SAFE_USDG = usdg('0.50');
const PAYMENT = usdg('0.10');
const CAPABILITY = 'doc.summarize:1';

const LIMITS = {
  perCallCap: usdg('0.20'),
  dailyCap: usdg('0.50'),
  monthlyCap: usdg('0.50'),
  dailyWindow: 86_400,
  monthlyWindow: 30 * 86_400,
  approvalThreshold: usdg('0.10'),
};
const RAISED = { ...LIMITS, perCallCap: usdg('0.25') };

type Step = { readonly hash: Hex; readonly explorer: string; readonly signers?: readonly Address[]; readonly note?: string };
type Record_ = {
  chainId: number;
  safe?: { address: Address; owners: Address[]; threshold: number; version: string; deployTx: Step };
  mandate?: { address: Address; salt: Hex };
  agent?: Address;
  steps: { [name: string]: Step };
  signedApproval?: { approval: SpendApproval; digest: Hex; signature: Hex; signers: Address[]; validOnChain: boolean };
};

type Party = { readonly name: string; readonly address: Address; readonly privateKey: Hex };

function password(): string {
  const file = process.env.ETH_PASSWORD;
  if (file === undefined || !existsSync(file)) throw new Error('ETH_PASSWORD has to name the password file: source ops/rhc-env.sh first');
  return readFileSync(file, 'utf8').trim();
}

/** Web3 Secret Storage v3, opened in this process. The key is never printed or written. */
function readKeystore(name: string): Party {
  const store = JSON.parse(readFileSync(join(KEYSTORES, name), 'utf8')) as {
    crypto: {
      cipher: string;
      cipherparams: { iv: string };
      ciphertext: string;
      kdf: string;
      kdfparams: { dklen: number; n: number; p: number; r: number; salt: string };
      mac: string;
    };
  };
  const { kdfparams } = store.crypto;
  if (store.crypto.kdf !== 'scrypt' || store.crypto.cipher !== 'aes-128-ctr') throw new Error(`${name}: unsupported keystore`);
  const key = scryptSync(Buffer.from(password(), 'utf8'), Buffer.from(kdfparams.salt, 'hex'), kdfparams.dklen, {
    N: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    maxmem: 256 * kdfparams.n * kdfparams.r + 1024 * 1024,
  });
  const ciphertext = Buffer.from(store.crypto.ciphertext, 'hex');
  if (keccak256(Buffer.concat([key.subarray(16, 32), ciphertext])).slice(2) !== store.crypto.mac.toLowerCase()) {
    throw new Error(`${name} did not open: wrong password`);
  }
  const decipher = createDecipheriv('aes-128-ctr', key.subarray(0, 16), Buffer.from(store.crypto.cipherparams.iv, 'hex'));
  const privateKey = `0x${Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('hex')}` as Hex;
  return { name, address: privateKeyToAccount(privateKey).address, privateKey };
}

function loadRecord(): Record_ {
  if (!existsSync(RECORD)) return { chainId: 4663, steps: {} };
  return JSON.parse(readFileSync(RECORD, 'utf8')) as Record_;
}

const record = loadRecord();
function save() {
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, `${JSON.stringify(record, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`);
}

const payer = readKeystore('payer');
const payee = readKeystore('payee');
const filmOwner = readKeystore('film-owner');
const agent = readKeystore('film-agent-2');

const connection = await openConnection({ rpc: RPC }, 'safe-budgets');
const chain = connection.publicClient;
const { escrow, mandateAccountFactory: factory, settlementAsset: usdgAddress } = connection.addresses;
const chainId = connection.chain.chainId;
if (chainId !== 4663) throw new Error(`expected Robinhood Chain 4663, got ${chainId}`);
record.chainId = chainId;

const payerWallet = createWalletClient({ account: privateKeyToAccount(payer.privateKey), chain: chain.chain, transport: http(RPC) });

const link = (hash: Hex) => `${EXPLORER}/tx/${hash}`;

async function landed(hash: Hex, label: string) {
  const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${link(hash)}`);
  console.log(`  ${label}: ${link(hash)} (${receipt.gasUsed} gas)`);
  return receipt;
}

async function fromPayer(name: string, label: string, tx: { to: Address; value?: bigint; data?: Hex }) {
  if (record.steps[name]) return console.log(`  ${label}: already done, ${record.steps[name]!.explorer}`);
  const hash = await payerWallet.sendTransaction({ ...tx, chain: chain.chain });
  await landed(hash, label);
  record.steps[name] = { hash, explorer: link(hash) };
  save();
}

const safes = new Map<string, Safe>();
async function safeAs(party: Party): Promise<Safe> {
  let kit = safes.get(party.name);
  if (kit === undefined) {
    kit = await Safe.init({ provider: RPC, signer: party.privateKey, safeAddress: record.safe!.address });
    safes.set(party.name, kit);
  }
  return kit;
}

const SAFE_EVENTS = [
  { type: 'event', name: 'ExecutionSuccess', inputs: [{ name: 'txHash', type: 'bytes32', indexed: true }, { name: 'payment', type: 'uint256' }] },
  { type: 'event', name: 'ExecutionFailure', inputs: [{ name: 'txHash', type: 'bytes32', indexed: true }, { name: 'payment', type: 'uint256' }] },
] as const;

/**
 * One Safe transaction: drafted by the payer, signed by the payer and the payee, sent by the payer,
 * and refunded by the Safe at the gas price the signers approved, so the treasury pays its own gas.
 */
async function fromSafe(name: string, label: string, transactions: { to: Address; value?: bigint; data: Hex }[]) {
  if (record.steps[name]) return console.log(`  ${label}: already done, ${record.steps[name]!.explorer}`);
  const first = await safeAs(payer);
  const second = await safeAs(payee);
  const calls = transactions.map((tx) => ({ to: tx.to, value: (tx.value ?? 0n).toString(), data: tx.data }));

  const draft = await first.createTransaction({ transactions: calls, onlyCalls: true });
  const safeTxGas = (BigInt(await estimateSafeTxGas(first, draft)) * 13n) / 10n;
  const baseGas = BigInt(await estimateTxBaseGas(first, draft)) + 20_000n;
  const gasPrice = ((await chain.getGasPrice()) * 3n) / 2n;
  const tx = await first.createTransaction({
    transactions: calls,
    onlyCalls: true,
    options: { safeTxGas: safeTxGas.toString(), baseGas: baseGas.toString(), gasPrice: gasPrice.toString(), refundReceiver: payer.address },
  });

  const signedOnce = await first.signTransaction(tx);
  const signedTwice = await second.signTransaction(signedOnce);
  const signers = [...signedTwice.signatures.keys()].map((signer) => signer as Address);
  if (signers.length !== 2) throw new Error(`${label}: expected two signatures, have ${signers.length}`);

  // The Safe forwards exactly safeTxGas to the call and checks 64/63 of it is still there first;
  // on this chain the sender's gas also covers the data posted to Ethereum, so the ceiling is wide.
  const result = await first.executeTransaction(signedTwice, { gasLimit: (safeTxGas * 64n) / 63n + baseGas + 400_000n });
  const hash = result.hash as Hex;
  const receipt = await landed(hash, label);
  const outcome = receipt.logs
    .filter((log) => log.address.toLowerCase() === record.safe!.address.toLowerCase())
    .flatMap((log) => {
      try {
        return [decodeEventLog({ abi: SAFE_EVENTS, data: log.data, topics: log.topics })];
      } catch {
        return [];
      }
    })
    .find((event) => event.eventName === 'ExecutionSuccess' || event.eventName === 'ExecutionFailure');
  if (outcome?.eventName !== 'ExecutionSuccess') throw new Error(`${label}: the Safe recorded ${outcome?.eventName ?? 'no outcome'}: ${link(hash)}`);
  record.steps[name] = { hash, explorer: link(hash), signers, note: `refunded ${formatEther(outcome.args.payment)} ETH to the sender` };
  save();
}

const balance = async (address: Address) => ({
  eth: formatEther(await chain.getBalance({ address })),
  usdg: formatUnits(await chain.readContract({ address: usdgAddress, abi: settlementAssetAbi, functionName: 'balanceOf', args: [address] }), 6),
});

console.log(`chain ${chainId} via ${RPC}`);
console.log(`payer ${payer.address}`, await balance(payer.address));

// 1. The Safe: 2 of 3, owners payer, payee and the film owner, Safe 1.4.1 at its canonical addresses.
if (record.safe === undefined) {
  const predicted = await Safe.init({
    provider: RPC,
    signer: payer.privateKey,
    predictedSafe: {
      safeAccountConfig: { owners: [payer.address, payee.address, filmOwner.address], threshold: 2 },
      safeDeploymentConfig: { saltNonce: BigInt(keccak256(toHex(SALT))).toString(), safeVersion: '1.4.1' },
    },
  });
  const address = (await predicted.getAddress()) as Address;
  console.log(`safe ${address} (predicted)`);
  let deployTx: Step;
  if (await predicted.isSafeDeployed()) {
    deployTx = { hash: '0x', explorer: `${EXPLORER}/address/${address}`, note: 'already deployed before this run' };
  } else {
    const deployment = await predicted.createSafeDeploymentTransaction();
    const hash = await payerWallet.sendTransaction({
      to: deployment.to as Address,
      value: BigInt(deployment.value),
      data: deployment.data as Hex,
      chain: chain.chain,
    });
    await landed(hash, 'deploy the Safe');
    deployTx = { hash, explorer: link(hash) };
  }
  record.safe = { address, owners: [payer.address, payee.address, filmOwner.address], threshold: 2, version: '1.4.1', deployTx };
  save();
}
const safeAddress = record.safe.address;
console.log(`safe ${safeAddress}`, await balance(safeAddress));

// 2. Gas and the budget, from the payer to the Safe.
await fromPayer('fund-safe-eth', 'ETH for gas to the Safe', { to: safeAddress, value: SAFE_GAS });
await fromPayer('fund-safe-usdg', '$0.50 USDG to the Safe', {
  to: usdgAddress,
  data: encodeFunctionData({ abi: settlementAssetAbi, functionName: 'transfer', args: [safeAddress, SAFE_USDG] }),
});

// 3. The mandate, created by the Safe. The factory accepts the principal alone as its creator.
const salt = keccak256(toHex(`${SALT}:mandate`));
const limits = encodeLimits(LIMITS);
const mandateAddress = (await chain.readContract({
  address: factory,
  abi: mandateAccountFactoryAbi,
  functionName: 'predict',
  args: [safeAddress, zeroAddress, salt, limits],
})) as Address;
record.mandate = { address: mandateAddress, salt };
save();
console.log(`mandate ${mandateAddress} (predicted)`);
await fromSafe('create', 'create the mandate', [
  { to: factory, data: encodeFunctionData({ abi: mandateAccountFactoryAbi, functionName: 'create', args: [safeAddress, zeroAddress, salt, limits] }) },
]);

// 4. Funded from the Safe: the allowance and the deposit in one Safe transaction.
await fromSafe('fund', 'fund the mandate with $0.50', [
  { to: usdgAddress, data: encodeFunctionData({ abi: settlementAssetAbi, functionName: 'approve', args: [mandateAddress, SAFE_USDG] }) },
  { to: mandateAddress, data: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'deposit', args: [SAFE_USDG] }) },
]);

// 5. A limit changed: the per-payment cap goes from $0.20 to $0.25.
await fromSafe('limits', 'raise the per-payment cap to $0.25', [
  { to: mandateAddress, data: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setLimits', args: [encodeLimits(RAISED)] }) },
]);

// 6. An agent seated, with the payee and the kind of work it may buy. A bare label is a service,
// which is the class `pay` files it under.
const capabilityId = toCapabilityId(`service:${CAPABILITY}`);
record.agent = agent.address;
await fromSafe('seat', 'seat the agent, allow the payee and the capability', [
  { to: mandateAddress, data: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setAgent', args: [agent.address] }) },
  { to: mandateAddress, data: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setMerchant', args: [payee.address, true] }) },
  { to: mandateAddress, data: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setCapability', args: [capabilityId, true] }) },
]);

if (!(await chain.readContract({ address: mandateAddress, abi: mandateAccountAbi, functionName: 'capabilities', args: [capabilityId] }))) {
  await fromSafe('capability', 'allow the capability the agent pays under', [
    { to: mandateAddress, data: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setCapability', args: [capabilityId, true] }) },
  ]);
}

// 7. An approval registered on chain, the path for a wallet that cannot sign a typed message.
const registered: SpendApproval = {
  approvalId: keccak256(toHex(`${SALT}:approval:registered`)),
  merchant: payee.address,
  capabilityId,
  amount: PAYMENT,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400),
};
await fromSafe('approve', 'register an approval for $0.10', [
  { to: mandateAddress, data: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'approveSpend', args: [registered] }) },
]);

// 8. An approval signed off chain by two owners, checked by the mandate through ERC-1271.
if (record.signedApproval === undefined) {
  const approval: SpendApproval = {
    approvalId: keccak256(toHex(`${SALT}:approval:signed`)),
    merchant: payee.address,
    capabilityId,
    amount: PAYMENT,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400),
  };
  const typed = { domain: mandateDomain(mandateAddress, chainId), types: SPEND_APPROVAL_TYPES, primaryType: 'SpendApproval' as const, message: approval };
  const digest = hashTypedData(typed);
  const first = await safeAs(payer);
  const second = await safeAs(payee);
  const message = first.createMessage({
    domain: typed.domain,
    primaryType: typed.primaryType,
    types: { SpendApproval: [...SPEND_APPROVAL_TYPES.SpendApproval] },
    message: { ...approval, amount: approval.amount.toString(), expiry: approval.expiry.toString() },
  });
  const signedOnce = await first.signMessage(message);
  const signedTwice = await second.signMessage(signedOnce);
  const signature = signedTwice.encodedSignatures() as Hex;
  const magic = await chain.readContract({
    address: safeAddress,
    abi: [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const,
    functionName: 'isValidSignature',
    args: [digest, signature],
  });
  const validOnChain = magic === '0x1626ba7e';
  console.log(`  signed approval: ${validOnChain ? 'the Safe accepts the two signatures' : `the Safe answered ${magic}`}`);
  if (!validOnChain) throw new Error('the Safe refused the signed approval');
  record.signedApproval = { approval, digest, signature, signers: [...signedTwice.signatures.keys()] as Address[], validOnChain };
  save();
}

// 9. The agent pays the payee $0.10 with the Safe-signed approval.
await fromPayer('fund-agent-eth', 'ETH for gas to the agent', { to: agent.address, value: AGENT_GAS });
if (record.steps['pay'] === undefined) {
  const mandate = await mandateAccount(mandateAddress, { rpc: RPC, account: agent.privateKey });
  const receipt = await mandate.pay({
    to: payee.address,
    amount: PAYMENT,
    capability: CAPABILITY,
    input: { task: 'summarise', document: 'The quarterly treasury report, twelve pages.' },
    // Read back from the record, where JSON holds the two numbers as strings.
    approval: {
      approval: { ...record.signedApproval.approval, amount: BigInt(record.signedApproval.approval.amount), expiry: BigInt(record.signedApproval.approval.expiry) },
      signature: record.signedApproval.signature,
    },
  });
  console.log(`  payment: ${receipt.explorer} escrow ${receipt.escrowId}`);
  record.steps['pay'] = { hash: receipt.hash, explorer: receipt.explorer, note: `escrow lock ${receipt.escrowId}, sent by the agent with the Safe's signature` };
  save();
}

const status = await (await mandateAccount(mandateAddress, { rpc: RPC })).status();
console.log('mandate', { balance: formatUnits(status.balance, 6), perPayment: formatUnits(status.limits.perCallCap, 6), agent: record.agent });
console.log(`safe ${safeAddress}`, await balance(safeAddress));
console.log(`payer ${payer.address}`, await balance(payer.address));
console.log(`escrow ${escrow}`);
console.log(`record written to ${RECORD}`);
