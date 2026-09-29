import { describe, expect, it } from 'vitest';

import { exampleMandate, laneAvailable, laneParkOf, laneValue, mandateFactories, newMandateFactory, readFundingLane } from '@/chain/mandates';
import { readDraft } from '@/app/(app)/console/limits-form';
import { newDraft, readWorkspace } from '@/workspace/model';
import { readableExport } from '@/workspace/readable';

const V21 = '0x669366d0Ae3C6b51fEDcf451A01bF741Fd2ed08D';

describe('funding lanes', () => {
  it('reads the lane a link asks for and nothing else', () => {
    expect(readFundingLane('collateral')).toBe('collateral');
    expect(readFundingLane('treasury')).toBe('treasury');
    expect(readFundingLane('prefund')).toBe('prefund');
    expect(readFundingLane('Collateral')).toBeUndefined();
    expect(readFundingLane(['collateral'])).toBeUndefined();
    expect(readFundingLane(undefined)).toBeUndefined();
  });

  it('writes lane 1 only for collateral, which is the lane the vault accepts', () => {
    expect(laneValue('collateral')).toBe(1);
    expect(laneValue('treasury')).toBe(0);
    expect(laneValue('prefund')).toBe(0);
  });

  it('creates every lane through the v2.1 factory, which the list also reads', () => {
    expect(newMandateFactory()).toBe(V21);
    expect(mandateFactories()).toContain(V21);
  });

  it('names the treasury park and the collateral vault as the park for their lanes', () => {
    expect(laneParkOf('prefund')).toBeUndefined();
    expect(laneParkOf('treasury')).toBe('0xB0aa8Dc8850d9b38727D3cFcd7a7F86DFdA34f53');
    expect(laneParkOf('collateral')).toBe('0x4AB6d4859D56452736f8b70749880CaFfC5c62C4');
    expect(['prefund', 'treasury', 'collateral'].every((lane) => laneAvailable(lane as never))).toBe(true);
  });

  it('carries the lane into the limits the create screen sends', () => {
    const draft = { ...newDraft().limits, perCall: '0.02', daily: '0.05', monthly: '0.10', approvalAmount: '0.02' };
    const reading = readDraft(draft, Date.now(), { contractSet: 'v2', classMask: 3, lane: laneValue('collateral') });
    expect(reading.problems).toEqual([]);
    expect(reading.limits?.lane).toBe(1);
    expect(reading.limits?.totalCap).toBe(100_000n);
  });

  it('points a visitor at the live example mandate', () => {
    expect(exampleMandate()).toBe('0x420BeB507F72173E7d78e0f956968f64fb508356');
  });
});

describe('drafts and the lane', () => {
  it('starts a new draft on prefund and reads an older draft without a lane as prefund', () => {
    expect(newDraft().lane).toBe('prefund');
    const { lane: _dropped, ...old } = newDraft();
    const restored = readWorkspace({ version: 1, drafts: [old], agents: [] });
    expect(restored.drafts[0]?.lane).toBe('prefund');
  });

  it('puts the lane in the readable export only when ticked', () => {
    const workspace = { version: 1 as const, agents: [], drafts: [{ ...newDraft(), lane: 'collateral' as const }] };
    expect(readableExport(workspace, { drafts: ['lane'], agents: [] })['drafts']).toEqual([{ fundingLane: 'Collateral' }]);
    expect(JSON.stringify(readableExport(workspace, { drafts: ['name'], agents: [] }))).not.toContain('Collateral');
  });
});
