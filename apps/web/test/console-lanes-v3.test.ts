import { describe, expect, it, vi } from 'vitest';

import { laneAvailable, laneParkOf, mandateFactories, newMandateFactory } from '@/chain/mandates';

/**
 * A v3 set deploys one account build, and every account it makes asks its park for USDG inside a
 * spend. So its own factory serves every lane, and the lanes are open as soon as the set carries
 * the park and the vault.
 */
vi.mock('@bursar/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@bursar/core')>();
  const { v3Lanes, v3Record, withRecords } = await import('./support/address-book');
  return withRecords(core, [v3Record(core, { rwa: v3Lanes() }), core.deployment('rhc-mainnet-v2' as never), core.deployment('rhc-mainnet' as never)]);
});

const V3_FACTORY = `0x${'6'.repeat(40)}`;

describe('funding lanes on a v3 head', () => {
  it('creates every lane through the v3 factory and still lists the earlier ones', () => {
    expect(newMandateFactory()).toBe(V3_FACTORY);
    expect(mandateFactories()[0]).toBe(V3_FACTORY);
    expect(mandateFactories()).toContain('0x669366d0Ae3C6b51fEDcf451A01bF741Fd2ed08D');
  });

  it('opens the treasury and collateral lanes on the v3 park and vault', () => {
    expect(laneParkOf('treasury')).toBe(`0x${'a'.repeat(40)}`);
    expect(laneParkOf('collateral')).toBe(`0x${'c'.repeat(40)}`);
    expect(['prefund', 'treasury', 'collateral'].every((lane) => laneAvailable(lane as never))).toBe(true);
  });
});
