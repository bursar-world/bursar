import { describe, expect, test } from 'vitest';

import { canonicalJson, sha256Bytes32, sha256Hex } from '../src/canonical.js';
import { DocumentError } from '../src/errors.js';

describe('canonicalJson', () => {
  test('keeps insertion order rather than sorting', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
  });

  test('drops undefined members so an extended record keeps the narrower preimage', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  test('writes a bigint as a bare integer, not a string', () => {
    expect(canonicalJson({ amount_micros: 12_500_000n })).toBe('{"amount_micros":12500000}');
  });

  test('carries an amount past 2^53 without losing a micro', () => {
    const huge = 9_007_199_254_740_993n;
    expect(canonicalJson({ v: huge })).toBe(`{"v":${huge.toString()}}`);
  });

  test('escapes strings the way JSON does', () => {
    expect(canonicalJson({ note: 'a"b\\c\nd' })).toBe('{"note":"a\\"b\\\\c\\nd"}');
  });

  test('encodes null, booleans and nested arrays', () => {
    expect(canonicalJson({ a: null, b: true, c: [1, 'x', false, [2n]] })).toBe('{"a":null,"b":true,"c":[1,"x",false,[2]]}');
  });

  test('refuses a float, because money never reaches a preimage as one', () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(DocumentError);
  });

  test('refuses a value outside the safe integer range as a number', () => {
    expect(() => canonicalJson({ v: 2 ** 53 })).toThrow(DocumentError);
  });

  test('refuses a symbol', () => {
    expect(() => canonicalJson({ v: Symbol('x') as never })).toThrow(DocumentError);
  });
});

describe('sha256', () => {
  test('matches the published digest of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('bytes32 form is the hex digest with a 0x prefix', () => {
    expect(sha256Bytes32('abc')).toBe(`0x${sha256Hex('abc')}`);
  });
});
