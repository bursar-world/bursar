import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { fundingAmounts } from '@/app/(app)/console/lib/amount';
import { alreadyAllowed } from '@/app/(app)/console/lib/reads';
import type { GateEntry } from '@/app/(app)/console/lib/reads';

/**
 * Two balances in two accounts, and the two sentences that keep them apart.
 *
 * A deposit is pulled out of the owner's own wallet by `transferFrom`, so the wallet's balance is
 * its ceiling; a withdrawal comes out of the mandate, so the mandate's balance is its ceiling. The
 * deposit button used to ignore both: the field said the amount was more than the wallet held and
 * the button stayed pressable, which is a fee paid for a call that reverts inside the token.
 *
 * Neither figure is ever the other's, and neither of them is ETH, which is what the fee is
 * charged in and is nowhere on this panel's two fields.
 */
const WALLET: Micro = micro(7_500_000n);
const HELD: Micro = micro(3_000_000n);

function read(depositText: string, withdrawText: string, wallet: Micro | undefined = WALLET) {
  return fundingAmounts({ depositText, withdrawText, wallet, held: HELD });
}

/** The same panel with the owner's balance unread, which the token does answer with sometimes. */
function unread(depositText: string) {
  return fundingAmounts({ depositText, withdrawText: '', wallet: undefined, held: HELD });
}

describe('a deposit above what the wallet holds', () => {
  it('is refused, with the wallet’s own balance quoted back', () => {
    const { deposit } = read('8', '');

    expect(deposit.value).toBeUndefined();
    expect(deposit.problem).toBe('Your wallet holds $7.50.');
  });

  it('is taken at exactly the balance, which is what the Max control fills in', () => {
    expect(read('7.5', '').deposit.value).toBe(7_500_000n);
  });

  it('is not bounded at all where the token did not answer, rather than guessed at', () => {
    const { deposit } = unread('8');

    expect(deposit.value).toBe(8_000_000n);
    expect(deposit.problem).toBeUndefined();
  });

  it('still refuses an amount that is not an amount, whatever the balance reading did', () => {
    expect(unread('abc').deposit.problem).toBe('Use digits, and a comma or a dot for the decimal point.');
  });
});

describe('a withdrawal above what the mandate holds', () => {
  it('is refused against the mandate’s balance, not the wallet’s', () => {
    const { withdraw } = read('', '5');

    expect(withdraw.value).toBeUndefined();
    expect(withdraw.problem).toBe('This mandate holds $3.00.');
  });

  it('takes an amount the wallet could not cover, because the wallet is not what pays it', () => {
    expect(read('', '3').withdraw.value).toBe(3_000_000n);
  });
});

describe('the two fields never borrow each other’s ceiling', () => {
  it('lets one refuse while the other takes the same figure', () => {
    const both = read('5', '5');

    expect(both.deposit.value).toBe(5_000_000n);
    expect(both.withdraw.value).toBeUndefined();
  });

  it('names an account in each refusal, so the reader knows which one to top up', () => {
    const refused = read('8', '5');

    expect(refused.deposit.problem).toContain('Your wallet');
    expect(refused.withdraw.problem).toContain('This mandate');
  });

  it('quotes no figure in ETH, which is a different asset and not what either field moves', () => {
    const refused = read('8', '5');

    expect(refused.deposit.problem).not.toContain('ETH');
    expect(refused.withdraw.problem).not.toContain('ETH');
  });
});

/**
 * Writing a gate into the state it already holds is a transaction that changes nothing and still
 * costs its fee. The forms check first, and only a chain reading of `true` counts: an entry
 * nobody managed to read is not an entry that is allowed.
 */
describe('a gate that is already open', () => {
  const PAYEE = '0x4444444444444444444444444444444444444444' as Address;
  const OTHER = '0x5555555555555555555555555555555555555555' as Address;
  const CAPABILITY = `0x${'ab'.repeat(32)}` as Hex;

  const merchants: readonly GateEntry<string>[] = [
    { key: PAYEE, allowed: true },
    { key: OTHER, allowed: false },
    { key: '0x6666666666666666666666666666666666666666', allowed: undefined },
  ];

  it('is recognised whatever case the address was typed in', () => {
    expect(alreadyAllowed(merchants, PAYEE.toLowerCase())).toBe(true);
    expect(alreadyAllowed(merchants, PAYEE.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('is not claimed for an address the account has refused', () => {
    expect(alreadyAllowed(merchants, OTHER)).toBe(false);
  });

  it('is not claimed for an entry the chain never answered about', () => {
    expect(alreadyAllowed(merchants, '0x6666666666666666666666666666666666666666')).toBe(false);
  });

  it('is not claimed for anything the account has never heard of', () => {
    expect(alreadyAllowed(merchants, CAPABILITY)).toBe(false);
  });

  it('says nothing about a field nobody has filled in', () => {
    expect(alreadyAllowed(merchants, undefined)).toBe(false);
  });
});
