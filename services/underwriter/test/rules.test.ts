import { describe, expect, test } from 'vitest';

import { DocumentError } from '../src/errors.js';
import { type Rule, parseRule, permits, ruleToPattern } from '../src/rules.js';

const allowAll = parseRule('*', 'allow');
const allowGpu = parseRule('gpu.*', 'allow');
const denyExperimental = parseRule('gpu.experimental', 'deny');

describe('parseRule', () => {
  test('a trailing star is a prefix rule', () => {
    expect(allowGpu.pattern).toEqual({ type: 'prefix', value: 'gpu.' });
  });

  test('anything else matches exactly', () => {
    expect(denyExperimental.pattern).toEqual({ type: 'exact', value: 'gpu.experimental' });
  });

  test('a bare star is the prefix rule matching everything', () => {
    expect(allowAll.pattern).toEqual({ type: 'prefix', value: '' });
  });

  test('round-trips back to its written form', () => {
    for (const rule of [allowAll, allowGpu, denyExperimental]) {
      expect(parseRule(ruleToPattern(rule), rule.effect)).toEqual(rule);
    }
  });

  test('rejects an unknown effect and an empty pattern', () => {
    expect(() => parseRule('gpu.*', 'maybe')).toThrow(DocumentError);
    expect(() => parseRule('', 'allow')).toThrow(DocumentError);
    expect(() => parseRule(42, 'allow')).toThrow(DocumentError);
  });
});

describe('permits', () => {
  test('nothing matching is a refusal', () => {
    expect(permits([], 'gpu.lease')).toBe(false);
    expect(permits([allowGpu], 'storage.put')).toBe(false);
  });

  test('an exact deny carves a hole in a prefix allow', () => {
    const rules: Rule[] = [allowGpu, denyExperimental];
    expect(permits(rules, 'gpu.lease')).toBe(true);
    expect(permits(rules, 'gpu.experimental')).toBe(false);
  });

  test('an exact allow beats a broader deny', () => {
    const rules: Rule[] = [parseRule('gpu.*', 'deny'), parseRule('gpu.lease', 'allow')];
    expect(permits(rules, 'gpu.lease')).toBe(true);
    expect(permits(rules, 'gpu.render')).toBe(false);
  });

  test('the longer prefix wins', () => {
    const rules: Rule[] = [parseRule('*', 'allow'), parseRule('gpu.exp*', 'deny')];
    expect(permits(rules, 'storage.put')).toBe(true);
    expect(permits(rules, 'gpu.experimental')).toBe(false);
  });

  test('a deny wins a tie at the same specificity, in either order', () => {
    expect(permits([parseRule('gpu.*', 'allow'), parseRule('gpu.*', 'deny')], 'gpu.lease')).toBe(false);
    expect(permits([parseRule('gpu.*', 'deny'), parseRule('gpu.*', 'allow')], 'gpu.lease')).toBe(false);
  });

  test('an exact rule does not match a longer action', () => {
    expect(permits([parseRule('gpu.lease', 'allow')], 'gpu.lease.extend')).toBe(false);
  });
});
