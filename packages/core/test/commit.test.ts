import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { canonicalStringify, capabilityId, commitCanonical, toCapabilityId, toDataUri } from '../src/commit.js';

/**
 * The bytes an escrow commitment covers.
 *
 * The payer hashes its input in one process and the payee hashes its output in another, and the
 * chain stores only the hash. Two serialisers that disagree on one byte produce a lock nobody can
 * settle. This lived in three packages once; the copies agreed on everything a test happened to
 * cover and disagreed on sparse arrays, where one emitted `[1,,3]`, which is not JSON at all.
 */

describe('canonical JSON', () => {
  it('sorts object keys, including the integer-like ones JavaScript hoists', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalStringify({ '10': 'a', '2': 'b', z: 'c' })).toBe('{"10":"a","2":"b","z":"c"}');
  });

  it('emits null for an array hole, the way JSON.stringify does', () => {
    const sparse = [1, , 3];
    expect(canonicalStringify(sparse)).toBe('[1,null,3]');
    expect(canonicalStringify([1, undefined, 3])).toBe('[1,null,3]');
    expect(JSON.parse(canonicalStringify(sparse))).toEqual([1, null, 3]);
  });

  it('sorts nested keys too, so the same document hashes the same either way round', () => {
    const a = { outer: { z: 1, a: [{ y: 2, b: 3 }] } };
    const b = { outer: { a: [{ b: 3, y: 2 }], z: 1 } };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(commitCanonical(a)).toBe(commitCanonical(b));
  });

  it('names the member it refused, so a caller can fix one field', () => {
    expect(() => canonicalStringify({ outer: { inner: 1n } })).toThrow(/input\.outer\.inner/);
    expect(() => canonicalStringify({ list: [0, Number.NaN] })).toThrow(/input\.list\[1\]/);
  });

  it('refuses what has no JSON form rather than guessing one', () => {
    expect(() => canonicalStringify({ a: 1n })).toThrow(/bigint/);
    expect(() => canonicalStringify({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalStringify({ a: new Date(0) })).toThrow(/plain objects/);
    expect(() => canonicalStringify({ a: () => 1 })).toThrow(/function/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalStringify(cycle)).toThrow(/cyclic/);
  });

  it('commits to the bytes, not to a display form', () => {
    expect(commitCanonical({ city: 'Paris' })).toBe(keccak256(toBytes('{"city":"Paris"}')));
  });

  it('hashes a capability label as raw UTF-8, never as a JSON string', () => {
    expect(capabilityId('gpu.render:1')).toBe(keccak256(toBytes('gpu.render:1')));
    expect(capabilityId('gpu.render:1')).not.toBe(commitCanonical('gpu.render:1'));
  });

  it('takes a capability as a label or as the id a contract already holds', () => {
    const id = capabilityId('gpu.render:1');
    expect(toCapabilityId('gpu.render:1')).toBe(id);
    expect(toCapabilityId(id)).toBe(id);
    // A 20-byte hex is an address, not an id, so it is hashed.
    expect(toCapabilityId('0x3600000000000000000000000000000000000000')).not.toBe(
      '0x3600000000000000000000000000000000000000',
    );
  });

  it('publishes the committed bytes inline so a payee needs no second fetch', () => {
    const canonical = canonicalStringify({ city: 'Paris' });
    expect(toDataUri(canonical)).toBe(
      `data:application/json;base64,${Buffer.from(canonical).toString('base64')}`,
    );
  });
});
