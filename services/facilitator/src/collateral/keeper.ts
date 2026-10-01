import { collateralVaultAbi, creditPoolAbi, drawHaltOf, priceGuardAbi } from '@bursar/core';
import type { CollateralDeployment, DrawHalt } from '@bursar/core';
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAbiItem } from 'viem';
import type { Abi, Account, Address, Chain, Hex, PublicClient, WalletClient } from 'viem';

import { fromAccountTuple } from '../lanes/onchain-collateral.js';
import type { OnchainCollateral } from '../lanes/onchain-collateral.js';

/**
 * The collateral lane's health keeper.
 *
 * Each run finds every line the vault has opened, reads each one's health, and for a line under
 * 1.0 asks the vault to liquidate its largest fresh position. The vault sells only the slice that
 * restores the target, through the asset's pinned pool, and pays the caller the bounty. A sale
 * the price guard refuses is reported as deferred: the contract waits for a price it can trust,
 * and so does the keeper. The guard is asked twice, before the sale and again after it, so a sale
 * that would push the pool out of its band is deferred the same way. A line with nothing left that
 * a sale could turn into USDG has its debt written off by the same call, and that is reported as a
 * write-off rather than a sale. The keeper also sweeps the credit spread to Staking once
 * governance has named the pool as its credit manager.
 *
 * From v4 the keeper also keeps the price guard's readings current. A draw counts a position only
 * against a reading of its pool that `observe(asset)` took at least `MIN_OBSERVATION_AGE` earlier
 * and at most `MAX_OBSERVATION_AGE` earlier, so with nobody observing every draw halts within the
 * hour. Each pass reads each asset's pending and aged samples and observes where it would change
 * what a draw sees; a reading the guard refuses as too young is reported as waiting, and a pass
 * that finds the pool and the feed where the last reading left them sends nothing unless the aged
 * sample is about to run out. A guard from before v4 has no readings to keep, and the pass says so.
 *
 * Dry run is the default. Nothing is sent unless the run is told to execute and holds a key.
 */

const WAD = 10n ** 18n;

/** The widest a pool mid is recorded at: the guard clips a reading to this before it stores it. */
const MAX_SAMPLE_PRICE = (1n << 104n) - 1n;

/**
 * Reverts that mean "not now", as opposed to "never", with what the keeper is waiting for. Every
 * one of them is the price guard's.
 */
const DEFERRING: Readonly<Record<string, string>> = {
  StalePrice: 'the feed is older than the asset allows a trade on',
  BadPrice: 'the feed has no usable answer',
  OraclePaused: "the token's oracle is paused",
  TokenPaused: 'the token is paused',
  AccessPaused: "Robinhood's access registry is paused",
  Blocked: 'the access registry blocks the vault',
  PoolPriceDeviation: "the asset's pool trades outside its band of the feed, before the sale or after it",
};

/**
 * What `liquidate` can revert with: its own errors, and the price guard's and the credit pool's,
 * which reach the caller unwrapped. Decoding against the vault's ABI alone leaves a guard refusal as
 * a bare selector, and a deferral would read as a failure.
 */
const LIQUIDATE_ABI = [
  ...collateralVaultAbi,
  ...priceGuardAbi.filter((entry) => entry.type === 'error'),
  ...creditPoolAbi.filter((entry) => entry.type === 'error'),
] as const satisfies Abi;

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

/** A reading of a pool's mid against the feed's answer, as the guard stores it. `at` is zero for none. */
export type Sample = {
  readonly at: bigint;
  readonly poolE8: bigint;
  readonly feedE8: bigint;
};

/** The guard's bounds on a reading. */
export type ObservationRule = {
  readonly minAge: bigint;
  readonly maxAge: bigint;
};

/** Everything the pass needs to decide whether to observe one asset. */
export type Observation = {
  /** The reading a draw counts, and the newer one waiting to replace it. */
  readonly aged: Sample;
  readonly pending: Sample;
  /** The pool's mid and the feed's answer now, as `observe` would record them. Zero for no answer. */
  readonly poolE8: bigint;
  readonly feedE8: bigint;
  /** What the vault says a draw against this asset fails on right now. Undefined for a condition this build does not name. */
  readonly halt: DrawHalt | undefined;
};

export interface KeeperChain {
  lines(fromBlock: bigint): Promise<readonly Address[]>;
  account(mandate: Address): Promise<OnchainCollateral>;
  positions(mandate: Address): Promise<readonly Position[]>;
  inSession(): Promise<boolean>;
  spread(): Promise<Spread>;
  /**
   * The raw amount the call would sell, or zero when it would write the line's debt off instead.
   * Throws the revert when the call would fail.
   */
  simulateLiquidate(mandate: Address, asset: Address): Promise<bigint>;
  liquidate(mandate: Address, asset: Address): Promise<Hex>;
  simulateSweep(): Promise<void>;
  sweep(): Promise<Hex>;
  /** The chain's clock, which every sample age is measured against. */
  now(): Promise<bigint>;
  /** Every asset the vault values. */
  assets(): Promise<readonly Address[]>;
  /** The guard's bounds on a reading, or null on a guard from before v4, which takes none. */
  observationRule(): Promise<ObservationRule | null>;
  observation(asset: Address): Promise<Observation>;
  /** Throws the revert when the call would fail. */
  simulateObserve(asset: Address): Promise<void>;
  observe(asset: Address): Promise<Hex>;
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
  | { readonly kind: 'liquidate' | 'write-off'; readonly mandate: Address; readonly asset: Address; readonly outcome: 'sent'; readonly tx: Hex }
  | { readonly kind: 'liquidate' | 'write-off'; readonly mandate: Address; readonly asset: Address; readonly outcome: 'would-send' }
  | {
      readonly kind: 'liquidate';
      readonly mandate: Address;
      readonly asset: Address | null;
      readonly outcome: 'deferred' | 'failed';
      readonly reason: string;
      /** For a deferral, what the sale is waiting for. */
      readonly detail?: string;
    }
  | { readonly kind: 'sweep'; readonly amountMicro: string; readonly outcome: 'sent'; readonly tx: Hex }
  | { readonly kind: 'sweep'; readonly amountMicro: string; readonly outcome: 'would-send' | 'waiting' | 'failed'; readonly reason?: string }
  | { readonly kind: 'observe'; readonly asset: Address; readonly outcome: 'sent'; readonly reason: ObserveReason; readonly tx: Hex }
  | { readonly kind: 'observe'; readonly asset: Address; readonly outcome: 'would-send'; readonly reason: ObserveReason }
  | { readonly kind: 'observe'; readonly asset: Address; readonly outcome: 'waiting' | 'skipped' | 'failed'; readonly reason: string; readonly detail?: string };

/** Why a pass observes an asset. */
export type ObserveReason =
  /** The guard holds no reading of this pool yet. */
  | 'first-reading'
  /** A reading waits and none is in force, or the one in force is about to run out. */
  | 'promote'
  /** A draw is halted on the reading in force, and the one waiting may clear it. */
  | 'halted'
  /** The pool or the feed has moved since the waiting reading was taken. */
  | 'moved';

/** One asset's standing under the draw rule, after the pass. `Unknown` is a condition this build does not name. */
export type ObservationSnapshot = {
  readonly asset: Address;
  readonly halt: DrawHalt | 'Unknown';
  /** Null while the guard holds no such reading. */
  readonly agedAgeSeconds: number | null;
  readonly pendingAgeSeconds: number | null;
};

/**
 * Whether the readings this keeper is responsible for are in force. False when a draw against any
 * asset is halted for want of a reading, which is what a keeper that has not run looks like from
 * the vault; the other halts are the market's and are listed without failing the pass.
 */
export type ObservationHealth = {
  readonly observed: boolean;
  readonly halted: readonly { readonly asset: Address; readonly halt: DrawHalt | 'Unknown' }[];
  readonly summary: string;
};

export type KeeperReport = {
  readonly at: string;
  readonly execute: boolean;
  readonly inSession: boolean;
  readonly lines: readonly LineSnapshot[];
  readonly actions: readonly KeeperAction[];
  /** Null on a lane from before v4, whose guard takes no readings. */
  readonly observations: readonly ObservationSnapshot[] | null;
  readonly health: ObservationHealth;
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

  const [mandates, inSession, rule] = await Promise.all([chain.lines(options.fromBlock), chain.inSession(), chain.observationRule()]);
  const lines: LineSnapshot[] = [];
  const actions: KeeperAction[] = [];

  // Readings first: a liquidation reads the same vault, and a line whose draws are halted for want
  // of a reading is better served by the reading than by anything else this pass can send.
  const observed = rule === null ? null : await observeAssets(chain, rule, execute);
  if (observed !== null) actions.push(...observed.actions);

  for (const mandate of mandates) {
    const position = await chain.account(mandate);
    lines.push(snapshot(position, !inSession));
    if (position.outstandingMicro === 0n || position.healthE18 >= WAD) continue;
    actions.push(await liquidateLine(chain, mandate, execute));
  }

  const sweep = await sweepSpread(chain, execute, options.sweepMinMicro);
  if (sweep !== null) actions.push(sweep);

  return {
    at: now().toISOString(),
    execute,
    inSession,
    lines,
    actions,
    observations: observed?.snapshots ?? null,
    health: observed?.health ?? { observed: true, halted: [], summary: 'The price guard on this lane takes no readings, so there is nothing to keep.' },
  };
}

/**
 * Halts the next reading may clear. The rest are the feed's, the issuer's or the pool's to clear,
 * `Unreadable` among them: a feed or a pool that does not answer is not helped by a reading of it.
 */
const CLEARED_BY_OBSERVING: ReadonlySet<DrawHalt | undefined> = new Set(['NoObservation', 'ObservationExpired', 'ObservationOffBand', 'FeedJump']);

/** Halts that mean this keeper has not kept up. */
const UNKEPT: ReadonlySet<DrawHalt | 'Unknown'> = new Set(['NoObservation', 'ObservationExpired']);

function clip(priceE8: bigint): bigint {
  return priceE8 > MAX_SAMPLE_PRICE ? MAX_SAMPLE_PRICE : priceE8;
}

/**
 * What one asset needs this pass: a reading, a wait, or nothing.
 *
 * A reading the guard would refuse as too young is a wait, whatever else is true, because the call
 * would revert. After that, anything a reading would change is worth its gas: a guard with no
 * reading at all, no reading in force, one about to run out, a draw halted on the reading in force,
 * or a pool or feed that has moved since the waiting reading was taken. A pool and a feed sitting
 * where the last reading left them, with the reading in force good for two more waits, is the
 * weekend, and observing it would record the same figures under a newer stamp.
 */
export function observeDecision(
  o: Observation,
  rule: ObservationRule,
  now: bigint,
): { readonly action: 'observe'; readonly reason: ObserveReason } | { readonly action: 'wait'; readonly until: bigint } | { readonly action: 'skip' } {
  if (o.pending.at === 0n) return { action: 'observe', reason: 'first-reading' };

  const pendingAge = now - o.pending.at;
  if (pendingAge < rule.minAge) return { action: 'wait', until: o.pending.at + rule.minAge };

  if (o.aged.at === 0n) return { action: 'observe', reason: 'promote' };
  // Two waits of margin: the pass after this one may land late, and the one after that is when the
  // reading promoted now would itself be due.
  if (now - o.aged.at + 2n * rule.minAge > rule.maxAge) return { action: 'observe', reason: 'promote' };
  if (CLEARED_BY_OBSERVING.has(o.halt)) return { action: 'observe', reason: 'halted' };
  if (clip(o.poolE8) !== o.pending.poolE8 || clip(o.feedE8) !== o.pending.feedE8) return { action: 'observe', reason: 'moved' };

  return { action: 'skip' };
}

async function observeAssets(
  chain: KeeperChain,
  rule: ObservationRule,
  execute: boolean,
): Promise<{ actions: KeeperAction[]; snapshots: ObservationSnapshot[]; health: ObservationHealth }> {
  const [assets, now] = await Promise.all([chain.assets(), chain.now()]);
  const actions: KeeperAction[] = [];
  const snapshots: ObservationSnapshot[] = [];

  for (const asset of assets) {
    const o = await chain.observation(asset);
    snapshots.push({
      asset,
      halt: o.halt ?? 'Unknown',
      agedAgeSeconds: o.aged.at === 0n ? null : Number(now - o.aged.at),
      pendingAgeSeconds: o.pending.at === 0n ? null : Number(now - o.pending.at),
    });

    const decision = observeDecision(o, rule, now);
    if (decision.action === 'skip') {
      actions.push({ kind: 'observe', asset, outcome: 'skipped', reason: 'unchanged', detail: 'the pool and the feed sit where the waiting reading left them, and the reading in force has time left' });
      continue;
    }
    if (decision.action === 'wait') {
      actions.push({
        kind: 'observe',
        asset,
        outcome: 'waiting',
        reason: 'too-soon',
        detail: `the waiting reading can replace the one in force from ${new Date(Number(decision.until) * 1000).toISOString()}`,
      });
      continue;
    }

    try {
      await chain.simulateObserve(asset);
    } catch (error) {
      const reason = revertName(error);
      // The clock moved between the read and the simulation, or another keeper got there first.
      // Either way the reading now waiting is young, which is what the next pass will find.
      actions.push(
        reason.includes('ObservationTooSoon')
          ? { kind: 'observe', asset, outcome: 'waiting', reason: 'too-soon', detail: 'the guard holds a reading younger than its minimum age; another sender landed one' }
          : { kind: 'observe', asset, outcome: 'failed', reason },
      );
      continue;
    }

    if (!execute) {
      actions.push({ kind: 'observe', asset, outcome: 'would-send', reason: decision.reason });
      continue;
    }
    try {
      actions.push({ kind: 'observe', asset, outcome: 'sent', reason: decision.reason, tx: await chain.observe(asset) });
    } catch (error) {
      actions.push({ kind: 'observe', asset, outcome: 'failed', reason: revertName(error) });
    }
  }

  const halted = snapshots.filter((s) => s.halt !== 'None').map((s) => ({ asset: s.asset, halt: s.halt }));
  const unkept = halted.filter((h) => UNKEPT.has(h.halt));
  const sent = actions.filter((a) => a.kind === 'observe' && a.outcome === 'sent').length;
  return {
    actions,
    snapshots,
    health: {
      observed: unkept.length === 0,
      halted,
      summary:
        unkept.length > 0
          ? `Draws against ${unkept.length} of ${assets.length} assets are halted for want of a reading in force${sent > 0 ? `; ${sent} reading${sent === 1 ? '' : 's'} sent this pass, in force after the guard's minimum age` : ''}.`
          : halted.length > 0
            ? `Readings are in force for every asset; draws against ${halted.length} of ${assets.length} are halted on the feed, the issuer or the pool.`
            : `Readings are in force for every asset and draws count all ${assets.length}.`,
    },
  };
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
  const held = (await chain.positions(mandate))
    .filter((p) => p.raw > 0n)
    .sort((a, b) => (b.valueMicro > a.valueMicro ? 1 : b.valueMicro < a.valueMicro ? -1 : 0));
  // The largest fresh position is the one worth selling. With none fresh the vault is still asked:
  // a line holding only dust or a dropped asset is written off by the same call, and anything else
  // comes back with the guard's reason for waiting.
  const asset = (held.find((p) => p.fresh) ?? held[0])?.asset;
  if (asset === undefined) {
    return { kind: 'liquidate', mandate, asset: null, outcome: 'deferred', reason: 'no collateral posted' };
  }

  let sold: bigint;
  try {
    sold = await chain.simulateLiquidate(mandate, asset);
  } catch (error) {
    const reason = revertName(error);
    const waiting = Object.entries(DEFERRING).find(([name]) => reason.includes(name));
    return waiting === undefined
      ? { kind: 'liquidate', mandate, asset, outcome: 'failed', reason }
      : { kind: 'liquidate', mandate, asset, outcome: 'deferred', reason: waiting[0], detail: waiting[1] };
  }

  const kind = sold === 0n ? 'write-off' : 'liquidate';
  if (!execute) return { kind, mandate, asset, outcome: 'would-send' };
  return { kind, mandate, asset, outcome: 'sent', tx: await chain.liquidate(mandate, asset) };
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

/** A guard from before v4 has no `MIN_OBSERVATION_AGE`, and viem reports the call as answering nothing. */
function noSuchFunction(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionZeroDataError) !== null;
}

function toSample(tuple: readonly [number, bigint, bigint]): Sample {
  return { at: BigInt(tuple[0]), poolE8: tuple[1], feedE8: tuple[2] };
}

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

  // The guard is immutable on the vault, so one read serves the pass.
  let guard: Promise<Address> | undefined;
  const guardAddress = (): Promise<Address> =>
    (guard ??= publicClient.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'guard' }).catch((error: unknown) => {
      guard = undefined;
      throw error;
    }));

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
      const { result } = await publicClient.simulateContract({
        address: vault,
        abi: LIQUIDATE_ABI,
        functionName: 'liquidate',
        args: [mandate, asset],
        account: caller,
      });
      return result;
    },
    liquidate: (mandate, asset) =>
      send({ address: vault, abi: collateralVaultAbi, functionName: 'liquidate', args: [mandate, asset], account: options.account ?? null, chain: options.chain ?? null }),
    async simulateSweep() {
      await publicClient.simulateContract({ address: pool, abi: creditPoolAbi, functionName: 'sweepSpread', account: caller });
    },
    sweep: () =>
      send({ address: pool, abi: creditPoolAbi, functionName: 'sweepSpread', account: options.account ?? null, chain: options.chain ?? null }),
    async now() {
      return (await publicClient.getBlock()).timestamp;
    },
    assets: () => publicClient.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'collateralAssets' }),
    async observationRule() {
      const address = await guardAddress();
      try {
        const [minAge, maxAge] = await Promise.all([
          publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'MIN_OBSERVATION_AGE' }),
          publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'MAX_OBSERVATION_AGE' }),
        ]);
        return { minAge, maxAge };
      } catch (error) {
        if (noSuchFunction(error)) return null;
        throw error;
      }
    },
    async observation(asset) {
      const address = await guardAddress();
      const [aged, pending, poolE8, valuation, halt] = await Promise.all([
        publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'aged', args: [asset] }),
        publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'pending', args: [asset] }),
        publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'poolPriceE8', args: [asset] }),
        publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'valuation', args: [asset] }),
        publicClient.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'drawHalt', args: [asset] }),
      ]);
      return { aged: toSample(aged), pending: toSample(pending), poolE8, feedE8: valuation[0], halt: drawHaltOf(halt) };
    },
    async simulateObserve(asset) {
      await publicClient.simulateContract({ address: await guardAddress(), abi: priceGuardAbi, functionName: 'observe', args: [asset], account: caller });
    },
    observe: async (asset) =>
      send({ address: await guardAddress(), abi: priceGuardAbi, functionName: 'observe', args: [asset], account: options.account ?? null, chain: options.chain ?? null }),
  };
}
