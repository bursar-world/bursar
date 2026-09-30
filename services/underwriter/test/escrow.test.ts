import { toMicro } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import type { EscrowTerms, MerchantStanding } from '../src/chain.js';
import { RefuseReason } from '../src/decision.js';
import { checkDeadline, deadlineBounds, escrowPreflight } from '../src/escrow.js';

const NOW = 1_800_000_000n;

const TERMS: EscrowTerms = {
  escrow: '0x5555555555555555555555555555555555555555',
  settlementAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  reputation: '0x6666666666666666666666666666666666666666',
  registry: '0x7777777777777777777777777777777777777777',
  minTtlSeconds: 60n,
  maxTtlSeconds: 604_800n,
  minLockMicros: toMicro(10_000),
  feeBps: 50,
  disputeBondBps: 500,
};

const STANDING: MerchantStanding = {
  merchant: '0x4444444444444444444444444444444444444444',
  active: true,
  blacklisted: false,
  capMicros: toMicro(10_000_000),
};

describe('deadlineBounds', () => {
  const bounds = deadlineBounds(NOW, TERMS);

  test('both ends are exclusive on chain and inclusive here', () => {
    expect(bounds.earliest).toBe(NOW + TERMS.minTtlSeconds + 1n);
    expect(bounds.latest).toBe(NOW + TERMS.maxTtlSeconds - 1n);
  });

  test('the exact contract boundaries are refused', () => {
    expect(checkDeadline(NOW + TERMS.minTtlSeconds, bounds)).toBe(RefuseReason.TtlTooShort);
    expect(checkDeadline(NOW + TERMS.maxTtlSeconds, bounds)).toBe(RefuseReason.TtlTooLong);
  });

  test('one second inside either boundary is accepted', () => {
    expect(checkDeadline(bounds.earliest, bounds)).toBeNull();
    expect(checkDeadline(bounds.latest, bounds)).toBeNull();
  });

  test('drift raises the lower bound and leaves the upper one alone', () => {
    const drifted = deadlineBounds(NOW, TERMS, 30n);
    expect(drifted.earliest).toBe(bounds.earliest + 30n);
    expect(drifted.latest).toBe(bounds.latest);
  });

  test('a deadline quoted at the tight end goes stale as blocks pass', () => {
    const quoted = deadlineBounds(NOW, TERMS).earliest;
    const atInclusion = deadlineBounds(NOW + 10n, TERMS);
    expect(checkDeadline(quoted, atInclusion)).toBe(RefuseReason.TtlTooShort);

    const withDrift = deadlineBounds(NOW, TERMS, 30n).earliest;
    expect(checkDeadline(withDrift, atInclusion)).toBeNull();
  });
});

describe('escrowPreflight', () => {
  const bounds = deadlineBounds(NOW, TERMS);
  const base = {
    amountMicros: toMicro(100_000),
    minLockMicros: TERMS.minLockMicros,
    balanceMicros: toMicro(1_000_000),
    standing: STANDING,
    bounds,
    deadline: NOW + 3_600n,
  };

  test('a clean spend passes', () => {
    expect(escrowPreflight(base)).toBeNull();
  });

  // The account's own preview does not know the floor, so without this a spend under it clears
  // every limit and reverts inside the lock after the gas is spent.
  test('an amount under the escrow floor is refused before anything else', () => {
    expect(escrowPreflight({ ...base, amountMicros: toMicro(9_999), deadline: NOW + 10n })).toBe(
      RefuseReason.BelowMinLock,
    );
    expect(escrowPreflight({ ...base, amountMicros: toMicro(10_000) })).toBeNull();
  });

  test('an escrow before v3 floors nothing but an empty lock', () => {
    expect(escrowPreflight({ ...base, amountMicros: toMicro(1), minLockMicros: toMicro(1) })).toBeNull();
  });

  test('a bad deadline is caught here, because previewSpend cannot see it', () => {
    expect(escrowPreflight({ ...base, deadline: NOW + 10n })).toBe(RefuseReason.TtlTooShort);
    expect(escrowPreflight({ ...base, deadline: NOW + 999_999n })).toBe(RefuseReason.TtlTooLong);
  });

  test('a request with no deadline skips the ttl test and still checks the rest', () => {
    const { deadline: _deadline, ...withoutDeadline } = base;
    expect(escrowPreflight(withoutDeadline)).toBeNull();
    expect(escrowPreflight({ ...withoutDeadline, balanceMicros: toMicro(1) })).toBe(RefuseReason.AccountUnderfunded);
  });

  test('a blacklisted merchant is reported before an inactive one', () => {
    expect(escrowPreflight({ ...base, standing: { ...STANDING, blacklisted: true, active: false } })).toBe(
      RefuseReason.MerchantBlacklisted,
    );
  });

  test('an unregistered merchant is refused', () => {
    expect(escrowPreflight({ ...base, standing: { ...STANDING, active: false } })).toBe(RefuseReason.MerchantInactive);
  });

  test('the payee reputation cap is a control, not advice', () => {
    const funded = { ...base, balanceMicros: toMicro(100_000_000) };
    expect(escrowPreflight({ ...funded, amountMicros: toMicro(10_000_001) })).toBe(RefuseReason.PayeeCapExceeded);
    expect(escrowPreflight({ ...funded, amountMicros: toMicro(10_000_000) })).toBeNull();
  });

  test('an underfunded account is refused, since the escrow pulls the exact amount', () => {
    expect(escrowPreflight({ ...base, balanceMicros: toMicro(99_999) })).toBe(RefuseReason.AccountUnderfunded);
    expect(escrowPreflight({ ...base, balanceMicros: toMicro(100_000) })).toBeNull();
  });
});
