import { committedMandateAccountAbi, settlementAssetAbi } from '@bursar/core';
import type { AgentHandoff, GeneratedStealthAddress, RecoveredMandate, StealthIdentity, StealthKeys, StealthMandatePlan, StealthRole, TermsDocument } from '@bursar/sdk';
import { createWalletClient, custom } from 'viem';
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hex, PublicClient, TransactionReceipt } from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';

import { rhcClient } from './client';
import { CHAIN, CHAIN_ID, sameAddress } from './rhc';

/**
 * Private owners: a mandate whose owner and agent are fresh stealth addresses drawn from the
 * connected wallet's keys. The stealth keys live in this page's memory for as long as it is open and
 * are derived again from the same wallet signature next time; nothing here is stored.
 */

export const STEALTH_LIMIT_LINE =
  'Gas and USDG sent straight from this wallet to the new addresses are visible on chain and link them to it. Funding them from your shielded funds avoids that direct transfer. While you are the pool’s only depositor, that funding can still be matched to your deposit.';

/** What the pool cannot hide, said wherever shielded funding is offered, before anyone commits. */
export const SHIELDED_TIMING_LINE =
  'A payout from the pool hides which depositor it came from only among the wallets that have deposited. While you are the only depositor, anything paid out of the pool can be matched to your deposit. Once others deposit, leave time between your deposit and a payout and use a different amount, since a close match in timing and amount can still be linked.';

/** Two announcements and the create, with room to spare. The create alone measured 1.64M on 4663. */
export const STEALTH_CREATE_GAS = 2_000_000n;
/** One proven payment measured 766k gas; the agent gets enough for several. */
export const AGENT_SPEND_GAS = 900_000n;
export const AGENT_PAYMENTS_FUNDED = 5n;

/** What the owner-side address needs before it can announce and create, at twice today's price. */
export function createGasWei(gasPrice: bigint): bigint {
  return STEALTH_CREATE_GAS * gasPrice * 2n;
}

export function agentGasWei(gasPrice: bigint): bigint {
  return AGENT_SPEND_GAS * AGENT_PAYMENTS_FUNDED * gasPrice * 2n;
}

/** How much of a top-up the owner-side address can pass to the agent and still send the transfer. */
export function spareForAgent(balance: bigint, gasPrice: bigint, wanted: bigint): bigint {
  const fee = 21_000n * gasPrice * 2n;
  const spare = balance > fee ? balance - fee : 0n;
  return spare < wanted ? spare : wanted;
}

export type StealthStep = 'announce-owner' | 'announce-agent' | 'create';

export const STEALTH_STEP_LABEL: Record<StealthStep, string> = {
  'announce-owner': 'Announce the owner address',
  'announce-agent': 'Announce the agent address',
  create: 'Create the mandate',
};

/** The steps still to run, in order, given the ones already confirmed. */
export function remainingSteps(done: ReadonlySet<StealthStep>): readonly StealthStep[] {
  return (['announce-owner', 'announce-agent', 'create'] as const).filter((step) => !done.has(step));
}

/** Sends one call signed by a stealth key through the same pooled client every read uses. */
export async function sendFromStealth<const abi extends Abi, name extends ContractFunctionName<abi, 'nonpayable' | 'payable'>>(
  privateKey: Hex,
  call: {
    address: Address;
    abi: abi;
    functionName: name;
    args: ContractFunctionArgs<abi, 'nonpayable' | 'payable', name>;
  },
  client: PublicClient = rhcClient() as unknown as PublicClient,
): Promise<TransactionReceipt> {
  const account = privateKeyToAccount(privateKey);
  const { request } = await client.simulateContract({ ...call, account } as never);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: custom({ request: client.request }) });
  const hash = await wallet.writeContract(request as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`The transaction reverted: ${hash}`);
  return receipt;
}

export async function sendEthFromStealth(
  privateKey: Hex,
  to: Address,
  value: bigint,
  client: PublicClient = rhcClient() as unknown as PublicClient,
): Promise<TransactionReceipt> {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: custom({ request: client.request }) });
  const hash = await wallet.sendTransaction({ to, value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`The transfer reverted: ${hash}`);
  return receipt;
}

export type AgentKeyFile = { readonly name: string; readonly body: string };

export async function agentKeyFile(args: {
  mandate: Address;
  privateKey: Hex;
  terms: TermsDocument;
  fromBlock: number | bigint;
}): Promise<AgentKeyFile> {
  const { agentHandoff, agentHandoffFileName } = await import('@bursar/sdk');
  const handoff: AgentHandoff = agentHandoff({ chainId: CHAIN_ID, ...args });
  return { name: agentHandoffFileName(args.mandate), body: `${JSON.stringify(handoff, null, 2)}\n` };
}

export function downloadFile(file: AgentKeyFile): void {
  const blob = new Blob([file.body], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(url);
}

export type OwnedPrivateMandate = RecoveredMandate & {
  readonly balance: bigint;
  readonly paused: boolean;
  readonly revoked: boolean;
  /** ETH on the owner-side address, which pays for pause and resume. */
  readonly ownerGas: bigint;
  readonly agentGas: bigint;
};

type ScanClient = Pick<PublicClient, 'getLogs' | 'getBlockNumber' | 'readContract' | 'getBalance'>;

/**
 * Every private mandate this owner holds, found from public announcements with its keys. Nothing
 * about the owner's wallet is sent anywhere: the scan reads every scheme-1 announcement and tests
 * each one locally.
 */
export async function scanOwnedMandates(args: {
  keys: StealthKeys;
  factories: readonly Address[];
  fromBlock: bigint;
  client?: ScanClient;
}): Promise<readonly OwnedPrivateMandate[]> {
  const client = args.client ?? (rhcClient() as unknown as ScanClient);
  const { fetchAnnouncements, recoverStealthMandates, scanAnnouncements } = await import('@bursar/sdk');
  const announcements = await fetchAnnouncements(client, { fromBlock: args.fromBlock });
  const matches = scanAnnouncements(announcements, args.keys);
  const recovered = await recoverStealthMandates(client, matches, args.factories);
  return Promise.all(
    recovered.map(async (entry) => {
      const abi = committedMandateAccountAbi;
      const [asset, paused, revoked, ownerGas, agentGas] = await Promise.all([
        client.readContract({ address: entry.mandate, abi, functionName: 'settlementAsset' }),
        client.readContract({ address: entry.mandate, abi, functionName: 'paused' }),
        client.readContract({ address: entry.mandate, abi, functionName: 'revoked' }),
        client.getBalance({ address: entry.principal.stealthAddress }),
        client.getBalance({ address: entry.agent }),
      ]);
      const balance = await client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'balanceOf', args: [entry.mandate] });
      return { ...entry, balance, paused, revoked, ownerGas, agentGas };
    }),
  );
}

export type OwnerKeys = { readonly stealth: StealthKeys; readonly termsKey: Uint8Array };

/**
 * The two addresses drawn for a hidden owner and agent, kept until the mandate exists.
 *
 * The draw is random and its ephemeral keys live in the page, so a reload between sending gas to
 * the owner address and announcing it used to strand that gas: nothing could find the address
 * again. Only the public half is kept, and the private keys are recomputed from the wallet's
 * signature, so what sits in storage opens nothing on its own.
 */
export type SavedDraw = Readonly<Record<StealthRole, GeneratedStealthAddress>>;

const drawKey = (owner: Address) => `bursar.stealth-draw.${owner.toLowerCase()}`;

export function readDraw(owner: Address): SavedDraw | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(drawKey(owner));
    return raw ? (JSON.parse(raw) as SavedDraw) : undefined;
  } catch {
    return undefined;
  }
}

export function keepDraw(owner: Address, plan: StealthMandatePlan): void {
  const draw: SavedDraw = { principal: plan.principal.announcement, agent: plan.agent.announcement };
  try {
    globalThis.localStorage?.setItem(drawKey(owner), JSON.stringify(draw));
  } catch {
    // Storage refused (private mode, quota): the draw lives in the page only, as it did before.
  }
}

export function forgetDraw(owner: Address): void {
  try {
    globalThis.localStorage?.removeItem(drawKey(owner));
  } catch {
    // Nothing kept, nothing to remove.
  }
}

/** The plan again from a kept draw, or undefined when the draw was not made with these keys. */
export async function planFromDraw(keys: StealthKeys, draw: SavedDraw): Promise<StealthMandatePlan | undefined> {
  const { computeStealthKey } = await import('@bursar/sdk');
  const identity = (role: StealthRole): StealthIdentity | undefined => {
    const announcement = draw[role];
    const privateKey = computeStealthKey({
      ephemeralPublicKey: announcement.ephemeralPublicKey,
      viewingPrivateKey: keys.viewingPrivateKey,
      spendingPrivateKey: keys.spendingPrivateKey,
    });
    return sameAddress(privateKeyToAddress(privateKey), announcement.stealthAddress) ? { address: announcement.stealthAddress, privateKey, announcement, role } : undefined;
  };
  const principal = identity('principal');
  const agent = identity('agent');
  return principal && agent ? { principal, agent } : undefined;
}

/** The owner's stealth keys and terms key, from the one viewing-key signature. */
export async function ownerKeysFrom(signature: Hex): Promise<OwnerKeys> {
  const { deriveStealthKeys, deriveViewingKey } = await import('@bursar/sdk');
  return { stealth: deriveStealthKeys(signature), termsKey: deriveViewingKey(signature).termsKey };
}

/** ETH to three significant figures, enough for the gas amounts this chain charges. */
export function formatEth(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return '0 ETH';
  return `${eth.toPrecision(3).replace(/\.?0+(e|$)/, '$1')} ETH`;
}
