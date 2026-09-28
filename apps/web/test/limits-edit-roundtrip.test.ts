import { TOTAL_BUDGET_MIN_SECONDS, micro } from '@bursar/core';
import type { ContractSet } from '@bursar/core';
import type { MandateLimits } from '@bursar/sdk';
import { encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import { draftFromLimits, readDraft } from '@/app/(app)/console/limits-form';
import { mandateAccountAbi, mandateAccountAbiV1 } from '@/chain/abi';
import { toLimitsTuple, toLimitsTupleV1 } from '@/chain/limits';

/**
 * Opening "Change the limits" and saving without touching anything has to write the limits the
 * chain already holds. The example is 0x420BeB507F72173E7d78e0f956968f64fb508356 on chain 4663 as
 * `limits()` returned it: a v2 mandate with a total budget and a rolling 30-day second cap, which
 * the form used to collapse into the total alone.
 */
const EXAMPLE: MandateLimits = {
  perCallCap: micro(100_000n),
  dailyCap: micro(500_000n),
  monthlyCap: micro(2_000_000n),
  dailyWindow: 86_400n,
  monthlyWindow: 2_592_000n,
  approvalThreshold: micro(100_000n),
  validFrom: 0n,
  validUntil: 0n,
  classMask: 3,
  totalCap: micro(1_000_000n),
  lane: 0,
};

const NOW = Date.parse('2026-09-28T12:00:00Z');

/** The calldata the spend panel sends for an untouched form, next to the calldata of the chain's own limits. */
function saveUntouched(limits: MandateLimits, contractSet: ContractSet) {
  const draft = draftFromLimits(limits, contractSet);
  const reading = readDraft(draft, NOW, { contractSet, classMask: limits.classMask, lane: limits.lane, from: limits });
  expect(reading.problems).toEqual([]);

  if (contractSet === 'v1') {
    const onChain = {
      perCallCap: limits.perCallCap,
      dailyCap: limits.dailyCap,
      monthlyCap: limits.monthlyCap,
      dailyWindow: limits.dailyWindow,
      monthlyWindow: limits.monthlyWindow,
      approvalThreshold: limits.approvalThreshold,
      validFrom: limits.validFrom,
      validUntil: limits.validUntil,
    };
    return {
      sent: encodeFunctionData({ abi: mandateAccountAbiV1, functionName: 'setLimits', args: [toLimitsTupleV1(reading.limits!)] }),
      held: encodeFunctionData({ abi: mandateAccountAbiV1, functionName: 'setLimits', args: [onChain] }),
    };
  }
  return {
    sent: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setLimits', args: [toLimitsTuple(reading.limits!)] }),
    held: encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setLimits', args: [limits] }),
  };
}

describe('saving an untouched limits form', () => {
  it('keeps both the total budget and the rolling second cap of the example mandate', () => {
    const draft = draftFromLimits(EXAMPLE, 'v2');
    expect(draft).toMatchObject({ monthly: '2', longWindow: 2_592_000, total: '1' });

    const { sent, held } = saveUntouched(EXAMPLE, 'v2');
    expect(sent).toBe(held);
  });

  it('keeps a v2 total whose second window only repeats the first', () => {
    const limits = { ...EXAMPLE, monthlyCap: EXAMPLE.dailyCap, monthlyWindow: EXAMPLE.dailyWindow };
    expect(draftFromLimits(limits, 'v2').total).toBeUndefined();
    const { sent, held } = saveUntouched(limits, 'v2');
    expect(sent).toBe(held);
  });

  it('keeps a threshold above the per-payment cap, an expiry mid-day and a window off the presets', () => {
    const limits: MandateLimits = {
      ...EXAMPLE,
      approvalThreshold: micro(250_000n),
      validUntil: BigInt(Math.floor(Date.parse('2027-03-01T09:30:00Z') / 1000)),
      dailyWindow: 2n * 86_400n,
      monthlyWindow: 45n * 86_400n,
      classMask: 7,
    };
    const { sent, held } = saveUntouched(limits, 'v2');
    expect(sent).toBe(held);
  });

  it('keeps a v2 second cap that is long but has no total behind it', () => {
    const limits = { ...EXAMPLE, totalCap: micro(0n), monthlyWindow: BigInt(TOTAL_BUDGET_MIN_SECONDS) };
    const { sent, held } = saveUntouched(limits, 'v2');
    expect(sent).toBe(held);
  });

  it('keeps a v1 total held in a window that never rolls', () => {
    const limits = { ...EXAMPLE, classMask: 0, totalCap: micro(0n), monthlyWindow: BigInt(TOTAL_BUDGET_MIN_SECONDS) + 86_400n };
    const { sent, held } = saveUntouched(limits, 'v1');
    expect(sent).toBe(held);
  });

  it('still writes what the reader changed', () => {
    const draft = { ...draftFromLimits(EXAMPLE, 'v2'), total: '3' };
    const reading = readDraft(draft, NOW, { contractSet: 'v2', classMask: 3, lane: 0, from: EXAMPLE });
    expect(reading.limits).toMatchObject({ totalCap: 3_000_000n, monthlyCap: 2_000_000n, monthlyWindow: 2_592_000 });
  });

  it('refuses a total budget below the period cap on the total field', () => {
    const draft = { ...draftFromLimits(EXAMPLE, 'v2'), total: '0.2' };
    const reading = readDraft(draft, NOW, { contractSet: 'v2', classMask: 3, lane: 0, from: EXAMPLE });
    expect(reading.limits).toBeUndefined();
    expect(reading.problems.map((p) => p.field)).toContain('totalCap');
  });
});
