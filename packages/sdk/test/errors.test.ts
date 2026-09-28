import { describe, expect, it } from 'vitest';
import { micro } from '@bursar/core';

import {
  GasFailureError,
  InsufficientFundsError,
  MandateDeniedError,
  NoAcceptablePaymentError,
  PaymentRejectedError,
  SubmittedButUnconfirmedError,
  denialReasonFor,
  isGasFailure,
  type GasFailure,
  type GasFailureReason,
  type MandateSnapshot,
} from '../src/errors.js';
import { WindowKind } from '../src/types.js';

const MANDATE = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-09-11T12:00:00.000Z');

const SNAPSHOT: MandateSnapshot = {
  limits: {
    perCallCap: micro(1_000_000n),
    dailyCap: micro(50_000_000n),
    monthlyCap: micro(500_000_000n),
    dailyWindow: 86_400n,
    monthlyWindow: 2_592_000n,
    approvalThreshold: micro(25_000_000n),
    validFrom: 1_700_000_000n,
    validUntil: 1_800_000_000n,
    classMask: 0b011,
    totalCap: micro(0n),
    lane: 0,
  },
  remaining: {
    perCall: micro(1_000_000n),
    daily: micro(1_200_000n),
    monthly: micro(400_000_000n),
    dailyResetsAt: new Date('2026-09-11T16:12:00.000Z'),
    monthlyResetsAt: new Date('2026-10-01T00:00:00.000Z'),
  },
  daily: {
    kind: WindowKind.Daily,
    cap: micro(50_000_000n),
    spent: micro(48_800_000n),
    remaining: micro(1_200_000n),
    duration: 86_400n,
    startsAt: new Date('2026-09-10T16:12:00.000Z'),
    resetsAt: new Date('2026-09-11T16:12:00.000Z'),
    epoch: 3n,
  },
  monthly: {
    kind: WindowKind.Monthly,
    cap: micro(500_000_000n),
    spent: micro(100_000_000n),
    remaining: micro(400_000_000n),
    duration: 2_592_000n,
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    resetsAt: new Date('2026-10-01T00:00:00.000Z'),
    epoch: 1n,
  },
};

function denial(
  reason: 'daily-cap' | 'monthly-cap' | 'per-call-cap' | 'approval-required' | 'paused',
): MandateDeniedError {
  return new MandateDeniedError({
    reason,
    errorName: 'X',
    mandate: MANDATE,
    merchant: MERCHANT,
    amount: micro(2_500_000n),
    capability: 'gpu.render:1',
    snapshot: SNAPSHOT,
    now: NOW,
  });
}

describe('MandateDeniedError', () => {
  it('names the limit that stopped the spend and when it resets', () => {
    const error = denial('daily-cap');

    expect(error.message).toBe(
      `Mandate ${MANDATE} refused a 2.50 USDG payment to ${MERCHANT}: the daily limit has ` +
        '1.20 USDG left of 50.00 USDG and this call asks for 2.50 USDG. The daily window resets ' +
        'at 2026-09-11T16:12:00.000Z (in 4h 12m).',
    );
  });

  it('hands back the reset instant so a caller can retry without parsing prose', () => {
    expect(denial('daily-cap').resetsAt).toEqual(new Date('2026-09-11T16:12:00.000Z'));
    expect(denial('monthly-cap').resetsAt).toEqual(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('leaves resetsAt unset where nothing resets', () => {
    expect(denial('per-call-cap').resetsAt).toBeUndefined();
    expect(denial('paused').resetsAt).toBeUndefined();
  });

  it('distinguishes the monthly bucket from the daily one', () => {
    expect(denial('monthly-cap').message).toContain('the monthly limit has 400.00 USDG left');
    expect(denial('monthly-cap').message).toContain('The monthly window resets at 2026-10-01');
  });

  it('reports a per-call refusal against the cap rather than a window', () => {
    expect(denial('per-call-cap').message).toContain(
      'the per-call limit is 1.00 USDG and this call asks for 2.50 USDG',
    );
  });

  it('tells a caller how to clear an above-threshold spend', () => {
    expect(denial('approval-required').message).toContain(
      'at or above the approval threshold of 25.00 USDG',
    );
    expect(denial('approval-required').message).toContain('signApproval');
  });

  it('says what a paused mandate needs, not that a call reverted', () => {
    expect(denial('paused').message).toContain('setPaused(false)');
  });

  it('carries the machine-readable cause alongside the sentence', () => {
    const error = denial('daily-cap');

    expect(error.code).toBe('mandate_denied');
    expect(error.reason).toBe('daily-cap');
    expect(error.amount).toBe(2_500_000n);
    expect(error.merchant).toBe(MERCHANT);
    expect(error.details['amount']).toBe('2500000');
  });

  it('still says something useful without a snapshot to quote', () => {
    const error = new MandateDeniedError({
      reason: 'daily-cap',
      errorName: 'DailyCapExceeded',
      mandate: MANDATE,
      now: NOW,
    });

    expect(error.message).toBe(`Mandate ${MANDATE} refused a payment: the daily limit is exhausted.`);
  });
});

describe('denialReasonFor', () => {
  it('maps the account errors onto reasons a caller can branch on', () => {
    expect(denialReasonFor('DailyCapExceeded')).toBe('daily-cap');
    expect(denialReasonFor('MerkleGateActive')).toBe('merchant-proof-required');
    expect(denialReasonFor('AllowlistGateActive')).toBe('merchant-proof-unexpected');
  });

  it('reports nothing for an error that is not the account refusing a spend', () => {
    expect(denialReasonFor('PayeeCapExceeded')).toBeUndefined();
    expect(denialReasonFor('NotPrincipal')).toBeUndefined();
  });
});

/**
 * The wording, checked here so the anvil suite can stay about which failure is which. Every gas
 * message has to survive one test: a developer reading it knows what to change next.
 */
describe('GasFailureError', () => {
  const SIGNER = '0x3164F1EaA42C769e40Aec0a43e8C51ec2c0EBe03';
  const TWENTY_GWEI = 20_000_000_000n;

  const REASONS: readonly GasFailureReason[] = [
    'unfunded',
    'out-of-gas',
    'limit-below-intrinsic',
    'limit-above-block',
    'estimate-failed',
  ];

  function gas(reason: GasFailureReason, over: Partial<GasFailure> = {}): GasFailureError {
    return new GasFailureError({
      reason,
      action: 'spend',
      sender: SIGNER,
      balanceWei: 10n ** 18n,
      maxFeePerGas: TWENTY_GWEI,
      gasLimit: 100_000n,
      ...over,
    });
  }

  it('gives every reason its own answer, so no two share a fix', () => {
    const messages = REASONS.map((reason) => gas(reason).message);

    expect(new Set(messages).size).toBe(REASONS.length);
    for (const message of messages) {
      expect(message).toMatch(/Raise|Set a limit|Split|Pass a gas limit|Send ETH to the signer/);
    }
  });

  it('quotes the fee in ETH and the balance that has to cover it', () => {
    const error = gas('unfunded', { balanceWei: 1_000_000_000_000n });

    expect(error.message).toContain(`${SIGNER} is out of ETH`);
    expect(error.message).toContain('It holds 0.000001 ETH');
    expect(error.message).toContain('the fee comes to 0.002 ETH');
    expect(error.balanceWei).toBe(1_000_000_000_000n);
  });

  it('does not round a balance down to nothing', () => {
    expect(gas('unfunded', { balanceWei: 7n }).message).toContain('less than 0.000000001 ETH');
  });

  it('says what the balance covers, which is what separates money from a limit', () => {
    expect(gas('out-of-gas').message).toContain('holds 1 ETH, which covers 50,000,000 gas');
  });

  it('never states a gas balance in the settlement asset', () => {
    // ETH and USDG are different assets on this chain. Quoting a fee budget as an amount of USDG
    // would be a number the signer does not hold, and would send an operator to top up the wrong
    // balance. The word itself is allowed: the unfunded case exists to say which is which.
    for (const reason of REASONS) {
      expect(gas(reason).message).not.toMatch(/[\d.]\s*USDG/u);
    }
  });

  it('reads without the numbers a node did not give', () => {
    const error = gas('out-of-gas', { gasLimit: undefined, balanceWei: undefined });

    expect(error.message).toContain('execution used every unit of gas it was given');
    expect(error.message).not.toContain('undefined');
    expect(error.balanceWei).toBeUndefined();
  });

  it('carries the machine-readable cause and a stable code', () => {
    const error = gas('estimate-failed', { gasNeeded: 30_000_000n, nodeMessage: 'out of gas' });

    expect(error.code).toBe('gas_failure');
    expect(isGasFailure(error)).toBe(true);
    expect(error.details['reason']).toBe('estimate-failed');
    expect(error.details['nodeMessage']).toBe('out of gas');
    expect(error.message).toContain('needs more than the 30,000,000 gas it is allowed');
  });

  it('is not confused with the mandate account running out of settlement funds', () => {
    expect(isGasFailure(new InsufficientFundsError(MANDATE, micro(0n), micro(1n)))).toBe(false);
    expect(gas('unfunded').message).toContain('Funding the mandate account does not help');
  });
});

describe('the rest of the error surface', () => {
  it('tells a funding failure apart from a limit', () => {
    const error = new InsufficientFundsError(MANDATE, micro(1_000_000n), micro(2_500_000n));

    expect(error.code).toBe('insufficient_funds');
    expect(error.message).toContain('It holds 1.00 USDG and this spend needs 2.50 USDG');
  });

  it('keeps the hash of a transaction it could not confirm', () => {
    const hash = `0x${'ab'.repeat(32)}` as const;
    const error = new SubmittedButUnconfirmedError(hash, 60_000);

    expect(error.hash).toBe(hash);
    expect(error.message).toContain('may still confirm');
  });

  it('says what the resource offered and what this client settles', () => {
    const error = new NoAcceptablePaymentError(
      'https://api.example/render',
      ['0.10 USDG in 0xabc on eip155:8453 under exact'],
      'exact in 0x5fc on eip155:4663',
    );

    expect(error.message).toContain('offered 0.10 USDG in 0xabc on eip155:8453');
    expect(error.message).toContain('this client settles exact in 0x5fc');
  });

  it('reports a refused payment with the reason the server gave', () => {
    const error = new PaymentRejectedError('https://api.example/render', 402, 'insufficient_funds');

    expect(error.message).toBe(
      'https://api.example/render refused the payment: insufficient_funds',
    );
  });
});
