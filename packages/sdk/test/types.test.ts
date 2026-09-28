import { describe, expect, it } from 'vitest';
import type { ReadContractReturnType } from 'viem';
import { escrowAbi } from '@bursar/core';

import { LockStatus, MerchantGate, WindowKind, isNoLock, toLockStatus, type Lock } from '../src/types.js';

type DecodedLock = ReadContractReturnType<typeof escrowAbi, 'getLock'>;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Fails to compile the moment `Lock` and the struct `getLock` decodes to disagree on field
 * names, in either direction. Without it, a field added to the Solidity struct would decode into
 * an object this package's type says nothing about.
 */
const FIELDS_MATCH: Exact<keyof Lock, keyof DecodedLock> = true;

const ZEROED: Lock = {
  payer: '0x0000000000000000000000000000000000000000',
  payee: '0x0000000000000000000000000000000000000000',
  disputer: '0x0000000000000000000000000000000000000000',
  capabilityId: `0x${'00'.repeat(32)}`,
  inputCommit: `0x${'00'.repeat(32)}`,
  outputCommit: `0x${'00'.repeat(32)}`,
  inputURI: '',
  outputURI: '',
  amount: 0n as Lock['amount'],
  deadline: 0n,
  releasedAt: 0n,
  bond: 0n as Lock['bond'],
  disputedAt: 0n,
  status: LockStatus.None,
  counted: false,
};

describe('LockStatus', () => {
  it('matches the Solidity enum, value for value', () => {
    expect(LockStatus).toEqual({
      None: 0,
      Locked: 1,
      Released: 2,
      TimedOut: 3,
      Disputed: 4,
      Cancelled: 5,
      Resolved: 6,
    });
  });

  it('names exactly the fields getLock decodes to', () => {
    expect(FIELDS_MATCH).toBe(true);
  });
});

describe('toLockStatus', () => {
  it('passes through every state the escrow can return', () => {
    for (const status of Object.values(LockStatus)) {
      expect(toLockStatus(status)).toBe(status);
    }
  });

  it('refuses a status this package does not know rather than mislabelling a lock', () => {
    expect(() => toLockStatus(7)).toThrow(RangeError);
    expect(() => toLockStatus(-1)).toThrow(/deployment is ahead/);
  });
});

describe('isNoLock', () => {
  it('reports the zeroed struct an unknown id decodes to', () => {
    expect(isNoLock(ZEROED)).toBe(true);
  });

  it('reports a record the escrow holds', () => {
    for (const status of Object.values(LockStatus).filter((value) => value !== 0)) {
      expect(isNoLock({ ...ZEROED, status })).toBe(false);
    }
  });
});

describe('enums that mirror the account', () => {
  it('keeps the two gates and the two windows in contract order', () => {
    expect(MerchantGate).toEqual({ Allowlist: 0, MerkleRoot: 1 });
    expect(WindowKind).toEqual({ Daily: 0, Monthly: 1 });
  });
});

describe('the public surface', () => {
  it('ships one redactor and no reader nothing calls', async () => {
    const surface = Object.keys(await import('../src/index.js'));

    // The redactor that survived is the one wired to a log sink, in @bursar/mcp. The copy that
    // used to be exported here was case-sensitive, so a key that appeared in an error with
    // different hex casing went straight through it.
    expect(surface).not.toContain('redactSecrets');
    expect(surface).not.toContain('providerStatus');
    expect(surface).not.toContain('describeProvider');
  });
});
