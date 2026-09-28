import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Address } from './document.js';
import { JournalHeldError } from './errors.js';
import { FileDecisionSink, loadJournal } from './journal.js';
import { claimOwner, type JournalHandle, type JournalStore } from './journal-store.js';

/*
 * A spend journal on disk: one append-only file per account, claimed by a lock file beside it.
 *
 * Good enough for one host. The claim is a file, so it can only see processes that share the
 * filesystem, and a journal on a shared volume mounted by two machines is not protected by it. A
 * deployment that runs more than one underwriter sets `UNDERWRITER_DATABASE_URL` and gets a claim
 * the database enforces instead.
 *
 * A crash leaves the lock behind, and that case is recovered rather than escalated to a human. Two
 * things make a lock reclaimable. A lock naming this host and a process id nobody is running is
 * dead on the evidence, and is taken over at once. A lock nobody has renewed for the length of the
 * lease is taken over too, whatever host it names: a process that has stopped renewing has stopped
 * underwriting, and the alternative is a container that comes back under a new name and finds its
 * own journal permanently held by a process id that died with the old one.
 */

/**
 * How often a holder restates its claim, and how long a claim survives without that.
 *
 * The gap between them is what a stopped-the-world pause, a slow disk or a clock nudge is allowed
 * to cost before another process concludes the holder is gone. Ten renewals of room is generous
 * for a file write; a deployment that needs a harder answer than this runs the Postgres journal,
 * where the claim is a session the server drops.
 */
const LEASE_RENEW_MS = 30_000;
const LEASE_EXPIRY_MS = 5 * 60_000;

type Claim = { owner: string; host: string; pid: number; claimedAt: string; renewedAt: string };

export type FileJournalOptions = {
  /**
   * Told when a lock this process was holding stopped naming it, which means another process took
   * the journal over. The handle refuses every append from then on, and an operator has to know
   * why decisions for that account have started failing.
   */
  readonly onClaimLost?: (account: Address, holder: string) => void;
  readonly now?: () => number;
};

export function createFileJournalStore(directory: string, options: FileJournalOptions = {}): JournalStore {
  mkdirSync(directory, { recursive: true });

  const now = options.now ?? (() => Date.now());
  const held = new Map<string, { account: Address; claim: Claim }>();
  /** Locks this process held and lost. An append against one would fork the journal. */
  const lost = new Map<string, string>();
  let renewTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Restates every claim this process holds, so a live underwriter is never mistaken for a dead
   * one. A lock that has stopped naming us was taken over while we were not looking; it is dropped
   * rather than rewritten, because rewriting it would put two processes on one journal.
   */
  const renew = (): void => {
    for (const [lockPath, entry] of [...held]) {
      const current = read(lockPath);
      if (current === null || current.owner !== entry.claim.owner) {
        markLost(lockPath, current);
        continue;
      }

      const renewed: Claim = { ...entry.claim, renewedAt: new Date(now()).toISOString() };
      try {
        writeFileSync(lockPath, `${JSON.stringify(renewed, null, 2)}\n`);
        held.set(lockPath, { account: entry.account, claim: renewed });
      } catch {
        // A disk that will not take the renewal is a disk that will not take the next decision
        // either, and that one is reported where it happens. Nothing here is worth a crash.
      }
    }
  };

  const markLost = (lockPath: string, current: Claim | null): void => {
    const entry = held.get(lockPath);
    if (entry === undefined) return;
    const holder = current?.owner ?? 'nobody';
    held.delete(lockPath);
    lost.set(lockPath, holder);
    options.onClaimLost?.(entry.account, holder);
  };

  /**
   * Runs before every append. The renewal timer alone leaves thirty seconds in which a process
   * whose claim was taken over keeps writing, so the lock is read again here: one small file read
   * per decision is the price of never having two writers on one hash chain.
   */
  const assertHeld = (lockPath: string, account: Address): void => {
    const entry = held.get(lockPath);
    if (entry !== undefined) {
      const current = read(lockPath);
      if (current !== null && current.owner === entry.claim.owner) return;
      markLost(lockPath, current);
    }

    const holder = lost.get(lockPath) ?? 'nobody';
    throw new JournalHeldError(
      `the spend journal for ${account} is no longer claimed by this process (the lock names ${holder}); restart the underwriter before it decides for this account again`,
      { account, lockPath, holder },
    );
  };

  const startRenewing = (): void => {
    if (renewTimer !== null) return;
    renewTimer = setInterval(renew, LEASE_RENEW_MS);
    // Never a reason to hold the process open: a journal claim outlives nothing.
    renewTimer.unref?.();
  };

  const stopRenewing = (): void => {
    if (renewTimer === null || held.size > 0) return;
    clearInterval(renewTimer);
    renewTimer = null;
  };

  const drop = (lockPath: string): void => {
    const entry = held.get(lockPath);
    if (entry === undefined) return;
    held.delete(lockPath);

    // Only ever our own lock. Deleting one that has been taken over would leave the journal
    // unclaimed while another process is appending to it.
    const current = read(lockPath);
    if (current !== null && current.owner === entry.claim.owner) rmSync(lockPath, { force: true });
    stopRenewing();
  };

  return {
    kind: 'file',
    describe: directory,

    async open(account: Address): Promise<JournalHandle> {
      const key = account.toLowerCase();
      const journalPath = join(directory, `${key}.jsonl`);
      const lockPath = join(directory, `${key}.lock`);

      const me = claimOwner();
      const stamp = new Date(now()).toISOString();
      const claim: Claim = { owner: me.label, host: me.host, pid: me.pid, claimedAt: stamp, renewedAt: stamp };
      take(lockPath, claim, account, now());
      held.set(lockPath, { account, claim });
      lost.delete(lockPath);
      startRenewing();

      // A crash between here and the first append leaves a lock this process owns, which its own
      // stale check will reclaim on the next start.
      let log;
      try {
        log = loadJournal(journalPath);
      } catch (error) {
        // A journal that will not open leaves nothing to hold. Keeping the lock would make the
        // next attempt fail on the claim instead of on the fault an operator has to fix.
        drop(lockPath);
        throw error;
      }

      return {
        account,
        log,
        sink: new FileDecisionSink(journalPath, () => assertHeld(lockPath, account)),
        holder: me.label,
        async release() {
          drop(lockPath);
        },
      };
    },

    async close() {
      for (const lockPath of [...held.keys()]) drop(lockPath);
      held.clear();
      if (renewTimer !== null) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
    },
  };
}

function describeClaim(claim: Claim | null): string {
  return claim?.owner ?? 'an unreadable lock file';
}

function take(lockPath: string, claim: Claim, account: Address, atMs: number): void {
  try {
    writeFileSync(lockPath, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const existing = read(lockPath);
  if (existing === null || !stale(existing, claim.host, atMs)) {
    throw new JournalHeldError(
      `the spend journal for ${account} is held by ${describeClaim(existing)}; the lifetime ceiling is reserved in that journal, so only one underwriter may speak for this account`,
      { account, lockPath, holder: describeClaim(existing) },
    );
  }

  takeOver(lockPath, claim, account, atMs);
}

/**
 * Replaces a dead holder's lock, and lets exactly one process do it.
 *
 * The obvious version reads the lock, decides it is stale and overwrites it, which two processes
 * run side by side to reach the same conclusion and both write: one journal, two writers, and the
 * lifetime ceiling reserved twice. The claim itself has to be the thing that is exclusive.
 *
 * So the stale lock is moved aside first. A rename either finds the file and takes it or finds
 * nothing, and only one process can be the one that took it; a second arrival sees it gone and
 * stops rather than racing for the empty path. The replacement is then created exclusively, which
 * covers the third case: a process making a first claim in the moment the path stood empty wins
 * it, and this one steps back.
 */
function takeOver(lockPath: string, claim: Claim, account: Address, atMs: number): void {
  const parked = `${lockPath}.${claim.pid}.${Math.random().toString(36).slice(2, 10)}`;

  try {
    renameSync(lockPath, parked);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new JournalHeldError(
      `the spend journal for ${account} was claimed by another process while this one was taking over a dead holder's lock; start again`,
      { account, lockPath },
    );
  }

  // The lock we moved aside is the one we judged dead, not a fresh claim that landed in between.
  const moved = read(parked);
  if (moved === null || !stale(moved, claim.host, atMs)) {
    restore(parked, lockPath);
    throw new JournalHeldError(
      `the spend journal for ${account} is held by ${describeClaim(moved)}; the lifetime ceiling is reserved in that journal, so only one underwriter may speak for this account`,
      { account, lockPath, holder: describeClaim(moved) },
    );
  }

  try {
    writeFileSync(lockPath, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new JournalHeldError(
      `the spend journal for ${account} was claimed by ${describeClaim(read(lockPath))} while this process was taking over a dead holder's lock`,
      { account, lockPath },
    );
  } finally {
    rmSync(parked, { force: true });
  }
}

/** Puts a lock back where it was, and only if nothing has taken the path in the meantime. */
function restore(parked: string, lockPath: string): void {
  try {
    linkSync(parked, lockPath);
  } catch {
    // The path is taken, so somebody else is holding the journal, which is what the caller is
    // about to report anyway.
  }
  rmSync(parked, { force: true });
}

function read(lockPath: string): Claim | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<Claim>;
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

/**
 * Whether a lock can be taken over.
 *
 * A lock naming this host and a process id nobody is running is dead on the evidence, and is the
 * ordinary case: a crash and a restart on one machine. A lock nobody has renewed for the length of
 * the lease is dead on the clock, and that one is what a reboot and a renamed container both look
 * like from here. A live process holds its lock, including this one: a second claim on the same
 * journal inside one process is the double reservation this lock exists to prevent.
 *
 * A lock with no renewal stamp at all predates the lease and is judged on the process id alone,
 * which is the rule it was written under.
 */
function stale(claim: Claim, host: string, atMs: number): boolean {
  if (expired(claim, atMs)) return true;
  if (claim.host !== host) return false;
  try {
    // Signal 0 checks for the process without delivering anything.
    process.kill(claim.pid, 0);
    return false;
  } catch (error) {
    // EPERM means a process with that id exists and belongs to someone else, which is not stale.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function expired(claim: Claim, atMs: number): boolean {
  const renewed = Date.parse(claim.renewedAt);
  if (Number.isNaN(renewed)) return false;
  return atMs - renewed > LEASE_EXPIRY_MS;
}
