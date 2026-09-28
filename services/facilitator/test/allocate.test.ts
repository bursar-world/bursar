import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import {
  allocateRepayment,
  borrowingHeadroom,
  effectiveCollateral,
  grossedUpCollateral,
  healthFactor,
  ltvBps,
} from '../src/lanes/allocate.js';

const m = (value: number | string | bigint): Micro => toMicro(value);

const debts = [
  { id: 'oldest', outstandingMicro: m(1_000_000) },
  { id: 'middle', outstandingMicro: m(2_000_000) },
  { id: 'newest', outstandingMicro: m(500_000) },
];

describe('repayment allocation', () => {
  it('pays the oldest debt first', () => {
    const result = allocateRepayment(debts, m(1_500_000));
    expect(result.applications.map((a) => a.debtId)).toEqual(['oldest', 'middle']);
    expect(result.applications[0]).toMatchObject({ appliedMicro: 1_000_000n, closes: true });
    expect(result.applications[1]).toMatchObject({
      appliedMicro: 500_000n,
      remainingMicro: 1_500_000n,
      closes: false,
    });
    expect(result.appliedMicro).toBe(1_500_000n);
    expect(result.unappliedMicro).toBe(0n);
  });

  it('closes a debt paid to the cent and stops there', () => {
    const result = allocateRepayment(debts, m(1_000_000));
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]?.closes).toBe(true);
    expect(result.unappliedMicro).toBe(0n);
  });

  it('reports what it could not apply', () => {
    const result = allocateRepayment(debts, m(4_000_000));
    expect(result.appliedMicro).toBe(3_500_000n);
    expect(result.unappliedMicro).toBe(500_000n);
    expect(result.applications.every((a) => a.closes)).toBe(true);
  });

  it('applies nothing when there is nothing open', () => {
    const result = allocateRepayment([], m(1_000_000));
    expect(result.applications).toEqual([]);
    expect(result.appliedMicro).toBe(0n);
    expect(result.unappliedMicro).toBe(1_000_000n);
  });

  it('skips a row that is already at zero', () => {
    const result = allocateRepayment([{ id: 'settled', outstandingMicro: m(0) }, ...debts], m(1n));
    expect(result.applications.map((a) => a.debtId)).toEqual(['oldest']);
  });

  it('conserves the payment across every allocation', () => {
    for (const amount of [1n, 999n, 1_000_000n, 3_499_999n, 3_500_000n, 9_999_999n]) {
      const result = allocateRepayment(debts, m(amount));
      const summed = result.applications.reduce((total, a) => total + a.appliedMicro, 0n);
      expect(summed).toBe(result.appliedMicro);
      expect(result.appliedMicro + result.unappliedMicro).toBe(amount);
    }
  });

  it('treats a non-positive payment as applying nothing', () => {
    expect(allocateRepayment(debts, m(0)).appliedMicro).toBe(0n);
    expect(allocateRepayment(debts, m(-5)).appliedMicro).toBe(0n);
  });
});

describe('collateral haircut', () => {
  it('takes the settlement asset at face value', () => {
    expect(effectiveCollateral(m(1_000_000), 0)).toBe(1_000_000n);
  });

  it('truncates toward zero, matching the contracts', () => {
    expect(effectiveCollateral(m(999), 500)).toBe(949n);
    expect(effectiveCollateral(m(1), 1)).toBe(0n);
  });

  it('refuses a haircut outside basis points', () => {
    expect(() => effectiveCollateral(m(1), -1)).toThrow(RangeError);
    expect(() => effectiveCollateral(m(1), 10_001)).toThrow(RangeError);
    expect(() => effectiveCollateral(m(1), 1.5)).toThrow(RangeError);
  });

  it('inverts to the posted amount a debt has to hold back', () => {
    expect(grossedUpCollateral(m(1_000_000), 0)).toBe(1_000_000n);
    expect(grossedUpCollateral(m(1_000_000), 2_000)).toBe(1_250_000n);
  });

  it('rounds the gross-up up, so a lock never falls short of what it backs', () => {
    const locked = grossedUpCollateral(m(999), 500);
    expect(locked).toBe(1_052n);
    expect(effectiveCollateral(locked, 500)).toBeGreaterThanOrEqual(999n);
  });

  it('refuses to gross up against an asset that backs nothing', () => {
    expect(() => grossedUpCollateral(m(1), 10_000)).toThrow(RangeError);
  });
});

describe('position health', () => {
  it('reports no draw when nothing is owed', () => {
    expect(ltvBps(m(0), m(1_000_000))).toBe(0);
    expect(healthFactor(m(0), m(1_000_000), 6_000)).toBeNull();
  });

  it('reports a full draw when debt outruns backing', () => {
    expect(ltvBps(m(2_000_000), m(1_000_000))).toBe(10_000);
    expect(ltvBps(m(1), m(0))).toBe(10_000);
  });

  it('measures a partial draw in basis points', () => {
    expect(ltvBps(m(500_000), m(1_000_000))).toBe(5_000);
    expect(ltvBps(m(1), m(1_000_000))).toBe(0);
  });

  it('puts the health factor at one when the draw sits exactly on the cap', () => {
    expect(healthFactor(m(600_000), m(1_000_000), 6_000)).toBeCloseTo(1, 6);
    expect(healthFactor(m(300_000), m(1_000_000), 6_000)).toBeCloseTo(2, 6);
  });

  it('stays exact for a position larger than a double can hold', () => {
    const backing = m('90000000000000');
    const owed = m('45000000000000');
    expect(healthFactor(owed, backing, 10_000)).toBeCloseTo(2, 6);
  });

  it('reports zero health when there is debt and no cap or no backing', () => {
    expect(healthFactor(m(1), m(1_000_000), 0)).toBe(0);
    expect(healthFactor(m(1), m(0), 6_000)).toBe(0);
  });

  it('says how much more may be drawn, never a negative', () => {
    expect(borrowingHeadroom(m(1_000_000), m(0), 6_000)).toBe(600_000n);
    expect(borrowingHeadroom(m(1_000_000), m(500_000), 6_000)).toBe(100_000n);
    expect(borrowingHeadroom(m(1_000_000), m(900_000), 6_000)).toBe(0n);
  });
});
