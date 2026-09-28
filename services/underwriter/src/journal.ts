import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';

import { LogError } from './errors.js';
import { type LogEntry, SpendLog, decodeEntry, encodeEntry } from './log.js';

/**
 * Where a decision goes before it is acted on. Write-before-you-act is the discipline. A crash
 * between the write and the spend leaves a record with no payment, which is recoverable. The
 * other order leaves a payment with no record, which is not.
 */
export type DecisionSink = {
  append(entry: LogEntry): Promise<void> | void;
};

/** Discards entries. For a caller that keeps the log in memory and accepts losing it on a crash. */
export const nullSink: DecisionSink = { append: () => undefined };

/**
 * How far the journal had got, kept beside it.
 *
 * The journal file is the reservation the lifetime ceiling rests on, and a missing file is
 * indistinguishable from a journal that was never written: an unmounted volume, a wiped container
 * disk and a first run all present the same empty directory. Replaying that as an empty log resets
 * every spend to zero and reports ready. The marker is what tells them apart. It names the last
 * sequence written and that entry's hash, and a journal that does not reach it is refused.
 *
 * It is a claim about the journal, not a second copy of it: the entries are still the record, and
 * a stranger verifying the file needs nothing from here.
 */
export type JournalHead = { readonly seq: number; readonly entryHash: string };

export function headMarkerPath(journalPath: string): string {
  return `${journalPath}.head`;
}

/**
 * Replaces the marker in one step. A half-written marker would refuse a good journal, so the bytes land in a neighbouring file and the rename puts them in place atomically.
 */
function writeHead(path: string, head: JournalHead): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w');
  try {
    writeAll(fd, `${JSON.stringify(head)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

export function readHead(path: string): JournalHead | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(text) as Partial<JournalHead>;
    if (typeof parsed.seq !== 'number' || typeof parsed.entryHash !== 'string') return null;
    return { seq: parsed.seq, entryHash: parsed.entryHash };
  } catch {
    return null;
  }
}

/**
 * Writes the whole buffer, however many calls that takes.
 *
 * `writeSync` returns how many bytes it took and is free to take fewer than it was offered, which
 * is what a filesystem with no room left does. Ignoring that return reports a short write
 * as a durable append: the decision goes back to the caller, the money moves, and the next start
 * refuses to open a journal whose last line is half an entry.
 */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    const wrote = writeSync(fd, bytes, written, bytes.length - written);
    if (wrote <= 0) {
      throw new LogError('log_broken', `the spend journal took ${written} of ${bytes.length} bytes and then stopped`, {
        written,
        expected: bytes.length,
      });
    }
    written += wrote;
  }
}

/**
 * One JSON object per line, each carrying its own hash, so a stranger holding only this file can
 * rebuild the chain and recompute the root without the service that wrote it.
 *
 * `guard` runs before every write and throws when this process may no longer append, which is how
 * a file journal whose claim was taken over stops writing instead of forking the chain.
 */
export class FileDecisionSink implements DecisionSink {
  readonly path: string;
  readonly headPath: string;
  readonly #guard: () => void;
  /**
   * Set when a failed append could not be undone. The file may end in part of an entry the log in
   * memory does not hold, and the next entry would be chained onto a line nobody can verify.
   */
  #broken: string | null = null;

  constructor(path: string, guard: () => void = () => undefined) {
    this.path = path;
    this.headPath = headMarkerPath(path);
    this.#guard = guard;
  }

  append(entry: LogEntry): void {
    if (this.#broken !== null) {
      throw new LogError(
        'log_broken',
        `the spend journal ${this.path} could not be put back after a failed append (${this.#broken}); restart the underwriter so it replays what is on disk`,
        { path: this.path },
      );
    }
    this.#guard();

    const line = `${JSON.stringify(encodeEntry(entry))}\n`;
    const fd = openSync(this.path, 'a');
    try {
      const size = fstatSync(fd).size;
      try {
        writeAll(fd, line);
        // The fsync is what makes the file worth writing. Without it the entry lives in the page
        // cache and a power loss takes the record while the payment it authorised survives.
        fsyncSync(fd);
      } catch (error) {
        // The caller is about to be told this decision was not recorded, so the file must not
        // keep it either. A line left behind would sit at a sequence the log in memory hands to
        // the next decision, and the journal would stop reloading.
        this.#undo(fd, size);
        throw error;
      }
    } finally {
      closeSync(fd);
    }

    // After the entry, never before. A marker ahead of the journal would refuse a journal that is
    // intact; a marker behind one is accepted by `loadJournal`, so a marker that did not land is
    // not a reason to report a durable entry as lost.
    try {
      writeHead(this.headPath, { seq: entry.seq, entryHash: entry.entry_hash });
    } catch {
      // The next append moves it forward, and until then it only protects slightly less.
    }
  }

  #undo(fd: number, size: number): void {
    try {
      ftruncateSync(fd, size);
      fsyncSync(fd);
    } catch (error) {
      this.#broken = error instanceof Error ? error.message : String(error);
    }
  }
}

function readEntries(path: string): LogEntry[] {
  const text = readFileSync(path, 'utf8');
  const entries: LogEntry[] = [];

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? '').trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LogError('log_broken', `spend log ${path} has malformed JSON on line ${index + 1}`, {
        path,
        line: index + 1,
      });
    }
    entries.push(decodeEntry(parsed));
  }

  return entries;
}

/**
 * The recipe a stranger runs against a log file: parse each line, rebuild the chain, recompute
 * every hash. Compare the root it returns against the one anchored on chain.
 */
export function verifyJournalFile(path: string): { entries: readonly LogEntry[] } & ReturnType<SpendLog['verify']> {
  const entries = readEntries(path);
  return { entries, ...SpendLog.fromEntries(entries).verify() };
}

/**
 * Rebuilds a log from its file and rejects a broken one, a truncated one, and one that has gone
 * missing under a marker that says it should not have.
 *
 * A missing file with no marker beside it is an empty log, which is how a subject's first decision
 * starts one. A missing file with a marker is a journal that existed and does not now, and the
 * only safe reading of that is to stop: replaying it as empty would hand back every micro of the
 * lifetime ceiling that has already been spent.
 *
 * The check runs the stranger's own recipe, so the verdict an outside reader gets is the verdict
 * this process started on.
 */
export function loadJournal(path: string): SpendLog {
  const headPath = headMarkerPath(path);
  const head = readHead(headPath);

  if (!existsSync(path)) {
    if (head === null) return new SpendLog();
    throw new LogError(
      'log_broken',
      `the spend journal ${path} is not there and the marker beside it records ${head.seq + 1} entries. The lifetime ceiling is reserved in that journal, so an empty one would hand back everything already spent. Restore the file, or delete ${headPath} if this account is genuinely starting over.`,
      { path, headPath, expectedEntries: head.seq + 1 },
    );
  }

  const verdict = verifyJournalFile(path);
  if ('broken' in verdict) {
    throw new LogError('log_broken', `spend log ${path} is broken at entry ${verdict.index}`, {
      path,
      index: verdict.index,
    });
  }

  if (head !== null) {
    const reached = verdict.entries[head.seq];
    if (reached === undefined || reached.entry_hash !== head.entryHash) {
      throw new LogError(
        'log_broken',
        `the spend journal ${path} replays ${verdict.entries.length} entries and the marker beside it records ${head.seq + 1}. A journal shorter than its marker has lost decisions that were already acted on.`,
        { path, headPath, replayed: verdict.entries.length, expectedEntries: head.seq + 1 },
      );
    }
  }

  const log = SpendLog.fromEntries(verdict.entries);
  // A journal written before the marker existed gets one now, from what it replayed, so the next
  // start is protected even though this one could not be.
  const last = verdict.entries.at(-1);
  if (head === null && last !== undefined) writeHead(headPath, { seq: last.seq, entryHash: last.entry_hash });
  return log;
}
