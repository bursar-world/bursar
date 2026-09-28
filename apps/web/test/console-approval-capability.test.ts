import { toCapabilityId } from '@bursar/core';
import { encodeFunctionData } from 'viem';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { approvedCapabilities } from '@/app/(app)/console/lib/activity';
import type { IndexedTransaction } from '@/app/(app)/console/lib/explorer';
import { mandateAccountAbi } from '@/chain/abi';

/**
 * Naming the work a consent was granted for.
 *
 * `SpendApproved` carries the payee, the ceiling and the expiry. The capability is hashed into the
 * approval and emitted nowhere, so the approvals table had nothing to name a consent it had just
 * registered and said the capability was held inside it. The grant's own calldata is where it
 * still is, and this is the reading of it.
 */

const MANDATE = '0xB4Bd99d8604fDB876fA1B38a3f8bA024D20ccD0b' as Address;
const PAYER = '0x877c349EFb5926082C413833E8055F0991185c61' as Address;
const PAYEE = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as Address;

const APPROVAL_ID = '0x34c017a4dc6e8b819d4a320c7753794f5a59c3820287032f94a636d338ea0df3' as Hex;
const CAPABILITY = toCapabilityId('doc.summarize:1');

function grant(over: Partial<IndexedTransaction> = {}, approvalId: Hex = APPROVAL_ID): IndexedTransaction {
  return {
    hash: '0x871dc3dbe83bfb461fb3c68b666a98438d402f0daf69304bd6e54b263c64bb88',
    from: PAYER,
    to: MANDATE,
    at: new Date('2026-09-23T17:00:00Z'),
    blockNumber: 70_700_000n,
    input: encodeFunctionData({
      abi: mandateAccountAbi,
      functionName: 'approveSpend',
      args: [{ approvalId, merchant: PAYEE, capabilityId: CAPABILITY, amount: 100_000n, expiry: 1_790_000_000n }],
    }),
    failed: false,
    ...over,
  };
}

describe('approvedCapabilities', () => {
  it('names the capability a registered approval was granted for', () => {
    expect(approvedCapabilities([grant()]).get(APPROVAL_ID.toLowerCase())).toBe(CAPABILITY);
  });

  it('is keyed the way the log hands ids back, whatever casing the calldata carried', () => {
    const upper = APPROVAL_ID.toUpperCase().replace('0X', '0x') as Hex;
    expect(approvedCapabilities([grant({}, upper)]).get(APPROVAL_ID.toLowerCase())).toBe(CAPABILITY);
  });

  /**
   * A grant that reverted registered nothing, and a table that named a capability from it would be
   * describing consent the account refused.
   */
  it('ignores a grant the account refused', () => {
    expect(approvedCapabilities([grant({ failed: true })]).size).toBe(0);
  });

  it('ignores every other call, including one this build cannot decode', () => {
    const spend = encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setMerchant', args: [PAYEE, true] });
    const rows = [grant({ input: spend }), grant({ input: '0x' }), grant({ input: '0xdeadbeef' })];

    expect(approvedCapabilities(rows).size).toBe(0);
  });

  it('reads every grant in the window, newest last', () => {
    const second = '0x11c017a4dc6e8b819d4a320c7753794f5a59c3820287032f94a636d338ea0d11' as Hex;
    const found = approvedCapabilities([grant(), grant({}, second)]);

    expect(found.size).toBe(2);
    expect(found.get(second.toLowerCase())).toBe(CAPABILITY);
  });
});
