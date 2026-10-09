import { describe, expect, it, vi } from 'vitest';

import { TOKEN_ROLES } from '@/chain';
import { contractGroups, earlierContracts } from '@/app/(app)/status/status-view';

/** Chain 4663 with a made-up v3 set on top of v2 and v1. */
vi.mock('@bursar/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@bursar/core')>();
  const { v3Record, withRecords } = await import('./support/address-book');
  return withRecords(core, [v3Record(core), core.deployment('rhc-mainnet-v2' as never), core.deployment('rhc-mainnet' as never)]);
});

describe('the contracts on the status page once a third set lands', () => {
  const groups = contractGroups();
  const earlier = earlierContracts();
  const earlierAddresses = earlier.flatMap((row) => row.addresses.map((address) => address.toLowerCase()));

  it('lists the new escrow with the payments and both earlier escrows once, newest first', () => {
    const payments = groups.find((group) => group.title === 'Payments');
    expect(payments?.rows.find((row) => row.name === 'Escrow')?.address).toBe(`0x${'3'.repeat(40)}`);
    const escrows = earlier.find((row) => row.name === 'Escrow')?.addresses.map((address) => address.toLowerCase());
    expect(escrows).toEqual(['0x4315f8be7c9661345710910577ec31cb867f3c20', '0x7d82ad9dc36734adcf5cf985295096b2b575c8c4']);
  });

  it('keeps the lanes the second set deployed listed, because they still hold what was put there', () => {
    for (const address of [
      '0x4315F8be7C9661345710910577Ec31cb867f3c20',
      '0xB0aa8Dc8850d9b38727D3cFcd7a7F86DFdA34f53',
      '0x4AB6d4859D56452736f8b70749880CaFfC5c62C4',
      '0xC217af334e6eaC06b774B5059b16257695937B0a',
      '0xbb4E0427872C825ADec1DaA3b896034f3a9ab3D7',
      '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7',
    ]) {
      expect(earlierAddresses).toContain(address.toLowerCase());
    }
  });

  it('never lists a live contract again among the earlier ones', () => {
    const live = new Set(groups.flatMap((group) => group.rows.map((row) => row.address.toLowerCase())));
    for (const address of earlierAddresses) expect(live.has(address)).toBe(false);
  });

  it('lists the token governance delay with the token, never among the earlier contracts', () => {
    expect(earlierAddresses).not.toContain(TOKEN_ROLES.adminTimelock.toLowerCase());
    const listed = groups.flatMap((group) => group.rows.map((row) => row.address.toLowerCase()));
    expect(listed).toContain(TOKEN_ROLES.adminTimelock.toLowerCase());
  });
});
