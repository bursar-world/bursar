/**
 * The reputation contract's arithmetic, done off chain.
 *
 * `capOf` answers what a payee may be paid today. What recording a release is worth, and why a
 * clean record scores 25 and not 100, are sums over state the contract holds and never publishes
 * as an answer. They are done here the way the contract does them: in integers, with its one
 * floored division, so a figure worked out before a transaction is the figure the chain lands on.
 */

import { isAddressEqual } from 'viem';
import type { Address } from 'viem';
import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';

/** The top of the score scale, which `Reputation.scoreMax()` answers. */
const TOP = 100n;

/** How a payee's scored locks ended. Counts as the contract holds them, in uint64. */
export type ReputationCounters = {
  readonly released: bigint;
  readonly timedOut: bigint;
  readonly disputed: bigint;
};

/** `IReputation.CapCurve`: the cap at a score of zero, what each point adds, and the ceiling. */
export type CapCurve = {
  readonly baseCap: Micro;
  readonly capPerScore: Micro;
  readonly maxCap: Micro;
};

/**
 * `IReputation.Weights`: what a point costs. A lock under `minScored` moves no counter in either
 * direction. Each payer's released volume counts toward a payee's credit up to `edgeCap`, and the
 * released share counts in full once the credit reaches `fullCredit`, so a full score takes at
 * least `fullCredit / edgeCap` payers.
 */
export type ReputationWeights = {
  readonly minScored: Micro;
  readonly edgeCap: Micro;
  readonly fullCredit: Micro;
};

/** A release about to be recorded: who paid, and the lock's principal. */
export type ScoredRelease = {
  readonly payer: Address;
  readonly amount: Micro;
};

/** The weighing a v4 contract applies, and what it has booked so far. */
export type ReputationWeighing = {
  readonly weights: ReputationWeights;
  /** `creditOf(payee)`: the payee's released volume, each payer counted up to the edge cap. */
  readonly credit: Micro;
  /**
   * `edgeVolume(payer, payee)` for each payer a projected release names. A payer left out is read
   * as having released nothing to this payee yet.
   */
  readonly edges?: readonly { readonly payer: Address; readonly volume: Micro }[];
};

export type ReputationProjection = {
  readonly score: number;
  readonly cap: Micro;
  readonly counters: ReputationCounters;
  /** Undefined where the contract weighs nothing. */
  readonly credit: Micro | undefined;
  /** Releases that would move nothing: the payee paying itself, or a lock under `minScored`. */
  readonly uncounted: number;
};

function least(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * `Reputation.score`. Released locks as a share of settled ones, scaled by the credit earned
 * toward `fullCredit`, in a single division that floors. Without a weighing it is the share alone,
 * which is the whole score on a contract from before v4.
 */
export function reputationScore(
  counters: ReputationCounters,
  weighing?: { readonly credit: bigint; readonly fullCredit: bigint },
): number {
  const settled = counters.released + counters.timedOut + counters.disputed;
  if (settled === 0n) return 0;
  if (weighing === undefined) return Number((counters.released * TOP) / settled);

  const earned = least(weighing.credit, weighing.fullCredit);
  return Number((counters.released * TOP * earned) / (settled * weighing.fullCredit));
}

/** `Reputation.capOf` for a score: `min(baseCap + capPerScore * score, maxCap)`. */
export function capAtScore(score: number, curve: CapCurve): Micro {
  const cap = curve.baseCap + curve.capPerScore * BigInt(score);
  return micro(least(cap, curve.maxCap));
}

/**
 * What a release of `amount` adds to a payee's credit when its payer's edge already holds `volume`.
 * Credit is the capped edge volume, so only the part of the release that lifts the edge toward
 * its cap is new, and past the cap a payer can keep paying and add nothing.
 */
export function creditFromRelease(amount: bigint, volume: bigint, edgeCap: bigint): bigint {
  return least(volume + amount, edgeCap) - least(volume, edgeCap);
}

/**
 * Where a payee's score and cap land once `releases` are recorded, in the order given.
 *
 * Each release goes through what `onReleased` does: a payee paying itself moves nothing, and
 * under a weighing neither does a lock below `minScored`; every other one counts as released, adds
 * its amount to its payer's edge and adds to the credit whatever part of it the edge cap leaves
 * room for. Leave `weighing` out for a contract from before v4, which counts and does not weigh.
 */
export function projectReputation(args: {
  readonly payee: Address;
  readonly counters: ReputationCounters;
  readonly curve: CapCurve;
  readonly weighing?: ReputationWeighing;
  readonly releases: readonly ScoredRelease[];
}): ReputationProjection {
  const { payee, curve, weighing } = args;
  const volumes = new Map<string, bigint>((weighing?.edges ?? []).map((edge) => [edge.payer.toLowerCase(), edge.volume]));

  let released = args.counters.released;
  let credit: bigint | undefined = weighing?.credit;
  let uncounted = 0;

  for (const release of args.releases) {
    const scored =
      !isAddressEqual(release.payer, payee) && (weighing === undefined || release.amount >= weighing.weights.minScored);
    if (!scored) {
      uncounted += 1;
      continue;
    }

    released += 1n;
    if (weighing === undefined || credit === undefined) continue;

    const key = release.payer.toLowerCase();
    const volume = volumes.get(key) ?? 0n;
    credit += creditFromRelease(release.amount, volume, weighing.weights.edgeCap);
    volumes.set(key, volume + release.amount);
  }

  const counters = { ...args.counters, released };
  const score = reputationScore(
    counters,
    weighing === undefined || credit === undefined ? undefined : { credit, fullCredit: weighing.weights.fullCredit },
  );

  return {
    score,
    cap: capAtScore(score, curve),
    counters,
    credit: credit === undefined ? undefined : micro(credit),
    uncounted,
  };
}
