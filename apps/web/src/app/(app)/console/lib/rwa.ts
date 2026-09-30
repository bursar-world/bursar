import { useQuery } from '@tanstack/react-query';
import {
  RWA_CLASS_BIT,
  assetRegistryAbi,
  mandateAccountAbi,
  parkAdapterAbi,
  priceGuardAbi,
  rawToUsdgMicros,
  rwaDeployment,
  settlementAssetAbi,
  stockSpendRouterAbi,
  treasuryParkAbi,
} from '@bursar/core';
import type { RwaAssetKind, RwaDeployment } from '@bursar/core';
import { decodeErrorResult, erc20Abi, formatUnits, zeroAddress } from 'viem';
import { getCode, readContract } from 'viem/actions';
import type { Abi, Address } from 'viem';

import { ReadBatch, addChainTime, runBatch } from '@/chain/batch';
import type { Slot } from '@/chain/batch';
import { rhcClient } from '@/chain/client';
import { collateralLane, readCollateralAccount } from '@/chain/collateral';
import { mandateBuild } from '@/chain/mandates';
import { ADDRESSES, CHAIN_ID } from '@/chain/rhc';
import { formatDuration } from '@/lib/time';

export function rwaLane(): RwaDeployment | undefined {
  return rwaDeployment(CHAIN_ID);
}

type RawAsset = {
  feed: Address;
  tradeStaleness: number;
  valuationStaleness: number;
  bandBps: number;
  haircutBps: number;
  decimals: number;
  eligible: boolean;
  isStock: boolean;
  isTreasury: boolean;
  perTradeCap: bigint;
  perMandateCap: bigint;
  totalCap: bigint;
};

export type RwaAsset = {
  readonly symbol: string;
  readonly address: Address;
  readonly kind: RwaAssetKind;
  readonly config: RawAsset | undefined;
  readonly priceE8: bigint | undefined;
  readonly updatedAt: Date | undefined;
  /** Fresh enough to count toward spending power. */
  readonly fresh: boolean | undefined;
  /** Why a trade at the feed price would be refused right now, if it would be. */
  readonly tradeRefusal: string | undefined;
  readonly held: bigint | undefined;
  readonly allowed: boolean | undefined;
};

export type ParkPosition = {
  readonly symbol: string;
  readonly adapter: Address;
  readonly asset: RwaAsset | undefined;
  readonly raw: bigint | undefined;
  readonly basis: bigint | undefined;
  readonly value: bigint | undefined;
  readonly priceE8: bigint | undefined;
  readonly updatedAt: Date | undefined;
  readonly fresh: boolean | undefined;
  readonly haircutBps: number | undefined;
};

export type RwaState = {
  readonly lane: RwaDeployment;
  readonly router: Address | undefined;
  readonly slippageBps: number | undefined;
  readonly assets: readonly RwaAsset[];
  readonly positions: readonly ParkPosition[];
  readonly vault: Address | undefined;
  readonly vaultHeld: bigint | undefined;
  readonly buffer: bigint | undefined;
  readonly parkedTotal: bigint | undefined;
  readonly parkedCounted: bigint | undefined;
  readonly spendingPower: bigint | undefined;
  readonly chainTime: Date | undefined;
};

export async function readRwa(mandate: Address): Promise<RwaState | undefined> {
  const lane = rwaLane();
  if (lane === undefined) return undefined;

  const batch = new ReadBatch();
  const call = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
    ({ address, abi, functionName, ...(args === undefined ? {} : { args }) }) as const;
  const registry = (fn: string, args: readonly unknown[]) => call(lane.AssetRegistry, assetRegistryAbi as Abi, fn, args);
  const guard = (fn: string, args: readonly unknown[]) => call(lane.PriceGuard, priceGuardAbi as Abi, fn, args);
  const router = (fn: string, args: readonly unknown[]) => call(lane.StockSpendRouter, stockSpendRouterAbi as Abi, fn, args);
  const park = (fn: string, args: readonly unknown[]) => call(lane.TreasuryPark, treasuryParkAbi as Abi, fn, args);

  const routerSlot = batch.add<Address>('mandate.router', call(mandate, mandateAccountAbi as Abi, 'router'));
  const slippageSlot = batch.add<number>('router.maxSlippageBps', router('maxSlippageBps', [mandate]));
  const vaultSlot = batch.add<Address>('park.vaultOf', park('vaultOf', [mandate]));
  const bufferSlot = batch.add<bigint>('park.buffer', park('buffer', [mandate]));
  const parkedSlot = batch.add<readonly [bigint, bigint]>('park.parkedValue', park('parkedValue', [mandate]));
  const powerSlot = batch.add<bigint>('park.spendingPower', park('spendingPower', [mandate]));
  const timeSlot = addChainTime(batch);

  const assetSlots = lane.assets.map((asset) => ({
    asset,
    config: batch.add<RawAsset>(`registry.get:${asset.symbol}`, registry('get', [asset.address])),
    price: batch.add<readonly [bigint, bigint, boolean]>(`guard.valuationPrice:${asset.symbol}`, guard('valuationPrice', [asset.address])),
    trade: batch.add<bigint>(`guard.tradePrice:${asset.symbol}`, guard('tradePrice', [asset.address, mandate])),
    held: batch.add<bigint>(`balanceOf:${asset.symbol}`, call(asset.address, erc20Abi as Abi, 'balanceOf', [mandate])),
    allowed: batch.add<boolean>(`router.assetAllowed:${asset.symbol}`, router('assetAllowed', [mandate, asset.address])),
  }));

  const adapterSlots = Object.entries(lane.adapters).map(([symbol, adapter]) => ({
    symbol,
    adapter,
    position: batch.add<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(`park.position:${symbol}`, park('position', [mandate, adapter])),
    haircut: batch.add<number>(`adapter.haircutBps:${symbol}`, call(adapter, parkAdapterAbi as Abi, 'haircutBps')),
  }));

  const results = await runBatch(rhcClient(), batch);
  const vault = results.get(vaultSlot);

  let vaultHeld: bigint | undefined;
  if (vault !== undefined) {
    const second = new ReadBatch();
    const heldSlot: Slot<bigint> = second.add('usdg.balanceOf:vault', call(ADDRESSES.usdg, settlementAssetAbi as Abi, 'balanceOf', [vault]));
    vaultHeld = (await runBatch(rhcClient(), second)).get(heldSlot);
  }

  const assets: RwaAsset[] = assetSlots.map((slots) => {
    const price = results.get(slots.price);
    const tradeProblem = results.problem(slots.trade);
    return {
      symbol: slots.asset.symbol,
      address: slots.asset.address,
      kind: slots.asset.kind,
      config: results.get(slots.config),
      priceE8: price?.[0],
      updatedAt: price === undefined || price[1] === 0n ? undefined : new Date(Number(price[1]) * 1000),
      fresh: price?.[2],
      tradeRefusal: tradeProblem === undefined ? undefined : refusalInText(tradeProblem) ?? 'The price check could not be read.',
      held: results.get(slots.held),
      allowed: results.get(slots.allowed),
    };
  });

  const positions: ParkPosition[] = adapterSlots.map((slots) => {
    const p = results.get(slots.position);
    return {
      symbol: slots.symbol,
      adapter: slots.adapter,
      asset: assets.find((asset) => asset.symbol === slots.symbol),
      raw: p?.[0],
      basis: p?.[1],
      value: p?.[2],
      priceE8: p?.[3],
      updatedAt: p === undefined || p[4] === 0n ? undefined : new Date(Number(p[4]) * 1000),
      fresh: p?.[5],
      haircutBps: results.get(slots.haircut),
    };
  });

  const parked = results.get(parkedSlot);
  const time = results.get(timeSlot);
  const slippage = results.get(slippageSlot);

  return {
    lane,
    router: results.get(routerSlot),
    slippageBps: slippage === undefined ? undefined : Number(slippage),
    assets,
    positions,
    vault,
    vaultHeld,
    buffer: results.get(bufferSlot),
    parkedTotal: parked?.[0],
    parkedCounted: parked?.[1],
    spendingPower: results.get(powerSlot),
    chainTime: time === undefined ? undefined : new Date(Number(time) * 1000),
  };
}

export function allowsRwa(classMask: number | undefined): boolean {
  return classMask !== undefined && (classMask & RWA_CLASS_BIT) !== 0;
}

export function routerSet(router: Address | undefined): boolean {
  return router !== undefined && router !== zeroAddress;
}

/** USDG micros for a holding at the feed price. */
export function holdingValue(raw: bigint, priceE8: bigint, decimals = 18): bigint {
  return rawToUsdgMicros(raw, priceE8, decimals);
}

/** The smallest fill the router accepts, worked out the way the router does. */
export function minOutAt(usdgIn: bigint, priceE8: bigint, decimals: number, slippageBps: number, bandBps: number): bigint {
  if (priceE8 <= 0n) return 0n;
  const slip = slippageBps === 0 || slippageBps > bandBps ? bandBps : slippageBps;
  const atFeed = (usdgIn * 10n ** BigInt(decimals + 2)) / priceE8;
  return (atFeed * BigInt(10_000 - slip)) / 10_000n;
}

export function tokenAmount(raw: bigint, decimals = 18, places = 8): string {
  const [whole, fraction = ''] = formatUnits(raw, decimals).split('.');
  const cut = fraction.slice(0, places).replace(/0+$/, '');
  if (cut === '' && raw > 0n) return `<0.${'0'.repeat(places - 1)}1`;
  return cut === '' ? (whole ?? '0') : `${whole}.${cut}`;
}

export function feedPrice(priceE8: bigint): string {
  const value = Number(priceE8) / 1e8;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 6 : 2 })}`;
}

export function hours(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600} hours` : formatDuration(seconds);
}

const RWA_ERRORS = [
  ...(mandateAccountAbi as Abi),
  ...(stockSpendRouterAbi as Abi),
  ...(priceGuardAbi as Abi),
  ...(treasuryParkAbi as Abi),
  ...(assetRegistryAbi as Abi),
].filter((entry) => entry.type === 'error') as Abi;

/** Plain language for every refusal on the purchase and park paths. */
export const RWA_REFUSALS: Readonly<Record<string, string>> = {
  NotAgent: 'Only the agent wallet on this mandate can buy.',
  NotPrincipal: 'Only the owner of this mandate can do this.',
  ClassNotAllowed: 'This mandate does not allow stock purchases. The owner turns them on under spend classes in the limits.',
  RouterNotSet: 'No purchase router is set on this mandate yet. The owner sets it above.',
  IsPaused: 'The mandate is paused.',
  IsRevoked: 'The mandate is revoked.',
  NotYetValid: 'The mandate is not open yet.',
  Expired: 'The mandate has expired.',
  PerCallCapExceeded: 'The amount is above the most this mandate allows per payment.',
  DailyCapExceeded: 'The amount is more than is left in the period cap.',
  MonthlyCapExceeded: 'The amount is more than is left in the second cap.',
  TotalCapExceeded: 'The amount is more than is left in the total budget.',
  ApprovalRequired: 'The amount is above the approval threshold, and purchases cannot carry an approval.',
  AssetNotAllowed: 'The owner has not allowed this asset for this mandate.',
  NotAStock: 'This asset is not listed as a stock.',
  NotEligible: 'This asset is not eligible for purchase right now.',
  TradeCapExceeded: 'The amount is above the largest single purchase this asset allows.',
  StalePrice: 'The feed price is too old to trade against.',
  BadPrice: 'The feed returned no usable price.',
  OraclePaused: 'The price feed for this asset is paused.',
  TokenPaused: 'Transfers of this asset are paused by its issuer.',
  AccessPaused: 'Trading in these assets is paused by the issuer.',
  Blocked: 'The issuer blocks this account from trading these assets.',
  PoolPriceDeviation: 'The pool price has moved too far from the feed price.',
  PriceOutsideBand: 'The quoted price is too far from the feed price. Reload and try again.',
  InsufficientOutput: 'The fill came back below the slippage limit.',
  SwapShort: 'The fill came back below the slippage limit.',
  BadSlippage: 'The slippage limit has to be below 100%.',
  UnknownAdapter: 'That parking option is not enabled.',
  NotFactoryAccount: 'Only a mandate created by one of the factories the treasury lane accepts can park.',
  NothingToUnpark: 'Nothing parked can be sold right now to cover the amount, so the mandate pays from the USDG it holds.',
  ZeroAmount: 'Enter an amount above zero.',
  VaultShort: 'The parking vault holds less USDG than the amount. Move the USDG into it first.',
  BelowBuffer: 'The mandate holds less USDG than its buffer, so nothing more can be parked.',
  MandateCapExceeded: 'This would take the mandate past its parking cap for this asset.',
  PositionShort: 'The position holds less than that.',
  ERC20InsufficientBalance: 'The mandate holds less USDG than the amount.',
};

export function refusalInText(message: string): string | undefined {
  for (const name of Object.keys(RWA_REFUSALS)) {
    if (new RegExp(`\\b${name}\\b`).test(message)) return RWA_REFUSALS[name];
  }
  return undefined;
}

/** Runs the call against the chain first, so a refusal is named before the wallet opens. */
export async function refuseEarly(request: {
  readonly account: Address;
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
}): Promise<void> {
  try {
    await rhcClient().simulateContract({ ...request, abi: [...request.abi, ...RWA_ERRORS] } as never);
  } catch (error) {
    const reason = refusalFrom(error);
    if (reason !== undefined) throw new Error(reason);
    throw error;
  }
}

function refusalFrom(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (typeof node === 'object' && node !== null && !seen.has(node)) {
    seen.add(node);
    const shaped = node as { data?: unknown; cause?: unknown; errorName?: unknown };
    if (typeof shaped.errorName === 'string' && RWA_REFUSALS[shaped.errorName]) return RWA_REFUSALS[shaped.errorName];
    const data = shaped.data as { errorName?: unknown } | string | undefined;
    if (typeof data === 'object' && data !== null && typeof data.errorName === 'string') {
      return RWA_REFUSALS[data.errorName];
    }
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: RWA_ERRORS, data: data as `0x${string}` });
        return RWA_REFUSALS[decoded.errorName];
      } catch {
        // not one of ours
      }
    }
    node = shaped.cause;
  }
  return undefined;
}

export function useRwa(mandate: Address, enabled: boolean) {
  return useQuery({
    queryKey: ['console', 'rwa', mandate.toLowerCase()],
    queryFn: () => readRwa(mandate),
    enabled: enabled && rwaLane() !== undefined,
    refetchInterval: 30_000,
  });
}

/**
 * Whether the account's own code draws from its park during a payment: its `spend` and `buy` pull a
 * shortfall from parked value or the collateral line inside the same transaction. The v2.1 build
 * and every build from v3 on do; a v2 account holds the same park and never draws from it.
 * `chain/mandates.ts` fingerprints each build.
 */
export async function drawsInsidePayment(mandate: Address): Promise<boolean> {
  return mandateBuild(mandate, await getCode(rhcClient(), { address: mandate }))?.draws === true;
}

/**
 * USDG a payment can pull in beyond what the account holds: the collateral line's headroom when the
 * park is the collateral vault, the counted parked value when it is the treasury park. Zero for an
 * account that cannot draw inside a payment.
 */
export async function readDrawable(mandate: Address): Promise<bigint> {
  if (!(await drawsInsidePayment(mandate))) return 0n;
  const park = (await readContract(rhcClient(), { address: mandate, abi: mandateAccountAbi as Abi, functionName: 'treasuryPark' })) as Address;
  if (park === zeroAddress) return 0n;

  const lane = collateralLane();
  if (lane !== undefined && park.toLowerCase() === lane.CollateralVault.toLowerCase()) {
    return (await readCollateralAccount(mandate, undefined))?.headroom ?? 0n;
  }
  const [rwa, held] = await Promise.all([
    readRwa(mandate),
    readContract(rhcClient(), { address: ADDRESSES.usdg, abi: settlementAssetAbi as Abi, functionName: 'balanceOf', args: [mandate] }) as Promise<bigint>,
  ]);
  const power = rwa?.spendingPower ?? 0n;
  return power > held ? power - held : 0n;
}
