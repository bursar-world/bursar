import type { StateLevel } from '@/state';

/**
 * Where a dispute is, and which of its two exits the registry will accept right now.
 *
 * The contract decides both from four numbers and a clock, and it decides them differently from
 * how they read. `finalize` opens before the reveal window closes once every commitment has been
 * revealed, and `failDispute` opens the moment the commit window closes when too few resolvers
 * committed to ever reach quorum. A screen that offered only the obvious one would send a resolver
 * at a call that reverts, and a resolver who pays for a reverted call twice stops trusting the
 * screen. Everything here mirrors the guards in `OracleRegistry` and is tested against them.
 */

/** `IOracleRegistry.DisputeStatus`, in the order the enum declares. */
export const DisputeStatus = {
  None: 0,
  Committing: 1,
  Revealing: 2,
  Finalized: 3,
  Failed: 4,
} as const;

/** `IOracleRegistry.ResolverStatus`. */
export const ResolverStatus = {
  None: 0,
  Active: 1,
  Unbonding: 2,
  Exited: 3,
} as const;

export type DisputePhase =
  /** Sealed scores are being taken. Nothing can be revealed yet. */
  | 'commit'
  /** The commit window has closed and the scores behind it are being published. */
  | 'reveal'
  /** The vote is over and somebody has to close it. Until they do, the money stays locked. */
  | 'ruling'
  | 'finalized'
  | 'failed'
  /** The registry has no dispute under this id. */
  | 'unknown';

/** Which call the registry accepts. `none` means neither, and the reason is the clock. */
export type DisputeExit = 'finalize' | 'fail' | 'none';

/** The four fields the guards read, and nothing else, so this stays testable without a chain. */
export type DisputeClock = {
  readonly status: number;
  readonly commitEndsAt: Date | null;
  readonly revealEndsAt: Date | null;
  readonly commitCount: number;
  readonly revealCount: number;
};

export type VotingRules = {
  readonly quorum: number;
  readonly maxVoters: number;
  readonly maxDeviation: number;
  readonly slashBps: number;
};

/**
 * The registry's roster cap, `MAX_RESOLVERS`. A registry whose `maxVoters` reaches it seats every
 * bonded resolver on every dispute, so nobody can be crowded out by whoever commits first.
 */
export const ROSTER_SEATS = 64;

/**
 * Which call closes this dispute, or neither.
 *
 * Reveals can never outnumber commitments, so a commit phase that ended short of quorum has
 * already decided the outcome and `failDispute` takes it there without waiting out a reveal window
 * nobody can add to. That branch comes first because `finalize` would revert on the same dispute.
 *
 * A window whose end could not be read is treated as still open. That is the answer that sends
 * nobody at a call that reverts.
 */
export function exitFor(dispute: DisputeClock, rules: VotingRules, now: Date): DisputeExit {
  if (dispute.status !== DisputeStatus.Committing && dispute.status !== DisputeStatus.Revealing) return 'none';
  if (dispute.commitEndsAt === null || now < dispute.commitEndsAt) return 'none';

  if (dispute.commitCount < rules.quorum) return 'fail';

  const revealClosed = dispute.revealEndsAt !== null && now >= dispute.revealEndsAt;
  if (dispute.revealCount >= rules.quorum && (revealClosed || dispute.revealCount >= dispute.commitCount)) {
    return 'finalize';
  }
  if (revealClosed) return 'fail';

  return 'none';
}

/**
 * What closing a dispute without a ruling does to the bonds behind it, right now.
 *
 * `failDispute` decides the silence slash off the clock alone:
 *
 *     _closeVotes(disputeId, 0, cfg, block.timestamp >= dispute.revealEndsAt, false);
 *
 * That test is independent of the quorum branch above it, so the same call is harmless the moment
 * the commit window shuts and costs every committer that never revealed 10% of its bond a few
 * hours later. Nothing on screen may assert one of those and mean the other.
 */
export type SilenceSlash = {
  /** Committers that never revealed. `_closeVotes` reaches exactly these. */
  readonly silent: number;
  /** Whether the reveal window has closed, which is what turns silence into a slash. */
  readonly counted: boolean;
};

export function silenceSlash(dispute: DisputeClock, now: Date): SilenceSlash {
  return {
    silent: Math.max(dispute.commitCount - dispute.revealCount, 0),
    // A reveal window that did not come back is read as closed. That is the direction that warns
    // a resolver about a slash the registry might take rather than promising one it will not.
    counted: dispute.revealEndsAt === null || now >= dispute.revealEndsAt,
  };
}

export function phaseOf(dispute: DisputeClock, rules: VotingRules, now: Date): DisputePhase {
  if (dispute.status === DisputeStatus.None) return 'unknown';
  if (dispute.status === DisputeStatus.Finalized) return 'finalized';
  if (dispute.status === DisputeStatus.Failed) return 'failed';
  if (dispute.commitEndsAt === null) return 'commit';
  if (now < dispute.commitEndsAt) return 'commit';
  return exitFor(dispute, rules, now) === 'none' ? 'reveal' : 'ruling';
}

/**
 * The moment the phase on screen runs out. Null where nothing is counting down: a dispute waiting
 * on a ruling waits for a person, not for a clock, and a settled one has no next moment at all.
 */
export function phaseDeadline(dispute: DisputeClock, phase: DisputePhase): Date | null {
  if (phase === 'commit') return dispute.commitEndsAt;
  if (phase === 'reveal') return dispute.revealEndsAt;
  return null;
}

const PHASE_LABEL: Record<DisputePhase, string> = {
  commit: 'Sealing scores',
  reveal: 'Revealing',
  ruling: 'Waiting to be closed',
  finalized: 'Ruled',
  failed: 'Closed without a ruling',
  unknown: 'Not on the registry',
};

const PHASE_LEVEL: Record<DisputePhase, StateLevel> = {
  commit: 'attention',
  reveal: 'attention',
  ruling: 'blocked',
  finalized: 'ok',
  failed: 'ok',
  unknown: 'unknown',
};

export function phaseLabel(phase: DisputePhase): string {
  return PHASE_LABEL[phase];
}

export function phaseLevel(phase: DisputePhase): StateLevel {
  return PHASE_LEVEL[phase];
}

/** Whether the registry will take a sealed score from a resolver right now. */
export type CommitBlocker =
  | 'window-closed'
  | 'panel-full'
  | 'already-committed'
  | 'not-active'
  | 'bond-short'
  | 'barred'
  | 'unread';

export type CommitCheck = { readonly allowed: boolean; readonly blocker: CommitBlocker | null };

export type ResolverSeat = {
  readonly status: number | undefined;
  readonly bond: bigint | undefined;
  readonly floor: bigint | undefined;
  readonly barred: boolean | undefined;
  readonly committed: boolean | undefined;
};

/**
 * `commitVote` reads the bond floor live on every vote, so a resolver benched by a raise is
 * benched from the next block and not from the next registration. The order here is the order the
 * contract checks in, which is what makes the one named blocker the one that would revert.
 */
export function commitCheck(
  dispute: DisputeClock,
  rules: VotingRules,
  seat: ResolverSeat,
  phase: DisputePhase,
): CommitCheck {
  if (phase !== 'commit') return { allowed: false, blocker: 'window-closed' };
  if (seat.status === undefined || seat.bond === undefined || seat.floor === undefined || seat.committed === undefined) {
    return { allowed: false, blocker: 'unread' };
  }
  if (seat.status !== ResolverStatus.Active) return { allowed: false, blocker: 'not-active' };
  if (seat.barred === true) return { allowed: false, blocker: 'barred' };
  if (seat.bond < seat.floor) return { allowed: false, blocker: 'bond-short' };
  if (seat.committed) return { allowed: false, blocker: 'already-committed' };
  if (dispute.commitCount >= rules.maxVoters) return { allowed: false, blocker: 'panel-full' };
  return { allowed: true, blocker: null };
}

export type RevealBlocker = 'commit-window-open' | 'window-closed' | 'nothing-sealed' | 'already-revealed' | 'unread';

export type RevealCheck = { readonly allowed: boolean; readonly blocker: RevealBlocker | null };

export function revealCheck(
  dispute: DisputeClock,
  seat: Pick<ResolverSeat, 'committed'> & { readonly revealed: boolean | undefined },
  now: Date,
): RevealCheck {
  if (seat.committed === undefined || seat.revealed === undefined) return { allowed: false, blocker: 'unread' };
  if (!seat.committed) return { allowed: false, blocker: 'nothing-sealed' };
  if (seat.revealed) return { allowed: false, blocker: 'already-revealed' };
  if (dispute.status !== DisputeStatus.Committing && dispute.status !== DisputeStatus.Revealing) {
    return { allowed: false, blocker: 'window-closed' };
  }
  if (dispute.commitEndsAt === null || now < dispute.commitEndsAt) return { allowed: false, blocker: 'commit-window-open' };
  if (dispute.revealEndsAt === null || now >= dispute.revealEndsAt) return { allowed: false, blocker: 'window-closed' };
  return { allowed: true, blocker: null };
}

/**
 * `OracleRegistry.refundBpsForScore`, copied so the panel can say what a score does to the money
 * before anyone pays for a transaction to find out. The steps are the contract's, in score points.
 */
export function refundBpsForScore(score: number): number {
  if (score < 50) return 10_000;
  if (score < 65) return 7_500;
  if (score < 80) return 3_500;
  return 0;
}

/** What a score means for the payer's money, in the words the payer would use. */
export function scoreMeaning(score: number): string {
  const refund = refundBpsForScore(score);
  if (refund === 10_000) return 'The payer gets the whole payment back.';
  if (refund === 7_500) return 'The payer gets three quarters back and the payee keeps a quarter.';
  if (refund === 3_500) return 'The payer gets 35% back and the payee keeps the rest.';
  return 'The payee keeps the whole payment.';
}

/** The score the reveal panel refuses above. `scoreMax()` on the registry, checked on chain. */
export const SCORE_MAX = 100;

/**
 * A typed score as a whole number.
 *
 * A comma is taken as a decimal separator, because most of the world writes one and a resolver
 * typing 80,0 means eighty. A fraction that is not zero is refused rather than rounded: the
 * contract takes a `uint8` and rounding a vote silently is not this screen's decision to make.
 */
export function parseScore(input: string): number | undefined {
  const cleaned = input.replace(/[\s ']/gu, '');
  if (!/^\d+([.,]\d*)?$/u.test(cleaned)) return undefined;

  const separator = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'));
  const whole = separator === -1 ? cleaned : cleaned.slice(0, separator);
  const fraction = separator === -1 ? '' : cleaned.slice(separator + 1);
  if (fraction !== '' && /[1-9]/u.test(fraction)) return undefined;

  const value = Number(whole);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function scoreProblem(score: number | undefined): string | undefined {
  if (score === undefined) return 'Enter a score between 0 and 100.';
  if (!Number.isInteger(score)) return 'A score is a whole number between 0 and 100.';
  if (score < 0 || score > SCORE_MAX) return `A score is between 0 and ${SCORE_MAX}.`;
  return undefined;
}

/**
 * How far a revealed score may sit from the median before the bond behind it is cut. Read from the
 * live config rather than written here, because governance moves it.
 */
export function deviationWarning(score: number, rules: VotingRules): string {
  return `A revealed score more than ${rules.maxDeviation} points from the panel's median loses ${(rules.slashBps / 100).toFixed(
    rules.slashBps % 100 === 0 ? 0 : 2,
  )}% of your bond. You are voting ${score}.`;
}
