import type { Micro } from '@bursar/core';

import type { DocumentSource } from './config.js';
import type { MandateChain } from './chain.js';
import type { Decision } from './decision.js';
import type { Address, Hex32, MandateDocument } from './document.js';
import { documentHash } from './document.js';
import { DocumentError } from './errors.js';
import type { EventSink } from './events.js';
import type { JournalHandle, JournalStore } from './journal-store.js';
import type { LogEntry, RefundOrigin } from './log.js';
import type { SpendRequest } from './policy.js';
import { deriveDocument } from './store/derive.js';
import type { DocumentStore } from './store/types.js';
import { type Quote, Underwriter } from './underwriter.js';

/*
 * Which mandates this process speaks for, and the only place a decision is taken.
 *
 * Three things are held together here because they have to move together: the terms, the account
 * they are enforced against, and the journal the lifetime ceiling is reserved in. A journal is
 * claimed once, when a mandate is first bound, and released at shutdown, so the reservation stays
 * with one process for as long as that process is alive.
 *
 * In `chain` mode the terms are derived from the account, and the derived document is cached.
 * Caching is safe because the account, not the document, decides: a cached copy that has fallen
 * behind can only be looser than the live limits, and `previewSpend` and the simulated call both
 * run against the live account on every request. The cache is dropped as soon as a quote reports a
 * version the document was not written against, so the next request re-derives it.
 */

export type MandateSummary = {
  readonly subject: string;
  readonly account: Address;
  /** Null in `chain` mode until the first request derives the terms off the account. */
  readonly documentHash: Hex32 | null;
  readonly derived: boolean;
  readonly journalEntries: number;
  readonly journalRoot: string | null;
  readonly journalHolder: string;
};

export type DecisionResult = {
  readonly subject: string;
  readonly account: Address;
  readonly documentHash: Hex32;
  readonly decision: Decision;
  readonly quote: Quote | null;
  readonly idempotent: boolean;
  /** The journal entry this decision was written as, and the root after it. For reconciliation. */
  readonly entryHash: string;
  readonly root: string | null;
};

export type SettlementResult = {
  readonly subject: string;
  readonly account: Address;
  readonly decision: Decision;
  readonly entryHash: string;
  readonly root: string | null;
};

export type RefundResult = {
  readonly subject: string;
  readonly account: Address;
  readonly refundedMicros: Micro;
  readonly remainingMicros: Micro;
  readonly entryHash: string;
  readonly root: string | null;
};

export type JournalView = {
  readonly subject: string;
  readonly account: Address;
  readonly root: string | null;
  readonly intact: boolean;
  /** Every entry on the journal, including those outside this page. */
  readonly total: number;
  /** The sequence this page starts at, and the one a caller asks for next. */
  readonly from: number;
  readonly nextFrom: number | null;
  readonly entries: readonly LogEntry[];
};

export type JournalPage = {
  /** The first sequence to return. Past the end of the journal is an empty page, not an error. */
  readonly from?: number;
  readonly limit?: number;
};

/** A page nobody sized, and the most one request will hand back however large it asks. */
export const DEFAULT_JOURNAL_PAGE = 200;
export const MAX_JOURNAL_PAGE = 1_000;

export type RegistryOptions = {
  readonly store: DocumentStore;
  readonly journals: JournalStore;
  readonly chain: MandateChain;
  readonly chainId: number;
  readonly simulate: boolean;
  readonly deadlineDriftSeconds: bigint;
  readonly reloadIntervalMs: number;
  readonly holdExpirySeconds?: number;
  readonly onEvent?: EventSink;
  readonly now?: () => number;
};

type Bound = {
  readonly subject: string;
  readonly account: Address;
  readonly journal: JournalHandle;
  /** Null in `chain` mode, where the document is derived per request and cached below. */
  readonly document: MandateDocument | null;
  derived: { document: MandateDocument; at: number } | null;
  /** The last verification of this journal, kept against the log it was taken over. */
  verified: { length: number; root: string | null; intact: boolean } | null;
};

export type MandateRegistry = {
  readonly source: DocumentSource;
  /** Binds every mandate the store holds and claims each one's journal. Throws if one is held. */
  start(): Promise<void>;
  reload(): Promise<void>;
  subjects(): readonly string[];
  mandates(): readonly MandateSummary[];
  /** The mandate for one subject, re-reading the store once if it is not bound yet. */
  find(subject: string): Promise<MandateSummary | null>;
  authorize(subject: string, request: SpendRequest): Promise<DecisionResult | null>;
  /** `merchantProof` is re-presented for an account behind a Merkle gate; the journal does not keep it. */
  settle(
    subject: string,
    requestId: string,
    resolution: 'approve' | 'deny',
    at: string,
    merchantProof?: readonly Hex32[],
  ): Promise<SettlementResult | null>;
  /** Records money the escrow gave back against the decision that spent it, once the chain agrees. */
  refund(
    subject: string,
    requestId: string,
    amountMicros: Micro,
    at: string,
    origin?: RefundOrigin,
  ): Promise<RefundResult | null>;
  journal(subject: string, page?: JournalPage): JournalView | null;
  close(): Promise<void>;
};

export function createMandateRegistry(options: RegistryOptions): MandateRegistry {
  const now = options.now ?? (() => Date.now());
  const bound = new Map<string, Bound>();
  const queues = new Map<string, Promise<unknown>>();
  /** When the store was last asked, and what it said if it refused to answer. */
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let lastFailure: unknown = null;

  /**
   * One decision at a time per account.
   *
   * Deciding is read-then-append: the chain is read, the ceiling is replayed off the journal, and
   * only then is an entry built against a sequence number. Two requests interleaving inside that
   * window both measure the ceiling before either has reserved against it, and two retries of one
   * request id both get past the idempotency guard. Serialising per account is what makes the
   * journal the reservation it is documented to be.
   */
  const serialise = <T>(account: Address, work: () => Promise<T>): Promise<T> => {
    const key = account.toLowerCase();
    const queued = (queues.get(key) ?? Promise.resolve()).then(work);
    queues.set(
      key,
      queued.catch(() => undefined),
    );
    return queued;
  };

  /**
   * Re-reads the store, and remembers a read that did not come back.
   *
   * Marking the attempt and moving on would make a store that threw look like a store that
   * came back with nothing: for the whole reload window afterwards every unknown subject is
   * reported as having no mandate here, which reads to a caller as a principal who never wrote
   * one. A failed read is never rendered as an empty one, so the failure is kept and raised again
   * until a read succeeds.
   */
  const load = async (): Promise<void> => {
    lastAttempt = now();
    try {
      await readStore();
      lastFailure = null;
    } catch (error) {
      lastFailure = error;
      throw error;
    }
  };

  const readStore = async (): Promise<void> => {
    for (const binding of await options.store.load()) {
      const existing = bound.get(binding.subject);
      if (existing) {
        // Rebinding an account would mean claiming a second journal for it while the first is
        // still held, and the mandate the ceiling was reserved under would change underneath it.
        if (existing.account.toLowerCase() !== binding.account.toLowerCase()) {
          throw new DocumentError(
            `${binding.subject} is already bound to ${existing.account} and the store now names ${binding.account}; restart to move a subject between accounts`,
            { subject: binding.subject, bound: existing.account, offered: binding.account },
          );
        }
        continue;
      }
      bound.set(binding.subject, {
        subject: binding.subject,
        account: binding.account,
        journal: await options.journals.open(binding.account),
        document: binding.document,
        derived: null,
        verified: null,
      });
    }
  };

  /**
   * Re-reads the store when a subject is unknown, so a new mandate does not need a restart.
   *
   * Inside the reload window the answer is whatever the last read produced: null when it answered
   * and this subject was not in it, and the failure again when it did not answer at all.
   */
  const find = async (subject: string): Promise<Bound | null> => {
    const known = bound.get(subject);
    if (known) return known;
    if (now() - lastAttempt < options.reloadIntervalMs) {
      if (lastFailure !== null) throw lastFailure;
      return null;
    }
    await load();
    return bound.get(subject) ?? null;
  };

  const termsFor = async (entry: Bound): Promise<MandateDocument> => {
    if (entry.document !== null) return entry.document;

    const cached = entry.derived;
    if (cached !== null && now() - cached.at < options.reloadIntervalMs) return cached.document;

    const state = await options.chain.readAccount(entry.account);
    const document = deriveDocument(entry.subject, state, options.chainId);
    entry.derived = { document, at: now() };
    return document;
  };

  const underwriterFor = (entry: Bound, document: MandateDocument): Underwriter =>
    new Underwriter({
      chain: options.chain,
      chainId: options.chainId,
      account: entry.account,
      document,
      log: entry.journal.log,
      sink: entry.journal.sink,
      simulate: options.simulate,
      deadlineDriftSeconds: options.deadlineDriftSeconds,
      ...(options.holdExpirySeconds === undefined ? {} : { holdExpirySeconds: options.holdExpirySeconds }),
      // A derived document is the account restated, so the only disagreements it can report are
      // the ones the contract cannot express in document form. Reporting those on every request
      // would bury the divergences that mean a principal's written terms have gone stale.
      ...(entry.document !== null && options.onEvent ? { onEvent: options.onEvent } : {}),
    });

  const summarise = (entry: Bound, document: MandateDocument | null): MandateSummary => ({
    subject: entry.subject,
    account: entry.account,
    documentHash: document === null ? null : documentHash(document),
    derived: entry.document === null,
    journalEntries: entry.journal.log.length,
    journalRoot: entry.journal.log.root(),
    journalHolder: entry.journal.holder,
  });

  return {
    source: options.store.source,

    async start() {
      await load();
    },

    async reload() {
      await load();
    },

    subjects() {
      return [...bound.keys()];
    },

    mandates() {
      return [...bound.values()].map((entry) => summarise(entry, entry.document ?? entry.derived?.document ?? null));
    },

    async find(subject) {
      const entry = await find(subject);
      return entry === null ? null : summarise(entry, entry.document ?? entry.derived?.document ?? null);
    },

    async authorize(subject, request) {
      const entry = await find(subject);
      if (entry === null) return null;

      return serialise(entry.account, async () => {
        const document = await termsFor(entry);
        const result = await underwriterFor(entry, document).authorize(request);

        // The account moved on from the terms this decision was measured against. The decision
        // stands, because the contract decided it; the derived copy is dropped so the next one is
        // taken against the limits the principal now holds the agent to.
        const version = result.quote?.accountVersion ?? null;
        if (entry.document === null && version !== null && version !== document.version) {
          entry.derived = null;
        }

        return {
          subject: entry.subject,
          account: entry.account,
          documentHash: documentHash(document),
          decision: result.decision,
          quote: result.quote,
          idempotent: result.idempotent,
          entryHash: result.entry.entry_hash,
          root: entry.journal.log.root(),
        };
      });
    },

    async settle(subject, requestId, resolution, at, merchantProof) {
      const entry = await find(subject);
      if (entry === null) return null;

      return serialise(entry.account, async () => {
        const document = await termsFor(entry);
        const { entry: written, decision } = await underwriterFor(entry, document).settle(
          requestId,
          resolution,
          at,
          merchantProof,
        );

        return {
          subject: entry.subject,
          account: entry.account,
          decision,
          entryHash: written.entry_hash,
          root: entry.journal.log.root(),
        };
      });
    },

    async refund(subject, requestId, amountMicros, at, origin) {
      const entry = await find(subject);
      if (entry === null) return null;

      return serialise(entry.account, async () => {
        const document = await termsFor(entry);
        const written = await underwriterFor(entry, document).refund(requestId, amountMicros, at, origin);

        return {
          subject: entry.subject,
          account: entry.account,
          refundedMicros: written.refundedMicros,
          remainingMicros: written.remainingMicros,
          entryHash: written.entry.entry_hash,
          root: entry.journal.log.root(),
        };
      });
    },

    /**
     * A page of the journal, and whether the whole chain still reconciles.
     *
     * The verification is the expensive half and it is the half that does not change between two
     * reads of the same log: every hash from the genesis entry forward, on every request, is a
     * cost that grows with the record and is paid by whoever asks most often. It is taken once per
     * state of the log and kept against the length and root it was taken over, so an append
     * invalidates it and nothing else has to.
     */
    journal(subject, page = {}) {
      const entry = bound.get(subject);
      if (!entry) return null;

      const log = entry.journal.log;
      const root = log.root();
      if (entry.verified === null || entry.verified.length !== log.length || entry.verified.root !== root) {
        entry.verified = { length: log.length, root, intact: 'valid' in log.verify() };
      }

      const limit = Math.min(Math.max(page.limit ?? DEFAULT_JOURNAL_PAGE, 1), MAX_JOURNAL_PAGE);
      const from = Math.min(Math.max(page.from ?? 0, 0), log.length);
      const entries = log.entries.slice(from, from + limit);
      const next = from + entries.length;

      return {
        subject: entry.subject,
        account: entry.account,
        root,
        intact: entry.verified.intact,
        total: log.length,
        from,
        nextFrom: next < log.length ? next : null,
        entries,
      };
    },

    async close() {
      // A journal that will not let go is reported, but never before the rest have been released:
      // one stuck claim must not leave the others held.
      let failure: unknown = null;
      for (const entry of bound.values()) {
        try {
          await entry.journal.release();
        } catch (error) {
          failure ??= error;
        }
      }

      bound.clear();
      queues.clear();
      await options.journals.close();
      await options.store.close();
      if (failure !== null) throw failure;
    },
  };
}
