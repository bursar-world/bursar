import { toCapabilityId } from '@bursar/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { readClassLabel } from '@/app/(app)/console/[mandate]/gates-panel';
import { SpendClassFields, chainLabel, classCapabilities } from '@/app/(app)/console/spend-class-fields';
import { SPEND_CLASS_INFO } from '@/chain/capabilities';

const LISTED = [
  { spendClass: 'service' as const, label: 'gpu.render:1' },
  { spendClass: 'hire' as const, label: 'research.summarize:1' },
  { spendClass: 'rwa' as const, label: 'aapl:1' },
];

describe('class toggles write the capability sets', () => {
  it('writes only the capabilities of classes that are on', () => {
    const written = classCapabilities({ service: true, hire: false, rwa: false }, LISTED).map(chainLabel);
    expect(written).toEqual(['service:gpu.render:1']);
    expect(written.map((label) => toCapabilityId(label))).toEqual([toCapabilityId('service:gpu.render:1')]);
  });

  it('writes both when services and hires are on', () => {
    expect(classCapabilities({ service: true, hire: true, rwa: false }, LISTED).map(chainLabel)).toEqual([
      'service:gpu.render:1',
      'hire:research.summarize:1',
    ]);
  });

  it('never writes eligible stocks, whatever the toggle says', () => {
    expect(SPEND_CLASS_INFO.rwa.available).toBe(false);
    expect(classCapabilities({ service: false, hire: false, rwa: true }, LISTED)).toEqual([]);
  });

  it('shows eligible stocks as not yet available, disabled, and not hidden', () => {
    const markup = renderToStaticMarkup(
      <SpendClassFields classes={{ service: true, hire: false, rwa: false }} capabilities={[]} onChange={() => undefined} />,
    );
    expect(markup).toContain('Eligible stocks');
    expect(markup).toContain('Not yet available');
    expect(markup).toMatch(/data-spend-class="rwa"[\s\S]*?type="checkbox"[^>]*disabled/);
    expect(markup).toContain('service:gpu.render:1');
  });
});

describe('allowing a capability on a deployed mandate', () => {
  it('namespaces a bare label under the chosen class', () => {
    expect(readClassLabel('hire', 'research.summarize:1')).toEqual({ label: 'hire:research.summarize:1' });
  });

  it('refuses a label from another class instead of writing it', () => {
    expect(readClassLabel('service', 'hire:research.summarize:1').problem).toMatch(/hire class/);
  });

  it('asks for nothing while the field is empty', () => {
    expect(readClassLabel('service', '  ')).toEqual({});
  });
});
