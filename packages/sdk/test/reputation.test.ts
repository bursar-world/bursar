import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { usdg } from '../src/money.js';
import { capAtScore, creditFromRelease, projectReputation, reputationScore } from '../src/reputation.js';
import type { CapCurve, ReputationCounters, ReputationWeights, ScoredRelease } from '../src/reputation.js';

const PAYEE: Address = '0x00000000000000000000000000000000000000aa';
const payer = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;

/** What the deploy sets: 25 USDG with no history, 2.25 more per point, 250 at the top. */
const CURVE: CapCurve = { baseCap: usdg('25'), capPerScore: usdg('2.25'), maxCap: usdg('250') };

/** And how a point is earned: a lock of 1 USDG or more counts, each payer for up to 62.5, and 250 is full credit. */
const WEIGHTS: ReputationWeights = { minScored: usdg('1'), edgeCap: usdg('62.5'), fullCredit: usdg('250') };

const NONE: ReputationCounters = { released: 0n, timedOut: 0n, disputed: 0n };

/** A payee with no history, after `releases` are recorded. */
function project(releases: readonly ScoredRelease[]) {
  return projectReputation({
    payee: PAYEE,
    counters: NONE,
    curve: CURVE,
    weighing: { weights: WEIGHTS, credit: usdg('0') },
    releases,
  });
}

/**
 * The contract divides once and floors. Every figure here is one `Reputation` answers from `score`
 * and `capOf` after the same releases, and the worked examples are the ones
 * contracts/test/ReputationCredit.t.sol asserts on chain.
 */
describe('the score a v4 reputation contract answers', () => {
  it('is zero with no history, whatever the credit', () => {
    expect(reputationScore(NONE, { credit: usdg('250'), fullCredit: usdg('250') })).toBe(0);
  });

  it('scales the released share by the credit earned toward full credit', () => {
    const clean = { released: 2n, timedOut: 0n, disputed: 0n };

    expect(reputationScore(clean, { credit: usdg('62.5'), fullCredit: usdg('250') })).toBe(25);
    expect(reputationScore(clean, { credit: usdg('250'), fullCredit: usdg('250') })).toBe(100);
    expect(reputationScore(clean, { credit: usdg('0'), fullCredit: usdg('250') })).toBe(0);
  });

  it('counts credit past full credit as full and no further', () => {
    const clean = { released: 9n, timedOut: 0n, disputed: 0n };

    expect(reputationScore(clean, { credit: usdg('900'), fullCredit: usdg('250') })).toBe(100);
  });

  it('floors once, after both factors, where two floors would lose a point', () => {
    // 2 of 3 released at 249 of 250 credit: 2 * 100 * 249 / (3 * 250) = 66.4. Flooring the share
    // to 66 first and scaling it after would answer 65.
    const mixed = { released: 2n, timedOut: 1n, disputed: 0n };

    expect(reputationScore(mixed, { credit: usdg('249'), fullCredit: usdg('250') })).toBe(66);
  });

  it('takes one release and one dispute from a payer at its cap to 12, half of a quarter floored', () => {
    const half = { released: 1n, timedOut: 0n, disputed: 1n };

    expect(reputationScore(half, { credit: usdg('62.5'), fullCredit: usdg('250') })).toBe(12);
  });

  it('is the released share alone on a contract that weighs nothing', () => {
    expect(reputationScore({ released: 9n, timedOut: 0n, disputed: 1n })).toBe(90);
    expect(reputationScore({ released: 1n, timedOut: 1n, disputed: 1n })).toBe(33);
  });
});

describe('the cap a score earns', () => {
  it('runs from the base cap to the ceiling', () => {
    expect(capAtScore(0, CURVE)).toBe(usdg('25'));
    expect(capAtScore(25, CURVE)).toBe(usdg('81.25'));
    expect(capAtScore(50, CURVE)).toBe(usdg('137.5'));
    expect(capAtScore(100, CURVE)).toBe(usdg('250'));
  });

  it('stops at the ceiling when the slope would pass it', () => {
    expect(capAtScore(100, { ...CURVE, maxCap: usdg('200') })).toBe(usdg('200'));
  });
});

describe('the credit one release adds', () => {
  it('is the whole amount while the edge has room, the remainder at the cap, and nothing past it', () => {
    expect(creditFromRelease(usdg('25'), usdg('0'), WEIGHTS.edgeCap)).toBe(usdg('25'));
    expect(creditFromRelease(usdg('47.5'), usdg('25'), WEIGHTS.edgeCap)).toBe(usdg('37.5'));
    expect(creditFromRelease(usdg('10'), usdg('72.5'), WEIGHTS.edgeCap)).toBe(0n);
  });
});

describe('where recording releases takes a payee', () => {
  it('starts every payee at the base cap', () => {
    const start = project([]);

    expect(start.score).toBe(0);
    expect(start.cap).toBe(usdg('25'));
  });

  it('takes one payer paying 25 then 47.5 to a score of 25 and a cap of 81.25', () => {
    const first = project([{ payer: payer(1), amount: usdg('25') }]);

    // 25 of 250 credit on a clean record is ten points, which lifts the cap to 47.5: the size of
    // the second job.
    expect(first.score).toBe(10);
    expect(first.cap).toBe(usdg('47.5'));

    const second = project([
      { payer: payer(1), amount: usdg('25') },
      { payer: payer(1), amount: usdg('47.5') },
    ]);

    // The edge holds 72.5 and counts for 62.5, so one payer tops out at a quarter of the scale.
    expect(second.credit).toBe(usdg('62.5'));
    expect(second.score).toBe(25);
    expect(second.cap).toBe(usdg('81.25'));
    expect(second.counters.released).toBe(2n);
  });

  it('holds one payer at 25 however much more it pays', () => {
    const many = project(Array.from({ length: 12 }, () => ({ payer: payer(1), amount: usdg('62.5') })));

    expect(many.credit).toBe(usdg('62.5'));
    expect(many.score).toBe(25);
    expect(many.cap).toBe(usdg('81.25'));
  });

  it('takes four payers at the edge cap to 100 and the 250 ceiling', () => {
    const four = project([1, 2, 3, 4].map((n) => ({ payer: payer(n), amount: usdg('62.5') })));

    expect(four.credit).toBe(usdg('250'));
    expect(four.score).toBe(100);
    expect(four.cap).toBe(usdg('250'));
  });

  // test_aFullScoreTakesFourCounterpartiesAndTheVolumeBehindThem: each job is the size the cap
  // before it allows, and the fifth lands on the ceiling.
  it('climbs 47.5, 81.25, 137.5, 193.75 and 250 as each job fills the cap before it', () => {
    const ladder: ScoredRelease[] = [
      { payer: payer(1), amount: usdg('25') },
      { payer: payer(1), amount: usdg('47.5') },
      { payer: payer(2), amount: usdg('81.25') },
      { payer: payer(3), amount: usdg('137.5') },
      { payer: payer(4), amount: usdg('193.75') },
    ];
    const after = (jobs: number) => project(ladder.slice(0, jobs));

    expect([1, 2, 3, 4, 5].map((jobs) => after(jobs).score)).toEqual([10, 25, 50, 75, 100]);
    expect([1, 2, 3, 4, 5].map((jobs) => after(jobs).cap)).toEqual([
      usdg('47.5'),
      usdg('81.25'),
      usdg('137.5'),
      usdg('193.75'),
      usdg('250'),
    ]);
  });

  it('leaves three payers a quarter short', () => {
    const three = project([1, 2, 3].map((n) => ({ payer: payer(n), amount: usdg('62.5') })));

    expect(three.score).toBe(75);
    expect(three.cap).toBe(usdg('193.75'));
  });

  it('moves nothing for a lock under the scored minimum, or for a payee paying itself', () => {
    const small = project([
      { payer: payer(1), amount: usdg('0.99') },
      { payer: PAYEE, amount: usdg('62.5') },
    ]);

    expect(small.uncounted).toBe(2);
    expect(small.counters).toEqual(NONE);
    expect(small.credit).toBe(0n);
    expect(small.cap).toBe(usdg('25'));
  });

  it('counts a lock at exactly the scored minimum', () => {
    const edge = project([{ payer: payer(1), amount: usdg('1') }]);

    expect(edge.uncounted).toBe(0);
    expect(edge.counters.released).toBe(1n);
    expect(edge.credit).toBe(usdg('1'));
  });

  it('starts from what the contract has already booked on each edge', () => {
    const projection = projectReputation({
      payee: PAYEE,
      counters: { released: 3n, timedOut: 1n, disputed: 0n },
      curve: CURVE,
      weighing: {
        weights: WEIGHTS,
        credit: usdg('100'),
        // The first payer is already at its cap, in a different letter case than the release names it.
        edges: [{ payer: payer(0xab).toUpperCase().replace('0X', '0x') as Address, volume: usdg('80') }],
      },
      releases: [
        { payer: payer(0xab), amount: usdg('50') },
        { payer: payer(2), amount: usdg('50') },
      ],
    });

    // Only the new payer's 50 is new credit: 150 of 250, on 5 released of 6 settled.
    expect(projection.credit).toBe(usdg('150'));
    expect(projection.score).toBe(50);
    expect(projection.cap).toBe(usdg('137.5'));
  });

  it('counts every release and weighs none on a contract from before v4', () => {
    const projection = projectReputation({
      payee: PAYEE,
      counters: { released: 1n, timedOut: 1n, disputed: 0n },
      curve: CURVE,
      releases: [
        { payer: payer(1), amount: usdg('0.01') },
        { payer: PAYEE, amount: usdg('5') },
      ],
    });

    expect(projection.score).toBe(66);
    expect(projection.credit).toBeUndefined();
    expect(projection.uncounted).toBe(1);
    expect(projection.cap).toBe(usdg('173.5'));
  });
});
