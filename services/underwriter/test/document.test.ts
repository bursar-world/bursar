import { toMicro } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import { canonicalJson } from '../src/canonical.js';
import { documentHash, documentPreimage, parseDocument } from '../src/document.js';
import { DocumentError } from '../src/errors.js';

const MINIMAL = {
  subject: 'wallet:0x7e232beffab42f7033c69ace6d032a3e63cac8ef',
  expires_at: '2026-12-31T23:59:59Z',
  rules: [{ effect: 'allow', pattern: 'gpu.*' }],
  ceiling_micros: 120000,
  per_call_cap_micros: 100000,
  approval_threshold_micros: 90000,
};

const MERCHANT = '0x4444444444444444444444444444444444444444';

describe('parseDocument', () => {
  test('accepts the shape the evaluator was ported with', () => {
    const document = parseDocument(MINIMAL);
    expect(document.subject).toBe(MINIMAL.subject);
    expect(document.ceilingMicros).toBe(toMicro(120000));
    expect(document.daily).toBeNull();
    expect(document.version).toBeNull();
  });

  test('rejects a field it does not recognise rather than ignoring it', () => {
    expect(() => parseDocument({ ...MINIMAL, weekly_limit_micros: 10 })).toThrow(/unrecognised field/);
  });

  test('requires a subject and a parseable expiry', () => {
    expect(() => parseDocument({ ...MINIMAL, subject: '' })).toThrow(DocumentError);
    expect(() => parseDocument({ ...MINIMAL, expires_at: 'next tuesday' })).toThrow(DocumentError);
  });

  test('rejects a fractional amount, which is how a float would sneak in', () => {
    expect(() => parseDocument({ ...MINIMAL, ceiling_micros: 1.5 })).toThrow(DocumentError);
    expect(() => parseDocument({ ...MINIMAL, ceiling_micros: '1.5' })).toThrow(DocumentError);
  });

  test('rejects an amount wider than the uint128 the account stores it in', () => {
    expect(() => parseDocument({ ...MINIMAL, ceiling_micros: (1n << 128n).toString() })).toThrow(/uint128/);
  });

  test('accepts an amount written as a string and as a number identically', () => {
    expect(parseDocument({ ...MINIMAL, ceiling_micros: '120000' })).toEqual(parseDocument(MINIMAL));
  });

  test('refuses half a window', () => {
    expect(() => parseDocument({ ...MINIMAL, daily_limit_micros: 50000 })).toThrow(/declared together/);
    expect(() => parseDocument({ ...MINIMAL, daily_window_seconds: 86400 })).toThrow(/declared together/);
  });

  test('a declared window needs an anchor, and valid_from supplies one', () => {
    expect(() =>
      parseDocument({ ...MINIMAL, daily_limit_micros: 50000, daily_window_seconds: 86400 }),
    ).toThrow(/window_anchor or valid_from/);

    const anchored = parseDocument({
      ...MINIMAL,
      valid_from: '2026-01-01T00:00:00Z',
      daily_limit_micros: 50000,
      daily_window_seconds: 86400,
    });
    expect(anchored.windowAnchor).toBe('2026-01-01T00:00:00Z');
    expect(anchored.daily).toEqual({ limitMicros: toMicro(50000), seconds: 86400 });
  });

  test('valid_from must fall before expires_at', () => {
    expect(() => parseDocument({ ...MINIMAL, valid_from: '2027-01-01T00:00:00Z' })).toThrow(/before expires_at/);
  });

  test('normalises a merchant allowlist to checksummed addresses', () => {
    const document = parseDocument({
      ...MINIMAL,
      merchant_gate: { kind: 'allowlist', merchants: [MERCHANT.toLowerCase()] },
    });
    expect(document.merchantGate).toEqual({ kind: 'allowlist', merchants: [MERCHANT] });
  });

  test('refuses an all-zero Merkle root, which would admit nobody', () => {
    expect(() =>
      parseDocument({ ...MINIMAL, merchant_gate: { kind: 'merkleRoot', root: `0x${'0'.repeat(64)}` } }),
    ).toThrow(/must not be zero/);
  });

  test('refuses an unknown gate kind', () => {
    expect(() => parseDocument({ ...MINIMAL, merchant_gate: { kind: 'everyone' } })).toThrow(DocumentError);
  });

  test('reads a version written as a number or a string', () => {
    expect(parseDocument({ ...MINIMAL, version: 4 }).version).toBe(4n);
    expect(parseDocument({ ...MINIMAL, version: '4' }).version).toBe(4n);
    expect(() => parseDocument({ ...MINIMAL, version: -1 })).toThrow(DocumentError);
    expect(() => parseDocument({ ...MINIMAL, version: '4.5' })).toThrow(DocumentError);
  });

  test('lowercases capability ids and rejects a short one', () => {
    const id = `0x${'AB'.repeat(32)}`;
    expect(parseDocument({ ...MINIMAL, capabilities: [id] }).capabilities).toEqual([id.toLowerCase()]);
    expect(() => parseDocument({ ...MINIMAL, capabilities: ['0xdead'] })).toThrow(DocumentError);
  });
});

describe('documentHash', () => {
  test('is stable across key order, whitespace and number spelling', () => {
    const reordered = {
      per_call_cap_micros: '100000',
      rules: MINIMAL.rules,
      approval_threshold_micros: 90000,
      expires_at: MINIMAL.expires_at,
      ceiling_micros: 120000,
      subject: MINIMAL.subject,
    };
    expect(documentHash(parseDocument(reordered))).toBe(documentHash(parseDocument(MINIMAL)));
  });

  test('is stable across the order of a merchant allowlist', () => {
    const other = '0x9999999999999999999999999999999999999999';
    const a = parseDocument({ ...MINIMAL, merchant_gate: { kind: 'allowlist', merchants: [MERCHANT, other] } });
    const b = parseDocument({ ...MINIMAL, merchant_gate: { kind: 'allowlist', merchants: [other, MERCHANT] } });
    expect(documentHash(a)).toBe(documentHash(b));
  });

  test('moves when any limit moves', () => {
    const base = documentHash(parseDocument(MINIMAL));
    expect(documentHash(parseDocument({ ...MINIMAL, ceiling_micros: 120001 }))).not.toBe(base);
    expect(documentHash(parseDocument({ ...MINIMAL, version: 2 }))).not.toBe(base);
  });

  test('omits undeclared fields from the preimage entirely', () => {
    const encoded = canonicalJson(documentPreimage(parseDocument(MINIMAL)));
    expect(encoded).not.toContain('daily_limit_micros');
    expect(encoded).not.toContain('merchant_gate');
    expect(encoded).toContain('"ceiling_micros":120000');
  });

  test('is 32 bytes in the form setDocumentHash takes', () => {
    expect(documentHash(parseDocument(MINIMAL))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
