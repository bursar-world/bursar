import { hostname } from 'node:os';

import type { Address } from './document.js';
import type { DecisionSink } from './journal.js';
import type { SpendLog } from './log.js';

/**
 * The spend journal for one MandateAccount, claimed exclusively.
 *
 * The lifetime ceiling is reserved by replaying this log, so the log is the reservation. Two
 * processes each replaying their own copy would each see the whole ceiling unspent, and a
 * principal who wrote a 10,000 USDG lifetime ceiling would have written two. `open` therefore
 * claims the account before it replays, and throws `JournalHeldError` when someone else holds it.
 *
 * The claim is liveness; the ordering rules are safety. A Postgres journal keys its entries on
 * `(account, seq)`, so a second writer that somehow got past the claim collides on its first
 * append and the decision fails instead of reserving twice.
 */
export type JournalHandle = {
  readonly account: Address;
  readonly log: SpendLog;
  readonly sink: DecisionSink;
  /** Who holds the claim, as it would be shown to an operator. Never a credential. */
  readonly holder: string;
  release(): Promise<void>;
};

export type JournalStore = {
  readonly kind: 'file' | 'postgres';
  readonly describe: string;
  open(account: Address): Promise<JournalHandle>;
  close(): Promise<void>;
};

/** Identifies this process in a claim, so a rejected claim names what is holding the journal. */
export function claimOwner(): { readonly host: string; readonly pid: number; readonly label: string } {
  const host = hostname();
  return { host, pid: process.pid, label: `${host}/${process.pid}` };
}
