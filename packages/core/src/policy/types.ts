import type { Micro } from '../money.js';
import { DocumentError } from './errors.js';
import type { Rule } from './rules.js';

export type Address = `0x${string}`;
export type Hex32 = `0x${string}`;

/**
 * Which roster decides whether a merchant can be paid, mirroring `IMandateAccount.MerchantGate`.
 * Exactly one is live at a time on chain, so a document that declares the other one is
 * describing limits nobody is enforcing.
 */
export type MerchantGate =
  | { readonly kind: 'allowlist'; readonly merchants: readonly Address[] }
  | { readonly kind: 'merkleRoot'; readonly root: Hex32 };

/** A rolling spend window: a cap and the period it refills over. */
export type MandateWindow = { readonly limitMicros: Micro; readonly seconds: number };

/**
 * The off-chain mandate. It is the document a principal signs and an auditor reads, and it is
 * not the enforcement point: `MandateAccount` is. Every field here that the contract also
 * holds exists so the two can be compared, and the contract wins every disagreement.
 *
 * `ceilingMicros` is the lifetime total. The console's drafts carry their total budget here, and
 * the deployed account carries the same number in its second window.
 */
export type MandateDocument = {
  readonly subject: string;
  /** The MandateAccount these terms describe. Null means the document is not bound to one. */
  readonly account: Address | null;
  readonly chainId: number | null;
  /** The `MandateAccount.version` these terms were written against. Null means unanchored. */
  readonly version: bigint | null;
  readonly validFrom: string | null;
  readonly expiresAt: string;
  readonly rules: readonly Rule[];
  readonly ceilingMicros: Micro;
  readonly perCallCapMicros: Micro;
  readonly approvalThresholdMicros: Micro | null;
  readonly daily: MandateWindow | null;
  readonly monthly: MandateWindow | null;
  /** Where both rolling windows start counting. Required once a window is declared. */
  readonly windowAnchor: string | null;
  readonly merchantGate: MerchantGate | null;
  readonly capabilities: readonly Hex32[] | null;
};

/** RFC 3339 to epoch milliseconds. A timestamp the runtime cannot parse is not a deadline. */
export function parseTimestamp(raw: unknown, field: string): number {
  if (typeof raw !== 'string' || raw === '') {
    throw new DocumentError(`${field} must be an RFC 3339 timestamp`, { field });
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new DocumentError(`${field} must be an RFC 3339 timestamp`, { field, value: raw });
  }
  return ms;
}

/** Narrows a replay of spend history. See `SpendHistory.committedMicros`. */
export type ReplayOptions = {
  /** A held call to replay as released, so re-underwriting it does not charge its own reservation. */
  readonly released?: string;
};

/**
 * What the evaluator needs to know about money already committed: how much, since when.
 *
 * The underwriter answers it from its hash-chained journal. The console answers it from the
 * figures a principal types into a rule check. Either way the evaluator only ever asks this one
 * question, which is what keeps it pure.
 */
export interface SpendHistory {
  committedMicros(sinceMs?: number, options?: ReplayOptions): Micro;
}

/** A history made of plain entries, for callers with no journal. */
export function spendHistory(entries: readonly { readonly amountMicros: Micro; readonly atMs: number }[]): SpendHistory {
  return {
    committedMicros(sinceMs = Number.NEGATIVE_INFINITY) {
      let total = 0n;
      for (const entry of entries) if (entry.atMs >= sinceMs) total += entry.amountMicros;
      return total as Micro;
    },
  };
}
