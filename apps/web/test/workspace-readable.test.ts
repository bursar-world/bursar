import { describe, expect, it } from 'vitest';

import { newDraft } from '@/workspace/model';
import type { Workspace } from '@/workspace/model';
import { readableExport } from '@/workspace/readable';

const base = newDraft(new Date('2026-10-01T00:00:00Z'));
const WORKSPACE: Workspace = {
  version: 1,
  drafts: [
    {
      ...base,
      name: 'Research budget',
      notes: 'secret note',
      agent: '0x1111111111111111111111111111111111111111',
      payees: ['0x2222222222222222222222222222222222222222'],
      capabilities: [{ spendClass: 'service', label: 'gpu.render:1' }],
      limits: { ...base.limits, perCall: '0.25', daily: '0.50', monthly: '1.00' },
    },
  ],
  agents: [{ id: 'a', name: 'Summariser', address: '0x1111111111111111111111111111111111111111', notes: 'agent note' }],
};

describe('readable export', () => {
  it('contains only the ticked fields', () => {
    const out = readableExport(WORKSPACE, { drafts: ['name', 'limits'], agents: ['name'] });
    expect(Object.keys((out['drafts'] as object[])[0]!)).toEqual(['name', 'limits']);
    expect(Object.keys((out['agents'] as object[])[0]!)).toEqual(['name']);
    const text = JSON.stringify(out);
    expect(text).not.toContain('secret note');
    expect(text).not.toContain('agent note');
    expect(text).not.toContain('0x2222');
    expect(text).not.toContain('0x1111');
    expect(text).toContain('"totalBudgetUsdg":"1.00"');
  });

  it('leaves a section out entirely when none of its fields is ticked', () => {
    const out = readableExport(WORKSPACE, { drafts: ['payees'], agents: [] });
    expect(out).not.toHaveProperty('agents');
    expect(out['drafts']).toEqual([{ counterparties: ['0x2222222222222222222222222222222222222222'] }]);
  });

  it('writes capabilities with their class namespace', () => {
    const out = readableExport(WORKSPACE, { drafts: ['classes'], agents: [] });
    expect(out['drafts']).toEqual([{ spendClasses: [{ class: 'Services', capabilities: ['service:gpu.render:1'] }] }]);
  });
});
