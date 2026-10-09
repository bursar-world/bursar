import { micro } from '@bursar/core';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { positionFrom } from '@/chain/token';
import type { BuybackState, PendingExit, StakingPool } from '@/chain/token';
import { rebateReason, rebateSentence } from '@/app/(app)/token/rebate';
import { tokenFailure } from '@/app/(app)/token/refusal';
import { buybackTrigger, capSentence, ceilingStaleAt, exitStage, slasherSentence } from '@/app/(app)/token/state';
import { brsr } from '@/money';

const KEEPER = '0x000000000000000000000000000000000000bEEF' as Address;
const STRANGER = '0x0000000000000000000000000000000000000Bad' as Address;
const CREDIT_POOL = '0xc217AF334e6EaC06B774B5059B16257695937b0a' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const NOW = Date.parse('2026-10-10T12:00:00Z');
const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

function pool(over: Partial<StakingPool> = {}): StakingPool {
  return {
    address: '0x3f2a0E7822B30aD928488F053348b137866Cf962',
    stakeToken: undefined,
    rewardToken: undefined,
    totalStaked: brsr(1_000_000n * 10n ** 18n),
    totalShares: 1n,
    unbondingStaked: brsr(0n),
    paused: false,
    unbondingPeriod: 604_800n,
    unbondWindow: 604_800n,
    maxExitHold: 604_800n,
    exitsHeldUntil: null,
    slasher: ZERO,
    slashCapBps: 1_000,
    slashWindow: 604_800n,
    slashAllowance: brsr(100_000n * 10n ** 18n),
    tiers: [],
    ...over,
  };
}

function exit(over: Partial<PendingExit> = {}): PendingExit {
  return {
    amount: brsr(5_000n * 10n ** 18n),
    requestedAt: at('2026-10-01T12:00:00Z'),
    maturesAt: at('2026-10-08T12:00:00Z'),
    lapsesAt: at('2026-10-15T12:00:00Z'),
    ...over,
  };
}

function buyback(over: Partial<BuybackState> = {}): BuybackState {
  return {
    address: '0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0',
    available: micro(500_000n),
    paused: false,
    lastBuybackAt: null,
    nextBuybackAt: null,
    spendPerCall: micro(500_000n),
    maxSpendPerWindow: micro(5_000_000n),
    spentThisWindow: micro(0n),
    windowStartsAt: null,
    windowSeconds: 86_400n,
    ceiling: micro(240n),
    ceilingSetAt: at('2026-10-08T12:00:00Z'),
    maxCeilingAge: 604_800n,
    keeper: KEEPER,
    ...over,
  };
}

/** A refusal shaped the way viem hands one back once it has decoded it against the ABI it was given. */
function refused(errorName: string, args: readonly unknown[] = []): unknown {
  return {
    name: 'ContractFunctionExecutionError',
    message: `The contract function reverted with ${errorName}.`,
    cause: { name: 'ContractFunctionRevertedError', data: { errorName, args } },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An exit request earns nothing from the block it is filed, and it can only complete inside the
 * window between maturity and lapse, and not while a pause is holding exits. Each of those is a
 * different control on the card, so each is its own stage here.
 */
describe('where an exit request stands', () => {
  it('waits until it matures', () => {
    expect(exitStage(exit({ maturesAt: new Date(NOW + HOUR) }), pool(), NOW)).toBe('waiting');
  });

  it('is ready between maturity and lapse', () => {
    expect(exitStage(exit(), pool(), NOW)).toBe('ready');
  });

  it('lapses at the date the pool gives, whatever else is true', () => {
    expect(exitStage(exit({ lapsesAt: new Date(NOW - 1) }), pool({ paused: true }), NOW)).toBe('lapsed');
  });

  it('is held while a pause is keeping exits from completing', () => {
    expect(exitStage(exit(), pool({ paused: true, exitsHeldUntil: new Date(NOW + HOUR) }), NOW)).toBe('held');
  });

  it('is ready again once the hold runs out, even with the pool still paused', () => {
    expect(exitStage(exit(), pool({ paused: true, exitsHeldUntil: new Date(NOW - HOUR) }), NOW)).toBe('ready');
  });

  it('treats a pause whose hold could not be read as holding, never as open', () => {
    expect(exitStage(exit(), pool({ paused: true, exitsHeldUntil: undefined }), NOW)).toBe('unknown-hold');
    expect(exitStage(exit(), pool({ paused: undefined, exitsHeldUntil: undefined }), NOW)).toBe('unknown-hold');
    expect(exitStage(exit(), pool({ paused: false, exitsHeldUntil: undefined }), NOW)).toBe('ready');
  });
});

describe('the position, out of whichever readings came back', () => {
  const base = {
    raw: undefined,
    shares: 12n,
    unbond: undefined,
    activeStake: brsr(10n),
    stakedValue: brsr(15n),
    pendingRewards: micro(1n),
    rebateBps: 0,
    minBond: brsr(1n),
  };

  it('says no exit is open when the pool dates none', () => {
    expect(positionFrom({ ...base, unbond: [0n, 0n, 0n] }).exit).toBeNull();
  });

  it('prices and dates an open exit from one call', () => {
    const matures = BigInt(Date.parse('2026-10-08T12:00:00Z') / 1000);
    const lapses = BigInt(Date.parse('2026-10-15T12:00:00Z') / 1000);
    const read = positionFrom({ ...base, unbond: [5n, matures, lapses] });

    expect(read.exit).toEqual({ amount: 5n, requestedAt: undefined, maturesAt: at('2026-10-08T12:00:00Z'), lapsesAt: at('2026-10-15T12:00:00Z') });
  });

  it('leaves the exit unknown, not closed, when the pool did not answer', () => {
    const read = positionFrom(base);

    expect(read.exit).toBeUndefined();
    expect(read.shares).toBe(12n);
    expect(read.activeStake).toBe(10n);
  });

  it('prefers the share count a wiped pool reads as zero over the stale record', () => {
    const raw = { shares: 99n, unbondingShares: 0n, rewardDebt: 0n, rewards: 0n, unbondingAt: 0n, heldAtRequest: 0n, epoch: 0 };

    expect(positionFrom({ ...base, raw, shares: 0n }).shares).toBe(0n);
    expect(positionFrom({ ...base, raw, shares: undefined }).shares).toBe(99n);
  });
});

/**
 * The pool reads a staker's tier with one share more than they hold, so a stake of exactly a
 * tier's amount keeps it after a compound moves the price. The page takes the tier from that
 * answer rather than working it out again from a figure a hair under the line.
 */
describe('the rebate tier', () => {
  const TIERS = [
    { minStake: brsr(25_000n * 10n ** 18n), rebateBps: 500 },
    { minStake: brsr(100_000n * 10n ** 18n), rebateBps: 1_000 },
    { minStake: brsr(500_000n * 10n ** 18n), rebateBps: 2_000 },
  ];

  it('names the tier the contract awarded when the earning stake reads a hair under it', () => {
    const justUnder = brsr(100_000n * 10n ** 18n - 7n);
    const reason = rebateReason(TIERS, { rebateBps: 1_000, activeStake: justUnder, stakedValue: justUnder });

    expect(reason).toMatchObject({ kind: 'earning', tier: TIERS[1]?.minStake, nextTier: TIERS[2]?.minStake });
    expect(rebateSentence(reason)).toContain('clears the 100,000');
  });
});

describe('what staking exposes a staker to', () => {
  it('states the cap and the refill window the pool reads', () => {
    const sentence = capSentence(pool());

    expect(sentence).toContain('at most 10% of the pool');
    expect(sentence).toContain('refills evenly over 7 days');
    expect(sentence).toContain('including stake waiting to exit');
  });

  it('says nothing can take stake while no slasher is named', () => {
    expect(slasherSentence(pool(), CREDIT_POOL, false)).toContain('nothing can take stake');
  });

  it('says a write-off takes stake only on a live ceiling once the credit pool is the slasher', () => {
    const sentence = slasherSentence(pool({ slasher: CREDIT_POOL }), CREDIT_POOL, false);

    expect(sentence).toContain('credit pool is the slasher today');
    expect(sentence).toContain('unset or stale');
  });

  it('does not call an unread slasher empty', () => {
    const sentence = slasherSentence(pool({ slasher: undefined }), CREDIT_POOL, false);

    expect(sentence).toContain('Could not read which address can take stake');
    expect(sentence).not.toContain('No slasher is named');
  });
});

/**
 * Only the keeper can trigger a buy, and the contract refuses in a fixed order: the pause, the
 * keeper, an unset ceiling, a stale one, the interval. The card names the first of those that
 * holds, because that is the refusal the keeper's wallet would get.
 */
describe('whether a buy can run', () => {
  it('offers the trigger to the keeper when there is something to spend', () => {
    expect(buybackTrigger(buyback(), KEEPER, false, NOW)).toEqual({ isKeeper: true, canTrigger: true, hold: undefined });
  });

  it('does not offer it to anyone else, and says why', () => {
    const trigger = buybackTrigger(buyback(), STRANGER, false, NOW);

    expect(trigger.isKeeper).toBe(false);
    expect(trigger.hold).toContain('Only the keeper can trigger a buy');
  });

  it('says no buy can run while no keeper is named', () => {
    expect(buybackTrigger(buyback({ keeper: ZERO, available: micro(0n) }), STRANGER, false, NOW).hold).toContain('No keeper is named');
  });

  it('names an unset ceiling before a stale one, and a stale one before an empty balance', () => {
    const unset = buybackTrigger(buyback({ ceiling: micro(0n), available: micro(0n) }), KEEPER, false, NOW);
    const stale = buybackTrigger(buyback({ ceilingSetAt: at('2026-09-01T00:00:00Z'), available: micro(0n) }), KEEPER, false, NOW);

    expect(unset.hold).toContain('unset');
    expect(stale.hold).toContain('gone stale');
  });

  it('dates the stale point from when the ceiling was set and how long it is trusted', () => {
    expect(ceilingStaleAt(buyback())?.toISOString()).toBe('2026-10-15T12:00:00.000Z');
    expect(ceilingStaleAt(buyback({ maxCeilingAge: undefined }))).toBeUndefined();
  });

  it('says nothing while the first reading is on its way', () => {
    expect(buybackTrigger(undefined, KEEPER, true, NOW).hold).toBeUndefined();
  });

  it('keeps an unread keeper apart from an absent one', () => {
    expect(buybackTrigger(buyback({ keeper: undefined, available: micro(0n) }), KEEPER, false, NOW).hold).toContain('Could not read which address can trigger a buy');
  });
});

describe('what the staking pool and the buyback say no for', () => {
  const lapsedAt = BigInt(Date.parse('2026-10-15T12:00:00Z') / 1000);

  it('tells a staker whose request lapsed that the stake is still theirs and what brings it back', () => {
    const text = message(tokenFailure(refused('UnbondLapsed', [lapsedAt]), { action: 'Complete the withdrawal', contract: 'staking' }));

    expect(text).toContain('This request lapsed');
    expect(text).toContain('still yours');
    expect(text).toContain('Put it back to work');
    expect(text).not.toContain('UnbondLapsed');
  });

  it('says a held exit loses nothing by waiting', () => {
    const text = message(tokenFailure(refused('ExitsHeld', [lapsedAt]), { action: 'Complete the withdrawal', contract: 'staking' }));

    expect(text).toContain('keeps exits from completing until');
    expect(text).toContain('you lose nothing by waiting');
  });

  it('explains a pool that takes no new stake after a near-total loss', () => {
    expect(message(tokenFailure(refused('PoolCollapsed'), { action: 'Stake', contract: 'staking' }))).toContain('not taking new stake');
  });

  it('names the keeper and a stale ceiling in the buyback’s words', () => {
    expect(message(tokenFailure(refused('NotKeeper'), { action: 'Trigger a buy', contract: 'buyback' }))).toContain('Only the keeper');
    expect(message(tokenFailure(refused('PriceCeilingStale', [lapsedAt]), { action: 'Trigger a buy', contract: 'buyback' }))).toContain(
      'went stale',
    );
  });

  it('says which contract a pause belongs to', () => {
    expect(message(tokenFailure(refused('EnforcedPause'), { action: 'Trigger a buy', contract: 'buyback' }))).toContain('The buyback is paused');
    expect(message(tokenFailure(refused('EnforcedPause'), { action: 'Stake', contract: 'staking' }))).toContain('staking pool is paused');
  });

  it('leaves anything it has no sentence for to the classifier the rest of the app uses', () => {
    const text = message(tokenFailure(refused('SomethingNew'), { action: 'Stake', contract: 'staking' }));

    expect(text).toContain('Stake was refused with SomethingNew');
  });
});
