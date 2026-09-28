import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimState, createFileStateStore } from '../src/state.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bursar-sidecar-'));
  directories.push(directory);

  return directory;
}

describe('createFileStateStore', () => {
  it('reads back exactly what it wrote', async () => {
    const path = join(await workspace(), 'nested', 'cursor.json');
    const store = createFileStateStore(path);

    await store.write({ nextBlock: 61_540_100n, tracked: [7n, 9n] });

    expect(await store.read()).toEqual({ nextBlock: 61_540_100n, tracked: [7n, 9n] });
  });

  it('reports nothing stored on a first run', async () => {
    expect(await createFileStateStore(join(await workspace(), 'cursor.json')).read()).toBeUndefined();
  });

  it('stores block numbers as decimal strings, since json has no bigint', async () => {
    const path = join(await workspace(), 'cursor.json');
    await createFileStateStore(path).write({ nextBlock: 2n ** 64n, tracked: [1n] });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      nextBlock: '18446744073709551616',
      tracked: ['1'],
    });
  });

  it('leaves no temporary file behind', async () => {
    const directory = await workspace();
    const path = join(directory, 'cursor.json');
    await createFileStateStore(path).write({ nextBlock: 1n, tracked: [] });

    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow();
  });

  it.each([
    ['not json', 'cursor'],
    ['a list', '[]'],
    ['a missing block', '{"tracked":[]}'],
    ['a block that is not a number', '{"nextBlock":"0x10","tracked":[]}'],
    ['an unusable tracked entry', '{"nextBlock":"10","tracked":["seven"]}'],
  ])('refuses a store holding %s rather than rescanning from the head', async (_label, contents) => {
    const path = join(await workspace(), 'cursor.json');
    await writeFile(path, contents, 'utf8');

    await expect(createFileStateStore(path).read()).rejects.toThrow(/Sidecar state/);
  });
});

/**
 * Two sidecars pointed at one payee run every job twice, sign from one key at two nonces that race
 * each other, and overwrite each other's cursor. Nothing in the loop noticed: the second release
 * reverts on a status that is no longer `Locked`, which looks like an ordinary lost race in the
 * log, and by then both have paid gas and both have called the capability.
 */
describe('claiming a payee', () => {
  it('refuses a second sidecar on the same cursor and says what to do about it', async () => {
    const path = join(await workspace(), 'cursor.json');

    const held = await claimState(path);
    await expect(claimState(path)).rejects.toThrow(/Another sidecar is running this payee/);

    await held.release();
    await expect(claimState(path)).resolves.toMatchObject({ holder: expect.stringContaining('/') });
  });

  it('takes over a claim left by a process that is gone', async () => {
    const path = join(await workspace(), 'cursor.json');
    await writeFile(
      `${path}.lock`,
      JSON.stringify({ owner: `${hostname()}/999999`, host: hostname(), pid: 999_999, claimedAt: '' }),
      'utf8',
    );

    await expect(claimState(path)).resolves.toMatchObject({ holder: expect.stringContaining(hostname()) });
  });

  it('takes over a claim nobody has renewed for the length of the lease', async () => {
    const path = join(await workspace(), 'cursor.json');
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await writeFile(
      `${path}.lock`,
      JSON.stringify({ owner: 'pod-7f4c/1', host: 'pod-7f4c', pid: 1, claimedAt: longAgo, renewedAt: longAgo }),
      'utf8',
    );

    await expect(claimState(path)).resolves.toMatchObject({ holder: expect.stringContaining('/') });
  });

  it('leaves a claim another host is still renewing alone', async () => {
    const path = join(await workspace(), 'cursor.json');
    const justNow = new Date().toISOString();
    await writeFile(
      `${path}.lock`,
      JSON.stringify({ owner: 'pod-7f4c/1', host: 'pod-7f4c', pid: 1, claimedAt: justNow, renewedAt: justNow }),
      'utf8',
    );

    await expect(claimState(path)).rejects.toThrow(/Another sidecar is running this payee/);
  });

  /**
   * The claim is renewed on a timer, and a renewal that finds another holder used to say nothing.
   * Both sidecars then ran the payee until one of them was restarted by hand.
   */
  it('says so when a renewal finds the claim taken over', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const path = join(await workspace(), 'cursor.json');
      const lost: string[] = [];
      const held = await claimState(path, { onLost: (holder) => lost.push(holder) });

      const justNow = new Date().toISOString();
      await writeFile(
        `${path}.lock`,
        JSON.stringify({ owner: 'pod-7f4c/1', host: 'pod-7f4c', pid: 1, claimedAt: justNow, renewedAt: justNow }),
        'utf8',
      );
      vi.advanceTimersByTime(30_000);
      await vi.waitFor(() => expect(lost).toEqual(['pod-7f4c/1']));

      // Said once. The next renewal has nothing new to report and must not restate the claim.
      vi.advanceTimersByTime(30_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lost).toHaveLength(1);
      await held.release();
    } finally {
      vi.useRealTimers();
    }
  });
});

