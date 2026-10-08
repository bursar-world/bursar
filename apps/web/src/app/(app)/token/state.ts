import type { Address } from 'viem';

import { isZeroAddress, sameAddress } from '@/chain/rhc';
import type { BuybackState, PendingExit, StakingPool } from '@/chain/token';
import { formatDuration } from '@/lib';
import { bps } from '@/money';

/**
 * What the staking and buyback cards decide, kept apart from the markup so each rule can be held
 * to in a test without a chain or a wallet in front of it.
 */

/** When the buyback's ceiling stops being usable, or undefined where either half went unread. */
export function ceilingStaleAt(buyback: BuybackState | undefined): Date | undefined {
  if (buyback?.ceilingSetAt === undefined || buyback.ceilingSetAt === null || buyback.maxCeilingAge === undefined) return undefined;
  return new Date(buyback.ceilingSetAt.getTime() + Number(buyback.maxCeilingAge) * 1000);
}

export type BuybackTrigger = {
  /** The connected wallet is the keeper, so the trigger is offered at all. */
  readonly isKeeper: boolean;
  readonly canTrigger: boolean;
  /** Why a buy cannot run right now. Undefined when it can, or while the first reading is on its way. */
  readonly hold: string | undefined;
};

/**
 * Whether a buy can run, and if not, why. The reasons run in the order the contract checks them,
 * so the first one named is the one it would refuse with. An unread figure is its own reason and
 * never read as a zero.
 */
export function buybackTrigger(buyback: BuybackState | undefined, account: Address | undefined, reading: boolean, now: number): BuybackTrigger {
  const keeper = buyback?.keeper;
  const keeperNamed = keeper !== undefined && !isZeroAddress(keeper);
  const isKeeper = keeperNamed && account !== undefined && sameAddress(keeper, account);
  const staleAt = ceilingStaleAt(buyback);
  const stale = staleAt !== undefined && staleAt.getTime() < now;
  const canTrigger =
    isKeeper && buyback !== undefined && buyback.paused === false && buyback.available !== undefined && buyback.available > 0n;

  if (canTrigger || reading) return { isKeeper, canTrigger, hold: undefined };

  const hold =
    buyback === undefined
      ? 'Could not read the buyback contract. Read again to trigger a buy.'
      : buyback.paused === undefined
        ? 'Could not read whether the buyback is paused. A paused buyback refuses every buy.'
        : buyback.paused
          ? 'The buyback is paused, so it cannot spend.'
          : keeper === undefined
            ? 'Could not read which address can trigger a buy. Read again.'
            : !keeperNamed
              ? 'No keeper is named, so no buy can run. Governance names one by proposal.'
              : buyback.ceiling === 0n
                ? 'The price ceiling is unset, so every buy is refused until governance sets one.'
                : stale
                  ? 'The price ceiling has gone stale, so every buy is refused until governance sets it again.'
                  : buyback.available === undefined
                    ? 'Could not read what a buy could spend. Read again.'
                    : buyback.available === 0n
                      ? 'A buy could spend nothing right now, because of the balance, the window cap or the wait between buys.'
                      : 'Only the keeper can trigger a buy, and this wallet is not it.';

  return { isKeeper, canTrigger, hold };
}

/**
 * Where one exit request stands. `held` is a pause keeping a ready request from completing;
 * `unknown-hold` is a pause whose hold could not be read, which is treated as holding.
 */
export type ExitStage = 'waiting' | 'ready' | 'held' | 'unknown-hold' | 'lapsed';

export function exitStage(exit: PendingExit, pool: StakingPool | undefined, now: number): ExitStage {
  if (exit.lapsesAt.getTime() <= now) return 'lapsed';
  if (exit.maturesAt.getTime() > now) return 'waiting';
  const heldUntil = pool?.exitsHeldUntil;
  if (heldUntil instanceof Date && heldUntil.getTime() > now) return 'held';
  // A contract that does not say how long a pause holds exits is read as holding them for as long
  // as it is paused, which is what the first staking pool did.
  if (heldUntil === undefined && pool?.paused !== false) return 'unknown-hold';
  return 'ready';
}

export function capSentence(pool: StakingPool | undefined): string {
  if (pool?.slashCapBps === undefined || pool.slashWindow === undefined) {
    return 'Losses arrive at a capped rate: one slash takes at most a set share of the pool, and that allowance refills over a set window. Every staker loses the same share, including stake waiting to exit.';
  }
  return `Losses arrive at a capped rate. One slash takes at most ${bps(pool.slashCapBps)} of the pool, and that allowance refills evenly over ${formatDuration(
    Number(pool.slashWindow),
  )}. Every staker loses the same share, including stake waiting to exit.`;
}

export function slasherSentence(pool: StakingPool | undefined, creditPool: Address | undefined, reading: boolean): string {
  const slasher = pool?.slasher;
  if (slasher === undefined) {
    return reading
      ? 'Reading which address can take stake.'
      : 'Could not read which address can take stake, so whether a write-off reaches stakers today is unknown.';
  }
  if (isZeroAddress(slasher)) {
    return 'No slasher is named today, so nothing can take stake and the lender carries every write-off. Naming one takes a governance proposal, shown on the governance page before it can run.';
  }
  if (creditPool !== undefined && sameAddress(slasher, creditPool)) {
    return 'The credit pool is the slasher today. While the buyback’s price ceiling is unset or stale, a write-off takes no stake and the lender carries all of it. Changing the slasher takes a governance proposal and its delay.';
  }
  return 'The slasher today is an address other than the credit pool, shown below. Changing it takes a governance proposal, shown on the governance page before it can run.';
}

export function allowanceHint(pool: StakingPool | undefined): string {
  if (pool?.slashCapBps === undefined || pool.slashWindow === undefined) return 'What the slasher could take right now.';
  return `What the slasher could take right now: up to ${bps(pool.slashCapBps)} of the pool, less recent slashes, refilling over ${formatDuration(
    Number(pool.slashWindow),
  )}.`;
}

export function brakeHint(pool: StakingPool | undefined): string {
  const hold = pool?.maxExitHold === undefined ? 'for a set time' : `for at most ${formatDuration(Number(pool.maxExitHold))}`;
  return `When paused, the pool takes no new stake and keeps exits from completing ${hold}. Exit requests, cancellations and claims stay open.`;
}
