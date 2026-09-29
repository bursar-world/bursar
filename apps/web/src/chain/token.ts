import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address } from 'viem';

import { assertTokenChain } from './rhc';
import { rhcClient } from './client';
import { ReadBatch, addBlockNumber, runBatch } from './batch';
import { brsr } from '../money';
import type { Brsr } from '../money';
import { BRSR_SUPPLY, TOKEN_ADDRESSES, TOKEN_ROLES, buybackAbi, brsrAbi, stakingAbi, vestingAbi } from './generated/token';

export { BRSR_SUPPLY, TOKEN_ADDRESSES, TOKEN_ROLES, buybackAbi, brsrAbi, stakingAbi, vestingAbi };

/**
 * The staking pool holds two positions at once: stake that is working, and stake that is unbonding
 * and no longer is. Collapsing them into one balance would tell a staker they are still backing
 * the collateralized lane when they have already asked to leave.
 */
/**
 * Every figure here is its own call, so each one is undefined when that call went unanswered.
 * A zero balance and an unread balance are opposite answers, and the type keeps them apart.
 */
export type StakingPosition = {
  readonly shares: bigint;
  readonly unbondingShares: bigint;
  /** Stake still at risk, valued in $BRSR at the pool's current share price. */
  readonly activeStake: Brsr | undefined;
  /** Everything the account holds in the pool, working or not. */
  readonly stakedValue: Brsr | undefined;
  /** Unclaimed distribution, in USDG. The pool distributes the settlement asset, not the token. */
  readonly pendingRewards: Micro | undefined;
  /** Fee rebate this balance currently earns, in basis points against the facilitator fee. */
  readonly rebateBps: number | undefined;
  /** When unbonding stake can be withdrawn. Null when nothing is unbonding. */
  readonly unbondingAt: Date | null;
  readonly minBond: Brsr | undefined;
};

export type StakingPool = {
  readonly address: Address;
  readonly stakeToken: Address | undefined;
  /** USDG. Distribution is in the settlement asset. */
  readonly rewardToken: Address | undefined;
  readonly totalStaked: Brsr | undefined;
  readonly totalShares: bigint;
  readonly paused: boolean | undefined;
  readonly unbondingPeriod: bigint | undefined;
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
  /** USDG the contract holds and could spend on the next buy. */
  readonly available: Micro | undefined;
  readonly paused: boolean | undefined;
  readonly lastBuybackAt: Date | null;
  readonly nextBuybackAt: Date | null;
  readonly spendPerCall: Micro;
  readonly maxSpendPerWindow: Micro;
  readonly spentThisWindow: Micro | undefined;
  readonly windowStartsAt: Date | null;
  readonly windowSeconds: bigint;
};

export type TokenSnapshot = {
  readonly blockNumber: bigint | undefined;
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

type RawPosition = {
  shares: bigint;
  unbondingShares: bigint;
  rewardDebt: bigint;
  rewards: bigint;
  unbondingAt: bigint;
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
  const totalSupply = batch.add<bigint>('brsr.totalSupply', token('totalSupply'));

  const pool = {
    stakeToken: batch.add<Address>('staking.stakeToken', staking('stakeToken')),
    rewardToken: batch.add<Address>('staking.rewardToken', staking('rewardToken')),
    totalStaked: batch.add<bigint>('staking.totalStaked', staking('totalStaked')),
    totalShares: batch.add<bigint>('staking.totalShares', staking('totalShares')),
    paused: batch.add<boolean>('staking.paused', staking('paused')),
    minBond: batch.add<bigint>('staking.minBond', staking('minBond')),
    unbondingPeriod: batch.add<bigint>('staking.unbondingPeriod', staking('unbondingPeriod')),
    tiers: batch.add<readonly { minStake: bigint; rebateBps: number }[]>('staking.tiers', staking('tiers')),
  };

  const buybackSlots = {
    available: batch.add<bigint>('buyback.available', buyback('available')),
    paused: batch.add<boolean>('buyback.paused', buyback('paused')),
    last: batch.add<bigint>('buyback.lastBuybackAt', buyback('lastBuybackAt')),
    next: batch.add<bigint>('buyback.nextBuybackAt', buyback('nextBuybackAt')),
    params: batch.add<RawParams>('buyback.params', buyback('params')),
    window: batch.add<{ spentMicroUsd: bigint; start: bigint }>('buyback.window', buyback('window')),
  };

  const held = account
    ? {
        balance: batch.add<bigint>('brsr.balanceOf', token('balanceOf', [account])),
        delegate: batch.add<Address>('brsr.delegates', token('delegates', [account])),
        votes: batch.add<bigint>('brsr.getVotes', token('getVotes', [account])),
        position: batch.add<RawPosition>('staking.positionOf', staking('positionOf', [account])),
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

  return {
    blockNumber: results.get(blockNumber),
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
            paused: results.get(pool.paused),
            unbondingPeriod: results.get(pool.unbondingPeriod),
            tiers: results.get(pool.tiers)?.map((tier) => ({ minStake: brsr(tier.minStake), rebateBps: tier.rebateBps })),
          },
    position:
      held && rawPosition
        ? {
            shares: rawPosition.shares,
            unbondingShares: rawPosition.unbondingShares,
            activeStake: asBrsr(results.get(held.activeStake)),
            stakedValue: asBrsr(results.get(held.stakedValue)),
            pendingRewards: asMicro(results.get(held.pendingRewards)),
            rebateBps: results.get(held.rebateBps),
            unbondingAt: rawPosition.unbondingAt === 0n ? null : toDate(rawPosition.unbondingAt),
            minBond: asBrsr(results.get(held.minBondOf) ?? results.get(pool.minBond)),
          }
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
          },
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
