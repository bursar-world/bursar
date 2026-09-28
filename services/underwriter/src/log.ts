import { type Micro, micro, microToAtomicString, toMicro } from '@bursar/core';

import { canonicalJson, sha256Hex } from './canonical.js';
import { type Decision, allow, refuse, RefuseReason } from './decision.js';
import type { Address, Hex32 } from './document.js';
import { LogError } from './errors.js';

export const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export type Resolution = 'approve' | 'deny';

/**
 * One decision, as it is hashed.
 *
 * The first seven fields and their order are pinned by the conformance vector: they are the
 * preimage the roots were computed over. The chain context that follows is optional and is
 * omitted entirely when absent, so a decision taken against a document alone hashes exactly as
 * it did before the chain fields existed, and one taken against a live MandateAccount commits
 * to the version of the limits that decided it.
 */
export type DecisionBody = {
  readonly kind: 'decision';
  readonly request_id: string;
  readonly subject: string;
  readonly action: string;
  readonly amount_micros: Micro;
  readonly decision: Decision;
  readonly at: string;
  readonly merchant?: Address;
  readonly capability_id?: Hex32;
  readonly account?: Address;
  readonly account_version?: bigint;
  readonly document_hash?: Hex32;
};

/** The resolution of a held call. It never rewrites the hold; it points back at it by id. */
export type SettlementBody = {
  readonly kind: 'settlement';
  readonly settles: string;
  readonly resolution: Resolution;
  readonly at: string;
  /**
   * Why an approval was turned down at settlement, when it was. Omitted otherwise, so a settlement
   * written before this field existed hashes exactly as it did.
   */
  readonly reason?: string;
};

/**
 * Money the escrow gave back.
 *
 * `Escrow.timeout` returns a lock's amount to the payer and credits the MandateAccount's buckets,
 * and `Escrow.resolve` can return part of one. Without an entry for that, this log keeps counting
 * a spend the chain has already undone: the rolling windows this service applies decay toward zero
 * against an account whose own windows have room, and the lifetime ceiling never comes back. The
 * refund is a separate entry rather than an edit to the decision, because the decision was taken
 * and the record of it does not move.
 */
export type RefundBody = {
  readonly kind: 'refund';
  /** The decision whose amount came back. */
  readonly refunds: string;
  readonly amount_micros: Micro;
  readonly at: string;
  /** The escrow lock the credit came from, so the entry reconciles against the chain. */
  readonly escrow_id?: string;
  readonly tx_hash?: string;
};

export type LogBody = DecisionBody | SettlementBody | RefundBody;

export type LogEntry = {
  readonly seq: number;
  readonly prev_hash: string;
  readonly body: LogBody;
  readonly entry_hash: string;
};

export type VerifyResult = { readonly valid: true; readonly root: string } | { readonly broken: true; readonly index: number };

/**
 * The bytes an entry hash commits to: its position, the hash before it, and its body, in that
 * order and with no whitespace. `at` is carried through verbatim as the RFC 3339 string it
 * arrived as, never reformatted, because reformatting it would move the root.
 */
export function hashEntry(seq: number, prevHash: string, body: LogBody): string {
  return sha256Hex(canonicalJson({ seq, prev_hash: prevHash, body }));
}

/** What a decision was taken about, with the chain context that decided it. */
export type LoggedRequest = {
  readonly requestId: string;
  readonly subject: string;
  readonly action: string;
  readonly amountMicros: Micro;
  readonly at: string;
  readonly merchant?: Address;
  readonly capabilityId?: Hex32;
  readonly account?: Address;
  readonly accountVersion?: bigint;
  readonly documentHash?: Hex32;
};

function decisionBody(request: LoggedRequest, decision: Decision): DecisionBody {
  return {
    kind: 'decision',
    request_id: request.requestId,
    subject: request.subject,
    action: request.action,
    amount_micros: request.amountMicros,
    decision,
    at: request.at,
    merchant: request.merchant,
    capability_id: request.capabilityId,
    account: request.account,
    account_version: request.accountVersion,
    document_hash: request.documentHash,
  };
}

/**
 * Denying a held call returns the same refusal the ceiling would have given, because a hold
 * reserved its amount against the ceiling and the denial is what releases it.
 */
function settlementDecision(resolution: Resolution): Decision {
  return resolution === 'approve' ? allow() : refuse(RefuseReason.OverCumulativeCeiling);
}

/** Narrows a replay of the log. See `committedMicros`. */
export type ReplayOptions = {
  /** A held call to replay as released, so re-underwriting it does not charge its own reservation. */
  readonly released?: string;
};

/** What a refund entry records beyond the amount, for reconciling it against the chain. */
export type RefundOrigin = {
  readonly escrowId?: string;
  readonly txHash?: string;
};

/**
 * An append-only, hash-chained record of every spend decision for one subject.
 *
 * `build*` computes an entry without appending it, so a durable caller can put it on disk
 * before committing it to memory. That ordering is the difference between a crash that loses
 * a record of a spend and one that merely repeats a decision.
 */
export class SpendLog {
  #entries: LogEntry[] = [];

  static fromEntries(entries: readonly LogEntry[]): SpendLog {
    const log = new SpendLog();
    log.#entries = [...entries];
    return log;
  }

  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  get length(): number {
    return this.#entries.length;
  }

  root(): string | null {
    const last = this.#entries.at(-1);
    return last ? last.entry_hash : null;
  }

  #prevHash(): string {
    return this.#entries.at(-1)?.entry_hash ?? GENESIS_PREV_HASH;
  }

  #decisionEntry(requestId: string): LogEntry | undefined {
    return this.#entries.find((entry) => entry.body.kind === 'decision' && entry.body.request_id === requestId);
  }

  decisionEntryFor(requestId: string): LogEntry | null {
    return this.#decisionEntry(requestId) ?? null;
  }

  /**
   * Spend committed so far, replayed from the entries and never read from a stored counter. An
   * allow commits its amount; a hold reserves its amount so a parked hold cannot be approved
   * past the ceiling later; an approval keeps the reservation and a denial releases it; a
   * refusal commits nothing; a refund gives back what the escrow returned.
   *
   * `sinceMs` narrows the replay to a rolling window. A hold is attributed to the window its
   * decision fell in, not the window its resolution fell in, so a hold approved after the
   * window rolled still counts against the window that reserved it. A refund follows the same
   * rule as a denial and credits the window the spend was charged to, because crediting the
   * window the refund landed in would hand an agent that waits for a timeout a second allowance.
   *
   * `released` names one held call to replay as though it had been denied. That is what lets a
   * hold be re-underwritten at approval time without its own reservation counting against it
   * twice; nothing else may pass it.
   */
  committedMicros(sinceMs = Number.NEGATIVE_INFINITY, options: ReplayOptions = {}): Micro {
    let committed = 0n;
    const held = new Map<string, { amount: Micro; atMs: number }>();
    /** Every decision that put money on the line, so a refund knows what it is crediting back. */
    const charged = new Map<string, { amount: Micro; atMs: number; refunded: bigint }>();

    for (const entry of this.#entries) {
      const body = entry.body;
      if (body.kind === 'decision') {
        const atMs = Date.parse(body.at);
        const inWindow = atMs >= sinceMs;
        const releasing = body.request_id === options.released;
        if (body.decision.decision === 'allow') {
          if (inWindow) committed += body.amount_micros;
          charged.set(body.request_id, { amount: body.amount_micros, atMs, refunded: 0n });
        } else if (body.decision.decision === 'hold') {
          if (inWindow && !releasing) committed += body.amount_micros;
          if (!releasing) {
            held.set(body.request_id, { amount: body.amount_micros, atMs });
            charged.set(body.request_id, { amount: body.amount_micros, atMs, refunded: 0n });
          }
        }
      } else if (body.kind === 'settlement') {
        const reservation = held.get(body.settles);
        if (reservation === undefined) continue;
        held.delete(body.settles);
        if (body.resolution === 'deny') {
          charged.delete(body.settles);
          if (reservation.atMs >= sinceMs) committed -= reservation.amount;
        }
      } else {
        const spend = charged.get(body.refunds);
        if (spend === undefined) continue;
        // Clamped at what the decision charged. A log that claims more back than it spent is
        // caught by `verify`, and until someone looks at it the arithmetic here stays honest.
        const room = spend.amount - spend.refunded;
        const credited = body.amount_micros > room ? room : body.amount_micros;
        spend.refunded += credited;
        if (spend.atMs >= sinceMs) committed -= credited;
      }
    }

    return micro(committed);
  }

  #build(body: LogBody): LogEntry {
    const seq = this.#entries.length;
    const prevHash = this.#prevHash();
    return { seq, prev_hash: prevHash, body, entry_hash: hashEntry(seq, prevHash, body) };
  }

  /**
   * Prepares the decision entry for a request. A request id already on the log returns its
   * recorded entry and reports `idempotent`, so a retry never appends twice and never charges
   * twice.
   */
  buildDecision(request: LoggedRequest, decision: Decision): { entry: LogEntry; idempotent: boolean } {
    const prior = this.#decisionEntry(request.requestId);
    if (prior) return { entry: prior, idempotent: true };
    return { entry: this.#build(decisionBody(request, decision)), idempotent: false };
  }

  /**
   * What is still charged to a decision, after anything already refunded against it.
   *
   * A decision that committed nothing returns null: a refusal never moved money, and a hold that
   * was denied gave its reservation back when it was denied.
   */
  refundableMicros(requestId: string): Micro | null {
    let charged: bigint | null = null;
    let refunded = 0n;

    for (const entry of this.#entries) {
      const body = entry.body;
      if (body.kind === 'decision' && body.request_id === requestId) {
        if (body.decision.decision === 'refuse') return null;
        charged = body.amount_micros;
      } else if (body.kind === 'settlement' && body.settles === requestId) {
        if (body.resolution === 'deny') charged = null;
      } else if (body.kind === 'refund' && body.refunds === requestId) {
        refunded += body.amount_micros;
      }
    }

    if (charged === null) return null;
    return micro(charged > refunded ? charged - refunded : 0n);
  }

  /**
   * Prepares the entry that credits a spend back.
   *
   * The escrow is what refunds; this records it, so the windows and the ceiling this service
   * applies stop counting a payment the chain undid. It refuses an id that committed nothing and
   * an amount beyond what is still charged, because either one would hand back allowance that was
   * never spent.
   */
  buildRefund(spendRequestId: string, amountMicros: Micro, at: string, origin: RefundOrigin = {}): LogEntry {
    if (amountMicros <= 0n) {
      throw new LogError('log_not_refundable', 'a refund credits a positive amount', {
        requestId: spendRequestId,
        amountMicros: amountMicros.toString(10),
      });
    }

    const refundable = this.refundableMicros(spendRequestId);
    if (refundable === null) {
      throw new LogError(
        'log_not_refundable',
        `${spendRequestId} names no decision on this journal that committed an amount, so there is nothing to credit back. GET /v1/journal/{subject} shows what was decided.`,
        { requestId: spendRequestId },
      );
    }
    if (amountMicros > refundable) {
      throw new LogError(
        'log_not_refundable',
        `${spendRequestId} has ${refundable} micro-USD still charged to it and the refund claims ${amountMicros}`,
        { requestId: spendRequestId, refundable: refundable.toString(10), claimed: amountMicros.toString(10) },
      );
    }

    return this.#build({
      kind: 'refund',
      refunds: spendRequestId,
      amount_micros: amountMicros,
      at,
      ...(origin.escrowId === undefined ? {} : { escrow_id: origin.escrowId }),
      ...(origin.txHash === undefined ? {} : { tx_hash: origin.txHash }),
    });
  }

  /** Prepares the settling entry for a held call. Throws if the id names no open hold. */
  buildSettlement(heldRequestId: string, resolution: Resolution, at: string, reason?: string): LogEntry {
    if (resolution !== 'approve' && resolution !== 'deny') {
      throw new LogError('log_not_held', `resolution must be "approve" or "deny", got ${String(resolution)}`);
    }
    const isHeld = this.#entries.some(
      (entry) =>
        entry.body.kind === 'decision' &&
        entry.body.request_id === heldRequestId &&
        entry.body.decision.decision === 'hold',
    );
    if (!isHeld) {
      throw new LogError(
        'log_not_held',
        `${heldRequestId} names no held call, so there is nothing to resolve. GET /v1/journal/{subject} shows which decisions are holds.`,
        { requestId: heldRequestId },
      );
    }
    const settled = this.#entries.some((entry) => entry.body.kind === 'settlement' && entry.body.settles === heldRequestId);
    if (settled) {
      throw new LogError('log_already_settled', `held call ${heldRequestId} was already settled`, {
        requestId: heldRequestId,
      });
    }
    return this.#build({
      kind: 'settlement',
      settles: heldRequestId,
      resolution,
      at,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  push(entry: LogEntry): void {
    if (entry.seq !== this.#entries.length || entry.prev_hash !== this.#prevHash()) {
      throw new LogError('log_out_of_order', 'refusing to append an out-of-order entry', {
        seq: entry.seq,
        expectedSeq: this.#entries.length,
      });
    }
    this.#entries.push(entry);
  }

  record(request: LoggedRequest, decision: Decision): { entry: LogEntry; decision: Decision; idempotent: boolean } {
    const { entry, idempotent } = this.buildDecision(request, decision);
    if (!idempotent) this.push(entry);
    const body = entry.body;
    return { entry, decision: body.kind === 'decision' ? body.decision : decision, idempotent };
  }

  settle(heldRequestId: string, resolution: Resolution, at: string): { entry: LogEntry; decision: Decision } {
    const entry = this.buildSettlement(heldRequestId, resolution, at);
    this.push(entry);
    return { entry, decision: settlementDecision(resolution) };
  }

  /**
   * Recomputes the chain from the start and returns the first entry that does not reconcile,
   * or the valid root. An entry is broken if its sequence is out of order, its `prev_hash` is
   * not the entry before it, its own hash does not recompute, its request id repeats a
   * decision, a settlement points at no open hold, or a refund credits back more than the
   * decision it names ever charged.
   *
   * A valid result proves the chain is internally consistent, not that it is the chain that was
   * written: an edit followed by a wholesale rehash also verifies. What that cannot do is
   * reproduce a root already anchored on chain, so tampering is caught by comparing this root
   * against the anchored one, never by the verdict alone.
   */
  verify(): VerifyResult {
    let prev = GENESIS_PREV_HASH;
    const decided = new Set<string>();
    const openHolds = new Set<string>();
    /** What each decision still has charged to it, so a refund can be checked against it. */
    const charged = new Map<string, bigint>();

    for (let index = 0; index < this.#entries.length; index++) {
      const entry = this.#entries[index] as LogEntry;
      if (
        entry.seq !== index ||
        entry.prev_hash !== prev ||
        entry.entry_hash !== hashEntry(entry.seq, entry.prev_hash, entry.body)
      ) {
        return { broken: true, index };
      }

      const body = entry.body;
      if (body.kind === 'decision') {
        if (decided.has(body.request_id)) return { broken: true, index };
        decided.add(body.request_id);
        if (body.decision.decision === 'hold') openHolds.add(body.request_id);
        if (body.decision.decision !== 'refuse') charged.set(body.request_id, body.amount_micros);
      } else if (body.kind === 'settlement') {
        if (!openHolds.has(body.settles)) return { broken: true, index };
        openHolds.delete(body.settles);
        if (body.resolution === 'deny') charged.delete(body.settles);
      } else if (body.kind === 'refund') {
        const remaining = charged.get(body.refunds);
        if (remaining === undefined || body.amount_micros <= 0n || body.amount_micros > remaining) {
          return { broken: true, index };
        }
        charged.set(body.refunds, remaining - body.amount_micros);
      } else {
        return { broken: true, index };
      }

      prev = entry.entry_hash;
    }

    return { valid: true, root: prev };
  }
}

/**
 * The on-disk form of an entry. Amounts and the version counter travel as decimal strings
 * because they are `uint128` and `uint64` on chain and a JSON number cannot carry either
 * without silently rounding. The hash is still taken over the canonical form with bare
 * integers, so `decodeEntry` rebuilds that form and `verify` re-derives the same root.
 */
export type TransportEntry = {
  readonly seq: number;
  readonly prev_hash: string;
  readonly body: Record<string, unknown>;
  readonly entry_hash: string;
};

function encodeDecision(decision: Decision): Record<string, unknown> {
  if (decision.decision === 'hold') {
    return { decision: 'hold', threshold_micros: microToAtomicString(decision.threshold_micros) };
  }
  if (decision.decision === 'refuse') return { decision: 'refuse', reason: decision.reason };
  return { decision: 'allow' };
}

function decodeDecision(raw: unknown): Decision {
  const record = raw as Record<string, unknown> | null;
  if (record === null || typeof record !== 'object') throw new LogError('log_broken', 'decision is not an object');
  switch (record['decision']) {
    case 'allow':
      return { decision: 'allow' };
    case 'hold':
      return { decision: 'hold', threshold_micros: toMicro(record['threshold_micros'] as string) };
    case 'refuse':
      return { decision: 'refuse', reason: record['reason'] as RefuseReason };
    default:
      throw new LogError('log_broken', `unrecognised decision "${String(record['decision'])}"`);
  }
}

function encodeBody(body: LogBody): Record<string, unknown> {
  if (body.kind === 'decision') {
    return {
      kind: 'decision',
      request_id: body.request_id,
      subject: body.subject,
      action: body.action,
      amount_micros: microToAtomicString(body.amount_micros),
      decision: encodeDecision(body.decision),
      at: body.at,
      ...(body.merchant === undefined ? {} : { merchant: body.merchant }),
      ...(body.capability_id === undefined ? {} : { capability_id: body.capability_id }),
      ...(body.account === undefined ? {} : { account: body.account }),
      ...(body.account_version === undefined ? {} : { account_version: body.account_version.toString(10) }),
      ...(body.document_hash === undefined ? {} : { document_hash: body.document_hash }),
    };
  }

  if (body.kind === 'settlement') {
    return {
      kind: 'settlement',
      settles: body.settles,
      resolution: body.resolution,
      at: body.at,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    };
  }

  return {
    kind: 'refund',
    refunds: body.refunds,
    amount_micros: microToAtomicString(body.amount_micros),
    at: body.at,
    ...(body.escrow_id === undefined ? {} : { escrow_id: body.escrow_id }),
    ...(body.tx_hash === undefined ? {} : { tx_hash: body.tx_hash }),
  };
}

export function encodeEntry(entry: LogEntry): TransportEntry {
  return { seq: entry.seq, prev_hash: entry.prev_hash, body: encodeBody(entry.body), entry_hash: entry.entry_hash };
}

export function decodeEntry(raw: unknown): LogEntry {
  const entry = raw as TransportEntry | null;
  if (entry === null || typeof entry !== 'object') throw new LogError('log_broken', 'entry is not an object');
  const body = entry.body as Record<string, unknown> | undefined;
  if (body === undefined || typeof body !== 'object') throw new LogError('log_broken', 'entry has no body');

  let decoded: LogBody;
  if (body['kind'] === 'decision') {
    decoded = {
      kind: 'decision',
      request_id: body['request_id'] as string,
      subject: body['subject'] as string,
      action: body['action'] as string,
      amount_micros: toMicro(body['amount_micros'] as string),
      decision: decodeDecision(body['decision']),
      at: body['at'] as string,
      merchant: body['merchant'] as Address | undefined,
      capability_id: body['capability_id'] as Hex32 | undefined,
      account: body['account'] as Address | undefined,
      account_version: body['account_version'] === undefined ? undefined : BigInt(body['account_version'] as string),
      document_hash: body['document_hash'] as Hex32 | undefined,
    };
  } else if (body['kind'] === 'settlement') {
    decoded = {
      kind: 'settlement',
      settles: body['settles'] as string,
      resolution: body['resolution'] as Resolution,
      at: body['at'] as string,
      reason: body['reason'] as string | undefined,
    };
  } else if (body['kind'] === 'refund') {
    decoded = {
      kind: 'refund',
      refunds: body['refunds'] as string,
      amount_micros: toMicro(body['amount_micros'] as string),
      at: body['at'] as string,
      escrow_id: body['escrow_id'] as string | undefined,
      tx_hash: body['tx_hash'] as string | undefined,
    };
  } else {
    throw new LogError('log_broken', `unrecognised entry kind "${String(body['kind'])}"`);
  }

  return { seq: entry.seq, prev_hash: entry.prev_hash, body: decoded, entry_hash: entry.entry_hash };
}
