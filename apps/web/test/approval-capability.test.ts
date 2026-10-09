import { toCapabilityId } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { chainCapability } from '@/app/(app)/console/[mandate]/approvals/approvals-view';

/**
 * An approval names the capability a payment will carry, and a payment carries the namespaced id:
 * the SDK spends a bare name as a service. The form used to hash the bare text, which named a
 * capability no payment carries, so a consent signed for "gpu.render:1" could never be used.
 */
describe('the capability an approval names', () => {
  it('reads a bare name as a service, as a payment does', () => {
    const read = chainCapability('gpu.render:1', 'v4');
    expect(read.label).toBe('service:gpu.render:1');
    expect(read.id).toBe(toCapabilityId('service:gpu.render:1'));
  });

  it('keeps a name already in a class', () => {
    expect(chainCapability('hire:research.summarize:1', 'v4').id).toBe(toCapabilityId('hire:research.summarize:1'));
    expect(chainCapability(' service:gpu.render:1 ', 'v4').label).toBe('service:gpu.render:1');
  });

  it('takes a 32-byte id as it is, and a first-set account as written', () => {
    const id = toCapabilityId('service:gpu.render:1');
    expect(chainCapability(id, 'v4').id).toBe(id);
    expect(chainCapability('gpu.render:1', 'v1').id).toBe(toCapabilityId('gpu.render:1'));
  });

  it('says nothing for an empty field', () => {
    expect(chainCapability('  ', 'v4')).toEqual({ id: undefined, label: undefined, problem: undefined });
  });
});
