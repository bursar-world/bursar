import { describe, expect, it, vi } from 'vitest';

import { contractGroups } from '@/app/(app)/status/status-view';

// The records as they stood before v3, so the addresses below hold whatever a later deploy adds.
vi.mock('@bursar/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@bursar/core')>();
  const { withRecords } = await import('./support/address-book');
  return withRecords(core, [core.deployment('rhc-mainnet-v2' as never), core.deployment('rhc-mainnet' as never)]);
});

describe('the contracts on the status page', () => {
  const groups = contractGroups();
  const addresses = groups.flatMap((group) => group.rows.map((row) => row.address.toLowerCase()));

  it('lists the stock, collateral, private and shielded contracts from the record', () => {
    for (const address of [
      '0x669366d0Ae3C6b51fEDcf451A01bF741Fd2ed08D',
      '0xB0aa8Dc8850d9b38727D3cFcd7a7F86DFdA34f53',
      '0x4AB6d4859D56452736f8b70749880CaFfC5c62C4',
      '0xC217af334e6eaC06b774B5059b16257695937B0a',
      '0xbb4E0427872C825ADec1DaA3b896034f3a9ab3D7',
      '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7',
    ]) {
      expect(addresses).toContain(address.toLowerCase());
    }
  });

  it('lists the earlier payment contracts and both governance delays', () => {
    expect(addresses).toContain('0x7d82ad9dc36734adcf5cf985295096b2b575c8c4');
    expect(addresses).toContain('0x5a32eab02454f97a39857e85b536f83ee0f844bf');
    expect(addresses).toContain('0x135ef562ac57845aea1bb650fc0e74d67a4a866b');
  });

  it('lists each address once within a group', () => {
    for (const group of groups) expect(new Set(group.rows.map((row) => row.address)).size).toBe(group.rows.length);
  });
});
