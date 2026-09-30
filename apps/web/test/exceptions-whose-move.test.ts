import { LockStatus } from '@bursar/sdk';
import { describe, expect, it } from 'vitest';

import { whoseMove } from '@/app/(app)/console/[mandate]/exceptions/exceptions-view';

describe('whoseMove', () => {
  it('gives an overdue payment to the owner, an open dispute to the resolvers, and nothing closed to anyone', () => {
    expect(whoseMove(LockStatus.Locked, true)).toBe('Yours');
    expect(whoseMove(LockStatus.Disputed, false)).toBe('The resolvers');
    for (const status of [LockStatus.Resolved, LockStatus.TimedOut, LockStatus.Cancelled]) {
      expect(whoseMove(status, false)).toBe('Nobody, it is closed');
    }
  });
});
