import type { ShieldedDeployment } from '@bursar/core';
import type { AssociationSet, FundsKeyContext, OwnedNote, PoolEvents, RelayQuote, ShieldedKeys } from '@bursar/sdk';
import { getAddress, isAddress } from 'viem';
import type { Address, Hex } from 'viem';

import { rhcClient } from './client';
import { privateContracts } from './private';
import { CHAIN_ID } from './rhc';

/**
 * The shielded USDG pool, as the console reads and drives it.
 *
 * Deposits are sent from the connected wallet and are public. Withdrawals are proved in this page
 * and handed to the relayer, which submits them, so the wallet never signs the transaction that
 * pays the recipient. Nothing here falls back to sending a withdrawal from the wallet: that would
 * put the wallet on the payout and undo the point of the pool.
 */

export function shieldedContracts(): ShieldedDeployment | undefined {
  return privateContracts()?.shielded;
}

/**
 * What a funds-key signature is bound to: the wallet and this chain, and no contract, so the same
 * signature keeps finding the same deposits and hidden owners after a redeploy.
 */
export function fundsKeyContext(account: Address): FundsKeyContext {
  return { account, chainId: CHAIN_ID };
}

/** Service endpoints, set at build time. Empty means not configured. */
export function shieldedServices(env: Record<string, string | undefined> = publicEnv()): { relayer?: string; asp?: string } {
  const relayer = env['NEXT_PUBLIC_BURSAR_RELAYER_URL']?.trim();
  const asp = env['NEXT_PUBLIC_BURSAR_ASP_URL']?.trim();
  return { ...(relayer ? { relayer } : {}), ...(asp ? { asp } : {}) };
}

// Next inlines NEXT_PUBLIC_* only where the property is spelled out.
function publicEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_BURSAR_RELAYER_URL: process.env.NEXT_PUBLIC_BURSAR_RELAYER_URL,
    NEXT_PUBLIC_BURSAR_ASP_URL: process.env.NEXT_PUBLIC_BURSAR_ASP_URL,
  };
}

/** The proving files, served from /shielded by the build (scripts/shielded-artifacts.ts). */
export const SHIELDED_ARTIFACT_URLS = {
  withdraw: { wasm: '/shielded/withdraw.wasm', zkey: '/shielded/withdraw.zkey' },
  commitment: { wasm: '/shielded/commitment.wasm', zkey: '/shielded/commitment.zkey' },
} as const;

export type PoolLimits = {
  readonly minimumDeposit: bigint;
  readonly maxDeposit: bigint;
  readonly maxTotal: bigint;
};

export function poolLimits(contracts: ShieldedDeployment): PoolLimits {
  return {
    minimumDeposit: BigInt(contracts.minimumDeposit),
    maxDeposit: BigInt(contracts.maxDeposit),
    maxTotal: BigInt(contracts.maxTotal),
  };
}

/** Why a deposit of `amount` would be refused, before the wallet opens. Undefined when it would go through. */
export function depositProblem(args: {
  amount: bigint | undefined;
  limits: PoolLimits;
  poolBalance: bigint | undefined;
  walletBalance: bigint | undefined;
}): string | undefined {
  const { amount, limits, poolBalance, walletBalance } = args;
  if (amount === undefined || amount === 0n) return undefined;
  if (amount < limits.minimumDeposit) return `The smallest deposit is ${usdgText(limits.minimumDeposit)} USDG.`;
  if (amount > limits.maxDeposit) return `One deposit can be at most ${usdgText(limits.maxDeposit)} USDG.`;
  if (poolBalance !== undefined && poolBalance + amount > limits.maxTotal) {
    const room = limits.maxTotal > poolBalance ? limits.maxTotal - poolBalance : 0n;
    return room === 0n
      ? `The pool is full at ${usdgText(limits.maxTotal)} USDG.`
      : `The pool holds at most ${usdgText(limits.maxTotal)} USDG, so it can take ${usdgText(room)} more.`;
  }
  if (walletBalance !== undefined && amount > walletBalance) return `This wallet holds ${usdgText(walletBalance)} USDG.`;
  return undefined;
}

/** Why a withdrawal of `amount` from `note` cannot be sent. */
export function withdrawProblem(args: { amount: bigint | undefined; note: Pick<OwnedNote, 'value'>; inSet: boolean }): string | undefined {
  const { amount, note, inSet } = args;
  if (!inSet) return 'This deposit is waiting for the next association set. It can be withdrawn once the set includes it.';
  if (amount === undefined || amount === 0n) return undefined;
  if (amount > note.value) return `This deposit holds ${usdgText(note.value)} USDG.`;
  return undefined;
}

export function usdgText(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** What a withdrawal is for. The purpose sets the copy and whether the relayer sends gas along. */
export type WithdrawPurpose = 'mandate' | 'stealth-owner' | 'provider';

export const PURPOSES: Readonly<Record<WithdrawPurpose, { readonly label: string; readonly hint: string; readonly gasDrop: boolean }>> = {
  mandate: {
    label: 'Fund a mandate',
    hint: 'Sends USDG to a mandate account. The payout comes from the pool, so the mandate shows no link to this wallet.',
    gasDrop: false,
  },
  'stealth-owner': {
    label: 'Fund a hidden owner',
    hint: 'Sends USDG and a little gas to the owner address of a private mandate, so it can act without a transfer from this wallet.',
    gasDrop: true,
  },
  provider: {
    label: 'Pay a provider',
    hint: 'Pays a provider’s address from the pool. The provider sees the payment arrive from the pool, with no sender behind it.',
    gasDrop: false,
  },
};

export type WithdrawIntent = { readonly purpose: WithdrawPurpose; readonly recipient: Address | undefined };

/** Reads `?for=mandate|stealth-owner|provider&to=0x…` so other pages can send a person here with the recipient filled in. */
export function intentFromQuery(params: { get(name: string): string | null }): WithdrawIntent {
  const raw = params.get('for');
  const purpose: WithdrawPurpose = raw === 'mandate' || raw === 'stealth-owner' || raw === 'provider' ? raw : 'mandate';
  const to = params.get('to')?.trim();
  return { purpose, recipient: to && isAddress(to, { strict: false }) ? getAddress(to) : undefined };
}

export function shieldedHref(purpose: WithdrawPurpose, recipient: Address): string {
  return `/console/shielded?for=${purpose}&to=${recipient}`;
}

/**
 * Whether a set can be proved against. The pool only accepts proofs for the newest root on chain, so
 * a set from the service that has not been posted yet, or an old one, would make a proof that is
 * refused at submission.
 */
export function setMatchesChain(set: Pick<AssociationSet, 'root'> | undefined, latestRoot: bigint | undefined): boolean {
  if (set === undefined || latestRoot === undefined) return false;
  return BigInt(set.root) === latestRoot;
}

export function labelInSet(set: Pick<AssociationSet, 'labels'> | undefined, label: bigint): boolean {
  return set?.labels.includes(label.toString()) ?? false;
}

/** The relayer's fee on an amount, as the relay contract computes it. */
export function relayFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / 10_000n;
}

export type PoolReading = {
  readonly events: PoolEvents;
  readonly poolBalance: bigint;
  readonly latestRoot: bigint | undefined;
};

const entrypointReads = [
  { type: 'function', name: 'latestRoot', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

const balanceOf = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export async function readPool(contracts: ShieldedDeployment): Promise<PoolReading> {
  const { fetchPoolEvents } = await import('@bursar/sdk');
  const client = rhcClient();
  const [events, poolBalance, latestRoot] = await Promise.all([
    fetchPoolEvents(client, { pool: contracts.ShieldedPool, fromBlock: BigInt(contracts.fromBlock) }),
    client.readContract({ address: contracts.asset, abi: balanceOf, functionName: 'balanceOf', args: [contracts.ShieldedPool] }),
    // Before the first set is posted the Entrypoint reverts; that reads as no set.
    client.readContract({ address: contracts.Entrypoint, abi: entrypointReads, functionName: 'latestRoot' }).catch(() => undefined),
  ]);
  return { events, poolBalance, latestRoot };
}

/**
 * The association set, from the association-set service when one is configured, otherwise rebuilt
 * here from the pool's deposits and the access registry by the same rule the service applies.
 */
export async function readAssociationSet(contracts: ShieldedDeployment, reading: PoolReading, aspUrl: string | undefined): Promise<AssociationSet> {
  const sdk = await import('@bursar/sdk');
  if (aspUrl) return sdk.fetchAssociationSet(aspUrl);
  const blocked = await sdk.blockedDepositors(rhcClient(), reading.events.deposits.map((d) => d.depositor), contracts.AccessRegistry);
  return sdk.buildAssociationSet({
    chainId: CHAIN_ID,
    pool: contracts.ShieldedPool,
    scope: BigInt(contracts.scope),
    deposits: reading.events.deposits,
    blocked,
    throughBlock: reading.events.toBlock,
  });
}

export async function shieldedKeysFrom(signature: Hex, context: FundsKeyContext): Promise<ShieldedKeys> {
  const { deriveShieldedKeys } = await import('@bursar/sdk');
  return deriveShieldedKeys(signature, context);
}

export async function ownNotes(keys: ShieldedKeys, contracts: ShieldedDeployment, events: PoolEvents) {
  const { recoverNotes } = await import('@bursar/sdk');
  return recoverNotes({ keys, scope: BigInt(contracts.scope), events });
}

export async function depositPrecommitment(keys: ShieldedKeys, contracts: ShieldedDeployment, index: bigint): Promise<bigint> {
  const { depositSecrets, precommitmentOf } = await import('@bursar/sdk');
  return precommitmentOf(depositSecrets(keys, BigInt(contracts.scope), index));
}

/**
 * Proves a withdrawal in this page and hands it to the relayer. The proof binds the recipient, the
 * fee and the relay contract, so the relayer can submit it and nothing else.
 *
 * The association-set service posts a new root every few minutes and the pool takes proofs against
 * the newest only. When one lands between the proof and the submission, the pool and the set are read
 * again and the withdrawal is proved again, a couple of times at most.
 */
export async function withdrawThroughRelayer(args: {
  keys: ShieldedKeys;
  contracts: ShieldedDeployment;
  note: OwnedNote;
  amount: bigint;
  recipient: Address;
  gasDrop: boolean;
  relayerUrl: string;
  aspUrl: string | undefined;
  quote: RelayQuote;
  events: PoolEvents;
  set: AssociationSet;
}): Promise<{ transactionHash: Hex; gasDropWei: string }> {
  const sdk = await import('@bursar/sdk');
  const { proveWithdrawal } = await import('@bursar/sdk/shielded-prove');
  const { contracts, quote } = args;
  if (getAddress(quote.relay) !== getAddress(contracts.ShieldedRelay)) {
    throw new Error('The relayer named a different relay contract from this deployment. Nothing was sent.');
  }
  const scope = BigInt(contracts.scope);
  const withdrawal = {
    processooor: contracts.ShieldedRelay,
    data: sdk.encodeRelayData({ recipient: args.recipient, feeRecipient: quote.feeRecipient, relayFeeBPS: BigInt(quote.feeBps) }),
  };
  const fresh = async (attempt: number): Promise<{ events: PoolEvents; set: AssociationSet }> => {
    if (attempt === 1) return { events: args.events, set: args.set };
    const reading = await readPool(contracts);
    const set = await readAssociationSet(contracts, reading, args.aspUrl);
    if (!setMatchesChain(set, reading.latestRoot)) {
      throw new Error('The association set changed and its new root is not posted yet. Try again in a few minutes.');
    }
    return { events: reading.events, set };
  };
  return sdk.relayWithFreshProof({
    relayerUrl: args.relayerUrl,
    withdrawal,
    gasDrop: args.gasDrop,
    prove: async (attempt) => {
      const { events, set } = await fresh(attempt);
      const { proof } = await proveWithdrawal({
        note: args.note,
        amount: args.amount,
        change: sdk.changeSecrets(args.keys, args.note.label, BigInt(args.note.withdrawals)),
        stateLeaves: events.leaves,
        aspLabels: set.labels.map((label) => BigInt(label)),
        context: sdk.withdrawalContext(withdrawal, scope),
        artifacts: SHIELDED_ARTIFACT_URLS.withdraw,
      });
      return proof;
    },
  });
}

export async function ragequitProof(note: OwnedNote) {
  const { proveRagequit } = await import('@bursar/sdk/shielded-prove');
  return proveRagequit(note, SHIELDED_ARTIFACT_URLS.commitment);
}
