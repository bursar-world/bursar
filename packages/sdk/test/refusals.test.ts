import { describe, expect, it } from 'vitest';
import { ISSUER_REFUSAL, agentRegistryAbi, oracleRegistryAbi } from '@bursar/core';

import { PaymentRejectedError } from '../src/errors.js';
import { issuerRefusal, providerRefusal, resolverRefusal } from '../src/refusals.js';

const ISSUER_CODES = Object.values(ISSUER_REFUSAL);

type ErrorItem = { readonly type: 'error'; readonly name: string };

function errorsOf(abi: readonly unknown[]): readonly string[] {
  return abi.filter((item): item is ErrorItem => (item as ErrorItem).type === 'error').map((item) => item.name);
}

/**
 * The tables are keyed by the error names in the deployed ABI, so an error added to either
 * contract is a compile error until someone writes its sentence. These assert the same property at
 * runtime, which is what catches an ABI regenerated without a rebuild of this package.
 */
describe.each([
  ['the dispute layer', errorsOf(oracleRegistryAbi), resolverRefusal],
  ['the provider registry', errorsOf(agentRegistryAbi), providerRefusal],
] as const)('what %s says no for', (_label, names, refusalFor) => {
  it('has a sentence for every error the contract declares', () => {
    expect(names.filter((name) => refusalFor(name) === null)).toEqual([]);
  });

  it.each(names.map((name) => [name] as const))('names a condition and a next step for %s', (name) => {
    const refusal = refusalFor(name);

    expect(refusal?.code).toBe(name);
    expect(refusal?.message.length ?? 0).toBeGreaterThan(40);
    expect(refusal?.message).toMatch(/\.$/u);
  });

  it('answers nothing for a name that belongs to another contract', () => {
    expect(refusalFor('DailyCapExceeded')).toBeNull();
  });
});

/**
 * The underwriter and the x402 facilitator refuse with these five before anything is signed. An
 * agent that got the word back and no sentence would be told the payment failed and nothing about
 * who can clear it, which for these five is nobody on this side of the trade.
 */
describe('what the token issuer says no for', () => {
  it.each(ISSUER_CODES.map((code) => [code] as const))('names a condition and a next step for %s', (code) => {
    const refusal = issuerRefusal(code);

    expect(refusal?.code).toBe(code);
    expect(refusal?.message.length ?? 0).toBeGreaterThan(40);
    expect(refusal?.message).toMatch(/\.$/u);
  });

  it('answers nothing for a refusal somebody here can still clear', () => {
    expect(issuerRefusal('insufficient_funds')).toBeNull();
    expect(issuerRefusal('invalid_network')).toBeNull();
    expect(issuerRefusal('')).toBeNull();
  });

  it('attributes a freeze and a pause to the token, and an absent control to the deployment', () => {
    expect(issuerRefusal(ISSUER_REFUSAL.assetPaused)?.owner).toBe('token');
    expect(issuerRefusal(ISSUER_REFUSAL.payerFrozen)?.owner).toBe('token');
    expect(issuerRefusal(ISSUER_REFUSAL.payeeFrozen)?.owner).toBe('token');
    expect(issuerRefusal(ISSUER_REFUSAL.assetControlUnreadable)?.owner).toBe('token');
    expect(issuerRefusal(ISSUER_REFUSAL.assetControlAbsent)?.owner).toBe('deployment');
  });

  it('tells the payer and the payee apart, because the fix is a different address', () => {
    expect(issuerRefusal(ISSUER_REFUSAL.payerFrozen)?.message).not.toBe(
      issuerRefusal(ISSUER_REFUSAL.payeeFrozen)?.message,
    );
  });

  it('carries the sentence through to the error an agent catches', () => {
    const rejected = new PaymentRejectedError('https://api.example/render', 402, ISSUER_REFUSAL.assetPaused);

    expect(rejected.refusal?.owner).toBe('token');
    expect(rejected.message).toContain('USDG is paused');
    expect(rejected.details['owner']).toBe('token');
  });

  it('leaves a refusal it has no reading for exactly as the service worded it', () => {
    const rejected = new PaymentRejectedError('https://api.example/render', 402, 'insufficient_funds');

    expect(rejected.refusal).toBeNull();
    expect(rejected.reason).toBe('insufficient_funds');
  });
});

describe('who owns the condition', () => {
  it('puts a window that has closed on the clock, not on the caller', () => {
    expect(resolverRefusal('RevealWindowClosed')?.owner).toBe('clock');
    expect(providerRefusal('WithdrawalNotMatured')?.owner).toBe('clock');
  });

  it('puts a bar and a pause on governance, where the lever is', () => {
    expect(providerRefusal('IsBlacklisted')?.owner).toBe('governance');
    expect(providerRefusal('EnforcedPause')?.owner).toBe('governance');
    expect(resolverRefusal('BondNotAccepted')?.owner).toBe('governance');
  });

  it('puts a mispaired deployment on the deployment, which no caller can fix', () => {
    expect(resolverRefusal('StakingAssetMismatch')?.owner).toBe('deployment');
    expect(resolverRefusal('StakingNotSet')?.owner).toBe('deployment');
  });

  it('puts a token refusing a transfer on the token', () => {
    expect(resolverRefusal('SafeERC20FailedOperation')?.owner).toBe('token');
    expect(providerRefusal('TransferMismatch')?.owner).toBe('token');
  });
});

describe('the refusals a resolver stands to lose a bond over', () => {
  it('says a reveal that does not open the commitment cannot be retried into working', () => {
    const message = resolverRefusal('BadReveal')?.message ?? '';

    expect(message).toContain('dispute id, this resolver address, the score and the salt');
    expect(message).toContain('slashed');
  });

  it('says a closed reveal window is final', () => {
    expect(resolverRefusal('RevealWindowClosed')?.message).toContain('Nothing recovers it');
  });

  it('says a missed commit window costs nothing, so the two are not confused', () => {
    const message = resolverRefusal('CommitWindowClosed')?.message ?? '';

    expect(message).toContain('Nothing is lost by missing it');
  });
});

describe('what the tables never say', () => {
  const messages = [
    ...errorsOf(oracleRegistryAbi).map((name) => resolverRefusal(name)?.message ?? ''),
    ...errorsOf(agentRegistryAbi).map((name) => providerRefusal(name)?.message ?? ''),
    ...ISSUER_CODES.map((code) => issuerRefusal(code)?.message ?? ''),
  ];

  /** A bond is collateral taking first loss. Nothing in the protocol pays a return on holding one. */
  it('never describes a bond or a stake as something that earns', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\byield|\binterest\b|\bapy\b|\breturns?\b on|\bearns? (?:you )?\d/iu);
    }
  });

  it('never implies credit, which exists only in a lane that is not built', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\bcredit line\b|\bborrow\b|\bloan\b/iu);
    }
  });

  it('never claims the contracts have been reviewed', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\baudited\b|\bsecure\b|\bguaranteed\b|\bsafe\b/iu);
    }
  });

  it('reads as prose rather than as a dash-joined clause chain', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\s—\s/u);
    }
  });
});
