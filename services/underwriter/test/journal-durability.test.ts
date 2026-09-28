import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toMicro } from '@bursar/core';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { allow } from '../src/decision.js';
import { FileDecisionSink, headMarkerPath, loadJournal } from '../src/journal.js';
import { type LoggedRequest, SpendLog } from '../src/log.js';

/**
 * The journal is the reservation.
 *
 * The lifetime ceiling is replayed from it on every start, so anything that makes the file look
 * empty makes every micro already spent available again, and anything that leaves half an entry on
 * disk loses a decision that has already moved money. These are the two ways that happens without
 * anybody doing anything wrong: a volume that did not mount, and a filesystem with no room left.
 */

/**
 * One short write, on demand.
 *
 * A filesystem with no room left takes some of the bytes it was offered and returns how many. That
 * is not an error and `writeSync` does not throw for it; the caller either notices the count or
 * reports a truncated entry as a durable append.
 */
const shortWrite = vi.hoisted(() => ({ armed: false }));

/** A disk that takes part of an entry and then fails, and a marker rename that fails outright. */
const faults = vi.hoisted(() => ({ failWrite: false, failHead: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (faults.failHead && to.endsWith('.head')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      actual.renameSync(from, to);
    },
    writeSync: (fd: number, buffer: unknown, offset?: unknown, length?: unknown, position?: unknown): number => {
      if (faults.failWrite && Buffer.isBuffer(buffer) && typeof length === 'number' && length > 1) {
        faults.failWrite = false;
        actual.writeSync(fd, buffer, offset as number, 1, position as number | null);
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      if (shortWrite.armed && Buffer.isBuffer(buffer) && typeof length === 'number' && length > 1) {
        shortWrite.armed = false;
        return actual.writeSync(fd, buffer, offset as number, 1, position as number | null);
      }
      return actual.writeSync(fd, buffer as never, offset as never, length as never, position as never);
    },
  };
});

const SUBJECT = 'wallet:0x1111111111111111111111111111111111111111';
const dirs: string[] = [];

afterEach(() => {
  shortWrite.armed = false;
  faults.failWrite = false;
  faults.failHead = false;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bursar-journal-'));
  dirs.push(dir);
  return join(dir, 'spend.log');
}

function decision(id: string, amount: number): LoggedRequest {
  return { requestId: id, subject: SUBJECT, action: 'gpu.lease', amountMicros: toMicro(amount), at: '2026-01-01T00:00:00Z' };
}

function append(path: string, log: SpendLog, id: string, amount: number): void {
  const sink = new FileDecisionSink(path);
  const { entry } = log.buildDecision(decision(id, amount), allow());
  sink.append(entry);
  log.push(entry);
}

describe('an append that the filesystem only partly takes', () => {
  test('is finished rather than reported as a durable write', () => {
    const path = scratch();
    const log = new SpendLog();
    const { entry } = log.buildDecision(decision('a', 100), allow());

    shortWrite.armed = true;
    new FileDecisionSink(path).append(entry);

    // One whole line, and it reloads. Without the loop the file holds a single byte and the next
    // start refuses to open a journal whose last line is half an entry, after the decision has
    // already been returned and acted on.
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(loadJournal(path).root()).toBe(entry.entry_hash);
  });
});

describe('an append that fails', () => {
  /**
   * The caller is told the decision was not recorded, so the log in memory does not take it. A
   * byte of it left in the file sits where the next decision goes, and the journal stops reloading
   * with that decision already acted on.
   */
  test('leaves the file as it was, so the next append and the next start both work', () => {
    const path = scratch();
    const log = new SpendLog();
    append(path, log, 'a', 100_000);
    const before = readFileSync(path, 'utf8');

    faults.failWrite = true;
    const { entry } = log.buildDecision(decision('b', 100_000), allow());
    expect(() => new FileDecisionSink(path).append(entry)).toThrow(/ENOSPC/);
    expect(readFileSync(path, 'utf8')).toBe(before);

    append(path, log, 'c', 100_000);
    expect(loadJournal(path).root()).toBe(log.root());
  });

  /**
   * The entry is on disk and fsynced by then, so it is recorded. Reporting it as a failure would
   * have the caller retry a decision the journal already holds, and the log in memory fall a
   * sequence behind the file.
   */
  test('counts as written when only the marker failed to move', () => {
    const path = scratch();
    const log = new SpendLog();
    append(path, log, 'a', 100_000);

    faults.failHead = true;
    expect(() => append(path, log, 'b', 100_000)).not.toThrow();
    faults.failHead = false;

    // The marker lags one entry behind the journal, which the loader accepts.
    expect(loadJournal(path).root()).toBe(log.root());
  });
});

describe('a journal that is not where it was', () => {
  test('refuses to open as an empty one', () => {
    const path = scratch();
    const log = new SpendLog();
    append(path, log, 'a', 1_500_000);
    expect(loadJournal(path).committedMicros()).toBe(toMicro(1_500_000));

    // An unmounted volume, a wiped container disk, a path an operator moved. All three present
    // the same missing file, and replaying it as empty hands back the whole ceiling.
    rmSync(path);

    expect(() => loadJournal(path)).toThrow(/not there/);
  });

  test('refuses to open when it has lost entries behind its marker', () => {
    const path = scratch();
    const log = new SpendLog();
    append(path, log, 'a', 100_000);
    append(path, log, 'b', 100_000);

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    writeFileSync(path, `${lines[0]}\n`);

    expect(() => loadJournal(path)).toThrow(/replays 1 entries and the marker beside it records 2/);
  });

  test('takes a journal written before the marker existed, and writes one for next time', () => {
    const path = scratch();
    const log = new SpendLog();
    append(path, log, 'a', 100_000);

    // What an upgrade looks like: entries on disk and nothing beside them.
    rmSync(headMarkerPath(path));
    expect(loadJournal(path).length).toBe(1);

    // And from here on it is protected.
    rmSync(path);
    expect(() => loadJournal(path)).toThrow(/not there/);
  });

  test('a first run is still an empty log', () => {
    expect(loadJournal(scratch()).length).toBe(0);
  });
});
