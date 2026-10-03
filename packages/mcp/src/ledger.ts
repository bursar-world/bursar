/**
 * What has left the shielded float, kept on disk so the daily cap outlives the process.
 *
 * The pool caps deposits and nothing on the way out: a withdrawal is bounded only by the note it
 * spends, so a model told to pay could empty the float one note at a time, and the only thing in
 * the way is this server. Every payment is written here before it is handed to the relayer, and a
 * ledger that cannot be read or written refuses the payment rather than guess at the day.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { micro } from '@bursar/core';

import { ToolError } from './errors.js';
import { instant, money } from './format.js';
import { isJsonObject } from './schema.js';

/** A payment counts against the cap for this long after it went out. */
export const LEDGER_WINDOW_MS = 86_400_000;

export type LedgerLocking = {
  /** How long a draw waits for another process to finish its own before refusing the payment. */
  readonly waitMs: number;
  /** A draw holds the lock for one read and one write; a lock this old was left by a process that died. */
  readonly staleMs: number;
};

/** The wait outlasts the stale age, so a lock left by a crash clears within one draw's wait. */
export const LEDGER_LOCKING: LedgerLocking = { waitMs: 15_000, staleMs: 10_000 };

const LOCK_POLL_MS = 2;
const LOCK_SPIN_ATTEMPTS = 500;

export type LedgerPayment = {
  /** Milliseconds since the epoch. */
  readonly at: number;
  /** What left the float, relayer fee included, in micro-USDG. */
  readonly micro: bigint;
};

export type LedgerDay = {
  readonly drawn: bigint;
  /** Oldest first. */
  readonly payments: readonly LedgerPayment[];
};

export type SpendLedger = {
  readonly path: string;
  /** The last 24 hours as the file records them. */
  day(): LedgerDay;
  /** Refuses a payment the day has no room for. Reads only. */
  check(amount: bigint, cap: bigint): void;
  /** Records a payment the day has room for, on disk before it returns, or refuses it. */
  draw(amount: bigint, cap: bigint): void;
};

type File = { readonly version: 1; readonly payments: readonly { readonly at: string; readonly micro: string }[] };

export function createSpendLedger(path: string, now: () => number = Date.now, locking: LedgerLocking = LEDGER_LOCKING): SpendLedger {
  // Reads and writes are synchronous on purpose: a check and the write that follows it cannot be
  // interleaved with another payment's, so two payments in flight cannot both find room for one.
  // Across processes the same holds only under the lock, which draw takes around its read and write.
  function current(): LedgerDay {
    const moment = now();
    const payments = read(path)
      .filter((payment) => moment - payment.at < LEDGER_WINDOW_MS)
      .sort((a, b) => a.at - b.at);

    return { drawn: payments.reduce((sum, payment) => sum + payment.micro, 0n), payments };
  }

  function room(amount: bigint, cap: bigint): LedgerDay {
    const day = current();
    if (day.drawn + amount > cap) throw dailyCapRefusal(day, amount, cap);
    return day;
  }

  return {
    path,
    day: current,
    check(amount, cap) {
      room(amount, cap);
    },
    draw(amount, cap) {
      withLock(path, locking, () => write(path, [...room(amount, cap).payments, { at: now(), micro: amount }]));
    },
  };
}

/**
 * Two servers handed one key file share one ledger, and a draw is a read, a decision and a write.
 * Without the lock, two processes can each find room for the day's last payment, and the write of
 * one erases the other's: the cap is passed and the file undercounts what left the float.
 */
function withLock<T>(path: string, locking: LedgerLocking, run: () => T): T {
  const lock = `${path}.lock`;
  const fd = acquire(path, lock, locking);
  try {
    return run();
  } finally {
    release(lock, fd);
  }
}

function acquire(path: string, lock: string, locking: LedgerLocking): number {
  const deadline = Date.now() + locking.waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw unwritable(path, codeOf(error));
    }
    if (isStale(lock, locking.staleMs)) clearStale(path, lock);
    else if (Date.now() >= deadline) throw lockHeld(path, lock, locking);
    // A draw holds the lock for about a millisecond, so the first retries follow at once. Sleeping
    // polls, which the operating system may stretch well past their length, take over if it stays held.
    else if (attempt >= LOCK_SPIN_ATTEMPTS) pause(LOCK_POLL_MS);
  }
}

/** Only the lock this process took: a holder paused past the stale age finds another's in its place. */
function release(lock: string, fd: number): void {
  try {
    if (statSync(lock).ino === fstatSync(fd).ino) rmSync(lock, { force: true });
  } catch {
    // Already cleared as stale by another process, so there is nothing of this one's to remove.
  }
  closeSync(fd);
}

function isStale(lock: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > staleMs;
  } catch {
    // Released between the open and the stat; the next attempt takes it.
    return false;
  }
}

/**
 * Moved aside and then removed, rather than removed in place: of two processes that both find the
 * lock stale, the rename succeeds for one alone, and neither can remove a fresh lock a third process
 * has taken in the meantime.
 */
function clearStale(path: string, lock: string): void {
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    renameSync(lock, aside);
    rmSync(aside, { force: true });
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw unwritable(path, codeOf(error));
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function pause(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function read(path: string): LedgerPayment[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // No file yet is an empty day. Anything else is a file this server cannot see into.
    if (codeOf(error) === 'ENOENT') return [];
    throw unreadable(path, codeOf(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unreadable(path, 'it is not JSON');
  }

  if (!isJsonObject(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['payments'])) {
    throw unreadable(path, 'it is not a ledger this server writes');
  }

  return parsed['payments'].map((entry: unknown, index) => {
    const at = isJsonObject(entry) && typeof entry['at'] === 'string' ? Date.parse(entry['at']) : Number.NaN;
    const raw = isJsonObject(entry) ? entry['micro'] : undefined;
    if (!Number.isFinite(at) || typeof raw !== 'string' || !/^\d+$/u.test(raw)) {
      throw unreadable(path, `payment ${index} is not a time and an amount`);
    }
    return { at, micro: BigInt(raw) };
  });
}

/** Written whole to a sibling and renamed over the ledger, so a crash mid-write leaves the old day. */
function write(path: string, payments: readonly LedgerPayment[]): void {
  const file: File = {
    version: 1,
    payments: payments.map((payment) => ({ at: new Date(payment.at).toISOString(), micro: payment.micro.toString() })),
  };
  const sibling = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

  try {
    writeFileSync(sibling, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(sibling, path);
  } catch (error) {
    rmSync(sibling, { force: true });
    throw unwritable(path, codeOf(error));
  }
}

function dailyCapRefusal(day: LedgerDay, amount: bigint, cap: bigint): ToolError {
  const resumesAt = roomAt(day, amount, cap);
  const usdg = (value: bigint) => money(micro(value)).usdg;

  return new ToolError(
    'shielded_daily_cap',
    `This server sends at most ${usdg(cap)} USDG in shielded payments over any 24 hours. ${usdg(day.drawn)} USDG ` +
      `has gone out in the last 24 hours, and this payment would draw ${usdg(amount)} USDG, relayer fee included. ` +
      'Nothing was sent. ' +
      (resumesAt === null
        ? 'This payment is over the daily cap on its own. '
        : `Room for it returns at ${instant(Math.ceil(resumesAt / 1000))}, as earlier payments age past 24 hours. `) +
      'The operator sets the cap with BURSAR_SHIELDED_DAILY_CAP.',
    {
      cap: cap.toString(),
      drawn: day.drawn.toString(),
      payment: amount.toString(),
      resumesAt: resumesAt === null ? null : instant(Math.ceil(resumesAt / 1000)),
    },
  );
}

/** When enough of the day has aged out for `amount` to fit, or null when it never will. */
function roomAt(day: LedgerDay, amount: bigint, cap: bigint): number | null {
  if (amount > cap) return null;

  let drawn = day.drawn;
  for (const payment of day.payments) {
    drawn -= payment.micro;
    if (drawn + amount <= cap) return payment.at + LEDGER_WINDOW_MS;
  }

  return null;
}

function unreadable(path: string, reason: string): ToolError {
  return new ToolError(
    'shielded_ledger_unreadable',
    `The ledger of shielded payments at ${path} could not be read (${reason}), so no shielded payment is sent ` +
      'until it can be: the daily cap is counted from this file, and a day it cannot see is a day it cannot ' +
      'bound. The operator repairs or removes the file, or points BURSAR_SHIELDED_LEDGER at another.',
    { path, reason },
  );
}

function unwritable(path: string, reason: string): ToolError {
  return new ToolError(
    'shielded_ledger_unwritable',
    `The ledger of shielded payments at ${path} could not be written (${reason}), so this payment was not ` +
      'sent: a payment the ledger cannot record is one the daily cap cannot see. The operator makes the file ' +
      'and its directory writable, or points BURSAR_SHIELDED_LEDGER at a directory that is.',
    { path, reason },
  );
}

function lockHeld(path: string, lock: string, locking: LedgerLocking): ToolError {
  const seconds = (ms: number) => `${Math.round(ms / 1000)} seconds`;
  return new ToolError(
    'shielded_ledger_locked',
    `Another process has held the ledger of shielded payments at ${path} for over ${seconds(locking.waitMs)}, so ` +
      'this payment was not sent: a payment the ledger cannot record is one the daily cap cannot see. A lock ' +
      `left behind by a process that died clears on its own after ${seconds(locking.staleMs)}; one held this long ` +
      `has a live process behind it, which the operator finds before removing ${lock}.`,
    { path, lock },
  );
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'the file system refused';
}
