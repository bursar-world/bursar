import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GAS_FLOAT_MINIMUM_WEI,
  FundingCollisionError,
  WEI_PER_ETH,
  assertFundingIsolation,
  checkGasFloat,
  formatEth,
  parseEth,
  readGasFloat,
  wei,
} from '../src/gas-float.js';
import type { FundingAddresses } from '../src/gas-float.js';
import { BursarError } from '../src/errors.js';

const GAS = '0x1111111111111111111111111111111111111111' as const;
const SETTLEMENT = '0x2222222222222222222222222222222222222222' as const;
const COLLATERAL = '0x3333333333333333333333333333333333333333' as const;
const TREASURY = '0x4444444444444444444444444444444444444444' as const;

const isolated: FundingAddresses = {
  gasFloat: GAS,
  settlement: SETTLEMENT,
  collateral: COLLATERAL,
  treasury: TREASURY,
};

describe('assertFundingIsolation', () => {
  it('accepts a set where every role has its own address', () => {
    expect(assertFundingIsolation(isolated)).toBe(isolated);
    expect(assertFundingIsolation({ gasFloat: GAS, settlement: SETTLEMENT, collateral: COLLATERAL })).toBeTruthy();
  });

  it('still refuses to start when the relayer shares an address with money', () => {
    expect(() =>
      assertFundingIsolation({ gasFloat: GAS, settlement: GAS, collateral: COLLATERAL }),
    ).toThrow(FundingCollisionError);
    expect(() =>
      assertFundingIsolation({ gasFloat: GAS, settlement: SETTLEMENT, collateral: GAS }),
    ).toThrow(FundingCollisionError);
    expect(() => assertFundingIsolation({ ...isolated, treasury: GAS })).toThrow(FundingCollisionError);
  });

  /**
   * The rule outlived the chain it was written for; its reason did not. Gas is ETH and settlement is USDG, so a
   * shared address can no longer let a payout spend the gas budget. Anything still saying it can
   * is describing a chain whose gas and settlement asset were one balance.
   */
  it('gives the reason that is true on this chain, not one from a chain with a shared gas asset', () => {
    const error = capture(() =>
      assertFundingIsolation({ gasFloat: GAS, settlement: GAS, collateral: COLLATERAL }),
    ) as FundingCollisionError;

    expect(error.message).not.toMatch(/same USDC balance|two decimal views|gas budget/i);
    expect(error.message).toContain('hot');
    expect(error.message).toContain('nonce');
  });

  it('catches a collision written in a different case', () => {
    expect(() =>
      assertFundingIsolation({
        gasFloat: GAS.toUpperCase().replace('0X', '0x') as `0x${string}`,
        settlement: GAS,
        collateral: COLLATERAL,
      }),
    ).toThrow(FundingCollisionError);
  });

  it('names both roles and the address so an operator can act on it', () => {
    const error = capture(() =>
      assertFundingIsolation({ gasFloat: GAS, settlement: SETTLEMENT, collateral: SETTLEMENT }),
    ) as FundingCollisionError;

    expect(error.code).toBe('funding_collision');
    expect(error.details['roles']).toEqual(['settlement', 'collateral']);
    expect(error.message).toContain(SETTLEMENT);
  });

  it('refuses a malformed address before it can be compared', () => {
    expect(() =>
      assertFundingIsolation({ gasFloat: '0x123' as `0x${string}`, settlement: SETTLEMENT, collateral: COLLATERAL }),
    ).toThrow(BursarError);
  });
});

describe('ETH amounts', () => {
  it('parses and formats decimal ETH without going near micro-USD', () => {
    expect(parseEth('0.004')).toBe(4_000_000_000_000_000n);
    expect(parseEth('1')).toBe(WEI_PER_ETH);
    expect(formatEth(wei(11_300_000_000_000_000n))).toBe('0.0113');
    expect(DEFAULT_GAS_FLOAT_MINIMUM_WEI).toBe(parseEth('0.004'));
  });

  it('refuses an amount with more precision than wei', () => {
    expect(() => parseEth('0.0000000000000000001')).toThrow(/eighteen decimal places/);
    expect(() => parseEth('1e-3')).toThrow(/not an ETH amount/);
  });
});

describe('gas float balance', () => {
  /**
   * On a chain that pays gas in USDC the native balance is the same USDC seen at eighteen
   * decimals, so reading it means dividing by 1e12 to reach the ledger's units. On Robinhood Chain
   * it is ETH, which has no price in this package. The balance is handed back as it was read.
   */
  it('returns the ETH balance in wei, unconverted', async () => {
    const getBalance = vi.fn(async () => 11_300_000_000_000_000n);

    await expect(readGasFloat({ getBalance }, isolated)).resolves.toBe(11_300_000_000_000_000n);
    expect(getBalance).toHaveBeenCalledWith({ address: GAS });
  });

  it('keeps every wei, because there is nothing to floor it to', async () => {
    const getBalance = vi.fn(async () => 3_000_000_000_001n);
    await expect(readGasFloat({ getBalance }, isolated)).resolves.toBe(3_000_000_000_001n);
  });

  it('will not read a balance at all while the addresses collide', async () => {
    const getBalance = vi.fn(async () => 0n);

    await expect(readGasFloat({ getBalance }, { ...isolated, settlement: GAS })).rejects.toThrow(
      FundingCollisionError,
    );
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('flags a float below the reserve with a line an operator can page on, priced in ETH', async () => {
    const low = await checkGasFloat({ getBalance: async () => parseEth('0.0009') }, isolated, parseEth('0.004'));

    expect(low.healthy).toBe(false);
    expect(low.balance).toBe(parseEth('0.0009'));
    expect(low.summary).toContain('0.0009 ETH');
    expect(low.summary).toContain('below the 0.004 ETH reserve');
    expect(low.summary).not.toContain('$');

    const fine = await checkGasFloat({ getBalance: async () => parseEth('0.0113') }, isolated, parseEth('0.004'));
    expect(fine.healthy).toBe(true);
    expect(fine.summary).toContain('0.0113 ETH');
  });

  it('takes the build plan reserve when a caller names no minimum', async () => {
    const status = await checkGasFloat({ getBalance: async () => parseEth('0.003') }, isolated);

    expect(status.minimum).toBe(DEFAULT_GAS_FLOAT_MINIMUM_WEI);
    expect(status.healthy).toBe(false);
  });
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}
