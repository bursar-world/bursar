import { describe, expect, it } from 'vitest';
import { SettlementBudget } from '../src/x402/budget.js';

function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('settlement budget', () => {
  it('allows settlements up to the daily limit and then refuses', () => {
    const budget = new SettlementBudget({ dailySettlements: 2, perPayerPerHour: 10 });
    expect(budget.take('0xa').ok).toBe(true);
    expect(budget.take('0xb').ok).toBe(true);
    expect(budget.take('0xc')).toEqual({ ok: false, reason: 'daily_budget_exhausted' });
  });

  it('rate limits one payer without touching the others', () => {
    const budget = new SettlementBudget({ dailySettlements: 100, perPayerPerHour: 2 });
    budget.take('0xNoisy');
    budget.take('0xNOISY');
    expect(budget.take('0xnoisy')).toEqual({ ok: false, reason: 'payer_rate_limited' });
    expect(budget.take('0xquiet').ok).toBe(true);
  });

  it('lets a payer through again once their hour has rolled off', () => {
    const time = clock();
    const budget = new SettlementBudget({ dailySettlements: 100, perPayerPerHour: 1, now: time.now });
    expect(budget.take('0xa').ok).toBe(true);
    expect(budget.take('0xa').ok).toBe(false);
    time.advance(3_600_001);
    expect(budget.take('0xa').ok).toBe(true);
  });

  it('resets the daily window a day later', () => {
    const time = clock();
    const budget = new SettlementBudget({ dailySettlements: 1, now: time.now });
    expect(budget.take('0xa').ok).toBe(true);
    expect(budget.take('0xb').ok).toBe(false);
    time.advance(86_400_000);
    expect(budget.take('0xb').ok).toBe(true);
    expect(budget.state().settlementsToday).toBe(1);
  });

  it('hands back an allowance that bought nothing', () => {
    const budget = new SettlementBudget({ dailySettlements: 1, perPayerPerHour: 1 });
    expect(budget.take('0xa').ok).toBe(true);
    budget.refund('0xa');
    expect(budget.state().settlementsToday).toBe(0);
    expect(budget.take('0xa').ok).toBe(true);
  });

  it('never refunds below zero', () => {
    const budget = new SettlementBudget({});
    budget.refund('0xa');
    budget.refund('0xa');
    expect(budget.state().settlementsToday).toBe(0);
  });

  it('refuses everything when the limit is zero', () => {
    const budget = new SettlementBudget({ dailySettlements: 0 });
    expect(budget.take('0xa')).toEqual({ ok: false, reason: 'daily_budget_exhausted' });
  });

  it('reports its limits for the supported document', () => {
    const budget = new SettlementBudget({ dailySettlements: 7, perPayerPerHour: 3 });
    expect(budget.state()).toMatchObject({
      settlementsToday: 0,
      dailyLimit: 7,
      perPayerHourlyLimit: 3,
    });
  });
});
