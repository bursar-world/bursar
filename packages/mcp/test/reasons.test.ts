import { agentRegistryAbi, escrowAbi, mandateAccountAbi, oracleRegistryAbi } from '@bursar/core';
import { toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { refusalForName, refusalForSelector } from '../src/reasons.js';

type ErrorItem = Extract<(typeof mandateAccountAbi)[number], { type: 'error' }>;

const ERRORS: readonly ErrorItem[] = mandateAccountAbi.filter(
  (item): item is ErrorItem => item.type === 'error',
);

function selectorOf(item: ErrorItem): Hex {
  return toFunctionSelector(`${item.name}(${item.inputs.map((input) => input.type).join(',')})`);
}

describe('the refusal an agent reads', () => {
  it('is written for every error the account can revert with', () => {
    const unwritten = ERRORS.filter((item) => refusalForName(item.name) === null).map((item) => item.name);

    expect(unwritten).toEqual([]);
  });

  it.each(ERRORS.map((item) => [item.name, item] as const))('says something an agent can act on for %s', (_name, item) => {
    const refusal = refusalForSelector(selectorOf(item));

    expect(refusal?.message).not.toBe('The mandate refused this spend.');
    expect(refusal?.message.length ?? 0).toBeGreaterThan(30);
  });

  it('reaches the same sentence by selector and by name', () => {
    for (const item of ERRORS) {
      expect(refusalForSelector(selectorOf(item))).toEqual(refusalForName(item.name));
    }
  });

  it('names the condition behind each of the ten that used to fall through', () => {
    const reads = (name: string): string => refusalForName(name)?.message ?? '';

    expect(reads('AuthorizationExpired')).toContain('deadline');
    expect(reads('BadApprovalThreshold')).toContain('approval threshold');
    expect(reads('BadNonce')).toContain('nonce');
    expect(reads('BadValidity')).toContain('valid-from');
    expect(reads('BadWindow')).toContain('zero seconds');
    expect(reads('CreditExceedsSpend')).toContain('larger than the spend');
    expect(reads('NotEscrow')).toContain('mandate_inspect');
    expect(reads('NotPendingPrincipal')).toContain('accept');
    expect(reads('TransferMismatch')).toContain('nothing settled');
    expect(reads('UnknownSpend')).toContain('mandate_list_settlements');
  });

  it('attributes each refusal to a part of the mandate', () => {
    expect(refusalForName('BadNonce')?.subject).toBe('limits');
    expect(refusalForName('UnknownSpend')?.subject).toBe('escrow');
    expect(refusalForName('TransferMismatch')?.subject).toBe('asset');
  });

  /**
   * `setAgent` clears `revoked`, so a revoked mandate is one an agent can be seated on again. The
   * MCP server told agents the opposite, while the console told owners the truth.
   */
  it('says a revoked mandate goes back to work when an agent is seated again', () => {
    const message = refusalForName('IsRevoked')?.message ?? '';

    expect(message).toContain('Seating an agent again');
    expect(message).not.toMatch(/cannot be reopened/iu);
  });

  it('answers nothing for the zero selector a clean quote returns', () => {
    expect(refusalForSelector('0x00000000')).toBeNull();
  });

  it('says so plainly when a selector is not one this build knows', () => {
    const refusal = refusalForSelector('0xdeadbeef');

    expect(refusal?.code).toBe('0xdeadbeef');
    expect(refusal?.message).toContain('does not recognise');
  });
});

type Named = { readonly type: 'error'; readonly name: string };

function errorsOf(abi: readonly unknown[]): readonly string[] {
  return abi.filter((item): item is Named => (item as Named).type === 'error').map((item) => item.name);
}

/**
 * Three contracts declare `ZeroAmount`, two declare `NotRegistered`, and the sentence for each is
 * different. The lookup is scoped by the contract that refused rather than guessing from a name
 * that belongs to several.
 */
describe.each([
  ['the dispute layer', 'resolver', errorsOf(oracleRegistryAbi)],
  ['the provider registry', 'provider', errorsOf(agentRegistryAbi)],
] as const)('what %s says no for', (_label, scope, names) => {
  it('has a sentence for every error the contract declares', () => {
    expect(names.filter((name) => refusalForName(name, scope) === null)).toEqual([]);
  });

  it.each(names.map((name) => [name] as const))('names a condition and a next step for %s', (name) => {
    const refusal = refusalForName(name, scope);

    expect(refusal?.code).toBe(name);
    expect(refusal?.message.length ?? 0).toBeGreaterThan(40);
    expect(refusal?.message).toMatch(/\.$/u);
  });

  it('answers nothing for a name that belongs to another contract', () => {
    expect(refusalForName('DailyCapExceeded', scope)).toBeNull();
  });
});

/**
 * A spend opens its lock inside the account's `spend`, and a dispute goes through `disputeSpend`, so
 * the escrow's own refusals come back on the mandate's path with the escrow's names on them.
 */
describe('what the escrow says no for on a spend or a dispute', () => {
  it('names the lock floor the same way by name and by selector', () => {
    const byName = refusalForName('BelowMinLock');

    expect(byName?.subject).toBe('amount');
    expect(byName?.message).toContain('locks no payment under its floor');
    expect(refusalForSelector(toFunctionSelector('BelowMinLock()'))).toEqual(byName);
  });

  it('has a sentence for the floor the escrow refuses when it is deployed', () => {
    expect(refusalForName('BadMinLock')?.message).toContain('Report it to the operator');
  });

  it('says a held payment cannot be contested past its delivery deadline', () => {
    expect(refusalForName('TooLate')?.message).toContain('only until its delivery deadline');
  });

  it('never reaches for the fallback on an escrow error it has a sentence for', () => {
    for (const name of ['BelowMinLock', 'BadMinLock', 'TooLate', 'PayeeCapExceeded', 'PartyNotAllowed', 'BadTtl']) {
      const item = escrowAbi.find((entry) => entry.type === 'error' && entry.name === name);
      expect(item, name).toBeDefined();
      expect(refusalForSelector(toFunctionSelector(`${name}()`))?.code).toBe(name);
    }
  });
});

describe('what the hardened contracts changed in the sentences', () => {
  it('says a spent approval id stays spent across a change of principal', () => {
    expect(refusalForName('ApprovalSpent')?.message).toContain('even across a change of principal');
  });

  it('refuses a handover to the principal it already has', () => {
    expect(refusalForName('AlreadyPrincipal')?.message).toContain('named itself as the next principal');
  });

  it('bars the principal the paying account named, as well as the two parties', () => {
    expect(refusalForName('PartyCannotVote', 'resolver')?.message).toContain('the principal the paying account named');
  });

  it('says a vote with no result reopens the payment rather than refunding it', () => {
    for (const name of ['QuorumNotMet', 'QuorumSuspect']) {
      const message = refusalForName(name, 'resolver')?.message ?? '';
      expect(message).toContain('back on hold with a new deadline');
      expect(message).not.toMatch(/refund/iu);
    }
  });
});

describe('one name, three contracts, three conditions', () => {
  it('reads ZeroAmount differently in each place it can be raised', () => {
    expect(refusalForName('ZeroAmount')?.message).toContain('greater than zero');
    expect(refusalForName('ZeroAmount', 'resolver')?.message).toContain('BRSR');
    expect(refusalForName('ZeroAmount', 'provider')?.message).toContain('USDG');
  });

  it('defaults to the mandate, which is the only table the spending path can hit', () => {
    expect(refusalForName('DailyCapExceeded')).not.toBeNull();
  });
});

describe('what a resolver stands to lose a bond over', () => {
  it('says a reveal that does not open the commitment cannot be retried into working', () => {
    const message = refusalForName('BadReveal', 'resolver')?.message ?? '';

    expect(message).toContain('dispute id, this resolver address, the score and the salt');
    expect(message).toContain('nothing recomputes a salt that was lost');
    expect(message).toContain('slashed as silence');
  });

  it('separates a closed reveal window, which is final, from a closed commit window, which is free', () => {
    expect(refusalForName('RevealWindowClosed', 'resolver')?.message).toContain('Nothing recovers it');
    expect(refusalForName('CommitWindowClosed', 'resolver')?.message).toContain('Nothing is lost by missing it');
  });
});

describe('what the tables never say', () => {
  const messages = [
    ...errorsOf(oracleRegistryAbi).map((name) => refusalForName(name, 'resolver')?.message ?? ''),
    ...errorsOf(agentRegistryAbi).map((name) => refusalForName(name, 'provider')?.message ?? ''),
    ...ERRORS.map((item) => refusalForName(item.name)?.message ?? ''),
  ];

  /** A bond and a stake are collateral taking first loss. Nothing here pays a return on holding one. */
  it('never describes a bond or a stake as something that earns', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\byield|\binterest\b|\bapy\b/iu);
    }
  });

  it('never implies credit, which exists only in a lane that is not built', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\bcredit line\b|\bborrow\b|\bloan\b/iu);
    }
  });

  it('never claims the contracts have been reviewed', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\baudited\b|\bguaranteed\b|\brisk-free\b/iu);
    }
  });

  it('reads as prose rather than as a dash-joined clause chain', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\s\u2014\s/u);
    }
  });
});
