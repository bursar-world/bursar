import { LockStatus } from '@bursar/sdk';
import { describe, expect, it } from 'vitest';

import { OVERDUE_DETAIL, OVERDUE_WORD, contestable, lockDetail, lockWord, returnable } from '@/app/(app)/console/lib/format';

/**
 * When a payment is still open to a complaint, on the escrow's own two conditions.
 *
 * A lock the escrow still holds can be contested by either side, and the bond is posted from the
 * mandate. A lock it has already paid out can be contested by the payer alone, and only until the
 * dispute window closes; after that the escrow answers `TooLate`. Nothing else is contestable:
 * a lock that timed out, was cancelled, or has already been ruled on is finished.
 *
 * Two screens offer the control, the settlements table and the exceptions list, and they read the
 * same function. A payment listed as contestable on one and refused on the other is one bug
 * printed twice.
 */
const WINDOW = 3_600n;
const NOW = new Date('2026-09-23T12:00:00.000Z');

function lock(status: LockStatus, releasedAt: Date | null = null) {
  return { status, releasedAt };
}

describe('a lock the escrow still holds', () => {
  it('is open to a complaint from the mandate that paid it', () => {
    expect(contestable(lock(LockStatus.Locked), WINDOW, NOW)).toBe(true);
  });

  it('stays open even where the dispute window could not be read, because it does not gate this', () => {
    expect(contestable(lock(LockStatus.Locked), undefined, NOW)).toBe(true);
  });
});

describe('a lock the provider has already been paid out of', () => {
  it('is open while the dispute window is still running', () => {
    const released = new Date(NOW.getTime() - 60_000);

    expect(contestable(lock(LockStatus.Released, released), WINDOW, NOW)).toBe(true);
  });

  it('closes once the window has run out, which is what the escrow answers TooLate to', () => {
    const released = new Date(NOW.getTime() - Number(WINDOW) * 1000 - 1_000);

    expect(contestable(lock(LockStatus.Released, released), WINDOW, NOW)).toBe(false);
  });

  it('is not offered when the window is unread, since the screen cannot say it is still open', () => {
    const released = new Date(NOW.getTime() - 60_000);

    expect(contestable(lock(LockStatus.Released, released), undefined, NOW)).toBe(false);
  });
});

describe('everything already finished', () => {
  const closed = [LockStatus.TimedOut, LockStatus.Cancelled, LockStatus.Disputed, LockStatus.Resolved, LockStatus.None];

  it.each(closed)('offers nothing on status %s', (status) => {
    expect(contestable(lock(status, NOW), WINDOW, NOW)).toBe(false);
  });
});

describe('a lock nobody managed to read', () => {
  it('is not contestable, and is not reported as settled either', () => {
    expect(contestable(undefined, WINDOW, NOW)).toBe(false);
  });
});

/**
 * When the escrow will hand a payment back.
 *
 * `Escrow.timeout` is open to anybody once a lock is past its deadline and refuses with `TooEarly`
 * at every moment up to and including it. Until this shipped, nothing in the product called it:
 * a provider that never answered left the payer's money in the escrow until somebody ran a script
 * against it. The clock that decides is the chain's, because that is the one the contract reads.
 */
describe('returning a payment the provider never answered', () => {
  const deadline = new Date('2026-09-23T12:00:00.000Z');

  function held(status: LockStatus = LockStatus.Locked) {
    return { status, deadline };
  }

  it('is offered once the chain is past the deadline', () => {
    expect(returnable(held(), new Date(deadline.getTime() + 1_000))).toBe(true);
  });

  it('is refused while the provider still has time', () => {
    expect(returnable(held(), new Date(deadline.getTime() - 1_000))).toBe(false);
  });

  it('is refused on the deadline itself, which is what the escrow does', () => {
    expect(returnable(held(), deadline)).toBe(false);
  });

  it('is not offered on a clock the chain did not answer for', () => {
    expect(returnable(held(), undefined)).toBe(false);
  });

  it('is offered on a held lock and on nothing else', () => {
    const later = new Date(deadline.getTime() + 86_400_000);
    const others = [LockStatus.Released, LockStatus.TimedOut, LockStatus.Cancelled, LockStatus.Disputed, LockStatus.Resolved, LockStatus.None];

    expect(returnable(held(), later)).toBe(true);
    for (const status of others) expect(returnable(held(status), later)).toBe(false);
  });

  it('says nothing about a lock nobody managed to read', () => {
    expect(returnable(undefined, new Date(deadline.getTime() + 1_000))).toBe(false);
  });

  it('gives the overdue lock its own words rather than reusing "held"', () => {
    expect(OVERDUE_WORD).not.toBe(lockWord(LockStatus.Locked));
    expect(OVERDUE_DETAIL).not.toBe(lockDetail(LockStatus.Locked));
    expect(OVERDUE_DETAIL).toContain('deadline has gone');
  });
});
