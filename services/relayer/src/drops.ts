import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Address, Hex } from 'viem';

/** The budget window. Rolling, so a restart or midnight does not open a fresh allowance. */
export const GAS_DROP_WINDOW_MS = 86_400_000;

export type GasDrop = {
  /** The nullifier hash the withdrawal spent, as the proof carries it. */
  readonly note: bigint;
  readonly recipient: Address;
  readonly wei: bigint;
  readonly hash: Hex;
  readonly at: number;
};

type StoredDrop = { readonly at: string; readonly note: string; readonly recipient: string; readonly wei: string; readonly hash: string };

/**
 * Every gas drop this relayer has made, and the two rules it keeps: one drop per note spent and one
 * per recipient, counted against a rolling daily budget.
 *
 * The deposit label is a private input to the withdrawal proof, so the relayer cannot tell which
 * deposit a withdrawal came from. What it can see is the nullifier the withdrawal spends, and that
 * is what a drop is tied to.
 *
 * With a file the ledger survives a restart. Without one it starts empty: a spent note and a
 * recipient that already holds gas are still refused from chain state, and only the day's count
 * starts over.
 */
export class GasDropLedger {
  private readonly drops: GasDrop[] = [];
  private readonly notes = new Set<string>();
  private readonly recipients = new Set<string>();

  constructor(
    /** The file drops are appended to. Null keeps them in memory, which the relayer accepts only with drops off. */
    readonly path: string | null,
    readonly now: () => number = Date.now,
  ) {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const stored = JSON.parse(line) as StoredDrop;
      this.remember({
        note: BigInt(stored.note),
        recipient: stored.recipient as Address,
        wei: BigInt(stored.wei),
        hash: stored.hash as Hex,
        at: Date.parse(stored.at),
      });
    }
  }

  hasNote(note: bigint): boolean {
    return this.notes.has(note.toString());
  }

  hasRecipient(recipient: Address): boolean {
    return this.recipients.has(recipient.toLowerCase());
  }

  /** Drops made inside the budget window. */
  countToday(): number {
    const since = this.now() - GAS_DROP_WINDOW_MS;
    return this.drops.filter((drop) => drop.at > since).length;
  }

  record(drop: Omit<GasDrop, 'at'>): GasDrop {
    const entry = { ...drop, at: this.now() };
    this.remember(entry);
    if (this.path) {
      const stored: StoredDrop = {
        at: new Date(entry.at).toISOString(),
        note: entry.note.toString(),
        recipient: entry.recipient,
        wei: entry.wei.toString(),
        hash: entry.hash,
      };
      appendFileSync(this.path, `${JSON.stringify(stored)}\n`);
    }
    return entry;
  }

  private remember(drop: GasDrop): void {
    this.drops.push(drop);
    this.notes.add(drop.note.toString());
    this.recipients.add(drop.recipient.toLowerCase());
  }
}
