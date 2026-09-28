import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toMicro } from '@bursar/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { allow } from '../src/decision.js';
import type { Address } from '../src/document.js';
import { createFileJournalStore } from '../src/journal-file.js';
import type { JournalHandle } from '../src/journal-store.js';
import type { LogEntry } from '../src/log.js';

/**
 * A file journal whose claim was taken over has to stop writing.
 *
 * Another process that took the lock replays the journal and appends from where it ends. If this
 * one keeps appending too, both chain entries onto the same sequence and the file stops being one
 * hash chain: the lifetime ceiling is reserved twice and the journal no longer reloads.
 */

const ACCOUNT = '0xe8fd2904175811Db41636c6085eBFE6661E196d5' as Address;
const SUBJECT = 'wallet:0x1111111111111111111111111111111111111111';
const LEASE_RENEW_MS = 30_000;
const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bursar-lost-'));
  dirs.push(dir);
  return dir;
}

function next(handle: JournalHandle, id: string): LogEntry {
  return handle.log.buildDecision(
    { requestId: id, subject: SUBJECT, action: 'gpu.lease', amountMicros: toMicro(100_000), at: '2026-01-01T00:00:00Z' },
    allow(),
  ).entry;
}

/** The way the underwriter calls it: a sink that throws is a rejected append. */
async function append(handle: JournalHandle, entry: LogEntry): Promise<void> {
  await handle.sink.append(entry);
}

function takeOver(lockPath: string): void {
  const now = new Date().toISOString();
  writeFileSync(
    lockPath,
    JSON.stringify({ owner: 'other-host/4242', host: 'other-host', pid: 4_242, claimedAt: now, renewedAt: now }),
  );
}

describe('a file journal whose claim was taken over', () => {
  it('refuses to append the moment the lock stops naming it', async () => {
    const directory = scratch();
    const lost: string[] = [];
    const store = createFileJournalStore(directory, { onClaimLost: (_account, holder) => lost.push(holder) });
    const handle = await store.open(ACCOUNT);
    const journal = join(directory, `${ACCOUNT.toLowerCase()}.jsonl`);

    const first = next(handle, 'a');
    await handle.sink.append(first);
    handle.log.push(first);

    takeOver(join(directory, `${ACCOUNT.toLowerCase()}.lock`));

    await expect(append(handle, next(handle, 'b'))).rejects.toMatchObject({ code: 'underwriter_journal_held' });
    expect(readFileSync(journal, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    expect(lost).toEqual(['other-host/4242']);
    await store.close();
  });

  it('stays refused after the renewal found it lost, even once the other holder lets go', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const directory = scratch();
    const store = createFileJournalStore(directory);
    const handle = await store.open(ACCOUNT);
    const lockPath = join(directory, `${ACCOUNT.toLowerCase()}.lock`);

    takeOver(lockPath);
    vi.advanceTimersByTime(LEASE_RENEW_MS);
    rmSync(lockPath);

    // The path is empty, and an empty path is not this process's claim back. The other holder may
    // have appended in between, and the log this handle replayed at open knows nothing of it.
    await expect(append(handle, next(handle, 'a'))).rejects.toMatchObject({ code: 'underwriter_journal_held' });
    expect(existsSync(join(directory, `${ACCOUNT.toLowerCase()}.jsonl`))).toBe(false);
    await store.close();
  });
});
