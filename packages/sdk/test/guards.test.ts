import { describe, expect, it } from 'vitest';
import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { InvalidArgumentError } from '../src/errors.js';
import {
  UINT64_MAX,
  UINT128_MAX,
  UINT256_MAX,
  checkAddress,
  checkAmount,
  checkBytes32,
  checkCapability,
  checkEscrowId,
  checkPositiveAmount,
  checkProof,
  checkRange,
  checkSignature,
  toSeconds,
} from '../src/guards.js';

describe('checkRange', () => {
  it('accepts the widest value the field can hold', () => {
    expect(checkRange('perCallCap', UINT128_MAX, UINT128_MAX)).toBe(UINT128_MAX);
  });

  it('names the field when the value does not fit it', () => {
    expect(() => checkRange('perCallCap', UINT128_MAX + 1n, UINT128_MAX)).toThrow(
      /^perCallCap must be between 0 and/,
    );
    expect(() => checkRange('perCallCap', -1n, UINT128_MAX)).toThrow(InvalidArgumentError);
  });

  it('carries the field on the error, so a caller does not parse the message', () => {
    try {
      checkRange('dailyCap', -1n, UINT128_MAX);
      expect.unreachable('checkRange accepted a negative amount');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as InvalidArgumentError).field).toBe('dailyCap');
      expect((error as InvalidArgumentError).code).toBe('argument_invalid');
    }
  });
});

describe('checkPositiveAmount', () => {
  it('refuses a zero payment, which the account refuses too', () => {
    expect(() => checkPositiveAmount('amount', micro(0n))).toThrow(/greater than zero/);
  });

  it('accepts one millionth of a dollar', () => {
    expect(checkPositiveAmount('amount', micro(1n))).toBe(1n);
  });
});

describe('checkAmount', () => {
  it('allows zero, which is a legitimate cap', () => {
    expect(checkAmount('dailyCap', micro(0n))).toBe(0n);
  });
});

describe('toSeconds', () => {
  it('takes seconds as a number or a bigint', () => {
    expect(toSeconds('dailyWindow', 86_400)).toBe(86_400n);
    expect(toSeconds('dailyWindow', 86_400n)).toBe(86_400n);
  });

  it('refuses a fractional second rather than rounding it', () => {
    expect(() => toSeconds('ttlSeconds', 1.5)).toThrow(/whole number of seconds/);
  });

  it('refuses a value the uint64 field cannot hold', () => {
    expect(() => toSeconds('validUntil', UINT64_MAX + 1n)).toThrow(/must be between 0 and/);
  });
});

describe('checkBytes32', () => {
  it('accepts 32 bytes of hex', () => {
    expect(checkBytes32('approvalId', `0x${'11'.repeat(32)}`)).toBe(`0x${'11'.repeat(32)}`);
  });

  it('refuses anything shorter, longer, or not hex at all', () => {
    expect(() => checkBytes32('approvalId', `0x${'11'.repeat(31)}`)).toThrow(/32 bytes of hex/);
    expect(() => checkBytes32('approvalId', `0x${'11'.repeat(33)}`)).toThrow(/32 bytes of hex/);
    expect(() => checkBytes32('approvalId', 'not-hex' as `0x${string}`)).toThrow(/32 bytes of hex/);
  });
});

describe('checkAddress', () => {
  it('checksums an address written in one case', () => {
    expect(checkAddress('to', '0x1234567890abcdef1234567890abcdef12345678')).toBe(
      '0x1234567890AbcdEF1234567890aBcdef12345678',
    );
  });

  it('names the field rather than letting the encoder do it', () => {
    expect(() => checkAddress('to', 'nope' as Address)).toThrow(InvalidArgumentError);
    expect(() => checkAddress('to', 'nope' as Address)).toThrow(/^to is not a 0x address/u);
  });

  it('never quotes viem at a caller of this package', () => {
    try {
      checkAddress('to', 'nope' as Address);
      expect.unreachable('checkAddress accepted a value that is not an address');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';

      expect(message).not.toMatch(/viem/iu);
      expect((error as InvalidArgumentError).field).toBe('to');
    }
  });

  it('refuses a hex string that is not twenty bytes', () => {
    expect(() => checkAddress('to', '0x1234' as Address)).toThrow(InvalidArgumentError);
    expect(() => checkAddress('token', undefined as unknown as Address)).toThrow(/^token must be a 0x address/u);
  });
});

describe('checkEscrowId', () => {
  it('takes any id the escrow can issue', () => {
    expect(checkEscrowId('id', 0n)).toBe(0n);
    expect(checkEscrowId('id', UINT256_MAX)).toBe(UINT256_MAX);
  });

  it('refuses a negative id with the field on it', () => {
    expect(() => checkEscrowId('id', -1n)).toThrow(/^id must be between 0 and/u);
  });
});

describe('the types a JavaScript caller passes', () => {
  it('refuses a float where an amount belongs, and says what to write instead', () => {
    expect(() => checkAmount('amount', 1.5 as unknown as Micro)).toThrow(/must be a bigint/u);
    expect(() => checkPositiveAmount('amount', 1.5 as unknown as Micro)).toThrow(/1500000n/u);
  });

  it('refuses a string where an amount belongs', () => {
    expect(() => checkAmount('amount', 'abc' as unknown as Micro)).toThrow(InvalidArgumentError);
    expect(() => checkPositiveAmount('amount', '1000000' as unknown as Micro)).toThrow(InvalidArgumentError);
  });

  it('refuses a string where seconds belong', () => {
    expect(() => toSeconds('expiry', 'abc' as unknown as number)).toThrow(/^expiry must be a whole number/u);
    expect(() => toSeconds('ttlSeconds', '600' as unknown as number)).toThrow(InvalidArgumentError);
  });
});

describe('checkSignature', () => {
  it('reads a missing signature as none, which is what the account takes', () => {
    expect(checkSignature('signature', undefined)).toBe('0x');
  });

  it('refuses a signature that is not hex, which viem would have encoded as text', () => {
    expect(() => checkSignature('signature', 'nope' as Hex)).toThrow(/^signature must be 0x-prefixed hex/u);
  });
});

describe('checkProof and checkCapability', () => {
  it('names the node of a proof that is the wrong length', () => {
    expect(() => checkProof('merchantProof', ['0xdead' as Hex])).toThrow(/^merchantProof\[0\] must be 32 bytes/u);
  });

  it('refuses a capability that is not a label, which would hash to a valid wrong id', () => {
    expect(() => checkCapability('capability', 7 as unknown as string)).toThrow(InvalidArgumentError);
    expect(() => checkCapability('capability', '  ')).toThrow(/gpu\.render:1/u);
  });
});
