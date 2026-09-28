import { describe, expect, it } from 'vitest';

import {
  DisputeStatus,
  ResolverStatus,
  commitCheck,
  exitFor,
  parseScore,
  phaseDeadline,
  phaseOf,
  refundBpsForScore,
  revealCheck,
  scoreProblem,
} from '@/app/(app)/resolvers/phases';
import type { DisputeClock, VotingRules } from '@/app/(app)/resolvers/phases';

/**
 * The guards in `OracleRegistry`, restated.
 *
 * Offering a resolver the wrong call costs them a reverted transaction and, in the reveal window,
 * some of the only hours they have. Every case below is read off the contract's own conditions:
 * `finalize` opens early once every commitment has been revealed, and `failDispute` opens the
 * moment the commit window closes when the panel can never reach quorum.
 *
 * The live configuration on chain 4663, verified 2026-09-22: commit 21600s, reveal 21600s,
 * quorum 2, maxVoters 5, maxDeviation 20, slashBps 1000.
 */
const RULES: VotingRules = { quorum: 2, maxVoters: 5, maxDeviation: 20, slashBps: 1_000 };

const COMMIT_ENDS = new Date('2026-09-22T06:00:00Z');
const REVEAL_ENDS = new Date('2026-09-22T12:00:00Z');

const IN_COMMIT = new Date('2026-09-22T03:00:00Z');
const IN_REVEAL = new Date('2026-09-22T09:00:00Z');
const AFTER_REVEAL = new Date('2026-09-22T13:00:00Z');

function clock(over: Partial<DisputeClock> = {}): DisputeClock {
  return {
    status: DisputeStatus.Committing,
    commitEndsAt: COMMIT_ENDS,
    revealEndsAt: REVEAL_ENDS,
    commitCount: 0,
    revealCount: 0,
    ...over,
  };
}

describe('exitFor', () => {
  it('offers neither exit while the commit window is open', () => {
    expect(exitFor(clock({ commitCount: 3 }), RULES, IN_COMMIT)).toBe('none');
  });

  /**
   * Reveals can never outnumber commitments, so a commit phase that ended short of quorum has
   * already decided the outcome. Waiting out a reveal window nobody can add to only delays the
   * payer's refund.
   */
  it('offers the failure exit the moment a short commit phase ends', () => {
    expect(exitFor(clock({ commitCount: 1 }), RULES, IN_REVEAL)).toBe('fail');
    expect(exitFor(clock({ commitCount: 0 }), RULES, IN_REVEAL)).toBe('fail');
  });

  it('offers the ruling early once every commitment has been revealed', () => {
    expect(exitFor(clock({ status: DisputeStatus.Revealing, commitCount: 3, revealCount: 3 }), RULES, IN_REVEAL)).toBe('finalize');
  });

  it('keeps both exits shut while a revealed quorum is still short of the commitments', () => {
    expect(exitFor(clock({ status: DisputeStatus.Revealing, commitCount: 3, revealCount: 2 }), RULES, IN_REVEAL)).toBe('none');
  });

  it('offers the ruling once the reveal window closes on a quorum', () => {
    expect(exitFor(clock({ status: DisputeStatus.Revealing, commitCount: 3, revealCount: 2 }), RULES, AFTER_REVEAL)).toBe('finalize');
  });

  it('offers the failure exit once the reveal window closes short of quorum', () => {
    expect(exitFor(clock({ status: DisputeStatus.Revealing, commitCount: 3, revealCount: 1 }), RULES, AFTER_REVEAL)).toBe('fail');
  });

  it('offers nothing on a dispute that has already been closed', () => {
    expect(exitFor(clock({ status: DisputeStatus.Finalized, commitCount: 3, revealCount: 3 }), RULES, AFTER_REVEAL)).toBe('none');
    expect(exitFor(clock({ status: DisputeStatus.Failed }), RULES, AFTER_REVEAL)).toBe('none');
  });

  /** An unread window is treated as still open, which is the answer that sends nobody at a revert. */
  it('treats an unread commit window as still open', () => {
    expect(exitFor(clock({ commitEndsAt: null, commitCount: 1 }), RULES, AFTER_REVEAL)).toBe('none');
  });

  it('treats an unread reveal window as still running', () => {
    expect(exitFor(clock({ status: DisputeStatus.Revealing, revealEndsAt: null, commitCount: 3, revealCount: 1 }), RULES, AFTER_REVEAL)).toBe('none');
  });
});

describe('phaseOf', () => {
  it('names the four live phases apart', () => {
    expect(phaseOf(clock({ commitCount: 1 }), RULES, IN_COMMIT)).toBe('commit');
    expect(phaseOf(clock({ status: DisputeStatus.Revealing, commitCount: 3, revealCount: 2 }), RULES, IN_REVEAL)).toBe('reveal');
    expect(phaseOf(clock({ status: DisputeStatus.Revealing, commitCount: 3, revealCount: 3 }), RULES, IN_REVEAL)).toBe('ruling');
    expect(phaseOf(clock({ status: DisputeStatus.Finalized }), RULES, IN_REVEAL)).toBe('finalized');
    expect(phaseOf(clock({ status: DisputeStatus.Failed }), RULES, IN_REVEAL)).toBe('failed');
  });

  it('calls a dispute the registry has no record of unknown, never settled', () => {
    expect(phaseOf(clock({ status: DisputeStatus.None }), RULES, IN_COMMIT)).toBe('unknown');
  });

  it('reads a commit window that ended with nobody committing as waiting to be closed', () => {
    expect(phaseOf(clock({ commitCount: 0 }), RULES, IN_REVEAL)).toBe('ruling');
  });
});

describe('phaseDeadline', () => {
  it('counts down to the window the phase belongs to', () => {
    const live = clock({ commitCount: 2 });
    expect(phaseDeadline(live, 'commit')).toBe(COMMIT_ENDS);
    expect(phaseDeadline(live, 'reveal')).toBe(REVEAL_ENDS);
  });

  it('runs no clock where the dispute waits on a person', () => {
    const live = clock({ commitCount: 2 });
    expect(phaseDeadline(live, 'ruling')).toBeNull();
    expect(phaseDeadline(live, 'finalized')).toBeNull();
    expect(phaseDeadline(live, 'failed')).toBeNull();
  });
});

describe('commitCheck', () => {
  const seat = { status: ResolverStatus.Active, bond: 25_000n, floor: 25_000n, barred: false, committed: false };

  it('admits an active resolver at the floor inside the window', () => {
    expect(commitCheck(clock(), RULES, seat, 'commit')).toEqual({ allowed: true, blocker: null });
  });

  it('names the live bond floor as the thing in the way, not the registration', () => {
    expect(commitCheck(clock(), RULES, { ...seat, bond: 24_999n }, 'commit').blocker).toBe('bond-short');
  });

  it('refuses a barred address at any amount', () => {
    expect(commitCheck(clock(), RULES, { ...seat, bond: 10n ** 30n, barred: true }, 'commit').blocker).toBe('barred');
  });

  it('refuses a resolver on its way out', () => {
    expect(commitCheck(clock(), RULES, { ...seat, status: ResolverStatus.Unbonding }, 'commit').blocker).toBe('not-active');
  });

  it('refuses a second commitment from the same address', () => {
    expect(commitCheck(clock(), RULES, { ...seat, committed: true }, 'commit').blocker).toBe('already-committed');
  });

  it('refuses once the panel is full', () => {
    expect(commitCheck(clock({ commitCount: RULES.maxVoters }), RULES, seat, 'commit').blocker).toBe('panel-full');
  });

  it('refuses outside the commit phase', () => {
    expect(commitCheck(clock(), RULES, seat, 'reveal').blocker).toBe('window-closed');
  });

  /** An unread standing is not an empty one. A control that says "you cannot" on a failed read lies. */
  it('separates a standing it could not read from a standing that refuses', () => {
    expect(commitCheck(clock(), RULES, { ...seat, bond: undefined }, 'commit').blocker).toBe('unread');
    expect(commitCheck(clock(), RULES, { ...seat, floor: undefined }, 'commit').blocker).toBe('unread');
    expect(commitCheck(clock(), RULES, { ...seat, committed: undefined }, 'commit').blocker).toBe('unread');
  });
});

describe('revealCheck', () => {
  const sealed = { committed: true, revealed: false };

  it('admits a sealed score inside the reveal window', () => {
    expect(revealCheck(clock({ status: DisputeStatus.Revealing, commitCount: 2 }), sealed, IN_REVEAL)).toEqual({
      allowed: true,
      blocker: null,
    });
  });

  it('refuses while the commit window is still open', () => {
    expect(revealCheck(clock({ commitCount: 2 }), sealed, IN_COMMIT).blocker).toBe('commit-window-open');
  });

  it('refuses once the reveal window has closed', () => {
    expect(revealCheck(clock({ status: DisputeStatus.Revealing, commitCount: 2 }), sealed, AFTER_REVEAL).blocker).toBe('window-closed');
  });

  it('refuses where nothing was sealed and where it is already revealed', () => {
    expect(revealCheck(clock({ commitCount: 2 }), { committed: false, revealed: false }, IN_REVEAL).blocker).toBe('nothing-sealed');
    expect(revealCheck(clock({ commitCount: 2 }), { committed: true, revealed: true }, IN_REVEAL).blocker).toBe('already-revealed');
  });

  it('refuses on a dispute that has been closed', () => {
    expect(revealCheck(clock({ status: DisputeStatus.Finalized, commitCount: 2 }), sealed, IN_REVEAL).blocker).toBe('window-closed');
  });

  it('separates an unread vote from an absent one', () => {
    expect(revealCheck(clock({ commitCount: 2 }), { committed: undefined, revealed: undefined }, IN_REVEAL).blocker).toBe('unread');
  });
});

describe('refundBpsForScore', () => {
  /** The steps the registry publishes, checked against it on chain at 49, 64, 79 and 80. */
  it('follows the contract’s own steps', () => {
    expect(refundBpsForScore(0)).toBe(10_000);
    expect(refundBpsForScore(49)).toBe(10_000);
    expect(refundBpsForScore(50)).toBe(7_500);
    expect(refundBpsForScore(64)).toBe(7_500);
    expect(refundBpsForScore(65)).toBe(3_500);
    expect(refundBpsForScore(79)).toBe(3_500);
    expect(refundBpsForScore(80)).toBe(0);
    expect(refundBpsForScore(100)).toBe(0);
  });
});

describe('parseScore', () => {
  it('takes the decimal separator a person types', () => {
    expect(parseScore('62')).toBe(62);
    expect(parseScore('62,0')).toBe(62);
    expect(parseScore('62.00')).toBe(62);
    expect(parseScore(' 62 ')).toBe(62);
  });

  it('refuses a fraction rather than rounding somebody’s vote', () => {
    expect(parseScore('62,5')).toBeUndefined();
    expect(parseScore('62.5')).toBeUndefined();
  });

  it('refuses anything that is not a number', () => {
    expect(parseScore('')).toBeUndefined();
    expect(parseScore('-1')).toBeUndefined();
    expect(parseScore('sixty')).toBeUndefined();
  });
});

describe('scoreProblem', () => {
  it('holds the range the contract holds', () => {
    expect(scoreProblem(0)).toBeUndefined();
    expect(scoreProblem(100)).toBeUndefined();
    expect(scoreProblem(101)).toContain('between 0 and 100');
    expect(scoreProblem(undefined)).toContain('between 0 and 100');
  });
});
