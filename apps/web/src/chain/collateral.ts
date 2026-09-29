import { NO_DEBT_HEALTH, collateralDeployment, collateralVaultAbi, creditPoolAbi, healthRatio, rwaDeployment } from '@bursar/core';
import type { CollateralDeployment } from '@bursar/core';
import type { Abi, Address } from 'viem';

import { ReadBatch, addChainTime, runBatch } from './batch';
import type { Slot } from './batch';
import { rhcClient } from './client';
import { ADDRESSES, CHAIN_ID } from './rhc';

/**
 * Reads for the collateral lane. No hooks here: the public haircut page renders on the server and
 * a module that imports the query client cannot be.
 */

const stakingAbi = [
  { type: 'function', name: 'creditManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies Abi;

type RawTier = {
  sessionHaircutBps: number;
  afterHoursHaircutBps: number;
  sessionStaleness: number;
  valuationStaleness: number;
  name: string;
};

type RawParams = readonly [bigint, bigint, number];

type RawPosition = {
  asset: Address;
  tier: number;
  raw: bigint;
  priceE8: bigint;
  updatedAt: bigint;
  fresh: boolean;
  haircutBps: number;
  value: bigint;
  adjusted: bigint;
};

export type HaircutTier = {
  readonly index: number;
  readonly name: string;
  readonly sessionHaircutBps: number;
  readonly afterHoursHaircutBps: number;
  /** Feed silence, in seconds, past which the after-hours haircut applies on a weekday. */
  readonly sessionStaleness: number;
  /** Feed age, in seconds, past which a position counts zero. */
  readonly valuationStaleness: number;
  readonly assets: readonly TierAsset[];
};

export type TierAsset = {
  readonly address: Address;
  readonly symbol: string;
  /** The haircut that applies right now, and whether it is the after-hours one. */
  readonly haircutBps: number | undefined;
  readonly afterHours: boolean | undefined;
};

export type LaneTerms = {
  /** 1e18 is 1.0. */
  readonly minBorrowHealth: bigint;
  readonly liquidationTarget: bigint;
  readonly bountyBps: number;
};

export type PoolState = {
  readonly totalDebtCap: bigint | undefined;
  readonly perMandateCap: bigint | undefined;
  readonly totalDebt: bigint | undefined;
  readonly cash: bigint | undefined;
  readonly rateBps: bigint | undefined;
  readonly utilisationBps: bigint | undefined;
  readonly reserves: bigint | undefined;
  readonly spreadPaid: bigint | undefined;
  /** True once governance has named the pool as the staking contract's credit manager. */
  readonly spreadLive: boolean | undefined;
};

export type HaircutSchedule = {
  readonly lane: CollateralDeployment;
  readonly tiers: readonly HaircutTier[];
  readonly terms: LaneTerms | undefined;
  readonly pool: PoolState;
  readonly chainTime: Date | undefined;
  readonly complete: boolean;
};

export type CollateralPosition = {
  readonly asset: Address;
  readonly symbol: string;
  readonly tier: number;
  readonly raw: bigint;
  readonly priceE8: bigint;
  readonly updatedAt: Date | undefined;
  readonly fresh: boolean;
  readonly haircutBps: number;
  readonly afterHours: boolean | undefined;
  readonly value: bigint;
  readonly adjusted: bigint;
  /** Held by the caller's wallet, for the deposit form. */
  readonly walletHeld: bigint | undefined;
  readonly allowance: bigint | undefined;
};

export type CollateralAccount = {
  readonly lane: CollateralDeployment;
  readonly isLine: boolean | undefined;
  /** What the mandate asks when a spend runs short. The vault when the line is wired. */
  readonly creditSource: Address | undefined;
  readonly positions: readonly CollateralPosition[];
  readonly value: bigint | undefined;
  readonly adjusted: bigint | undefined;
  readonly debt: bigint | undefined;
  readonly headroom: bigint | undefined;
  readonly healthE18: bigint | undefined;
  readonly terms: LaneTerms | undefined;
  readonly usdgAllowance: bigint | undefined;
  readonly chainTime: Date | undefined;
};

export function collateralLane(): CollateralDeployment | undefined {
  return collateralDeployment(CHAIN_ID);
}

export function symbolOf(asset: Address): string {
  const known = rwaDeployment(CHAIN_ID)?.assets.find((a) => a.address.toLowerCase() === asset.toLowerCase());
  return known?.symbol ?? `${asset.slice(0, 6)}…${asset.slice(-4)}`;
}

const call = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
  ({ address, abi, functionName, ...(args === undefined ? {} : { args }) }) as const;

export async function readHaircutSchedule(): Promise<HaircutSchedule | undefined> {
  const lane = collateralLane();
  if (lane === undefined) return undefined;
  const vault = (fn: string, args?: readonly unknown[]) => call(lane.CollateralVault, collateralVaultAbi as Abi, fn, args);
  const pool = (fn: string) => call(lane.CreditPool, creditPoolAbi as Abi, fn);

  const batch = new ReadBatch();
  const tiersSlot = batch.add<readonly RawTier[]>('vault.tiers', vault('tiers'));
  const assetsSlot = batch.add<readonly Address[]>('vault.collateralAssets', vault('collateralAssets'));
  const paramsSlot = batch.add<RawParams>('vault.params', vault('params'));
  const poolSlots = {
    totalDebtCap: batch.add<bigint>('pool.totalDebtCap', pool('totalDebtCap')),
    perMandateCap: batch.add<bigint>('pool.perMandateCap', pool('perMandateCap')),
    totalDebt: batch.add<bigint>('pool.totalDebt', pool('totalDebt')),
    cash: batch.add<bigint>('pool.cash', pool('cash')),
    rateBps: batch.add<bigint>('pool.rateBps', pool('rateBps')),
    utilisationBps: batch.add<bigint>('pool.utilisationBps', pool('utilisationBps')),
    reserves: batch.add<bigint>('pool.reserves', pool('reserves')),
    spreadPaid: batch.add<bigint>('pool.spreadPaid', pool('spreadPaid')),
  };
  const managerSlot = batch.add<Address>('staking.creditManager', call(lane.Staking, stakingAbi, 'creditManager'));
  const timeSlot = addChainTime(batch);
  const first = await runBatch(rhcClient(), batch);

  const assets = first.get(assetsSlot) ?? [];
  const second = new ReadBatch();
  const perAsset = assets.map((asset) => ({
    asset,
    tier: second.add<number>(`vault.tierOf:${asset}`, vault('tierOf', [asset])),
    haircut: second.add<readonly [number, boolean]>(`vault.haircutOf:${asset}`, vault('haircutOf', [asset])),
  }));
  const rest = assets.length === 0 ? undefined : await runBatch(rhcClient(), second);

  const tiers = (first.get(tiersSlot) ?? []).map((t, i): HaircutTier => ({
    index: i + 1,
    name: t.name,
    sessionHaircutBps: Number(t.sessionHaircutBps),
    afterHoursHaircutBps: Number(t.afterHoursHaircutBps),
    sessionStaleness: Number(t.sessionStaleness),
    valuationStaleness: Number(t.valuationStaleness),
    assets: perAsset
      .filter((a) => Number(rest?.get(a.tier) ?? 0) === i + 1)
      .map((a) => {
        const h = rest?.get(a.haircut);
        return { address: a.asset, symbol: symbolOf(a.asset), haircutBps: h === undefined ? undefined : Number(h[0]), afterHours: h?.[1] };
      }),
  }));

  const manager = first.get(managerSlot);
  const time = first.get(timeSlot);
  return {
    lane,
    tiers,
    terms: termsFrom(first.get(paramsSlot)),
    pool: {
      totalDebtCap: first.get(poolSlots.totalDebtCap),
      perMandateCap: first.get(poolSlots.perMandateCap),
      totalDebt: first.get(poolSlots.totalDebt),
      cash: first.get(poolSlots.cash),
      rateBps: first.get(poolSlots.rateBps),
      utilisationBps: first.get(poolSlots.utilisationBps),
      reserves: first.get(poolSlots.reserves),
      spreadPaid: first.get(poolSlots.spreadPaid),
      spreadLive: manager === undefined ? undefined : manager.toLowerCase() === lane.CreditPool.toLowerCase(),
    },
    chainTime: time === undefined ? undefined : new Date(Number(time) * 1000),
    complete: first.failures === 0 && (rest?.failures ?? 0) === 0,
  };
}

export async function readCollateralAccount(mandate: Address, wallet: Address | undefined): Promise<CollateralAccount | undefined> {
  const lane = collateralLane();
  if (lane === undefined) return undefined;
  const vault = (fn: string, args?: readonly unknown[]) => call(lane.CollateralVault, collateralVaultAbi as Abi, fn, args);

  const batch = new ReadBatch();
  const lineSlot = batch.add<boolean>('vault.isLine', vault('isLine', [mandate]));
  const sourceSlot = batch.add<Address>('mandate.treasuryPark', call(mandate, mandateParkAbi, 'treasuryPark'));
  const positionsSlot = batch.add<readonly RawPosition[]>('vault.positions', vault('positions', [mandate]));
  const accountSlot = batch.add<readonly [bigint, bigint, bigint, bigint, bigint]>('vault.account', vault('account', [mandate]));
  const paramsSlot = batch.add<RawParams>('vault.params', vault('params'));
  const allowanceSlot: Slot<bigint> | undefined =
    wallet === undefined ? undefined : batch.add<bigint>('usdg.allowance', call(ADDRESSES.usdg, erc20Abi, 'allowance', [wallet, lane.CreditPool]));
  const timeSlot = addChainTime(batch);
  const first = await runBatch(rhcClient(), batch);

  const raw = first.get(positionsSlot) ?? [];
  const second = new ReadBatch();
  const extra = raw.map((p) => ({
    haircut: second.add<readonly [number, boolean]>(`vault.haircutOf:${p.asset}`, vault('haircutOf', [p.asset])),
    held: wallet === undefined ? undefined : second.add<bigint>(`balanceOf:${p.asset}`, call(p.asset, erc20Abi, 'balanceOf', [wallet])),
    allowance:
      wallet === undefined
        ? undefined
        : second.add<bigint>(`allowance:${p.asset}`, call(p.asset, erc20Abi, 'allowance', [wallet, lane.CollateralVault])),
  }));
  const rest = raw.length === 0 ? undefined : await runBatch(rhcClient(), second);

  const acct = first.get(accountSlot);
  const time = first.get(timeSlot);
  return {
    lane,
    isLine: first.get(lineSlot),
    creditSource: first.get(sourceSlot),
    positions: raw.map((p, i) => {
      const e = extra[i];
      const h = e === undefined ? undefined : rest?.get(e.haircut);
      return {
        asset: p.asset,
        symbol: symbolOf(p.asset),
        tier: Number(p.tier),
        raw: p.raw,
        priceE8: p.priceE8,
        updatedAt: p.updatedAt === 0n ? undefined : new Date(Number(p.updatedAt) * 1000),
        fresh: p.fresh,
        haircutBps: Number(p.haircutBps),
        afterHours: h?.[1],
        value: p.value,
        adjusted: p.adjusted,
        walletHeld: e?.held === undefined ? undefined : rest?.get(e.held),
        allowance: e?.allowance === undefined ? undefined : rest?.get(e.allowance),
      };
    }),
    value: acct?.[0],
    adjusted: acct?.[1],
    debt: acct?.[2],
    headroom: acct?.[3],
    healthE18: acct?.[4],
    terms: termsFrom(first.get(paramsSlot)),
    usdgAllowance: first.get(allowanceSlot),
    chainTime: time === undefined ? undefined : new Date(Number(time) * 1000),
  };
}

function termsFrom(p: RawParams | undefined): LaneTerms | undefined {
  if (p === undefined) return undefined;
  return { minBorrowHealth: p[0], liquidationTarget: p[1], bountyBps: Number(p[2]) };
}

/** A health figure for people: "No debt" when nothing is owed, otherwise two decimals. */
export function formatHealth(healthE18: bigint | undefined): string {
  if (healthE18 === undefined) return 'Unread';
  if (healthE18 === NO_DEBT_HEALTH) return 'No debt';
  const ratio = healthRatio(healthE18) ?? 0;
  return ratio.toFixed(2);
}

/** 1.25e18 as "1.25". */
export function formatRatio(e18: bigint): string {
  return (Number(e18 / 10n ** 14n) / 1e4).toFixed(2);
}

/** Whether a health figure sits below the liquidation edge. */
export function liquidatable(healthE18: bigint | undefined): boolean {
  return healthE18 !== undefined && healthE18 !== NO_DEBT_HEALTH && healthE18 < 10n ** 18n;
}

/** The mandate asks this address for USDG when a spend runs short. */
export function creditWired(account: Pick<CollateralAccount, 'creditSource' | 'lane'>): boolean {
  return account.creditSource?.toLowerCase() === account.lane.CollateralVault.toLowerCase();
}

const mandateParkAbi = [
  { type: 'function', name: 'treasuryPark', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies Abi;

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const satisfies Abi;
