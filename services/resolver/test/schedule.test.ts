import { describe, expect, it } from 'vitest';

import { rotation, timeline } from '../src/schedule.js';

const T = 1_790_000_000n;
const HOUR = 3_600n;
const MINUTE = 60n;

describe('timeline', () => {
  it('lands on the published times for the live six-hour windows', () => {
    const tl = timeline({ openedAt: T, commitEndsAt: T + 6n * HOUR, revealEndsAt: T + 12n * HOUR });

    expect(tl.evidenceCutoff).toBe(T + 3n * HOUR);
    expect(tl.commitAt).toBe(T + 3n * HOUR + 30n * MINUTE);
    expect(tl.standbyAt).toBe(T + 4n * HOUR + 30n * MINUTE);
    expect(tl.commitCritical).toBe(T + 5n * HOUR + 30n * MINUTE);
    expect(tl.commitEndsAt).toBe(T + 6n * HOUR);
    expect(tl.revealCritical).toBe(T + 10n * HOUR);
    expect(tl.lastChance).toBe(T + 11n * HOUR);
    expect(tl.revealEndsAt).toBe(T + 12n * HOUR);
  });

  it('keeps every step inside its window when governance shortens them', () => {
    const tl = timeline({ openedAt: T, commitEndsAt: T + HOUR, revealEndsAt: T + 2n * HOUR });

    expect(tl.evidenceCutoff).toBeLessThan(tl.commitAt);
    expect(tl.commitAt).toBeLessThan(tl.standbyAt);
    expect(tl.standbyAt).toBeLessThan(tl.commitCritical);
    expect(tl.commitCritical).toBeLessThan(tl.commitEndsAt);
    expect(tl.revealCritical).toBeLessThan(tl.lastChance);
    expect(tl.lastChance).toBeLessThan(tl.revealEndsAt);
  });
});

describe('rotation', () => {
  it('takes keys[id mod 3] and keys[(id + 1) mod 3] as the pair and the third as standby', () => {
    expect(rotation(1n, 3, 2)).toEqual({ primary: [1, 2], standby: [0] });
    expect(rotation(2n, 3, 2)).toEqual({ primary: [2, 0], standby: [1] });
    expect(rotation(3n, 3, 2)).toEqual({ primary: [0, 1], standby: [2] });
  });

  it('keeps every key signing across consecutive disputes', () => {
    const signed = new Set([1n, 2n, 3n].flatMap((id) => rotation(id, 3, 2).primary));
    expect([...signed].sort()).toEqual([0, 1, 2]);
  });

  it('uses every key it has when quorum asks for more than there are', () => {
    expect(rotation(5n, 2, 3)).toEqual({ primary: [1, 0], standby: [] });
  });
});
