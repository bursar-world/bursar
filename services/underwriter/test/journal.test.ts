import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toMicro } from '@bursar/core';
import { afterEach, describe, expect, test } from 'vitest';

import { allow, hold } from '../src/decision.js';
import { LogError } from '../src/errors.js';
import { FileDecisionSink, loadJournal, nullSink, verifyJournalFile } from '../src/journal.js';
import { type LoggedRequest, SpendLog } from '../src/log.js';

const SUBJECT = 'wallet:0x1111111111111111111111111111111111111111';
const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bursar-underwriter-'));
  dirs.push(dir);
  return join(dir, 'spend.log');
}

function request(id: string, amount: number, at: string): LoggedRequest {
  return { requestId: id, subject: SUBJECT, action: 'gpu.lease', amountMicros: toMicro(amount), at };
}

afterEach(() => {
  dirs.length = 0;
});

describe('FileDecisionSink', () => {
  test('a missing file loads as an empty log', () => {
    expect(loadJournal(tempFile()).length).toBe(0);
  });

  test('every entry survives a reload with the same root', () => {
    const path = tempFile();
    const sink = new FileDecisionSink(path);
    const log = new SpendLog();

    for (const [id, amount] of [
      ['a', 100],
      ['b', 700],
    ] as const) {
      const { entry } = log.buildDecision(request(id, amount, '2026-01-01T00:00:00Z'), amount > 500 ? hold(toMicro(500)) : allow());
      sink.append(entry);
      log.push(entry);
    }

    const settlement = log.buildSettlement('b', 'deny', '2026-01-01T00:05:00Z');
    sink.append(settlement);
    log.push(settlement);

    const reloaded = loadJournal(path);
    expect(reloaded.length).toBe(3);
    expect(reloaded.root()).toBe(log.root());
    expect(reloaded.committedMicros()).toBe(toMicro(100));
  });

  test('writes one line per entry', () => {
    const path = tempFile();
    const sink = new FileDecisionSink(path);
    const log = new SpendLog();
    const { entry } = log.buildDecision(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    sink.append(entry);

    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });

  test('a tampered line is caught on load', () => {
    const path = tempFile();
    const sink = new FileDecisionSink(path);
    const log = new SpendLog();
    const { entry } = log.buildDecision(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    sink.append(entry);

    const line = JSON.parse(readFileSync(path, 'utf8').trim()) as { body: { amount_micros: string } };
    line.body.amount_micros = '999999';
    writeFileSync(path, `${JSON.stringify(line)}\n`);

    expect(() => loadJournal(path)).toThrow(/broken at entry 0/);
  });

  test('malformed JSON names the line it is on', () => {
    const path = tempFile();
    writeFileSync(path, '{not json\n');
    expect(() => loadJournal(path)).toThrow(/malformed JSON on line 1/);
  });

  test('verifyJournalFile is the recipe a stranger runs', () => {
    const path = tempFile();
    const sink = new FileDecisionSink(path);
    const log = new SpendLog();
    const { entry } = log.buildDecision(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    sink.append(entry);
    log.push(entry);

    const verdict = verifyJournalFile(path);
    expect(verdict).toMatchObject({ valid: true, root: log.root() });
    expect(verdict.entries).toHaveLength(1);
  });

  test('LogError is what a broken chain raises, not a generic Error', () => {
    const path = tempFile();
    writeFileSync(path, '{"seq":1,"prev_hash":"00","body":{"kind":"settlement","settles":"x","resolution":"approve","at":"2026-01-01T00:00:00Z"},"entry_hash":"zz"}\n');
    expect(() => loadJournal(path)).toThrow(LogError);
  });
});

describe('nullSink', () => {
  test('accepts an entry and keeps nothing', () => {
    const log = new SpendLog();
    const { entry } = log.buildDecision(request('a', 100, '2026-01-01T00:00:00Z'), allow());
    expect(nullSink.append(entry)).toBeUndefined();
  });
});
