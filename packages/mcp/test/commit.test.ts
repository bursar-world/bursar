import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';

import { canonicalStringify, capabilityId, commitCanonical, toDataUri } from '../src/commit.js';

describe('canonical commitment', () => {
  it('commits the exact bytes it publishes', () => {
    const input = { city: 'Paris' };
    const canonical = canonicalStringify(input);

    expect(canonical).toBe('{"city":"Paris"}');
    expect(commitCanonical(input)).toBe(keccak256(toBytes(canonical)));
    expect(toDataUri(canonical)).toBe('data:application/json;base64,eyJjaXR5IjoiUGFyaXMifQ==');
  });

  it('is independent of the order the arguments were assembled in', () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe(canonicalStringify({ a: 1, b: 2 }));
    expect(commitCanonical({ nested: { z: 1, a: 2 } })).toBe(commitCanonical({ nested: { a: 2, z: 1 } }));
  });

  it('keeps array order, which carries meaning', () => {
    expect(canonicalStringify({ ids: [3, 1, 2] })).toBe('{"ids":[3,1,2]}');
  });

  it('escapes strings the way JSON does', () => {
    expect(canonicalStringify({ q: 'a"b\né' })).toBe('{"q":"a\\"b\\né"}');
  });

  it.each([
    ['undefined member', { a: undefined }],
    ['a function', { a: () => 1 }],
    ['a bigint', { a: 1n }],
    ['a non-finite number', { a: Number.POSITIVE_INFINITY }],
  ])('refuses %s rather than committing to bytes a provider cannot reproduce', (_label, input) => {
    expect(() => canonicalStringify(input)).toThrow();
  });

  it('names the member it refused', () => {
    expect(() => canonicalStringify({ outer: { inner: 1n } })).toThrow('input.outer.inner');
  });

  it('hashes a capability by its versioned name', () => {
    expect(capabilityId('search.web:1')).toBe(keccak256(toBytes('search.web:1')));
    expect(capabilityId('search.web:1')).not.toBe(capabilityId('search.web:2'));
  });
});
