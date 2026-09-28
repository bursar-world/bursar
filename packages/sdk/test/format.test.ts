import { describe, expect, it } from 'vitest';

import { formatDeadline, formatDuration, secondsUntil, toDate } from '../src/format.js';

describe('formatDuration', () => {
  it('reports the two largest units that carry meaning', () => {
    expect(formatDuration(45n)).toBe('45s');
    expect(formatDuration(90n)).toBe('1m 30s');
    expect(formatDuration(3_600n)).toBe('1h');
    expect(formatDuration(15_132n)).toBe('4h 12m');
    expect(formatDuration(93_600n)).toBe('1d 2h');
    expect(formatDuration(2_592_000n)).toBe('30d');
  });

  it('reads an elapsed window as now rather than as a negative interval', () => {
    expect(formatDuration(0n)).toBe('now');
    expect(formatDuration(-10n)).toBe('now');
  });
});

describe('toDate', () => {
  it('reads unix seconds as the chain holds them', () => {
    expect(toDate(1_800_000_000n).toISOString()).toBe('2027-01-15T08:00:00.000Z');
  });
});

describe('secondsUntil', () => {
  it('floors the interval so a deadline is never reported as further off than it is', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');
    expect(secondsUntil(new Date('2026-09-11T12:00:59.900Z'), now)).toBe(59n);
  });
});

describe('formatDeadline', () => {
  it('gives the instant and the distance to it', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');

    expect(formatDeadline(new Date('2026-09-11T16:12:00.000Z'), now)).toBe(
      '2026-09-11T16:12:00.000Z (in 4h 12m)',
    );
  });

  it('drops the distance once the instant has passed', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');

    expect(formatDeadline(new Date('2026-09-11T11:00:00.000Z'), now)).toBe(
      '2026-09-11T11:00:00.000Z',
    );
  });
});
