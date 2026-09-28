import { micro, toCapabilityId } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { wei } from '../money';
import type { Wei } from '../money';
import { denialReasonFor } from '@bursar/sdk';
import type {
  DenialReason,
  MandateLimits,
  MerchantGate,
  Remaining,
  SpendWindow,
} from '@bursar/sdk';
import { toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';

import { ADDRESSES, MULTICALL3 } from './rhc';
import {
  adminTimelockAbi,
  agentRegistryAbi,
  escrowAbi,
  mandateAccountAbi,
  multicall3Abi,
  reputationAbi,
  settlementAssetAbi,
  settlementComplianceAbi,
} from './abi';
import { rhcClient } from './client';
import { ReadBatch, addBlockNumber, addChainTime, runBatch } from './batch';
import type { BatchResults, Slot } from './batch';

/** Whose state the screen is about. Everything is optional; the batch only asks for what is named. */
export type ReadScope = {
  /** The mandate account. Without it the mandate, permission and funding readings stay empty. */
  readonly mandate?: Address;
  readonly principal?: Address;
  readonly agent?: Address;
  /** The party being paid, for the permission reading and the provider surface. */
  readonly merchant?: Address;
  /** A capability label such as `gpu.render:1`, or a 32-byte id. */
  readonly capability?: string;
  /** A proposed spend. Present, the mandate is asked what it would decide. */
  readonly amount?: Micro;
  /** Whoever signs transactions. Their ETH balance is the gas float and it is not the mandate's. */
  readonly gasPayer?: Address;
};

export type RawLimits = {
  perCallCap: bigint;
  dailyCap: bigint;
  monthlyCap: bigint;
  dailyWindow: bigint;
  monthlyWindow: bigint;
  approvalThreshold: bigint;
  validFrom: bigint;
  validUntil: bigint;
};

type RawWindow = { cap: bigint; spent: bigint; duration: bigint; start: bigint; epoch: bigint };

export type MandateRead = {
  readonly address: Address;
  readonly principal: Address;
  readonly pendingPrincipal: Address;
  readonly agent: Address;
  readonly escrow: Address;
  readonly settlementAsset: Address;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly version: bigint;
  readonly limits: MandateLimits;
  readonly remaining: Remaining;
  readonly daily: SpendWindow;
  readonly monthly: SpendWindow;
  readonly merchantGate: MerchantGate;
  readonly merchantRoot: Hex;
  readonly documentHash: Hex;
  readonly nonce: bigint;
  /** The settlement asset the account holds, six decimals. Never the native view of the same funds. */
  readonly balance: Micro;
};

/** The settlement asset's compliance surface, read per address the screen is about. */
export type AssetRead = {
  readonly token: Address;
  readonly symbol: string | undefined;
  /** How many decimals the token reports. USDG carries six, and the product reads six everywhere. */
  readonly decimals: number | undefined;
  /** Undefined where the call could not be made, which is different from false. */
  readonly tokenPaused: boolean | undefined;
  /** The address that holds the pause and the blocklist. The token exposes one for both. */
  readonly controller: Address | undefined;
  readonly blocked: Readonly<Record<string, boolean | undefined>>;
  /** True when at least one compliance read failed. An incomplete reading is never a clean one. */
  readonly incomplete: boolean;
};

export type PermissionRead = {
  readonly merchant: Address | undefined;
  /** The amount the preview was taken against, when one was named. */
  readonly amount: Micro | undefined;
  readonly merchantAllowed: boolean | undefined;
  readonly merchantLeaf: Hex | undefined;
  readonly capability: string | undefined;
  readonly capabilityId: Hex | undefined;
  readonly capabilityAllowed: boolean | undefined;
  /** What the mandate says it would decide about this exact spend, without sending anything. */
  readonly preview: { readonly allowed: boolean; readonly reason: DenialReason | undefined; readonly errorName: string | undefined } | undefined;
};

export type FundingRead = {
  /** USDG held by the mandate account, six decimals. This is what pays a provider. */
  readonly mandateBalance: Micro | undefined;
  /** The signer's ETH, in wei. This is what pays a transaction fee, and it buys nothing else. */
  readonly gasPayer: Address | undefined;
  readonly gasBalance: Wei | undefined;
  readonly principalBalance: Micro | undefined;
};

export type ProviderRead = {
  readonly address: Address;
  readonly name: string | undefined;
  readonly registered: boolean | undefined;
  readonly active: boolean | undefined;
  readonly barred: boolean | undefined;
  readonly stake: Micro | undefined;
  readonly minStake: Micro | undefined;
  readonly score: number | undefined;
  readonly maxPerJob: Micro | undefined;
  readonly jobs: { readonly released: bigint; readonly timedOut: bigint; readonly disputed: bigint } | undefined;
};

export type GovernanceRead = {
  readonly timelock: Address;
  /** The delay a parameter change waits out, asked of the timelock every time. */
  readonly period: bigint | undefined;
};

export type EscrowRead = {
  readonly address: Address;
  readonly feeBps: number | undefined;
  readonly minTtl: bigint | undefined;
  readonly maxTtl: bigint | undefined;
  readonly disputeWindow: bigint | undefined;
  readonly disputeBondBps: number | undefined;
  /**
   * The cut a disputed lock pays the resolver panel. Taken off the lock before any refund is
   * worked out, and charged even where the panel never reached a quorum, so a payer weighing a
   * dispute has to be able to read it.
   */
  readonly resolverFeeBps: number | undefined;
  readonly treasury: Address | undefined;
};

export type ChainSnapshot = {
  /** The block every reading below came from. */
  readonly blockNumber: bigint;
  /** Chain time, not browser time. Window rollovers are decided by the chain's clock. */
  readonly chainTime: Date | undefined;
  readonly readAt: Date;
  readonly calls: number;
  readonly failures: number;
  readonly mandate: MandateRead | undefined;
  readonly asset: AssetRead;
  readonly permission: PermissionRead | undefined;
  readonly funding: FundingRead;
  readonly provider: ProviderRead | undefined;
  readonly escrow: EscrowRead;
  readonly governance: GovernanceRead;
};

/**
 * Solidity error selectors for the mandate account, computed from the generated ABI at load.
 * `previewSpend` answers with a four-byte selector and nothing else, so this is what turns
 * `0xcc70389d` into "the daily limit is exhausted".
 */
const SELECTORS: ReadonlyMap<string, string> = new Map(
  mandateAccountAbi
    .filter((entry): entry is Extract<typeof entry, { type: 'error' }> => entry.type === 'error')
    .map((entry) => [
      toFunctionSelector(`${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`),
      entry.name,
    ]),
);

export function errorNameForSelector(selector: Hex): string | undefined {
  return SELECTORS.get(selector);
}

/**
 * The aggregate call did not land, so nothing on the screen has a reading behind it.
 *
 * The code is what `ErrorSurface` branches on, and it matters that this is its own code rather
 * than a generic failure: an unreachable chain and a chain that answered with nothing look
 * identical to every caller above this one, and only one of them is a fact about an account.
 */
export class ChainUnreadable extends Error {
  readonly code = 'chain_unreadable';

  constructor(detail: string | undefined) {
    super('The chain did not answer this reading, so nothing on this screen is current.');
    this.name = 'ChainUnreadable';
    if (detail !== undefined) this.cause = detail;
  }
}

/**
 * Reads everything one screen needs in a single round trip.
 *
 * The call count is what this is for. Forty reads fanned out at twenty requests a second is a
 * queue the customer watches; aggregated it is one request and one block.
 */
export async function readSystem(scope: ReadScope): Promise<ChainSnapshot> {
  const client = rhcClient();
  const batch = new ReadBatch();
  const settlementAsset = ADDRESSES.usdg;
  const capabilityId = scope.capability === undefined ? undefined : toCapabilityId(scope.capability);

  const assetRead = (functionName: string, args?: readonly unknown[]) => ({
    address: settlementAsset,
    abi: settlementAssetAbi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });

  const compliance = (functionName: string, args?: readonly unknown[]) => ({
    address: settlementAsset,
    abi: settlementComplianceAbi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });

  const blockNumber = addBlockNumber(batch);
  const chainTime = addChainTime(batch);

  const tokenPaused = batch.add<boolean>('usdg.paused', compliance('paused'));
  const controller = batch.add<Address>('usdg.owner', compliance('owner'));
  const assetSymbol = batch.add<string>('usdg.symbol', assetRead('symbol'));
  const assetDecimals = batch.add<number>('usdg.decimals', assetRead('decimals'));

  const timelockPeriod = batch.add<bigint>('timelock.timelockPeriod', {
    address: ADDRESSES.adminTimelock,
    abi: adminTimelockAbi as never,
    functionName: 'timelockPeriod',
  });

  const escrowSlots = {
    feeBps: batch.add<number>('escrow.feeBps', { address: ADDRESSES.escrow, abi: escrowAbi as never, functionName: 'feeBps' }),
    minTtl: batch.add<bigint>('escrow.minTtl', { address: ADDRESSES.escrow, abi: escrowAbi as never, functionName: 'minTtl' }),
    maxTtl: batch.add<bigint>('escrow.maxTtl', { address: ADDRESSES.escrow, abi: escrowAbi as never, functionName: 'maxTtl' }),
    disputeWindow: batch.add<bigint>('escrow.disputeWindow', { address: ADDRESSES.escrow, abi: escrowAbi as never, functionName: 'disputeWindow' }),
    disputeBondBps: batch.add<number>('escrow.disputeBondBps', { address: ADDRESSES.escrow, abi: escrowAbi as never, functionName: 'disputeBondBps' }),
    resolverFeeBps: batch.add<number>('escrow.resolverFeeBps', { address: ADDRESSES.escrow, abi: escrowAbi as never, functionName: 'resolverFeeBps' }),
    treasury: batch.add<Address>('escrow.treasury', { address: ADDRESSES.escrow, abi: escrowAbi as never, functionName: 'treasury' }),
  };

  const blockedSlots = new Map<string, Slot<boolean>>();
  const watchBlocked = (address: Address | undefined, label: string) => {
    if (!address || blockedSlots.has(address.toLowerCase())) return;
    blockedSlots.set(address.toLowerCase(), batch.add<boolean>(`usdg.isFrozen:${label}`, compliance('isFrozen', [address])));
  };

  watchBlocked(scope.mandate, 'mandate');
  watchBlocked(scope.principal, 'principal');
  watchBlocked(scope.agent, 'agent');
  watchBlocked(scope.merchant, 'merchant');
  watchBlocked(scope.gasPayer, 'signer');

  const account = (functionName: string, args?: readonly unknown[]) => ({
    address: scope.mandate as Address,
    abi: mandateAccountAbi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });

  const mandateSlots = scope.mandate
    ? {
        principal: batch.add<Address>('mandate.principal', account('principal')),
        pendingPrincipal: batch.add<Address>('mandate.pendingPrincipal', account('pendingPrincipal')),
        agent: batch.add<Address>('mandate.agent', account('agent')),
        escrow: batch.add<Address>('mandate.escrow', account('escrow')),
        settlementAsset: batch.add<Address>('mandate.settlementAsset', account('settlementAsset')),
        paused: batch.add<boolean>('mandate.paused', account('paused')),
        revoked: batch.add<boolean>('mandate.revoked', account('revoked')),
        version: batch.add<bigint>('mandate.version', account('version')),
        limits: batch.add<RawLimits>('mandate.limits', account('limits')),
        remaining: batch.add<readonly [bigint, bigint, bigint]>('mandate.remaining', account('remaining')),
        daily: batch.add<RawWindow>('mandate.window.daily', account('window', [0])),
        monthly: batch.add<RawWindow>('mandate.window.monthly', account('window', [1])),
        merchantGate: batch.add<number>('mandate.merchantGate', account('merchantGate')),
        merchantRoot: batch.add<Hex>('mandate.merchantRoot', account('merchantRoot')),
        documentHash: batch.add<Hex>('mandate.documentHash', account('documentHash')),
        nonce: batch.add<bigint>('mandate.nonce', account('nonce')),
        balance: batch.add<bigint>('usdg.balanceOf:mandate', assetRead('balanceOf', [scope.mandate])),
      }
    : undefined;

  const permissionSlots =
    scope.mandate && (scope.merchant || capabilityId)
      ? {
          merchantAllowed: scope.merchant ? batch.add<boolean>('mandate.merchants', account('merchants', [scope.merchant])) : undefined,
          merchantLeaf: scope.merchant ? batch.add<Hex>('mandate.merchantLeaf', account('merchantLeaf', [scope.merchant])) : undefined,
          capabilityAllowed: capabilityId ? batch.add<boolean>('mandate.capabilities', account('capabilities', [capabilityId])) : undefined,
          preview:
            scope.merchant && capabilityId && scope.amount !== undefined
              ? batch.add<readonly [boolean, Hex]>('mandate.previewSpend', account('previewSpend', [scope.merchant, capabilityId, scope.amount]))
              : undefined,
        }
      : undefined;

  const gasSlot = scope.gasPayer
    ? batch.add<bigint>('gas.balance', { address: MULTICALL3, abi: multicall3Abi as never, functionName: 'getEthBalance', args: [scope.gasPayer] })
    : undefined;

  const principalBalanceSlot = scope.principal
    ? batch.add<bigint>('usdg.balanceOf:principal', assetRead('balanceOf', [scope.principal]))
    : undefined;

  const providerSlots = scope.merchant
    ? {
        agent: batch.add<{ name: string; stake: bigint; registeredAt: bigint; active: boolean }>('registry.getAgent', {
          address: ADDRESSES.agentRegistry,
          abi: agentRegistryAbi as never,
          functionName: 'getAgent',
          args: [scope.merchant],
        }),
        registered: batch.add<boolean>('registry.isRegistered', { address: ADDRESSES.agentRegistry, abi: agentRegistryAbi as never, functionName: 'isRegistered', args: [scope.merchant] }),
        active: batch.add<boolean>('registry.isActive', { address: ADDRESSES.agentRegistry, abi: agentRegistryAbi as never, functionName: 'isActive', args: [scope.merchant] }),
        barred: batch.add<boolean>('registry.isBlacklisted', { address: ADDRESSES.agentRegistry, abi: agentRegistryAbi as never, functionName: 'isBlacklisted', args: [scope.merchant] }),
        stake: batch.add<bigint>('registry.stakeOf', { address: ADDRESSES.agentRegistry, abi: agentRegistryAbi as never, functionName: 'stakeOf', args: [scope.merchant] }),
        minStake: batch.add<bigint>('registry.minStake', { address: ADDRESSES.agentRegistry, abi: agentRegistryAbi as never, functionName: 'minStake' }),
        score: batch.add<number>('reputation.score', { address: ADDRESSES.reputation, abi: reputationAbi as never, functionName: 'score', args: [scope.merchant] }),
        cap: batch.add<bigint>('reputation.capOf', { address: ADDRESSES.reputation, abi: reputationAbi as never, functionName: 'capOf', args: [scope.merchant] }),
        stats: batch.add<readonly [bigint, bigint, bigint]>('reputation.payeeStats', { address: ADDRESSES.reputation, abi: reputationAbi as never, functionName: 'payeeStats', args: [scope.merchant] }),
      }
    : undefined;

  const results = await runBatch(client, batch);

  // Multicall3 answers the block number out of its own storage, so that slot can only be empty if
  // the aggregate call never landed. viem folds a transport failure into a failure on every slot,
  // which from here reads as "the chain answered and there is nothing there". An unreachable chain
  // has to stay unreachable all the way up.
  const block = results.get(blockNumber);
  if (block === undefined) throw new ChainUnreadable(results.problem(blockNumber));

  const blocked: Record<string, boolean | undefined> = {};
  let incomplete = false;
  for (const [address, slot] of blockedSlots) {
    const value = results.get(slot);
    blocked[address] = value;
    if (value === undefined) incomplete = true;
  }
  const pausedValue = results.get(tokenPaused);
  if (pausedValue === undefined) incomplete = true;

  return {
    blockNumber: block,
    chainTime: toDate(results.get(chainTime)),
    readAt: new Date(),
    calls: batch.size,
    failures: results.failures,
    mandate: mandateSlots ? decodeMandate(scope.mandate as Address, mandateSlots, results) : undefined,
    asset: {
      token: settlementAsset,
      symbol: results.get(assetSymbol),
      decimals: results.get(assetDecimals),
      tokenPaused: pausedValue,
      controller: results.get(controller),
      blocked,
      incomplete,
    },
    permission: permissionSlots
      ? {
          merchant: scope.merchant,
          amount: scope.amount,
          merchantAllowed: results.get(permissionSlots.merchantAllowed),
          merchantLeaf: results.get(permissionSlots.merchantLeaf),
          capability: scope.capability,
          capabilityId,
          capabilityAllowed: results.get(permissionSlots.capabilityAllowed),
          preview: decodePreview(results.get(permissionSlots.preview)),
        }
      : undefined,
    funding: {
      mandateBalance: asMicro(results.get(mandateSlots?.balance)),
      gasPayer: scope.gasPayer,
      gasBalance: asWei(results.get(gasSlot)),
      principalBalance: asMicro(results.get(principalBalanceSlot)),
    },
    provider: providerSlots
      ? {
          address: scope.merchant as Address,
          name: results.get(providerSlots.agent)?.name,
          registered: results.get(providerSlots.registered),
          active: results.get(providerSlots.active),
          barred: results.get(providerSlots.barred),
          stake: asMicro(results.get(providerSlots.stake)),
          minStake: asMicro(results.get(providerSlots.minStake)),
          score: results.get(providerSlots.score),
          maxPerJob: asMicro(results.get(providerSlots.cap)),
          jobs: decodeJobs(results.get(providerSlots.stats)),
        }
      : undefined,
    escrow: {
      address: ADDRESSES.escrow,
      feeBps: results.get(escrowSlots.feeBps),
      minTtl: results.get(escrowSlots.minTtl),
      maxTtl: results.get(escrowSlots.maxTtl),
      disputeWindow: results.get(escrowSlots.disputeWindow),
      disputeBondBps: results.get(escrowSlots.disputeBondBps),
      resolverFeeBps: results.get(escrowSlots.resolverFeeBps),
      treasury: results.get(escrowSlots.treasury),
    },
    governance: {
      timelock: ADDRESSES.adminTimelock,
      period: results.get(timelockPeriod),
    },
  };
}

type MandateSlots = {
  readonly principal: Slot<Address>;
  readonly pendingPrincipal: Slot<Address>;
  readonly agent: Slot<Address>;
  readonly escrow: Slot<Address>;
  readonly settlementAsset: Slot<Address>;
  readonly paused: Slot<boolean>;
  readonly revoked: Slot<boolean>;
  readonly version: Slot<bigint>;
  readonly limits: Slot<RawLimits>;
  readonly remaining: Slot<readonly [bigint, bigint, bigint]>;
  readonly daily: Slot<RawWindow>;
  readonly monthly: Slot<RawWindow>;
  readonly merchantGate: Slot<number>;
  readonly merchantRoot: Slot<Hex>;
  readonly documentHash: Slot<Hex>;
  readonly nonce: Slot<bigint>;
  readonly balance: Slot<bigint>;
};

function decodeMandate(address: Address, slots: MandateSlots, results: BatchResults): MandateRead | undefined {
  const limits = results.get(slots.limits);
  const remaining = results.get(slots.remaining);
  const daily = results.get(slots.daily);
  const monthly = results.get(slots.monthly);
  const principal = results.get(slots.principal);

  // Every one of these comes from the same call. Missing any of them means the address holds no
  // mandate account, which is a different answer from a mandate that refuses a spend.
  if (!limits || !remaining || !daily || !monthly || !principal) return undefined;

  const dailyWindow = decodeWindow(0, daily);
  const monthlyWindow = decodeWindow(1, monthly);

  return {
    address,
    principal,
    pendingPrincipal: results.get(slots.pendingPrincipal) ?? ('0x' as Address),
    agent: results.get(slots.agent) ?? ('0x' as Address),
    escrow: results.get(slots.escrow) ?? ADDRESSES.escrow,
    settlementAsset: results.get(slots.settlementAsset) ?? ADDRESSES.usdg,
    paused: results.get(slots.paused) ?? false,
    revoked: results.get(slots.revoked) ?? false,
    version: results.get(slots.version) ?? 0n,
    limits: {
      perCallCap: micro(limits.perCallCap),
      dailyCap: micro(limits.dailyCap),
      monthlyCap: micro(limits.monthlyCap),
      dailyWindow: limits.dailyWindow,
      monthlyWindow: limits.monthlyWindow,
      approvalThreshold: micro(limits.approvalThreshold),
      validFrom: limits.validFrom,
      validUntil: limits.validUntil,
    },
    remaining: {
      perCall: micro(remaining[0]),
      daily: micro(remaining[1]),
      monthly: micro(remaining[2]),
      dailyResetsAt: dailyWindow.resetsAt,
      monthlyResetsAt: monthlyWindow.resetsAt,
    },
    daily: dailyWindow,
    monthly: monthlyWindow,
    merchantGate: (results.get(slots.merchantGate) ?? 0) as MerchantGate,
    merchantRoot: results.get(slots.merchantRoot) ?? ('0x' as Hex),
    documentHash: results.get(slots.documentHash) ?? ('0x' as Hex),
    nonce: results.get(slots.nonce) ?? 0n,
    balance: asMicro(results.get(slots.balance)) ?? micro(0n),
  };
}

function decodeWindow(kind: 0 | 1, raw: RawWindow): SpendWindow {
  const startsAt = new Date(Number(raw.start) * 1000);
  return {
    kind,
    cap: micro(raw.cap),
    spent: micro(raw.spent),
    remaining: micro(raw.cap > raw.spent ? raw.cap - raw.spent : 0n),
    duration: raw.duration,
    startsAt,
    resetsAt: new Date(Number(raw.start + raw.duration) * 1000),
    epoch: raw.epoch,
  };
}

function decodePreview(raw: readonly [boolean, Hex] | undefined): PermissionRead['preview'] {
  if (!raw) return undefined;
  const [allowed, selector] = raw;
  if (allowed) return { allowed: true, reason: undefined, errorName: undefined };
  const errorName = errorNameForSelector(selector);
  return { allowed: false, reason: errorName ? denialReasonFor(errorName) : undefined, errorName };
}

function decodeJobs(raw: readonly [bigint, bigint, bigint] | undefined): ProviderRead['jobs'] {
  return raw ? { released: raw[0], timedOut: raw[1], disputed: raw[2] } : undefined;
}

function asMicro(value: bigint | undefined): Micro | undefined {
  return value === undefined ? undefined : micro(value);
}

/**
 * The signer's ETH, branded so it cannot be handed to a function that formats money.
 *
 * On the previous chain the fee and the settlement asset were the same funds at two precisions and
 * this was a conversion. Here they are two assets, so there is nothing to convert and the type is
 * what keeps a fee out of a balance.
 */
function asWei(value: bigint | undefined): Wei | undefined {
  return value === undefined ? undefined : wei(value);
}

function toDate(seconds: bigint | undefined): Date | undefined {
  return seconds === undefined ? undefined : new Date(Number(seconds) * 1000);
}
