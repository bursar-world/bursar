import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';

import type { Address } from '../src/document.js';
import { createFileJournalStore } from '../src/journal-file.js';
import { SpendLog } from '../src/log.js';

/**
 * The claim is the fix for the double reservation.
 *
 * The lifetime ceiling is replayed from the journal, so two processes each replaying their own
 * copy would each see the whole ceiling unspent. One claim per account means one reservation.
 */

const ACCOUNT = '0xe8fd2904175811Db41636c6085eBFE6661E196d5' as Address;

describe('claiming an account spend journal', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bursar-claim-'));
    dirs.push(dir);
    return dir;
  }

  it('refuses a second holder and names what is holding it', async () => {
    const directory = scratch();
    const first = createFileJournalStore(directory);
    const second = createFileJournalStore(directory);

    const held = await first.open(ACCOUNT);
    await expect(second.open(ACCOUNT)).rejects.toMatchObject({ code: 'underwriter_journal_held' });

    await held.release();
    // Once the first lets go, the second is welcome to it.
    await expect(second.open(ACCOUNT)).resolves.toMatchObject({ account: ACCOUNT });
    await second.close();
    await first.close();
  });

  it('takes over a lock left by a process on this host that is gone', async () => {
    const directory = scratch();
    writeFileSync(
      join(directory, `${ACCOUNT.toLowerCase()}.lock`),
      JSON.stringify({ owner: `${hostname()}/999999`, host: hostname(), pid: 999_999, claimedAt: '' }),
    );

    const store = createFileJournalStore(directory);
    await expect(store.open(ACCOUNT)).resolves.toMatchObject({ account: ACCOUNT });
    await store.close();
  });

  it('never takes over a lock from another host, because an unreachable one looks dead', async () => {
    const directory = scratch();
    writeFileSync(
      join(directory, `${ACCOUNT.toLowerCase()}.lock`),
      JSON.stringify({ owner: 'other-host/1', host: 'other-host', pid: 1, claimedAt: '' }),
    );

    await expect(createFileJournalStore(directory).open(ACCOUNT)).rejects.toMatchObject({
      code: 'underwriter_journal_held',
    });
  });

  /**
   * A reboot and a container that comes back under a new name both leave a lock naming a host that
   * is not this one and a process id nobody is running. Judged on the host alone, neither is ever
   * reclaimable: the service crash-loops on its own journal until somebody deletes a file by hand.
   * A claim nobody has renewed for the length of the lease is dead on the clock, whatever name it
   * carries.
   */
  it('takes over a lock nobody has renewed for the length of the lease', async () => {
    const directory = scratch();
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    writeFileSync(
      join(directory, `${ACCOUNT.toLowerCase()}.lock`),
      JSON.stringify({ owner: 'pod-7f4c/1', host: 'pod-7f4c', pid: 1, claimedAt: longAgo, renewedAt: longAgo }),
    );

    const store = createFileJournalStore(directory);
    await expect(store.open(ACCOUNT)).resolves.toMatchObject({ account: ACCOUNT });
    await store.close();
  });

  it('leaves a lock another host is still renewing alone', async () => {
    const directory = scratch();
    const justNow = new Date().toISOString();
    writeFileSync(
      join(directory, `${ACCOUNT.toLowerCase()}.lock`),
      JSON.stringify({ owner: 'pod-7f4c/1', host: 'pod-7f4c', pid: 1, claimedAt: justNow, renewedAt: justNow }),
    );

    await expect(createFileJournalStore(directory).open(ACCOUNT)).rejects.toMatchObject({
      code: 'underwriter_journal_held',
    });
  });


  it('replays what it wrote, so the reservation survives a restart', async () => {
    const directory = scratch();
    const store = createFileJournalStore(directory);

    const handle = await store.open(ACCOUNT);
    const { entry } = handle.log.buildDecision(
      { requestId: 'r-1', subject: 'agent-1', action: 'doc.summarize', amountMicros: toMicro(1_500_000), at: at() },
      { decision: 'allow' },
    );
    await handle.sink.append(entry);
    handle.log.push(entry);
    await handle.release();

    const reopened = await store.open(ACCOUNT);
    expect(reopened.log.length).toBe(1);
    expect(reopened.log.committedMicros()).toBe(toMicro(1_500_000));
    expect(reopened.log.verify()).toMatchObject({ valid: true });
    await store.close();

    // And the file is the whole record: a stranger holding it can rebuild the chain.
    const lines = readFileSync(join(directory, `${ACCOUNT.toLowerCase()}.jsonl`), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(SpendLog.fromEntries(reopened.log.entries).root()).toBe(entry.entry_hash);
  });
});

function at(): string {
  return new Date().toISOString();
}
