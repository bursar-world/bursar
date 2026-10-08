import { bps, formatBrsr } from '@/money';
import type { Brsr } from '@/money';

/**
 * Why a staked balance earns the rebate it earns.
 *
 * `Staking.rebateBpsOf` measures the ladder against the earning shares alone, priced with one
 * share more than the account holds:
 *
 *     uint256 value = _stakeFor(position.shares + 1);
 *
 * The extra share gives back the fraction a deposit leaves in the pool, so a stake of exactly a
 * tier's amount reads that tier even after a compound has moved the price. It also means the
 * earning stake shown on the page can sit a hair under the tier the contract awards, so the tier is
 * taken from the contract's own answer and never re-derived from the stake.
 *
 * A position sitting above a tier and the same position with a withdrawal pending read the same on
 * the pool total and differently on the rebate, because a request moves its stake out of the
 * earning shares. The page used to explain every zero with "the table is not set", which was true
 * before the tiers landed and is now the wrong cause printed next to the right number.
 */
export type RebateTier = { readonly minStake: Brsr; readonly rebateBps: number };

export type RebateReason =
  /** A reading that has not landed or did not come back. Never merged with a real zero. */
  | { readonly kind: 'unread'; readonly missing: string }
  | { readonly kind: 'no-table' }
  | { readonly kind: 'nothing-staked' }
  /** Everything held is on its way out, so nothing is active and nothing earns. */
  | { readonly kind: 'all-exiting'; readonly held: Brsr; readonly ifCancelled: number }
  /** A pending withdrawal is what dropped the position below the tier it would otherwise hold. */
  | { readonly kind: 'exit-dropped-a-tier'; readonly atRisk: Brsr; readonly held: Brsr; readonly floor: Brsr; readonly ifCancelled: number }
  | { readonly kind: 'under-the-first-tier'; readonly atRisk: Brsr; readonly floor: Brsr }
  | { readonly kind: 'earning'; readonly atRisk: Brsr; readonly rebateBps: number; readonly tier: Brsr; readonly nextTier: Brsr | undefined };

export type RebatePosition = {
  readonly rebateBps: number | undefined;
  /** Stake not on its way out. The only figure the ladder is measured against. */
  readonly activeStake: Brsr | undefined;
  /** Everything in the pool, including anything already asked back. */
  readonly stakedValue: Brsr | undefined;
};

/** The rebate a balance of this size would earn, by the contract's own walk down the ladder. */
export function rebateForStake(tiers: readonly RebateTier[], value: Brsr): number {
  if (value === 0n) return 0;
  for (let index = tiers.length; index > 0; index -= 1) {
    const tier = tiers[index - 1];
    if (tier !== undefined && value >= tier.minStake) return tier.rebateBps;
  }
  return 0;
}

export function rebateReason(tiers: readonly RebateTier[] | undefined, position: RebatePosition): RebateReason {
  if (tiers === undefined) return { kind: 'unread', missing: 'the rebate tiers' };
  if (position.rebateBps === undefined) return { kind: 'unread', missing: 'the rebate on this position' };
  if (position.activeStake === undefined) return { kind: 'unread', missing: 'your earning stake' };
  if (position.stakedValue === undefined) return { kind: 'unread', missing: 'what this position holds in the pool' };
  if (tiers.length === 0) return { kind: 'no-table' };

  const ladder = [...tiers].sort((a, b) => (a.minStake < b.minStake ? -1 : a.minStake > b.minStake ? 1 : 0));
  const floor = ladder[0];
  if (floor === undefined) return { kind: 'no-table' };

  if (position.rebateBps > 0) {
    const reached = ladder.filter((tier) => position.activeStake !== undefined && position.activeStake >= tier.minStake);
    const current = ladder.find((tier) => tier.rebateBps === position.rebateBps) ?? reached[reached.length - 1] ?? floor;
    const next = ladder.find((tier) => tier.minStake > current.minStake);
    return {
      kind: 'earning',
      atRisk: position.activeStake,
      rebateBps: position.rebateBps,
      tier: current.minStake,
      nextTier: next?.minStake,
    };
  }

  if (position.stakedValue === 0n) return { kind: 'nothing-staked' };

  const ifCancelled = rebateForStake(ladder, position.stakedValue);

  if (position.activeStake === 0n) {
    return { kind: 'all-exiting', held: position.stakedValue, ifCancelled };
  }

  if (position.stakedValue > position.activeStake && ifCancelled > 0) {
    return {
      kind: 'exit-dropped-a-tier',
      atRisk: position.activeStake,
      held: position.stakedValue,
      floor: floor.minStake,
      ifCancelled,
    };
  }

  return { kind: 'under-the-first-tier', atRisk: position.activeStake, floor: floor.minStake };
}

/** The same answer in the words a staker would use. One sentence per reason, no hedging. */
export function rebateSentence(reason: RebateReason): string {
  switch (reason.kind) {
    case 'unread':
      return `Could not read ${reason.missing}, so this rebate cannot be explained yet.`;

    case 'no-table':
      return 'The staking contract holds no rebate tiers, so every staked balance earns zero until governance sets them.';

    case 'nothing-staked':
      return 'Nothing is staked here. The rebate comes from a staked balance.';

    case 'all-exiting':
      return `All ${formatBrsr(reason.held)} BRSR in this position is waiting to exit, and the rebate counts earning stake only. Cancelling the exit would earn ${bps(
        reason.ifCancelled,
      )}.`;

    case 'exit-dropped-a-tier':
      return `The rebate counts earning stake only, which is ${formatBrsr(
        reason.atRisk,
      )} BRSR here, and the first tier starts at ${formatBrsr(reason.floor)} BRSR. Your pending withdrawal put it under: the pool still holds ${formatBrsr(
        reason.held,
      )} BRSR for you, and cancelling the exit would earn ${bps(reason.ifCancelled)}.`;

    case 'under-the-first-tier':
      return `The rebate counts earning stake only, which is ${formatBrsr(
        reason.atRisk,
      )} BRSR here. The first tier starts at ${formatBrsr(reason.floor)} BRSR.`;

    case 'earning':
      return `${formatBrsr(reason.atRisk)} BRSR of earning stake clears the ${formatBrsr(reason.tier)} BRSR tier.${
        reason.nextTier === undefined ? '' : ` The next one starts at ${formatBrsr(reason.nextTier)} BRSR.`
      }`;
  }
}
