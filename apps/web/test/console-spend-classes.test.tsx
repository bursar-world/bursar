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

  it('writes eligible stocks when that class is on', () => {
    expect(SPEND_CLASS_INFO.rwa.available).toBe(true);
    expect(classCapabilities({ service: false, hire: false, rwa: true }, [{ spendClass: 'rwa', label: 'spy.buy:1' }]).map(chainLabel)).toEqual([
      'rwa:spy.buy:1',
    ]);
  });

  it('offers eligible stocks as a class that can be switched on', () => {
    const markup = renderToStaticMarkup(
      <SpendClassFields classes={{ service: true, hire: false, rwa: false }} capabilities={[]} onChange={() => undefined} />,
    );
    expect(markup).toContain('Eligible stocks');
    expect(markup).not.toContain('Not yet available');
    expect(markup).not.toMatch(/data-spend-class="rwa"[\s\S]*?type="checkbox"[^>]*disabled/);
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
