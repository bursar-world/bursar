import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/**
 * What the loop has to remember across a restart. `nextBlock` alone is not enough: a lock that was
 * released but not yet finalised is waiting on a dispute window that keeps running while the
 * process is down, and its `Locked` event is already behind the cursor.
 */
export type WatcherState = {
  readonly nextBlock: bigint;
  readonly tracked: readonly bigint[];
};

export type StateStore = {
  /** Undefined when nothing has been stored yet. A corrupt store throws. */
  read(): Promise<WatcherState | undefined>;
  write(state: WatcherState): Promise<void>;
};

/**
 * Who is running this payee's loop, kept beside the cursor.
 *
 * Two sidecars pointed at one payee both execute every job the escrow hands that payee, both write
 * the same cursor, and both sign a `release` for the same lock from the same key. The second
 * release reverts on a status that is no longer `Locked`, so the money is not paid twice, but the
 * gas is spent twice, the capability runs twice, the two nonces race each other and the cursor is
 * whatever the last writer said. `OUTPUT_DIR` is the other half of this: `<id>.json` is written
 * exclusively, so the two processes disagree about the bytes the moment either one delivers.
 *
 * The claim is a file, which sees only processes that share the filesystem. That is the same
 * boundary the cursor already has: two sidecars that do not share `STATE_PATH` were never going to
 * coordinate through it.
 */
export type StateClaim = {
  readonly holder: string;
  release(): Promise<void>;
};

type StoredState = {
  readonly nextBlock: string;
  readonly tracked: readonly string[];
};

const DECIMAL = /^\d+$/;

function parseState(raw: string, path: string): WatcherState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Sidecar state at ${path} is not JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Sidecar state at ${path} is not an object`);
  }

  const stored = parsed as Partial<StoredState>;
  if (typeof stored.nextBlock !== 'string' || !DECIMAL.test(stored.nextBlock)) {
    throw new Error(`Sidecar state at ${path} has no usable nextBlock`);
  }

  const tracked = stored.tracked ?? [];
  if (!Array.isArray(tracked) || tracked.some((id) => typeof id !== 'string' || !DECIMAL.test(id))) {
    throw new Error(`Sidecar state at ${path} has an unusable tracked list`);
  }

  return { nextBlock: BigInt(stored.nextBlock), tracked: tracked.map((id) => BigInt(id)) };
}

/**
 * Written through a temporary file and renamed into place, because the alternative is a truncated
 * cursor after a power cut and a sidecar that silently rescans from the head of the chain.
 */
export function createFileStateStore(path: string): StateStore {
  const temporary = `${path}.tmp`;

  return {
    read: async () => {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }

      return parseState(raw, path);
    },

    write: async (state) => {
      const stored: StoredState = {
        nextBlock: state.nextBlock.toString(),
        tracked: state.tracked.map((id) => id.toString()),
      };

      await mkdir(dirname(path), { recursive: true });
      const handle = await open(temporary, 'w');
      try {
        await handle.writeFile(`${JSON.stringify(stored)}\n`, 'utf8');
        // A rename can reach the disk before the bytes it names, and a power cut in between leaves
        // an empty cursor where the last good one was.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    },
  };
}

type Claim = { owner: string; host: string; pid: number; claimedAt: string; renewedAt: string };

/** How often the holder restates its claim, and how long one survives without that. */
const CLAIM_RENEW_MS = 30_000;
const CLAIM_EXPIRY_MS = 5 * 60_000;

export type ClaimOptions = {
  readonly now?: () => number;
  /**
   * Told once, when a renewal finds the lock naming another holder. Another sidecar is running
   * this payee from then on, and this one has to stop before it signs anything else.
   */
  readonly onLost?: (holder: string) => void;
};

/**
 * Claims this payee's loop, or refuses to start.
 *
 * A lock naming this host and a process id nobody is running is a crash that has already happened,
 * and it is taken over without anybody being asked. One nobody has renewed for five minutes is
 * taken over too, whatever host it names, because a reboot and a container that comes back under a
 * new name both leave one and neither is worth waiting for somebody to delete a file.
 */
export async function claimState(path: string, options: ClaimOptions = {}): Promise<StateClaim> {
  const now = options.now ?? Date.now;
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });

  const owner = `${hostname()}/${process.pid}`;
  const stamp = new Date(now()).toISOString();
  const claim: Claim = { owner, host: hostname(), pid: process.pid, claimedAt: stamp, renewedAt: stamp };

  await take(lockPath, claim, now());

  let lost = false;
  const timer = setInterval(() => {
    void renew(lockPath, claim, now).then((holder) => {
      if (holder === null || lost) return;
      lost = true;
      clearInterval(timer);
      options.onLost?.(holder);
    });
  }, CLAIM_RENEW_MS);
  timer.unref?.();

  return {
    holder: owner,
    async release() {
      clearInterval(timer);
      if ((await read(lockPath))?.owner === owner) await unlink(lockPath).catch(() => undefined);
    },
  };
}

async function take(lockPath: string, claim: Claim, atMs: number): Promise<void> {
  try {
    await writeFile(lockPath, `${JSON.stringify(claim, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const existing = await read(lockPath);
  if (existing === null || !stale(existing, atMs)) {
    throw new Error(
      `Another sidecar is running this payee: ${existing?.owner ?? 'an unreadable lock file'} holds ${lockPath}. ` +
        'Two of them execute every job twice, sign from the same key at the same nonce and overwrite each ' +
        "other's cursor. Stop the other one, or give this one its own STATE_PATH and OUTPUT_DIR.",
    );
  }

  // The previous holder is gone. Moving its lock aside first is what makes the replacement
  // exclusive: a rename either finds the file or does not, so only one of two processes reaching
  // this line at once can be the one that took it, and the `wx` below covers a third arriving in
  // the moment the path stands empty.
  const parked = `${lockPath}.${claim.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    await rename(lockPath, parked);
  } catch {
    throw new Error(`Another sidecar claimed ${lockPath} while this one was taking over a dead holder's lock.`);
  }

  try {
    await writeFile(lockPath, `${JSON.stringify(claim, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new Error(`Another sidecar claimed ${lockPath} while this one was taking over a dead holder's lock.`);
  } finally {
    await unlink(parked).catch(() => undefined);
  }
}

/** Restates the claim, or returns who holds the lock now when it no longer names this process. */
async function renew(lockPath: string, claim: Claim, now: () => number): Promise<string | null> {
  const current = await read(lockPath);
  // A lock that has stopped naming us was taken over. Rewriting it would put two sidecars back on
  // one payee, which is the thing the claim exists to stop.
  if (current?.owner !== claim.owner) return current?.owner ?? 'nobody';

  const renewed: Claim = { ...claim, renewedAt: new Date(now()).toISOString() };
  await writeFile(lockPath, `${JSON.stringify(renewed, null, 2)}\n`, 'utf8').catch(() => undefined);
  return null;
}

async function read(lockPath: string): Promise<Claim | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<Claim>;
    if (typeof parsed.owner !== 'string' || typeof parsed.host !== 'string' || typeof parsed.pid !== 'number') {
      return null;
    }
    return {
      owner: parsed.owner,
      host: parsed.host,
      pid: parsed.pid,
      claimedAt: parsed.claimedAt ?? '',
      renewedAt: parsed.renewedAt ?? parsed.claimedAt ?? '',
    };
  } catch {
    return null;
  }
}

function stale(claim: Claim, atMs: number): boolean {
  const renewed = Date.parse(claim.renewedAt);
  if (!Number.isNaN(renewed) && atMs - renewed > CLAIM_EXPIRY_MS) return true;
  if (claim.host !== hostname()) return false;

  try {
    // Signal 0 checks for the process without delivering anything.
    process.kill(claim.pid, 0);
    return false;
  } catch (error) {
    // EPERM means a process with that id exists and belongs to someone else, which is not stale.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
