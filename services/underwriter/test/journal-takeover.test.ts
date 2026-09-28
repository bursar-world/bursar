import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Address } from '../src/document.js';
import { createFileJournalStore } from '../src/journal-file.js';

/**
 * Taking over a dead holder's lock used to be read-then-write with nothing exclusive about it.
 * Two processes reach the same conclusion in the same moment, both write, and one journal ends up
 * with two writers appending at the same sequence and the lifetime ceiling reserved twice.
 *
 * The window is short and cannot be hit reliably by running two of anything, so it is opened here:
 * a competitor claims the path between the takeover reading the lock and writing its own. The
 * takeover has to lose. The claim is the one thing in this design that has to be exclusive.
 */

const race = vi.hoisted(() => ({ lockPath: '', competitor: '', writes: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (path: unknown, data: unknown, options: unknown): void => {
      if (path === race.lockPath && race.lockPath !== '') {
        race.writes += 1;
        // The first write is the ordinary exclusive claim, which finds the lock already there.
        // The second is the takeover's own, and this is the moment somebody else gets in.
        if (race.writes === 2) actual.writeFileSync(race.lockPath, race.competitor);
      }
      actual.writeFileSync(path as string, data as string, options as never);
    },
  };
});

const ACCOUNT = '0xe8fd2904175811Db41636c6085eBFE6661E196d5' as Address;
const dirs: string[] = [];

afterEach(() => {
  race.lockPath = '';
  race.competitor = '';
  race.writes = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bursar-takeover-'));
  dirs.push(dir);
  return dir;
}

describe('taking over a dead holder', () => {
  it('never overwrites a claim that appeared while it was taking over', async () => {
    const directory = scratch();
    const lockPath = join(directory, `${ACCOUNT.toLowerCase()}.lock`);

    writeFileSync(
      lockPath,
      JSON.stringify({ owner: `${hostname()}/999999`, host: hostname(), pid: 999_999, claimedAt: '' }),
    );

    const now = new Date().toISOString();
    race.competitor = JSON.stringify({
      owner: 'other-host/4242',
      host: 'other-host',
      pid: 4_242,
      claimedAt: now,
      renewedAt: now,
    });
    race.lockPath = lockPath;

    await expect(createFileJournalStore(directory).open(ACCOUNT)).rejects.toMatchObject({
      code: 'underwriter_journal_held',
    });

    // The competitor is still the holder. Two claims on one journal is the failure this prevents.
    expect(JSON.parse(readFileSync(lockPath, 'utf8')) as { owner: string }).toMatchObject({
      owner: 'other-host/4242',
    });
  });
});
