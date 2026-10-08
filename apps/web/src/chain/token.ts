import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address } from 'viem';

import { assertTokenChain } from './rhc';
import { rhcClient } from './client';
import { ReadBatch, addBlockNumber, addChainTime, runBatch } from './batch';
import { brsr } from '../money';
import type { Brsr } from '../money';
import { BRSR_SUPPLY, TOKEN_ADDRESSES, TOKEN_ROLES, buybackAbi, brsrAbi, stakingAbi, vestingAbi } from './generated/token';

export { BRSR_SUPPLY, TOKEN_ADDRESSES, TOKEN_ROLES, buybackAbi, brsrAbi, stakingAbi, vestingAbi };

/**
 * The staking pool holds two positions at once: stake that is earning, and stake behind an exit
 * request, which earns nothing and still takes losses. Collapsing them into one balance would tell
 * a staker they are still collecting on stake they have already asked to take out.
 *
 * Every figure here is its own call, so each one is undefined when that call went unanswered.
 * A zero balance and an unread balance are opposite answers, and the type keeps them apart.
 */
export type StakingPosition = {
  /** Earning shares. An exit request moves its stake out of these. */
  readonly shares: bigint | undefined;
  /** Earning stake, valued in $BRSR at the pool's current share price. */
  readonly activeStake: Brsr | undefined;
  /** Everything the account holds in the pool, a pending exit included. */
  readonly stakedValue: Brsr | undefined;
  /** Unclaimed distribution, in USDG. The pool distributes the settlement asset, not the token. */
  readonly pendingRewards: Micro | undefined;
  /** Fee rebate this balance currently earns, in basis points against the facilitator fee. */
  readonly rebateBps: number | undefined;
  /** The exit request. Null when none is pending, undefined when the pool did not say. */
  readonly exit: PendingExit | null | undefined;
  readonly minBond: Brsr | undefined;
};

/** One exit request, as `Staking.unbondOf` prices and dates it. */
export type PendingExit = {
  /** What completing it pays now: its value when it was filed, less every slash since. */
  readonly amount: Brsr;
  /** Undefined where the position record did not come back; the other dates do not need it. */
  readonly requestedAt: Date | undefined;
  readonly maturesAt: Date;
  /**
   * After this the request can no longer complete, and its stake waits, earning nothing, until it
   * is put back to work. Any time a pause spends holding exits is added to it.
   */
  readonly lapsesAt: Date;
};

export type StakingPool = {
  readonly address: Address;
  readonly stakeToken: Address | undefined;
  /** USDG. Distribution is in the settlement asset. */
  readonly rewardToken: Address | undefined;
  readonly totalStaked: Brsr | undefined;
  /** Earning shares. Stake behind pending exits is outside them. */
  readonly totalShares: bigint;
  /** The part of `totalStaked` behind pending exits. It earns nothing and takes its share of a slash. */
  readonly unbondingStaked: Brsr | undefined;
  readonly paused: boolean | undefined;
  readonly unbondingPeriod: bigint | undefined;
  /** How long a matured request stays open to complete. */
  readonly unbondWindow: bigint | undefined;
  /** The longest a pause holds matured exits closed. */
  readonly maxExitHold: bigint | undefined;
  /** When the pause running now stops holding exits. Null while nothing is held. */
  readonly exitsHeldUntil: Date | null | undefined;
  /** The one address that can take stake. The zero address means nobody can. */
  readonly slasher: Address | undefined;
  /** The most one slash can take, as a share of the pool. */
  readonly slashCapBps: number | undefined;
  /** How long a used allowance takes to refill. */
  readonly slashWindow: bigint | undefined;
  /** What the slasher could take in this block. */
  readonly slashAllowance: Brsr | undefined;
  readonly tiers: readonly { readonly minStake: Brsr; readonly rebateBps: number }[] | undefined;
};

export type VestingGrant = {
  readonly total: Brsr;
  readonly claimed: Brsr;
  readonly vested: Brsr | undefined;
  readonly claimable: Brsr | undefined;
  readonly start: Date;
  readonly cliffAt: Date | undefined;
  readonly endsAt: Date | undefined;
  readonly revokedAt: Date | null;
};

export type BuybackState = {
  readonly address: Address;
  /** What the keeper's next call would spend. Zero whenever that call would be refused. */
  readonly available: Micro | undefined;
  readonly paused: boolean | undefined;
  readonly lastBuybackAt: Date | null;
  readonly nextBuybackAt: Date | null;
  readonly spendPerCall: Micro;
  readonly maxSpendPerWindow: Micro;
  readonly spentThisWindow: Micro | undefined;
  readonly windowStartsAt: Date | null;
  readonly windowSeconds: bigint;
  /** The most a buy pays for one whole BRSR. Zero refuses every buy. */
  readonly ceiling: Micro;
  /** When governance last set the ceiling. */
  readonly ceilingSetAt: Date | null | undefined;
  /** How long a ceiling stays usable after it is set. */
  readonly maxCeilingAge: bigint | undefined;
  /** The only address that can trigger a buy. The zero address means nobody can. */
  readonly keeper: Address | undefined;
};

export type TokenSnapshot = {
  readonly blockNumber: bigint | undefined;
  /** The chain's clock at that block. Lapse and staleness are measured against it. */
  readonly chainTime: Date | undefined;
  readonly readAt: Date;
  /**
   * False when a call in this batch went unanswered. The page says so. The alternative is claiming
   * a block it read and leaving a figure at zero for a contract it never heard from.
   */
  readonly complete: boolean;
  readonly failures: number;
  readonly totalSupply: Brsr | undefined;
  readonly supply: typeof BRSR_SUPPLY;
  readonly balance: Brsr | undefined;
  readonly delegate: Address | undefined;
  readonly votes: Brsr | undefined;
  readonly pool: StakingPool | undefined;
  readonly position: StakingPosition | undefined;
  readonly grant: VestingGrant | undefined;
  readonly buyback: BuybackState | undefined;
};

export type RawPosition = {
  shares: bigint;
  unbondingShares: bigint;
  rewardDebt: bigint;
  rewards: bigint;
  unbondingAt: bigint;
  heldAtRequest: bigint;
  epoch: number;
};

type RawGrant = { totalWei: bigint; claimedWei: bigint; start: bigint; revokedAt: bigint };
type RawParams = {
  spendPerCallMicroUsd: bigint;
  maxSpendPerWindowMicroUsd: bigint;
  minSpendMicroUsd: bigint;
  maxPriceMicroUsdPerBrsr: bigint;
  window: bigint;
  minInterval: bigint;
};

/** One round trip for the whole token page, for the same reason every other read is batched. */
export async function readToken(account?: Address): Promise<TokenSnapshot> {
  assertTokenChain();

  const batch = new ReadBatch();
  const at = (address: Address, abi: unknown) => (functionName: string, args?: readonly unknown[]) => ({
    address,
    abi: abi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });

  const token = at(TOKEN_ADDRESSES.BRSR, brsrAbi);
  const staking = at(TOKEN_ADDRESSES.Staking, stakingAbi);
  const vesting = at(TOKEN_ADDRESSES.Vesting, vestingAbi);
  const buyback = at(TOKEN_ADDRESSES.Buyback, buybackAbi);

  const blockNumber = addBlockNumber(batch);
  const chainTime = addChainTime(batch);
  const totalSupply = batch.add<bigint>('brsr.totalSupply', token('totalSupply'));

  // Each of these is its own slot on purpose. The exit pool, the slash allowance and the ceiling's
  // age arrived with the contracts that replaced the first staking pool and buyback, and a contract
  // that does not answer one of them leaves that figure unread and the rest of the page standing.
  const pool = {
    stakeToken: batch.add<Address>('staking.stakeToken', staking('stakeToken')),
    rewardToken: batch.add<Address>('staking.rewardToken', staking('rewardToken')),
    totalStaked: batch.add<bigint>('staking.totalStaked', staking('totalStaked')),
    totalShares: batch.add<bigint>('staking.totalShares', staking('totalShares')),
    unbondingStaked: batch.add<bigint>('staking.unbondingStaked', staking('unbondingStaked')),
    paused: batch.add<boolean>('staking.paused', staking('paused')),
    minBond: batch.add<bigint>('staking.minBond', staking('minBond')),
    unbondingPeriod: batch.add<bigint>('staking.unbondingPeriod', staking('unbondingPeriod')),
    unbondWindow: batch.add<bigint>('staking.unbondWindow', staking('unbondWindow')),
    maxExitHold: batch.add<bigint>('staking.maxExitHold', staking('maxExitHold')),
    exitsHeldUntil: batch.add<bigint>('staking.exitsHeldUntil', staking('exitsHeldUntil')),
    slasher: batch.add<Address>('staking.slasher', staking('slasher')),
    slashCapBps: batch.add<number>('staking.slashCapBps', staking('slashCapBps')),
    slashWindow: batch.add<bigint>('staking.slashWindow', staking('slashWindow')),
    slashAllowance: batch.add<bigint>('staking.slashAllowance', staking('slashAllowance')),
    tiers: batch.add<readonly { minStake: bigint; rebateBps: number }[]>('staking.tiers', staking('tiers')),
  };

  const buybackSlots = {
    available: batch.add<bigint>('buyback.available', buyback('available')),
    paused: batch.add<boolean>('buyback.paused', buyback('paused')),
    last: batch.add<bigint>('buyback.lastBuybackAt', buyback('lastBuybackAt')),
    next: batch.add<bigint>('buyback.nextBuybackAt', buyback('nextBuybackAt')),
    params: batch.add<RawParams>('buyback.params', buyback('params')),
    window: batch.add<{ spentMicroUsd: bigint; start: bigint }>('buyback.window', buyback('window')),
    keeper: batch.add<Address>('buyback.keeper', buyback('keeper')),
    ceilingSetAt: batch.add<bigint>('buyback.ceilingSetAt', buyback('ceilingSetAt')),
    maxCeilingAge: batch.add<bigint>('buyback.maxCeilingAge', buyback('maxCeilingAge')),
  };

  const held = account
    ? {
        balance: batch.add<bigint>('brsr.balanceOf', token('balanceOf', [account])),
        delegate: batch.add<Address>('brsr.delegates', token('delegates', [account])),
        votes: batch.add<bigint>('brsr.getVotes', token('getVotes', [account])),
        position: batch.add<RawPosition>('staking.positionOf', staking('positionOf', [account])),
        shares: batch.add<bigint>('staking.sharesOf', staking('sharesOf', [account])),
        unbond: batch.add<readonly [bigint, bigint, bigint]>('staking.unbondOf', staking('unbondOf', [account])),
        activeStake: batch.add<bigint>('staking.activeStakeOf', staking('activeStakeOf', [account])),
        stakedValue: batch.add<bigint>('staking.stakedValueOf', staking('stakedValueOf', [account])),
        pendingRewards: batch.add<bigint>('staking.pendingRewards', staking('pendingRewards', [account])),
        rebateBps: batch.add<number>('staking.rebateBpsOf', staking('rebateBpsOf', [account])),
        minBondOf: batch.add<bigint>('staking.minBondOf', staking('minBondOf', [account])),
        grant: batch.add<RawGrant>('vesting.grantOf', vesting('grantOf', [account])),
        schedule: batch.add<readonly [bigint, bigint]>('vesting.scheduleOf', vesting('scheduleOf', [account])),
        vested: batch.add<bigint>('vesting.vestedOf', vesting('vestedOf', [account])),
        claimable: batch.add<bigint>('vesting.claimableOf', vesting('claimableOf', [account])),
      }
    : undefined;

  const results = await runBatch(rhcClient(), batch);

  const params = results.get(buybackSlots.params);
  const windowState = results.get(buybackSlots.window);
  const rawPosition = held ? results.get(held.position) : undefined;
  const rawGrant = held ? results.get(held.grant) : undefined;
  const schedule = held ? results.get(held.schedule) : undefined;
  const totalShares = results.get(pool.totalShares);
  const chainSeconds = results.get(chainTime);

  return {
    blockNumber: results.get(blockNumber),
    chainTime: chainSeconds === undefined ? undefined : toDate(chainSeconds),
    readAt: new Date(),
    complete: results.failures === 0,
    failures: results.failures,
    totalSupply: asBrsr(results.get(totalSupply)),
    supply: BRSR_SUPPLY,
    balance: held ? asBrsr(results.get(held.balance)) : undefined,
    delegate: held ? results.get(held.delegate) : undefined,
    votes: held ? asBrsr(results.get(held.votes)) : undefined,
    pool:
      totalShares === undefined
        ? undefined
        : {
            address: TOKEN_ADDRESSES.Staking,
            stakeToken: results.get(pool.stakeToken),
            rewardToken: results.get(pool.rewardToken),
            totalStaked: asBrsr(results.get(pool.totalStaked)),
            totalShares,
            unbondingStaked: asBrsr(results.get(pool.unbondingStaked)),
            paused: results.get(pool.paused),
            unbondingPeriod: results.get(pool.unbondingPeriod),
            unbondWindow: results.get(pool.unbondWindow),
            maxExitHold: results.get(pool.maxExitHold),
            exitsHeldUntil: optionalDate(results.get(pool.exitsHeldUntil)),
            slasher: results.get(pool.slasher),
            slashCapBps: results.get(pool.slashCapBps),
            slashWindow: results.get(pool.slashWindow),
            slashAllowance: asBrsr(results.get(pool.slashAllowance)),
            tiers: results.get(pool.tiers)?.map((tier) => ({ minStake: brsr(tier.minStake), rebateBps: tier.rebateBps })),
          },
    position: held
      ? positionFrom({
          raw: rawPosition,
          shares: results.get(held.shares),
          unbond: results.get(held.unbond),
          activeStake: asBrsr(results.get(held.activeStake)),
          stakedValue: asBrsr(results.get(held.stakedValue)),
          pendingRewards: asMicro(results.get(held.pendingRewards)),
          rebateBps: results.get(held.rebateBps),
          minBond: asBrsr(results.get(held.minBondOf) ?? results.get(pool.minBond)),
        })
      : undefined,
    grant:
      held && rawGrant && rawGrant.totalWei > 0n
        ? {
            total: brsr(rawGrant.totalWei),
            claimed: brsr(rawGrant.claimedWei),
            vested: asBrsr(results.get(held.vested)),
            claimable: asBrsr(results.get(held.claimable)),
            start: toDate(rawGrant.start),
            // The contract answers both dates in one call, and it answers zero only for an address
            // with no grant. This branch already has one, so a missing pair is an unread pair.
            cliffAt: schedule === undefined ? undefined : toDate(schedule[0]),
            endsAt: schedule === undefined ? undefined : toDate(schedule[1]),
            revokedAt: rawGrant.revokedAt === 0n ? null : toDate(rawGrant.revokedAt),
          }
        : undefined,
    buyback:
      params === undefined
        ? undefined
        : {
            address: TOKEN_ADDRESSES.Buyback,
            available: asMicro(results.get(buybackSlots.available)),
            paused: results.get(buybackSlots.paused),
            lastBuybackAt: nullableDate(results.get(buybackSlots.last)),
            nextBuybackAt: nullableDate(results.get(buybackSlots.next)),
            spendPerCall: micro(params.spendPerCallMicroUsd),
            maxSpendPerWindow: micro(params.maxSpendPerWindowMicroUsd),
            spentThisWindow: asMicro(windowState?.spentMicroUsd),
            windowStartsAt: nullableDate(windowState?.start),
            windowSeconds: params.window,
            ceiling: micro(params.maxPriceMicroUsdPerBrsr),
            ceilingSetAt: optionalDate(results.get(buybackSlots.ceilingSetAt)),
            maxCeilingAge: results.get(buybackSlots.maxCeilingAge),
            keeper: results.get(buybackSlots.keeper),
          },
  };
}

/**
 * The position out of whichever of its readings came back. Shares come from `sharesOf`, which
 * reads zero for a position a wiped pool left behind, and from the position record only when that
 * call fails; the exit comes from `unbondOf`, which prices and dates it in one call. No figure here
 * goes unread because a neighbouring call failed.
 *
 * Exported so the rule can be held to in a test without a chain in front of it.
 */
export function positionFrom(read: {
  raw: RawPosition | undefined;
  shares: bigint | undefined;
  unbond: readonly [bigint, bigint, bigint] | undefined;
  activeStake: Brsr | undefined;
  stakedValue: Brsr | undefined;
  pendingRewards: Micro | undefined;
  rebateBps: number | undefined;
  minBond: Brsr | undefined;
}): StakingPosition {
  const [amount, maturesAt, lapsesAt] = read.unbond ?? [];
  const exit: PendingExit | null | undefined =
    maturesAt === undefined || lapsesAt === undefined || amount === undefined
      ? undefined
      : maturesAt === 0n
        ? null
        : {
            amount: brsr(amount),
            requestedAt: read.raw === undefined || read.raw.unbondingAt === 0n ? undefined : toDate(read.raw.unbondingAt),
            maturesAt: toDate(maturesAt),
            lapsesAt: toDate(lapsesAt),
          };

  return {
    shares: read.shares ?? read.raw?.shares,
    activeStake: read.activeStake,
    stakedValue: read.stakedValue,
    pendingRewards: read.pendingRewards,
    rebateBps: read.rebateBps,
    exit,
    minBond: read.minBond,
  };
}

function asBrsr(value: bigint | undefined): Brsr | undefined {
  return value === undefined ? undefined : brsr(value);
}

function asMicro(value: bigint | undefined): Micro | undefined {
  return value === undefined ? undefined : micro(value);
}

function toDate(seconds: bigint): Date {
  return new Date(Number(seconds) * 1000);
}

function nullableDate(seconds: bigint | undefined): Date | null {
  return seconds === undefined || seconds === 0n ? null : toDate(seconds);
}

/** Zero is a reading that says "not set"; undefined is no reading at all. */
function optionalDate(seconds: bigint | undefined): Date | null | undefined {
  return seconds === undefined ? undefined : seconds === 0n ? null : toDate(seconds);
}

/** A bond floor at the whole supply admits no new address: only resolvers given their own floor can bond. */
export function closedBench(floor: bigint | undefined): boolean {
  return floor !== undefined && floor >= BRSR_SUPPLY.total;
}
