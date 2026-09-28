import { describe, expect, it } from 'vitest';

import { TOTAL_BUDGET_MIN_SECONDS, isTotalBudgetWindow, totalBudgetWindowSeconds } from '../src/index.js';

const NOW = 1_790_000_000;

describe('total budget window', () => {
  it('is one hundred years for a mandate with no expiry', () => {
    expect(TOTAL_BUDGET_MIN_SECONDS).toBe(100 * 365 * 86_400);
    expect(totalBudgetWindowSeconds(0, NOW)).toBe(BigInt(TOTAL_BUDGET_MIN_SECONDS));
  });

  it('is one hundred years for an expiry inside that', () => {
    expect(totalBudgetWindowSeconds(NOW + 30 * 86_400, NOW)).toBe(BigInt(TOTAL_BUDGET_MIN_SECONDS));
  });

  it('outlasts an expiry further out, rounded up to a whole day', () => {
    const until = NOW + TOTAL_BUDGET_MIN_SECONDS + 10;
    const seconds = totalBudgetWindowSeconds(until, NOW);
    expect(seconds >= BigInt(until - NOW)).toBe(true);
    expect(seconds % 86_400n).toBe(0n);
  });

  it('recognises the total by its length, and a rolling month as a period', () => {
    expect(isTotalBudgetWindow(totalBudgetWindowSeconds(0, NOW))).toBe(true);
    expect(isTotalBudgetWindow(30 * 86_400)).toBe(false);
    expect(isTotalBudgetWindow(365n * 86_400n)).toBe(false);
  });
});
