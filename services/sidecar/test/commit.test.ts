import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';

import { canonicalStringify, capabilityId, commitCanonical } from '../src/commit.js';

describe('commit', () => {
  it('hashes the same bytes the contracts hash', () => {
    expect(commitCanonical({ city: 'Paris' })).toBe(keccak256(toBytes('{"city":"Paris"}')));
  });

  it('canonicalizes before hashing, whatever order the payer used', () => {
    expect(canonicalStringify({ units: 'metric', city: 'Paris' })).toBe('{"city":"Paris","units":"metric"}');
    expect(commitCanonical({ units: 'metric', city: 'Paris' })).toBe(commitCanonical({ city: 'Paris', units: 'metric' }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalStringify({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}');
  });

  it('sorts by code unit rather than by the order javascript iterates keys', () => {
    // JavaScript hoists integer-like keys ahead of string keys, so a plain JSON.stringify would
    // emit 2 before "a" and produce a different commitment for the same document.
    expect(canonicalStringify({ a: 1, 2: 2, 10: 3 })).toBe('{"10":3,"2":2,"a":1}');
  });

  it('hashes a capability label as raw utf-8', () => {
    expect(capabilityId('weather.get:1')).toBe(keccak256(toBytes('weather.get:1')));
  });

  it.each([
    ['a non-finite number', { x: Number.POSITIVE_INFINITY }],
    ['an undefined member', { x: undefined }],
    ['a class instance', { x: new Date(0) }],
  ])('refuses %s rather than guessing at the bytes', (_label, value) => {
    expect(() => canonicalStringify(value)).toThrow(TypeError);
  });

  it('refuses a cyclic value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(() => canonicalStringify(cyclic)).toThrow(/cyclic/);
  });

  it('emits null for array holes, as json does', () => {
    expect(canonicalStringify([1, , 3])).toBe('[1,null,3]');
  });
});
