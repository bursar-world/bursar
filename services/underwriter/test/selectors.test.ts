import { mandateAccountAbi } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import { RefuseReason } from '../src/decision.js';
import {
  ACCOUNT_SELECTORS,
  APPROVAL_REQUIRED_SELECTOR,
  ESCROW_SELECTORS,
  MERKLE_GATE_ACTIVE_SELECTOR,
  accountRefusal,
  errorSelector,
  isApprovalRequired,
  isMerkleGateActive,
  spendRefusal,
} from '../src/selectors.js';

/**
 * Every selector `MandateAccount._reason` can hand back, with the value `forge inspect
 * MandateAccount errors` prints for it. They are hard-coded so that a rename upstream that moves
 * a selector fails this file, before the service quietly misreads a refusal.
 */
const PREVIEW_SELECTORS = {
  IsPaused: '0x1309a563',
  IsRevoked: '0x2b7ff87e',
  ZeroAmount: '0x1f2a2005',
  NotYetValid: '0x3fb4e43f',
  Expired: '0x203d82d8',
  CapabilityNotAllowed: '0xe39f8322',
  PerCallCapExceeded: '0x71f2ae7a',
  DailyCapExceeded: '0xcc70389d',
  MonthlyCapExceeded: '0x53f93d7e',
  ZeroAddress: '0xd92e233d',
  MerkleGateActive: '0x9750233f',
  MerchantNotAllowed: '0x84d9e4ff',
  ApprovalRequired: '0x5fcb45ee',
} as const;

describe('selector derivation', () => {
  test.each(Object.entries(PREVIEW_SELECTORS))('%s derives to the compiled selector', (name, expected) => {
    expect(errorSelector(name)).toBe(expected);
  });

  test('no two of the account errors collide', () => {
    const errors = (mandateAccountAbi as readonly { type: string; name?: string }[]).filter((item) => item.type === 'error');
    expect(ACCOUNT_SELECTORS.size).toBe(errors.length);
  });
});

describe('previewSpend coverage', () => {
  test('every selector previewSpend can return has a named reason', () => {
    for (const [name, selector] of Object.entries(PREVIEW_SELECTORS)) {
      const refusal = ACCOUNT_SELECTORS.get(selector as `0x${string}`);
      expect(refusal, name).toBeDefined();
      expect(refusal?.error, name).toBe(name);
      expect(refusal?.reason, name).not.toBe(RefuseReason.ChainRefusedUnrecognised);
    }
  });

  test('the cap errors name the bucket that ran out', () => {
    expect(accountRefusal(PREVIEW_SELECTORS.PerCallCapExceeded).bucket).toBe('per_call');
    expect(accountRefusal(PREVIEW_SELECTORS.DailyCapExceeded).bucket).toBe('daily');
    expect(accountRefusal(PREVIEW_SELECTORS.MonthlyCapExceeded).bucket).toBe('monthly');
  });

  test('a selector this build has never seen still refuses', () => {
    const refusal = accountRefusal('0xdeadbeef');
    expect(refusal.reason).toBe(RefuseReason.ChainRefusedUnrecognised);
    expect(refusal.error).toBe('unknown');
  });

  test('a selector arriving in mixed case is still recognised', () => {
    expect(accountRefusal('0xCC70389D').reason).toBe(RefuseReason.DailyCapExceeded);
  });

  test('the two selectors that are not refusals are identified', () => {
    expect(APPROVAL_REQUIRED_SELECTOR).toBe(PREVIEW_SELECTORS.ApprovalRequired);
    expect(MERKLE_GATE_ACTIVE_SELECTOR).toBe(PREVIEW_SELECTORS.MerkleGateActive);
    expect(isApprovalRequired(PREVIEW_SELECTORS.ApprovalRequired)).toBe(true);
    expect(isApprovalRequired(PREVIEW_SELECTORS.DailyCapExceeded)).toBe(false);
    expect(isMerkleGateActive(PREVIEW_SELECTORS.MerkleGateActive)).toBe(true);
    expect(isMerkleGateActive('0xdeadbeef')).toBe(false);
  });
});

describe('escrow reverts, which previewSpend never sees', () => {
  test('the escrow terms are decodable from a full simulation', () => {
    expect(ESCROW_SELECTORS.get('0x98582d7e')?.reason).toBe(RefuseReason.TtlOutOfBounds);
    expect(ESCROW_SELECTORS.get('0xdd5a3f41')?.reason).toBe(RefuseReason.PayeeCapExceeded);
    expect(ESCROW_SELECTORS.get('0x4895e48f')?.reason).toBe(RefuseReason.MerchantNotParty);
  });

  test('a spend revert is read against the account first, then the escrow', () => {
    expect(spendRefusal('0xcc70389d').reason).toBe(RefuseReason.DailyCapExceeded);
    expect(spendRefusal('0x98582d7e').reason).toBe(RefuseReason.TtlOutOfBounds);
    expect(spendRefusal('0xdeadbeef').reason).toBe(RefuseReason.ChainRefusedUnrecognised);
  });
});
