/**
 * When each step of a dispute happens, from the dispute's own clock. Pure.
 *
 * The published timeline is written for the live windows, six hours to commit and six to reveal.
 * It is computed here as fractions of those windows so a governance change to either moves every
 * step with it rather than leaving a commit scheduled after the window it belongs to has shut:
 *
 *   T + 3h00   evidence cutoff           half the commit window
 *   T + 3h30   commit from the primary   7/12
 *   T + 4h30   commit from the standby   3/4
 *   T + 5h30   page if short of quorum   11/12
 *   T + 10h    page if a reveal is owed  2/3 into the reveal window
 *   T + 11h    last-chance reveal        5/6 into the reveal window
 */

export type DisputeClock = {
  readonly openedAt: bigint;
  readonly commitEndsAt: bigint;
  readonly revealEndsAt: bigint;
};

export type Timeline = {
  readonly openedAt: bigint;
  readonly evidenceCutoff: bigint;
  readonly commitAt: bigint;
  readonly standbyAt: bigint;
  readonly commitCritical: bigint;
  readonly commitEndsAt: bigint;
  readonly revealCritical: bigint;
  readonly lastChance: bigint;
  readonly revealEndsAt: bigint;
};

/**
 * Past this long in `Disputed`, a lock is inside the window where `disputeTimeout` becomes
 * callable at 48 hours and D17 lets it pre-empt a ruling. Anything still frozen here is a page.
 */
export const WATCHDOG_SECONDS = 40n * 3_600n;

export function timeline(clock: DisputeClock): Timeline {
  const commit = clock.commitEndsAt - clock.openedAt;
  const reveal = clock.revealEndsAt - clock.commitEndsAt;
  const at = (start: bigint, span: bigint, numerator: bigint, denominator: bigint): bigint =>
    start + (span * numerator) / denominator;

  return {
    openedAt: clock.openedAt,
    evidenceCutoff: at(clock.openedAt, commit, 1n, 2n),
    commitAt: at(clock.openedAt, commit, 7n, 12n),
    standbyAt: at(clock.openedAt, commit, 3n, 4n),
    commitCritical: at(clock.openedAt, commit, 11n, 12n),
    commitEndsAt: clock.commitEndsAt,
    revealCritical: at(clock.commitEndsAt, reveal, 2n, 3n),
    lastChance: at(clock.commitEndsAt, reveal, 5n, 6n),
    revealEndsAt: clock.revealEndsAt,
  };
}

/**
 * Which keys vote on a dispute: `quorum` of them in turn from `disputeId mod n`, and the rest held
 * back as standby. The rotation keeps every key signing in the normal run of things, so a key
 * whose custody has broken shows up on an ordinary dispute rather than on the one that needed it.
 */
export function rotation(disputeId: bigint, keyCount: number, quorum: number): { primary: number[]; standby: number[] } {
  if (keyCount <= 0) return { primary: [], standby: [] };

  const start = Number(disputeId % BigInt(keyCount));
  const order = Array.from({ length: keyCount }, (_, offset) => (start + offset) % keyCount);
  const take = Math.min(Math.max(quorum, 1), keyCount);

  return { primary: order.slice(0, take), standby: order.slice(take) };
}
