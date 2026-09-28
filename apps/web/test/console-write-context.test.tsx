import { micro } from '@bursar/core';
import { MerchantGate, WindowKind } from '@bursar/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { ErrorSurface } from '@/components/error-surface';
import type { MandateRead } from '@/chain/reader';
import { failureFrom } from '@/lib/revert';
import { DEPLOY_FEE, ROUND_TRIP_FEE } from '@/state';
import type { FundingFacts, MandateFacts } from '@/state';
import { wei } from '@/money';

/**
 * What a refused write says once the screen hands the classifier what it already knows.
 *
 * Every write in the console goes out through wagmi, so nothing comes back typed: a spend the
 * account refused with `DailyCapExceeded` arrives as a viem error with four bytes somewhere down
 * its cause chain. The classifier turns that into the bucket, what is left in it and when it
 * rolls, and it can only do so when it is given the mandate and the reading on screen. It was
 * being called with the button's label and nothing else, so every refusal in the console came out
 * as the node's own sentence about calldata.
 *
 * These assert on what reaches the screen, not on which branch produced it.
 */
const MANDATE = '0x1111111111111111111111111111111111111111' as Address;
const PAYEE = '0x4444444444444444444444444444444444444444' as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

const NOW = new Date('2026-09-23T12:00:00.000Z');
const ROLLS_AT = new Date('2026-09-24T00:00:00.000Z');

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
    duration: BigInt(kind === 0 ? 86_400 : 2_592_000),
    startsAt: NOW,
    resetsAt: ROLLS_AT,
    epoch: 1n,
  };
}

function account(): MandateRead {
  const daily = window_(0, 50_000_000n, 40_000_000n);
  const monthly = window_(1, 1_000_000_000n, 40_000_000n);

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
      perCallCap: micro(25_000_000n),
      dailyCap: micro(50_000_000n),
      monthlyCap: micro(1_000_000_000n),
      dailyWindow: 86_400n,
      monthlyWindow: 2_592_000n,
      approvalThreshold: micro(20_000_000n),
      validFrom: 0n,
      validUntil: 0n,
    },
    remaining: {
      perCall: micro(10_000_000n),
      daily: micro(10_000_000n),
      monthly: micro(960_000_000n),
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
  perCallRemaining: micro(10_000_000n),
  dailyRemaining: micro(10_000_000n),
  monthlyRemaining: micro(960_000_000n),
  dailyResetsAt: ROLLS_AT,
  monthlyResetsAt: ROLLS_AT,
  validUntil: undefined,
  live: true,
};

const FUNDING: FundingFacts = {
  mandate: MANDATE,
  mandateBalance: micro(120_000_000n),
  gasPayer: '0x2222222222222222222222222222222222222222' as Address,
  gasBalance: wei(0n),
  roundTripFee: ROUND_TRIP_FEE,
  deployFee: DEPLOY_FEE,
};

/** What the mandate screens hand every button, before the per-call amount is spread on top. */
const CONTEXT = { mandate: MANDATE, facts: FACTS, funding: FUNDING };

function surface(error: unknown, action: string): string {
  return renderToStaticMarkup(<ErrorSurface error={error} action={action} />);
}

describe('a daily cap the account refused on', () => {
  const failure = failureFrom(reverted('DailyCapExceeded()'), {
    ...CONTEXT,
    action: 'Pay a provider',
    merchant: PAYEE,
    amount: micro(15_000_000n),
  });

  it('is named as a denial rather than as a generic revert', () => {
    expect((failure as { code?: string }).code).toBe('mandate_denied');
    expect((failure as { reason?: string }).reason).toBe('daily-cap');
  });

  it('says what is left in the bucket and what the payment asked for', () => {
    const shown = surface(failure, 'Pay a provider');

    expect(shown).toContain('this period’s cap is spent');
    expect(shown).toContain('$10.00');
    expect(shown).toContain('$50.00');
    expect(shown).toContain('$15.00');
  });

  it('carries the moment the window rolls, so the reader is not left to guess', () => {
    expect((failure as { resetsAt?: Date }).resetsAt).toEqual(ROLLS_AT);
    expect(surface(failure, 'Pay a provider')).toContain('Period rolls');
  });
});

describe('the same failure with no context behind it', () => {
  const bare = failureFrom(reverted('DailyCapExceeded()'), { action: 'Pay a provider' });

  it('falls back to naming the contract error, which is all it has', () => {
    expect((bare as { code?: string }).code).toBe('contract_reverted');
  });

  it('quotes no limit and no clock, which is the regression this pair exists to catch', () => {
    const shown = surface(bare, 'Pay a provider');

    expect(shown).not.toContain('Period rolls');
    expect(shown).not.toContain('$50.00');
  });
});

describe('the other refusals a principal meets', () => {
  it('names the per-payment ceiling and quotes it', () => {
    const failure = failureFrom(reverted('PerCallCapExceeded()'), {
      ...CONTEXT,
      action: 'Pay a provider',
      amount: micro(30_000_000n),
    });

    expect(surface(failure, 'Pay a provider')).toContain('$25.00');
    expect(surface(failure, 'Pay a provider')).toContain('over the per-payment limit');
  });

  it('names the threshold when consent is what is missing', () => {
    const failure = failureFrom(reverted('ApprovalRequired()'), { ...CONTEXT, action: 'Pay a provider' });
    const shown = surface(failure, 'Pay a provider');

    expect(shown).toContain('needs the account owner’s signature');
    expect(shown).toContain('$20.00');
  });

  it('sends a short account to funding, in the asset that is short', () => {
    const failure = failureFrom(reverted('ERC20InsufficientBalance(address,uint256,uint256)'), {
      ...CONTEXT,
      action: 'Move the funds in',
      amount: micro(200_000_000n),
    });
    const shown = surface(failure, 'Move the funds in');

    expect((failure as { code?: string }).code).toBe('insufficient_funds');
    expect(shown).toContain('not funded');
    expect(shown).toContain('$120.00');
    expect(shown).not.toContain('ETH');
  });
});

describe('a signer with no ETH', () => {
  const failure = failureFrom(
    { name: 'TransactionExecutionError', message: 'insufficient funds for gas * price + value', details: 'insufficient funds for gas * price + value' },
    { ...CONTEXT, action: 'Pause' },
  );

  it('names ETH as the asset that is short, and the signer as who holds it', () => {
    const shown = surface(failure, 'Pause');

    expect((failure as { code?: string }).code).toBe('gas_failure');
    expect((failure as { reason?: string }).reason).toBe('unfunded');
    expect(shown).toContain('could not pay the transaction fee in ETH');
    expect(shown).toContain('Signer holds');
  });

  it('says outright that funding the mandate does not fix it, because that is the wrong asset', () => {
    expect(surface(failure, 'Pause')).toContain('Funding the mandate account does not help');
  });
});
