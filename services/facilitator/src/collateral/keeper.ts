import { assetRegistryAbi, collateralVaultAbi, creditPoolAbi, drawHaltOf, priceGuardAbi } from '@bursar/core';
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
 * that finds a reading in force with time left sends nothing, however the pool and the feed have
 * moved: the guard judges each sample by the figures stored in it, so a reading taken in band stays
 * in band. Two readings are withheld on purpose: one taken while the pool sits
 * off band of its feed, which a push held across the pass would otherwise seat as the reading draws
 * are judged against, and one taken while the feed has jumped past the guard's bound since the
 * reading in force, which is a gap or a mis-scaled round until that reading runs out. A waiting
 * reading that was taken off band is replaced at once. A guard from before v4 has no readings to
 * keep, and the pass says so.
 *
 * Dry run is the default. Nothing is sent unless the run is told to execute and holds a key.
 */

const WAD = 10n ** 18n;

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
  /** The widest move of the feed since the reading in force that a draw still counts. */
  readonly maxFeedJumpBps: bigint;
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
  /** How far the pool's mid may sit from the feed for a reading to count, in basis points: the asset's band in the registry. */
  readonly bandBps: bigint;
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
  /** The waiting reading was taken with the pool off band, and is replaced before it can be promoted or judged. */
  | 'pending-off-band';

/** Why a pass leaves an asset's readings as they are. */
export type SkipReason =
  /** The reading in force has time left and the waiting one is sound; nothing a reading would change. */
  | 'unchanged'
  /** The pool sits off band of its feed, or one of them has no price; the reading in force stands. */
  | 'off-band'
  /** As `off-band`, with no reading in force to stand: draws halt until the pool returns. */
  | 'off-band-halting'
  /** The feed has jumped past the guard's bound since the reading in force, which lasts for now. */
  | 'feed-jump';

/** The readings a pass withholds, as opposed to the one it finds nothing to change. */
const WITHHELD: ReadonlySet<SkipReason> = new Set(['off-band', 'off-band-halting', 'feed-jump']);

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
const CLEARED_BY_OBSERVING: ReadonlySet<DrawHalt | undefined> = new Set(['NoObservation', 'ObservationExpired', 'ObservationOffBand', 'PendingOffBand', 'FeedJump']);

/** Halts that mean this keeper has not kept up. */
const UNKEPT: ReadonlySet<DrawHalt | 'Unknown'> = new Set(['NoObservation', 'ObservationExpired']);

const BPS = 10_000n;

/** How far `x` sits from `ref`, in basis points of `ref` rounded up, as the guard measures it. `ref` is never zero here. */
export function deviationBps(x: bigint, ref: bigint): bigint {
  const diff = x > ref ? x - ref : ref - x;
  return (diff * BPS + ref - 1n) / ref;
}

/** Whether a pool mid sits inside the band of a feed answer, as the guard judges a reading. No price on either side agrees with nothing. */
export function inBand(poolE8: bigint, feedE8: bigint, bandBps: bigint): boolean {
  return poolE8 !== 0n && feedE8 !== 0n && deviationBps(poolE8, feedE8) <= bandBps;
}

function e8(price: bigint): string {
  return (Number(price) / 1e8).toFixed(2);
}

/**
 * What one asset needs this pass: a reading, a wait, or nothing.
 *
 * Two readings are withheld before anything else is weighed. One taken while the pool sits off band
 * of its feed, or while either has no price, is a reading the guard holds against the lane: once
 * promoted it halts every draw for a cycle after the pool has recovered, which is what a push held
 * across one pass used to buy. So the pool has to agree with the feed before a reading is taken,
 * and the one in force stands meanwhile. When none is in force, or the one in force cannot last to
 * the next promotion, the lane halts for want of a reading instead, the halt the guard would raise
 * on the off-band reading itself. The other is a feed that has jumped past the guard's bound since
 * the reading in force: a gap or a mis-scaled round, and recording it would seat the jumped answer
 * as the one draws are judged against. It is left out while the reading in force lasts; once that
 * has run out the next reading is taken whatever the feed says, so the lane settles on two readings
 * that agree.
 *
 * A waiting reading the pool was pushed across is replaced at once, young or not: young, the guard
 * overwrites it in place; old enough, it is promoted, and the sooner that happens the sooner the
 * in-band reading taken now takes its place. A reading the guard would otherwise refuse as too young
 * is a wait, because the call would reset the waiting reading's clock. After that, only what a
 * reading would change is worth its gas: a guard with no reading at all, no reading in force or one
 * about to run out, or a draw halted on the reading in force where the one waiting may clear it. A
 * pool or a feed that has moved since the waiting reading was taken is not a reason: the guard
 * judges each sample by the pool and the feed stored in it, so a reading taken in band stays in
 * band, and refreshing it on every move cost a reading a pass per asset in a live market, which is
 * what emptied the keeper's float. With a reading in force good for two more waits, the pass sends
 * nothing.
 */
export function observeDecision(
  o: Observation,
  rule: ObservationRule,
  now: bigint,
):
  | { readonly action: 'observe'; readonly reason: ObserveReason }
  | { readonly action: 'wait'; readonly until: bigint }
  | { readonly action: 'skip'; readonly reason: SkipReason } {
  if (!inBand(o.poolE8, o.feedE8, o.bandBps)) {
    const stranded = o.aged.at === 0n || now - o.aged.at > rule.maxAge - rule.minAge;
    return { action: 'skip', reason: stranded ? 'off-band-halting' : 'off-band' };
  }
  if (o.aged.at !== 0n && o.aged.feedE8 !== 0n && now - o.aged.at <= rule.maxAge && deviationBps(o.feedE8, o.aged.feedE8) > rule.maxFeedJumpBps) {
    return { action: 'skip', reason: 'feed-jump' };
  }
  if (o.pending.at === 0n) return { action: 'observe', reason: 'first-reading' };
  if (!inBand(o.pending.poolE8, o.pending.feedE8, o.bandBps)) return { action: 'observe', reason: 'pending-off-band' };

  const pendingAge = now - o.pending.at;
  if (pendingAge < rule.minAge) return { action: 'wait', until: o.pending.at + rule.minAge };

  if (o.aged.at === 0n) return { action: 'observe', reason: 'promote' };
  // Two waits of margin: the pass after this one may land late, and the one after that is when the
  // reading promoted now would itself be due.
  if (now - o.aged.at + 2n * rule.minAge > rule.maxAge) return { action: 'observe', reason: 'promote' };
  if (CLEARED_BY_OBSERVING.has(o.halt)) return { action: 'observe', reason: 'halted' };

  return { action: 'skip', reason: 'unchanged' };
}

/** What a withheld or unneeded reading is waiting on, for the report. */
function skipDetail(reason: SkipReason, o: Observation, rule: ObservationRule): string {
  switch (reason) {
    case 'unchanged':
      return 'the reading in force has time left and the waiting one was taken in band; a reading now would change nothing a draw sees';
    case 'off-band':
      return `${offBand(o)}; recording it would carry the pushed price into the reading in force, so the one in force stands until the pool returns`;
    case 'off-band-halting':
      return `${offBand(o)}; no reading in force can carry the lane across, so draws halt until the pool returns and two readings agree`;
    case 'feed-jump':
      return `the feed (${e8(o.feedE8)}) has moved ${deviationBps(o.feedE8, o.aged.feedE8)} bps from the reading in force (${e8(o.aged.feedE8)}), past the guard's ${rule.maxFeedJumpBps} bps; a jumped round is not recorded while that reading lasts`;
  }
}

function offBand(o: Observation): string {
  if (o.feedE8 === 0n) return 'the feed has no answer';
  if (o.poolE8 === 0n) return 'the pool has no price';
  return `the pool's mid (${e8(o.poolE8)}) sits ${deviationBps(o.poolE8, o.feedE8)} bps from the feed (${e8(o.feedE8)}), outside the asset's ${o.bandBps} bps band`;
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
      actions.push({ kind: 'observe', asset, outcome: 'skipped', reason: decision.reason, detail: skipDetail(decision.reason, o, rule) });
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
      // Only a keeper the guard's governance named may record a reading; a key that is not one
      // cannot take readings at all, so every asset halts once the reading in force ages out.
      actions.push(
        reason.includes('NotKeeper')
          ? { kind: 'observe', asset, outcome: 'failed', reason: 'not-keeper', detail: 'the guard does not name this key as a keeper; governance names one with setKeeper' }
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
  const withheld = actions.filter((a) => a.kind === 'observe' && a.outcome === 'skipped' && WITHHELD.has(a.reason as SkipReason)).length;
  const standing =
    unkept.length > 0
      ? `Draws against ${unkept.length} of ${assets.length} assets are halted for want of a reading in force${sent > 0 ? `; ${sent} reading${sent === 1 ? '' : 's'} sent this pass, in force after the guard's minimum age` : ''}`
      : halted.length > 0
        ? `Readings are in force for every asset; draws against ${halted.length} of ${assets.length} are halted on the feed, the issuer or the pool`
        : `Readings are in force for every asset and draws count all ${assets.length}`;
  return {
    actions,
    snapshots,
    health: {
      observed: unkept.length === 0,
      halted,
      summary: `${standing}${withheld > 0 ? `; ${withheld} reading${withheld === 1 ? '' : 's'} withheld while the pool sits off band or the feed has jumped` : ''}.`,
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

  // The guard is immutable on the vault, and the registry on the guard, so one read of each serves
  // the pass.
  let guard: Promise<Address> | undefined;
  const guardAddress = (): Promise<Address> =>
    (guard ??= publicClient.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'guard' }).catch((error: unknown) => {
      guard = undefined;
      throw error;
    }));
  let registry: Promise<Address> | undefined;
  const registryAddress = (): Promise<Address> =>
    (registry ??= guardAddress()
      .then((address) => publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'registry' }))
      .catch((error: unknown) => {
        registry = undefined;
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
        const [minAge, maxAge, maxFeedJumpBps] = await Promise.all([
          publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'MIN_OBSERVATION_AGE' }),
          publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'MAX_OBSERVATION_AGE' }),
          publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'MAX_FEED_JUMP_BPS' }),
        ]);
        return { minAge, maxAge, maxFeedJumpBps };
      } catch (error) {
        if (noSuchFunction(error)) return null;
        throw error;
      }
    },
    async observation(asset) {
      const [address, registryAt] = await Promise.all([guardAddress(), registryAddress()]);
      const [aged, pending, poolE8, valuation, halt, terms] = await Promise.all([
        publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'aged', args: [asset] }),
        publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'pending', args: [asset] }),
        publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'poolPriceE8', args: [asset] }),
        publicClient.readContract({ address, abi: priceGuardAbi, functionName: 'valuation', args: [asset] }),
        publicClient.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'drawHalt', args: [asset] }),
        publicClient.readContract({ address: registryAt, abi: assetRegistryAbi, functionName: 'get', args: [asset] }),
      ]);
      return { aged: toSample(aged), pending: toSample(pending), poolE8, feedE8: valuation[0], halt: drawHaltOf(halt), bandBps: BigInt(terms.bandBps) };
    },
    async simulateObserve(asset) {
      await publicClient.simulateContract({ address: await guardAddress(), abi: priceGuardAbi, functionName: 'observe', args: [asset], account: caller });
    },
    observe: async (asset) =>
      send({ address: await guardAddress(), abi: priceGuardAbi, functionName: 'observe', args: [asset], account: options.account ?? null, chain: options.chain ?? null }),
  };
}
