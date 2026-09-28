import { toMicro } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import { canonicalJson } from '../src/canonical.js';
import { allow, hold, refuse, RefuseReason } from '../src/decision.js';
import { LogError } from '../src/errors.js';
import { GENESIS_PREV_HASH, type LoggedRequest, SpendLog, decodeEntry, encodeEntry, hashEntry } from '../src/log.js';

const SUBJECT = 'wallet:0x1111111111111111111111111111111111111111';

function request(id: string, amount: number, at: string): LoggedRequest {
  return { requestId: id, subject: SUBJECT, action: 'gpu.lease', amountMicros: toMicro(amount), at };
}

describe('SpendLog', () => {
  test('an empty log has no root and commits nothing', () => {
    const log = new SpendLog();
    expect(log.root()).toBeNull();
    expect(log.committedMicros()).toBe(0n);
    expect(log.verify()).toEqual({ valid: true, root: GENESIS_PREV_HASH });
  });

  test('an allow commits, a refusal does not', () => {
    const log = new SpendLog();
    log.record(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    log.record(request('b', 500, '2026-01-01T00:01:00Z'), refuse(RefuseReason.OverPerCallCap));
    expect(log.committedMicros()).toBe(toMicro(100));
  });

  test('a hold reserves its amount until it is settled', () => {
    const log = new SpendLog();
    log.record(request('a', 700, '2026-01-01T00:00:00Z'), hold(toMicro(500)));
    expect(log.committedMicros()).toBe(toMicro(700));

    log.settle('a', 'deny', '2026-01-01T00:01:00Z');
    expect(log.committedMicros()).toBe(0n);
  });

  test('approving a hold keeps the reservation', () => {
    const log = new SpendLog();
    log.record(request('a', 700, '2026-01-01T00:00:00Z'), hold(toMicro(500)));
    log.settle('a', 'approve', '2026-01-01T00:01:00Z');
    expect(log.committedMicros()).toBe(toMicro(700));
  });

  test('settling twice, or settling something never held, is a fault not a refusal', () => {
    const log = new SpendLog();
    log.record(request('a', 700, '2026-01-01T00:00:00Z'), hold(toMicro(500)));
    log.settle('a', 'approve', '2026-01-01T00:01:00Z');
    expect(() => log.settle('a', 'deny', '2026-01-01T00:02:00Z')).toThrow(LogError);

    log.record(request('b', 100, '2026-01-01T00:03:00Z'), allow());
    expect(() => log.settle('b', 'approve', '2026-01-01T00:04:00Z')).toThrow(/names no held call/);
  });

  test('a retried request id returns the first decision and appends nothing', () => {
    const log = new SpendLog();
    log.record(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    const again = log.record(request('a', 999, '2026-01-01T01:00:00Z'), refuse(RefuseReason.OverPerCallCap));

    expect(again.idempotent).toBe(true);
    expect(again.decision).toEqual(allow());
    expect(log.length).toBe(1);
  });

  test('the chain links every entry to the one before it', () => {
    const log = new SpendLog();
    log.record(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    log.record(request('b', 100, '2026-01-01T00:01:00Z'), allow());

    const [first, second] = log.entries;
    expect(first?.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(second?.prev_hash).toBe(first?.entry_hash);
    expect(log.root()).toBe(second?.entry_hash);
  });

  test('refuses an out-of-order append', () => {
    const log = new SpendLog();
    const { entry } = log.buildDecision(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    log.push(entry);
    expect(() => log.push(entry)).toThrow(LogError);
  });

  test('verify finds a body edited after the fact', () => {
    const log = new SpendLog();
    log.record(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    log.record(request('b', 100, '2026-01-01T00:01:00Z'), allow());

    const tampered = log.entries.map((entry, index) =>
      index === 0 && entry.body.kind === 'decision'
        ? { ...entry, body: { ...entry.body, amount_micros: toMicro(999_999) } }
        : entry,
    );

    expect(SpendLog.fromEntries(tampered).verify()).toEqual({ broken: true, index: 0 });
  });

  test('verify finds a settlement pointing at nothing held', () => {
    const log = new SpendLog();
    log.record(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    const orphan = {
      seq: 1,
      prev_hash: log.root() as string,
      body: { kind: 'settlement', settles: 'a', resolution: 'approve', at: '2026-01-01T00:01:00Z' },
    } as const;
    const entry = { ...orphan, entry_hash: hashEntry(orphan.seq, orphan.prev_hash, orphan.body) };

    expect(SpendLog.fromEntries([...log.entries, entry]).verify()).toEqual({ broken: true, index: 1 });
  });

  test('a rehash after an edit still verifies, which is why the root is anchored', () => {
    const honest = new SpendLog();
    honest.record(request('a', 100, '2026-01-01T00:00:00Z'), allow());

    const forged = new SpendLog();
    forged.record(request('a', 999, '2026-01-01T00:00:00Z'), allow());

    expect(forged.verify()).toMatchObject({ valid: true });
    expect(forged.root()).not.toBe(honest.root());
  });
});

describe('rolling window replay', () => {
  const anchor = Date.parse('2026-01-01T00:00:00Z');
  const day = 86_400_000;

  test('narrows the total to entries inside the window', () => {
    const log = new SpendLog();
    log.record(request('a', 100, '2026-01-01T06:00:00Z'), allow());
    log.record(request('b', 200, '2026-01-02T06:00:00Z'), allow());

    expect(log.committedMicros()).toBe(toMicro(300));
    expect(log.committedMicros(anchor + day)).toBe(toMicro(200));
  });

  test('attributes a hold to the window its decision fell in, not its settlement', () => {
    const log = new SpendLog();
    log.record(request('a', 400, '2026-01-01T23:59:00Z'), hold(toMicro(100)));
    log.settle('a', 'deny', '2026-01-02T00:05:00Z');

    // The reservation was released, so neither window carries it.
    expect(log.committedMicros(anchor)).toBe(0n);
    expect(log.committedMicros(anchor + day)).toBe(0n);
  });

  test('an approved hold stays counted against the window that reserved it', () => {
    const log = new SpendLog();
    log.record(request('a', 400, '2026-01-01T23:59:00Z'), hold(toMicro(100)));
    log.settle('a', 'approve', '2026-01-02T00:05:00Z');

    expect(log.committedMicros(anchor)).toBe(toMicro(400));
    expect(log.committedMicros(anchor + day)).toBe(0n);
  });
});

describe('transport form', () => {
  test('round-trips a decision entry and re-derives the same hash', () => {
    const log = new SpendLog();
    log.record(
      {
        ...request('a', 100, '2026-01-01T00:00:00Z'),
        merchant: '0x4444444444444444444444444444444444444444',
        capabilityId: `0x${'ab'.repeat(32)}`,
        account: '0x1111111111111111111111111111111111111111',
        accountVersion: 3n,
        documentHash: `0x${'cd'.repeat(32)}`,
      },
      hold(toMicro(90)),
    );

    const entry = log.entries[0] as NonNullable<(typeof log.entries)[0]>;
    const restored = decodeEntry(JSON.parse(JSON.stringify(encodeEntry(entry))));

    expect(restored).toEqual(entry);
    expect(hashEntry(restored.seq, restored.prev_hash, restored.body)).toBe(entry.entry_hash);
  });

  test('carries an amount past 2^53 without rounding', () => {
    const huge = (1n << 100n) as ReturnType<typeof toMicro>;
    const log = new SpendLog();
    log.record({ requestId: 'a', subject: SUBJECT, action: 'gpu.lease', amountMicros: huge, at: '2026-01-01T00:00:00Z' }, allow());

    const entry = log.entries[0] as NonNullable<(typeof log.entries)[0]>;
    const restored = decodeEntry(JSON.parse(JSON.stringify(encodeEntry(entry))));
    expect(restored.body.kind === 'decision' && restored.body.amount_micros).toBe(huge);
  });

  test('round-trips a settlement entry', () => {
    const log = new SpendLog();
    log.record(request('a', 400, '2026-01-01T00:00:00Z'), hold(toMicro(100)));
    log.settle('a', 'deny', '2026-01-01T00:05:00Z');

    const entry = log.entries[1] as NonNullable<(typeof log.entries)[1]>;
    expect(decodeEntry(JSON.parse(JSON.stringify(encodeEntry(entry))))).toEqual(entry);
  });

  test('rejects an entry whose kind it does not know', () => {
    expect(() => decodeEntry({ seq: 0, prev_hash: GENESIS_PREV_HASH, body: { kind: 'wat' }, entry_hash: '' })).toThrow(
      LogError,
    );
  });
});

describe('hash preimage', () => {
  test('is the compact object the vector pins', () => {
    const body = {
      kind: 'decision',
      request_id: 'a',
      subject: SUBJECT,
      action: 'gpu.lease',
      amount_micros: toMicro(100),
      decision: allow(),
      at: '2026-01-01T00:00:00Z',
    } as const;

    expect(canonicalJson({ seq: 0, prev_hash: GENESIS_PREV_HASH, body })).toBe(
      `{"seq":0,"prev_hash":"${GENESIS_PREV_HASH}","body":{"kind":"decision","request_id":"a","subject":"${SUBJECT}","action":"gpu.lease","amount_micros":100,"decision":{"decision":"allow"},"at":"2026-01-01T00:00:00Z"}}`,
    );
  });
});
