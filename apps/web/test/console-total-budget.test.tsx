import { TOTAL_BUDGET_MIN_SECONDS, micro } from '@bursar/core';
import { MerchantGate, WindowKind } from '@bursar/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { refusalForErrorName } from '@/app/(app)/console/lib/refusals';
import { ErrorSurface } from '@/components/error-surface';
import type { MandateRead } from '@/chain/reader';
import { failureFrom } from '@/lib/revert';
import { DEPLOY_FEE, ROUND_TRIP_FEE } from '@/state';
import type { FundingFacts, MandateFacts } from '@/state';
import { wei } from '@/money';

/**
 * F2: a mandate whose second window is the total budget. The contract reverts `MonthlyCapExceeded`
 * for it, and every console surface has to call that the total budget, not a monthly cap.
 */
const MANDATE = '0x1111111111111111111111111111111111111111' as Address;
const PAYEE = '0x4444444444444444444444444444444444444444' as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

const NOW = new Date('2026-09-23T12:00:00.000Z');
const ROLLS_AT = new Date('2026-09-24T00:00:00.000Z');
const LIFETIME = BigInt(TOTAL_BUDGET_MIN_SECONDS);

function selector(signature: string): Hex {
  return toFunctionSelector(signature);
}

/** A wallet failure shaped the way viem hands one back, with the revert data on the cause. */
function reverted(signature: string): unknown {
  return {
    name: 'ContractFunctionExecutionError',
    message: 'The contract function "spend" reverted.\n\nRequest Arguments:\n  from: 0x…',
    cause: { name: 'ContractFunctionRevertedError', data: selector(signature) },
  };
}

function window_(kind: 0 | 1, cap: bigint, spent: bigint) {
  return {
    kind: kind === 0 ? WindowKind.Daily : WindowKind.Monthly,
    cap: micro(cap),
    spent: micro(spent),
    remaining: micro(cap - spent),
    duration: kind === 0 ? 86_400n : LIFETIME,
    startsAt: NOW,
    resetsAt: ROLLS_AT,
    epoch: 1n,
  };
}

function account(): MandateRead {
  const daily = window_(0, 500_000n, 0n);
  const monthly = window_(1, 1_000_000n, 1_000_000n);

  return {
    address: MANDATE,
    principal: '0x2222222222222222222222222222222222222222' as Address,
    pendingPrincipal: '0x0000000000000000000000000000000000000000' as Address,
    agent: '0x3333333333333333333333333333333333333333' as Address,
    escrow: '0x5555555555555555555555555555555555555555' as Address,
    settlementAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
    paused: false,
    revoked: false,
    version: 3n,
    limits: {
      perCallCap: micro(500_000n),
      dailyCap: micro(500_000n),
      monthlyCap: micro(1_000_000n),
      dailyWindow: 86_400n,
      monthlyWindow: LIFETIME,
      approvalThreshold: micro(20_000_000n),
      validFrom: 0n,
      validUntil: 0n,
    },
    remaining: {
      perCall: micro(500_000n),
      daily: micro(500_000n),
      monthly: micro(0n),
      dailyResetsAt: ROLLS_AT,
      monthlyResetsAt: ROLLS_AT,
    },
    daily,
    monthly,
    merchantGate: MerchantGate.Allowlist,
    merchantRoot: ZERO_HASH,
    documentHash: ZERO_HASH,
    nonce: 0n,
    balance: micro(120_000_000n),
  };
}

const FACTS: MandateFacts = {
  account: account(),
  perCallRemaining: micro(500_000n),
  dailyRemaining: micro(500_000n),
  monthlyRemaining: micro(0n),
  dailyResetsAt: ROLLS_AT,
  monthlyResetsAt: ROLLS_AT,
  validUntil: undefined,
  live: true,
};

const FUNDING: FundingFacts = {
  mandate: MANDATE,
  mandateBalance: micro(5_000_000n),
  gasPayer: '0x2222222222222222222222222222222222222222' as Address,
  gasBalance: wei(0n),
  roundTripFee: ROUND_TRIP_FEE,
  deployFee: DEPLOY_FEE,
};

describe('the total budget, named as one', () => {
  it('maps MonthlyCapExceeded to the total budget when the second window is lifetime', () => {
    expect(refusalForErrorName('MonthlyCapExceeded', { totalBudget: true }).headline).toBe('The total budget is spent');
    expect(refusalForErrorName('MonthlyCapExceeded').headline).toBe('The second cap was reached');
    expect(refusalForErrorName('DailyCapExceeded').headline).toBe('The period cap was reached');
  });

  it('says total budget on the day-3 refusal, with no reset clock', () => {
    const failure = failureFrom(reverted('MonthlyCapExceeded()'), {
      mandate: MANDATE,
      facts: FACTS,
      funding: FUNDING,
      action: 'Pay a provider',
      merchant: PAYEE,
      amount: micro(500_000n),
    });
    expect((failure as { reason?: string }).reason).toBe('total-budget');
    expect((failure as { resetsAt?: Date }).resetsAt).toBeUndefined();

    const shown = renderToStaticMarkup(<ErrorSurface error={failure} action="Pay a provider" />);
    expect(shown).toContain('the total budget is spent');
    expect(shown).toContain('Total budget');
    expect(shown).not.toContain('monthly');
    expect(shown).not.toContain('Window rolls');
  });
});
