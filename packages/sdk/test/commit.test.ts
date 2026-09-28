import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';

import { canonicalStringify, capabilityId, commitCanonical, toCapabilityId } from '../src/commit.js';

/** The RFC 8785 sample object, which exercises surrogate pairs and control characters. */
const JCS_KEYS = {
  '€': 'Euro Sign',
  '\r': 'Carriage Return',
  'דּ': 'Hebrew Letter Dalet With Dagesh',
  '1': 'One',
  '': 'Control',
  'ö': 'Latin Small Letter O With Diaeresis',
  '\u{1f600}': 'Emoji: Grinning Face',
  'ó': 'Latin Small Letter O with Acute',
  '': 'Empty',
};

const JCS_KEYS_CANONICAL =
  '{"":"Empty","\\r":"Carriage Return","1":"One","":"Control",' +
  '"ó":"Latin Small Letter O with Acute","ö":"Latin Small Letter O With Diaeresis",' +
  '"€":"Euro Sign","\u{1f600}":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}';

describe('canonicalStringify', () => {
  it('sorts object keys recursively without changing array order', () => {
    expect(canonicalStringify({ z: [{ beta: 2, alpha: 1 }, null], a: 'first' })).toBe(
      '{"a":"first","z":[{"alpha":1,"beta":2},null]}',
    );
  });

  it('sorts keys by utf-16 code unit', () => {
    expect(canonicalStringify(JCS_KEYS)).toBe(JCS_KEYS_CANONICAL);
  });

  it('sorts integer-like keys as strings rather than as numbers', () => {
    expect(canonicalStringify({ 10: 'ten', 9: 'nine', '-1': 'minus one' })).toBe(
      '{"-1":"minus one","10":"ten","9":"nine"}',
    );
  });

  it('writes numbers in ecmascript form', () => {
    expect(canonicalStringify({ big: 1e21, small: 1e-7, zero: -0 })).toBe(
      '{"big":1e+21,"small":1e-7,"zero":0}',
    );
  });

  it('leaves non-ascii text as utf-8 instead of escaping it', () => {
    const encoded = canonicalStringify({ city: 'Århus' });

    expect(encoded).toBe('{"city":"Århus"}');
    expect(toBytes(encoded)).toHaveLength(encoded.length + 1);
  });

  it('writes array holes and undefined elements as null', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalStringify([1, , 3])).toBe('[1,null,3]');
    expect(canonicalStringify([undefined])).toBe('[null]');
  });

  it('rejects values outside JSON', () => {
    expect(() => canonicalStringify({ value: undefined })).toThrow(TypeError);
    expect(() => canonicalStringify(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalStringify(new Date())).toThrow(/plain objects/);
  });

  it('rejects a cycle rather than running out of stack', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(() => canonicalStringify(cyclic)).toThrow(/cyclic/);
  });
});

describe('commitCanonical', () => {
  it('is independent of key insertion order, at any depth', () => {
    expect(
      commitCanonical({ query: { units: 'metric', city: 'Paris' }, meta: [{ ttl: 60, source: 'cache' }] }),
    ).toBe(
      commitCanonical({ meta: [{ source: 'cache', ttl: 60 }], query: { city: 'Paris', units: 'metric' } }),
    );
  });

  it('hashes the canonical bytes, so a verifier can reproduce it from the document alone', () => {
    const document = { model: 'sd3', seed: 7 };

    expect(commitCanonical(document)).toBe(keccak256(toBytes(canonicalStringify(document))));
  });
});

describe('capabilityId', () => {
  it('hashes the raw label as the contracts do', () => {
    expect(capabilityId('gpu.render:1')).toBe(keccak256(toBytes('gpu.render:1')));
  });

  it('separates versions of the same capability', () => {
    expect(capabilityId('gpu.render:1')).not.toBe(capabilityId('gpu.render:2'));
  });

  it('hashes the raw label, not its canonical JSON form', () => {
    expect(capabilityId('gpu.render:1')).not.toBe(commitCanonical('gpu.render:1'));
  });
});

describe('toCapabilityId', () => {
  it('passes a 32-byte id through untouched', () => {
    const id = capabilityId('gpu.render:1');

    expect(toCapabilityId(id)).toBe(id);
  });

  it('hashes anything that is not already an id', () => {
    expect(toCapabilityId('gpu.render:1')).toBe(capabilityId('gpu.render:1'));
    expect(toCapabilityId('0xdeadbeef')).toBe(capabilityId('0xdeadbeef'));
  });
});
