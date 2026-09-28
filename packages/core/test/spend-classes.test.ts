import { describe, expect, it } from 'vitest';

import {
  CLASS_MASK_ALL,
  DEFAULT_CLASS_MASK,
  SPEND_CLASSES,
  SPEND_CLASS_INFO,
  SpendClassError,
  bareLabel,
  capabilityId,
  classCapabilityId,
  classLabel,
  classMaskOf,
  classOfLabel,
  classesInMask,
} from '../src/index.js';

describe('spend-class namespaces', () => {
  it('publishes service, hire and rwa, all available', () => {
    expect(SPEND_CLASSES).toEqual(['service', 'hire', 'rwa']);
    expect(SPEND_CLASS_INFO.service.prefix).toBe('service:');
    expect(SPEND_CLASS_INFO.hire.prefix).toBe('hire:');
    expect(SPEND_CLASS_INFO.rwa.prefix).toBe('rwa:');
    expect(SPEND_CLASS_INFO.service.available).toBe(true);
    expect(SPEND_CLASS_INFO.hire.available).toBe(true);
    expect(SPEND_CLASS_INFO.rwa.available).toBe(true);
  });

  it('places a bare label in the class it is spent under', () => {
    expect(classLabel('service', 'gpu.render:1')).toBe('service:gpu.render:1');
    expect(classLabel('hire', 'research.summarize:1')).toBe('hire:research.summarize:1');
    expect(classLabel('service', '  gpu.render:1 ')).toBe('service:gpu.render:1');
  });

  it('passes a label already in the class through unchanged', () => {
    expect(classLabel('service', 'service:gpu.render:1')).toBe('service:gpu.render:1');
    expect(classLabel('hire', 'hire:research.summarize:1')).toBe('hire:research.summarize:1');
  });

  it('refuses a label from another class', () => {
    expect(() => classLabel('service', 'hire:research.summarize:1')).toThrow(SpendClassError);
    expect(() => classLabel('hire', 'service:gpu.render:1')).toThrow(/hire spend/);
  });

  it('refuses a raw 32-byte id, whose class cannot be read back', () => {
    expect(() => classLabel('service', capabilityId('service:gpu.render:1'))).toThrow(SpendClassError);
  });

  it('refuses an empty label', () => {
    expect(() => classLabel('service', '  ')).toThrow(SpendClassError);
  });

  it('hashes the namespaced label, so the same name in two classes is two ids', () => {
    const service = classCapabilityId('service', 'gpu.render:1');
    const hire = classCapabilityId('hire', 'gpu.render:1');
    expect(service).toBe(capabilityId('service:gpu.render:1'));
    expect(hire).toBe(capabilityId('hire:gpu.render:1'));
    expect(service).not.toBe(hire);
    expect(service).not.toBe(capabilityId('gpu.render:1'));
  });

  it('reads the class back off a label and strips it', () => {
    expect(classOfLabel('service:gpu.render:1')).toBe('service');
    expect(classOfLabel('rwa:aapl:1')).toBe('rwa');
    expect(classOfLabel('gpu.render:1')).toBeUndefined();
    expect(bareLabel('hire:research.summarize:1')).toBe('research.summarize:1');
    expect(bareLabel('gpu.render:1')).toBe('gpu.render:1');
  });
});

describe('class masks', () => {
  it('sets one bit per class, in the contract order', () => {
    expect(classMaskOf(['service'])).toBe(1);
    expect(classMaskOf(['service', 'hire'])).toBe(DEFAULT_CLASS_MASK);
    expect(classMaskOf(['service', 'hire', 'rwa'])).toBe(CLASS_MASK_ALL);
    expect(classesInMask(0b101)).toEqual(['service', 'rwa']);
    expect(classesInMask(0)).toEqual([]);
  });
});
