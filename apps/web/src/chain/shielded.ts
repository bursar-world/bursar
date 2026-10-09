import type { ShieldedDeployment } from '@bursar/core';
import { relayFeeBpsFor, smallestWithGas } from '@bursar/sdk';
import type { AssociationSet, DepositRoom, FundsKeyContext, OwnedNote, PoolEvents, RelayQuote, ShieldedKeys } from '@bursar/sdk';
import { getAddress, isAddress } from 'viem';
import type { Address, Hex } from 'viem';

import { rhcClient } from './client';
import { chainNow, formatDuration } from '../lib/time';
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

/**
 * Why a deposit of `amount` would be refused, before the wallet opens, in the order the pool checks.
 * Undefined when it would go through. `room` is what the pool will still take from this wallet in
 * its current window; a pool from before v4 holds nobody to a window and answers none, and the check
 * is skipped the way that pool skips it.
 */
export function depositProblem(args: {
  amount: bigint | undefined;
  limits: PoolLimits;
  poolBalance: bigint | undefined;
  walletBalance: bigint | undefined;
  room?: DepositRoom | undefined;
  now?: Date;
}): string | undefined {
  const { amount, limits, poolBalance, walletBalance, room } = args;
  if (amount === undefined || amount === 0n) return undefined;
  if (amount < limits.minimumDeposit) return `The smallest deposit is ${usdgText(limits.minimumDeposit)} USDG.`;
  if (amount > limits.maxDeposit) return `One deposit can be at most ${usdgText(limits.maxDeposit)} USDG.`;
  if (room !== undefined && amount > room.room) {
    const resets = room.resetsAt === null ? '' : ` ${resetLine(room.resetsAt, args.now ?? chainNow())}`;
    return room.room === 0n
      ? `This wallet has put in ${usdgText(room.cap)} USDG, the most one wallet can in ${windowText(room.window)}.${resets}`
      : `This wallet can put in ${usdgText(room.room)} USDG more: one wallet can put in at most ${usdgText(room.cap)} USDG in ${windowText(room.window)}.${resets}`;
  }
  if (poolBalance !== undefined && poolBalance + amount > limits.maxTotal) {
    const room = limits.maxTotal > poolBalance ? limits.maxTotal - poolBalance : 0n;
    return room === 0n
      ? `The pool is full at ${usdgText(limits.maxTotal)} USDG.`
      : `The pool holds at most ${usdgText(limits.maxTotal)} USDG, so it can take ${usdgText(room)} more.`;
  }
  if (walletBalance !== undefined && amount > walletBalance) return `This wallet holds ${usdgText(walletBalance)} USDG.`;
  return undefined;
}

/** What this wallet may still put in, for the line under the deposit field. Undefined on a pool with no window. */
export function depositRoomLine(room: DepositRoom | undefined, now: Date = chainNow()): string | undefined {
  if (room === undefined) return undefined;
  const window = windowText(room.window);
  if (room.resetsAt === null) return `This wallet can put in up to ${usdgText(room.cap)} USDG in any ${window}.`;
  if (room.room === 0n) return `This wallet has put in its ${usdgText(room.cap)} USDG for this window. ${resetLine(room.resetsAt, now)}`;
  return `This wallet can put in ${usdgText(room.room)} USDG more this window, of ${usdgText(room.cap)} USDG in ${window}. ${resetLine(room.resetsAt, now)}`;
}

function resetLine(resetsAt: Date, now: Date): string {
  const seconds = Math.floor((resetsAt.getTime() - now.getTime()) / 1000);
  return seconds <= 0 ? 'Its window has just reset.' : `Its window resets in ${formatDuration(seconds)}.`;
}

/** A window is set in whole days, hours or minutes. */
function windowText(seconds: bigint): string {
  const value = Number(seconds);
  if (value % 86_400 === 0) return value === 86_400 ? 'a day' : `${value / 86_400} days`;
  if (value % 3_600 === 0) return value === 3_600 ? 'an hour' : `${value / 3_600} hours`;
  return `${Math.round(value / 60)} minutes`;
}

/** Why a withdrawal of `amount` from `note` cannot be sent. */
export function withdrawProblem(args: { amount: bigint | undefined; note: Pick<OwnedNote, 'value'>; inSet: boolean }): string | undefined {
  const { amount, note, inSet } = args;
  if (!inSet) return 'This deposit is waiting for approval. It can be withdrawn once it is approved.';
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
    hint: 'Pays a provider from the pool. The provider sees the pool as the sender.',
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
export function relayFee(amount: bigint, feeBps: number | bigint): bigint {
  return (amount * BigInt(feeBps)) / 10_000n;
}

/** What the amount field says the relayer keeps, with the gas drop's price on top when gas goes along. */
export function feeLine(amount: bigint | undefined, quote: RelayQuote | undefined, gasDrop: boolean): string {
  const rest = 'The rest stays yours in the pool.';
  if (amount === undefined || quote === undefined) return rest;
  const drop = gasDrop && quote.gasDropFee !== undefined ? BigInt(quote.gasDropFee) : 0n;
  const fee = relayFee(amount, relayFeeBpsFor(quote, amount, gasDrop));
  const rate = `${quote.feeBps / 100}%${drop > 0n ? `, plus ${usdgText(drop)} USDG for the gas it sends along` : ''}`;
  return `The relayer keeps ${usdgText(fee)} USDG (${rate}). ${rest}`;
}

/**
 * Why a withdrawal that asks for gas cannot be sent: the relay contract caps the fee, and the drop's
 * price has to fit under that cap together with the relayer's own rate.
 */
export function gasDropProblem(args: { amount: bigint | undefined; quote: RelayQuote | undefined; maxRelayFeeBps: number }): string | undefined {
  const { amount, quote, maxRelayFeeBps } = args;
  if (amount === undefined || amount === 0n || quote?.gasDropFee === undefined) return undefined;
  if (relayFeeBpsFor(quote, amount, true) <= BigInt(maxRelayFeeBps)) return undefined;
  const cost = `A gas drop costs ${usdgText(BigInt(quote.gasDropFee))} USDG at the moment, and the relayer`;
  const cap = `${maxRelayFeeBps / 100}%`;
  const least = smallestWithGas(quote, maxRelayFeeBps);
  if (least === null) return `${cost}’s fee is already the ${cap} the relay allows, so no withdrawal can carry one. Fund the owner without gas, or try again later.`;
  return `${cost} may keep at most ${cap} of a withdrawal, so a withdrawal with gas has to be at least ${usdgText(least)} USDG.`;
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

/** What the pool will still take from `wallet`, or undefined on a pool that holds nobody to a window. */
export async function readRoom(contracts: ShieldedDeployment, wallet: Address): Promise<DepositRoom | undefined> {
  const { readDepositRoom } = await import('@bursar/sdk');
  return readDepositRoom(rhcClient(), contracts.ShieldedPool, wallet);
}

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
    throw new Error('The relayer answered for a different relay contract than this console uses. Nothing was sent.');
  }
  // The page refuses this before the button is live; here it is the last check before a proof is made.
  const problem = args.gasDrop ? gasDropProblem({ amount: args.amount, quote, maxRelayFeeBps: contracts.maxRelayFeeBps }) : undefined;
  if (problem !== undefined) throw new Error(problem);
  const scope = BigInt(contracts.scope);
  const withdrawal = {
    processooor: contracts.ShieldedRelay,
    data: sdk.encodeRelayData({
      recipient: args.recipient,
      feeRecipient: quote.feeRecipient,
      relayFeeBPS: relayFeeBpsFor(quote, args.amount, args.gasDrop),
    }),
  };
  const fresh = async (attempt: number): Promise<{ events: PoolEvents; set: AssociationSet }> => {
    if (attempt === 1) return { events: args.events, set: args.set };
    const reading = await readPool(contracts);
    const set = await readAssociationSet(contracts, reading, args.aspUrl);
    if (!setMatchesChain(set, reading.latestRoot)) {
      throw new Error('The list of approved deposits is being updated. Try again in a few minutes.');
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
