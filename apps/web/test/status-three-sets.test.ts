import { describe, expect, it, vi } from 'vitest';

import { TOKEN_ROLES } from '@/chain';
import { contractGroups } from '@/app/(app)/status/status-view';

/** Chain 4663 with a made-up v3 set on top of v2 and v1. */
vi.mock('@bursar/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@bursar/core')>();
  const { v3Record, withRecords } = await import('./support/address-book');
  return withRecords(core, [v3Record(core), core.deployment('rhc-mainnet-v2' as never), core.deployment('rhc-mainnet' as never)]);
});

describe('the contracts on the status page once a third set lands', () => {
  const groups = contractGroups();

  it('lists the new escrow with the payments and each earlier set on its own', () => {
    const payments = groups.find((group) => group.title === 'Payments');
    expect(payments?.rows.find((row) => row.name === 'Escrow')?.address).toBe(`0x${'3'.repeat(40)}`);
    expect(groups.map((group) => group.title)).toContain('Earlier payment contracts, second set');
    expect(groups.map((group) => group.title)).toContain('Earlier payment contracts, first set');
  });

  it('keeps the lanes the second set deployed listed, because they still hold what was put there', () => {
    const second = groups.find((group) => group.title === 'Earlier payment contracts, second set');
    const listed = second?.rows.map((row) => row.address.toLowerCase()) ?? [];
    for (const address of [
      '0x4315F8be7C9661345710910577Ec31cb867f3c20',
      '0xB0aa8Dc8850d9b38727D3cFcd7a7F86DFdA34f53',
      '0x4AB6d4859D56452736f8b70749880CaFfC5c62C4',
      '0xC217af334e6eaC06b774B5059b16257695937B0a',
      '0xbb4E0427872C825ADec1DaA3b896034f3a9ab3D7',
      '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7',
    ]) {
      expect(listed).toContain(address.toLowerCase());
    }
  });

  it('says the token waits on a timelock only where that timelock administers it', () => {
    for (const group of groups.filter((entry) => entry.title.startsWith('Earlier'))) {
      const row = group.rows.find((entry) => entry.name === 'Governance delay');
      const administersToken = row?.address.toLowerCase() === TOKEN_ROLES.adminTimelock.toLowerCase();
      expect(row?.role.includes('the token'), group.title).toBe(administersToken);
    }
  });
});
