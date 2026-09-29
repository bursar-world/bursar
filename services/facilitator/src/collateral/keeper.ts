import { collateralVaultAbi, creditPoolAbi } from '@bursar/core';
import type { CollateralDeployment } from '@bursar/core';
import { BaseError, ContractFunctionRevertedError, getAbiItem } from 'viem';
import type { Account, Address, Chain, Hex, PublicClient, WalletClient } from 'viem';

import { fromAccountTuple } from '../lanes/onchain-collateral.js';
import type { OnchainCollateral } from '../lanes/onchain-collateral.js';

/**
 * The collateral lane's health keeper.
 *
 * Each run finds every line the vault has opened, reads each one's health, and for a line under
 * 1.0 asks the vault to liquidate its largest fresh position. The vault sells only the slice that
 * restores the target, through the asset's pinned pool, and pays the caller the bounty. A sale
 * the price guard refuses (a stale, paused or out-of-band price) is reported as deferred: the
 * contract waits for a price it can trust, and so does the keeper. It also sweeps the credit
 * spread to Staking once governance has named the pool as its credit manager.
 *
 * Dry run is the default. Nothing is sent unless the run is told to execute and holds a key.
 */

const WAD = 10n ** 18n;

/** Reverts that mean "not now", as opposed to "never". */
const DEFERRING = [
  'StalePrice',
  'OraclePaused',
  'TokenPaused',
  'AccessPaused',
  'BadPrice',
  'PoolPriceDeviation',
  'Blocked',
] as const;

export type Position = {
  readonly asset: Address;
  readonly raw: bigint;
  readonly valueMicro: bigint;
  readonly fresh: boolean;
  readonly haircutBps: number;
};

export type Spread = {
  readonly reservesMicro: bigint;
  /** Whether Staking accepts the pool's `distribute`. */
  readonly poolIsCreditManager: boolean;
};

export interface KeeperChain {
  lines(fromBlock: bigint): Promise<readonly Address[]>;
  account(mandate: Address): Promise<OnchainCollateral>;
  positions(mandate: Address): Promise<readonly Position[]>;
  inSession(): Promise<boolean>;
  spread(): Promise<Spread>;
  /** Throws the revert when the call would fail. */
  simulateLiquidate(mandate: Address, asset: Address): Promise<void>;
  liquidate(mandate: Address, asset: Address): Promise<Hex>;
  simulateSweep(): Promise<void>;
  sweep(): Promise<Hex>;
}

export type LineSnapshot = {
  readonly mandate: Address;
  readonly valueMicro: string;
  readonly adjustedMicro: string;
  readonly debtMicro: string;
  readonly headroomMicro: string;
  /** Null when nothing is owed. */
  readonly health: number | null;
  readonly afterHours: boolean;
};

export type KeeperAction =
  | { readonly kind: 'liquidate'; readonly mandate: Address; readonly asset: Address; readonly outcome: 'sent'; readonly tx: Hex }
  | { readonly kind: 'liquidate'; readonly mandate: Address; readonly asset: Address; readonly outcome: 'would-send' }
  | { readonly kind: 'liquidate'; readonly mandate: Address; readonly asset: Address | null; readonly outcome: 'deferred' | 'failed'; readonly reason: string }
  | { readonly kind: 'sweep'; readonly amountMicro: string; readonly outcome: 'sent'; readonly tx: Hex }
  | { readonly kind: 'sweep'; readonly amountMicro: string; readonly outcome: 'would-send' | 'waiting' | 'failed'; readonly reason?: string };

export type KeeperReport = {
  readonly at: string;
  readonly execute: boolean;
  readonly inSession: boolean;
  readonly lines: readonly LineSnapshot[];
  readonly actions: readonly KeeperAction[];
};

export type KeeperOptions = {
  readonly chain: KeeperChain;
  readonly fromBlock: bigint;
  /** Send transactions. False reports what it would send. */
  readonly execute: boolean;
  /** Sweep the spread only once it reaches this, in micro-USD. */
  readonly sweepMinMicro: bigint;
  readonly now?: () => Date;
};

export async function runKeeper(options: KeeperOptions): Promise<KeeperReport> {
  const { chain, execute } = options;
  const now = options.now ?? (() => new Date());

  const [mandates, inSession] = await Promise.all([chain.lines(options.fromBlock), chain.inSession()]);
  const lines: LineSnapshot[] = [];
  const actions: KeeperAction[] = [];

  for (const mandate of mandates) {
    const position = await chain.account(mandate);
    lines.push(snapshot(position, !inSession));
    if (position.outstandingMicro === 0n || position.healthE18 >= WAD) continue;
    actions.push(await liquidateLine(chain, mandate, execute));
  }

  const sweep = await sweepSpread(chain, execute, options.sweepMinMicro);
  if (sweep !== null) actions.push(sweep);

  return { at: now().toISOString(), execute, inSession, lines, actions };
}

function snapshot(p: OnchainCollateral, afterHours: boolean): LineSnapshot {
  return {
    mandate: p.mandate,
    valueMicro: p.valueMicro.toString(),
    adjustedMicro: p.effectiveCollateralMicro.toString(),
    debtMicro: p.outstandingMicro.toString(),
    headroomMicro: p.headroomMicro.toString(),
    health: p.healthFactor,
    afterHours,
  };
}

async function liquidateLine(chain: KeeperChain, mandate: Address, execute: boolean): Promise<KeeperAction> {
  const candidates = (await chain.positions(mandate))
    .filter((p) => p.raw > 0n && p.fresh)
    .sort((a, b) => (b.valueMicro > a.valueMicro ? 1 : b.valueMicro < a.valueMicro ? -1 : 0));
  const asset = candidates[0]?.asset;
  if (asset === undefined) {
    return { kind: 'liquidate', mandate, asset: null, outcome: 'deferred', reason: 'no position with a fresh price' };
  }

  try {
    await chain.simulateLiquidate(mandate, asset);
  } catch (error) {
    const reason = revertName(error);
    const outcome = DEFERRING.some((name) => reason.includes(name)) ? 'deferred' : 'failed';
    return { kind: 'liquidate', mandate, asset, outcome, reason };
  }

  if (!execute) return { kind: 'liquidate', mandate, asset, outcome: 'would-send' };
  return { kind: 'liquidate', mandate, asset, outcome: 'sent', tx: await chain.liquidate(mandate, asset) };
}

async function sweepSpread(chain: KeeperChain, execute: boolean, minMicro: bigint): Promise<KeeperAction | null> {
  const { reservesMicro, poolIsCreditManager } = await chain.spread();
  if (reservesMicro === 0n || reservesMicro < minMicro) return null;
  const amountMicro = reservesMicro.toString();
  if (!poolIsCreditManager) {
    return { kind: 'sweep', amountMicro, outcome: 'waiting', reason: 'Staking has not named the pool as its credit manager' };
  }
  try {
    await chain.simulateSweep();
  } catch (error) {
    return { kind: 'sweep', amountMicro, outcome: 'failed', reason: revertName(error) };
  }
  if (!execute) return { kind: 'sweep', amountMicro, outcome: 'would-send' };
  return { kind: 'sweep', amountMicro, outcome: 'sent', tx: await chain.sweep() };
}

export function revertName(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) return reverted.data.errorName;
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

const LOG_CHUNK = 50_000n;
const lineOpened = getAbiItem({ abi: collateralVaultAbi, name: 'LineOpened' });
const stakingAbi = [
  {
    type: 'function',
    name: 'creditManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export type ViemKeeperOptions = {
  readonly publicClient: PublicClient;
  readonly lane: CollateralDeployment;
  /** Needed only to send. */
  readonly walletClient?: WalletClient;
  readonly account?: Account;
  readonly chain?: Chain;
};

/** The keeper's reads and writes against a deployed lane through viem. */
export function createKeeperChain(options: ViemKeeperOptions): KeeperChain {
  const { publicClient, lane } = options;
  const vault = lane.CollateralVault;
  const pool = lane.CreditPool;
  const caller = options.account?.address;

  const send = async (request: Parameters<WalletClient['writeContract']>[0]): Promise<Hex> => {
    if (options.walletClient === undefined) throw new Error('the keeper holds no key');
    const hash = await options.walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };

  return {
    async lines(fromBlock) {
      const head = await publicClient.getBlockNumber();
      const seen = new Set<Address>();
      for (let start = fromBlock; start <= head; start += LOG_CHUNK) {
        const end = start + LOG_CHUNK - 1n < head ? start + LOG_CHUNK - 1n : head;
        const logs = await publicClient.getLogs({ address: vault, event: lineOpened, fromBlock: start, toBlock: end });
        for (const log of logs) if (log.args.mandate) seen.add(log.args.mandate);
      }
      return [...seen];
    },
    async account(mandate) {
      const tuple = await publicClient.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'account', args: [mandate] });
      return fromAccountTuple(mandate, tuple);
    },
    async positions(mandate) {
      const list = await publicClient.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'positions', args: [mandate] });
      return list.map((p) => ({ asset: p.asset, raw: p.raw, valueMicro: p.value, fresh: p.fresh, haircutBps: p.haircutBps }));
    },
    async inSession() {
      const block = await publicClient.getBlock();
      return publicClient.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'inSession', args: [block.timestamp] });
    },
    async spread() {
      const [reservesMicro, manager] = await Promise.all([
        publicClient.readContract({ address: pool, abi: creditPoolAbi, functionName: 'reserves' }),
        publicClient.readContract({ address: lane.Staking, abi: stakingAbi, functionName: 'creditManager' }),
      ]);
      return { reservesMicro, poolIsCreditManager: manager.toLowerCase() === pool.toLowerCase() };
    },
    async simulateLiquidate(mandate, asset) {
      await publicClient.simulateContract({ address: vault, abi: collateralVaultAbi, functionName: 'liquidate', args: [mandate, asset], account: caller });
    },
    liquidate: (mandate, asset) =>
      send({ address: vault, abi: collateralVaultAbi, functionName: 'liquidate', args: [mandate, asset], account: options.account ?? null, chain: options.chain ?? null }),
    async simulateSweep() {
      await publicClient.simulateContract({ address: pool, abi: creditPoolAbi, functionName: 'sweepSpread', account: caller });
    },
    sweep: () =>
      send({ address: pool, abi: creditPoolAbi, functionName: 'sweepSpread', account: options.account ?? null, chain: options.chain ?? null }),
  };
}
