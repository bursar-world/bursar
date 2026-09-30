import { type Micro, ZERO_MICRO, classOfLabel, isBursarError, micro } from '@bursar/core';

import type { AnchorStatus } from './anchor.js';
import { type AssetCondition, assetCondition } from './asset.js';
import {
  type AccountState,
  ESCROW_REFUNDED_STATUSES,
  type EscrowTerms,
  type IssuerControls,
  type MandateChain,
  type MerchantStanding,
} from './chain.js';
import { type Bucket, type Decision, RefuseReason, bucketFor, hold, refuse } from './decision.js';
import { MAX_AMOUNT_MICROS, type Address, type Hex32, type MandateDocument, documentHash } from './document.js';
import { ChainUnavailableError, LogError, RequestError, RequestReplayedError } from './errors.js';
import { type DeadlineBounds, deadlineBounds, escrowPreflight } from './escrow.js';
import { type DecisionSource, type EventSink, safeEmit } from './events.js';
import { type DecisionSink, nullSink } from './journal.js';
import { type DecisionBody, type LogEntry, type RefundOrigin, type ReplayOptions, SpendLog } from './log.js';
import { verifyMerchantProof } from './merkle.js';
import {
  type SpendRequest,
  assertClock,
  assertRequest,
  capabilityFromAction,
  documentWindows,
  evaluateDocument,
} from './policy.js';
import { type Divergence, reconcile } from './reconcile.js';
import {
  type ChainRefusal,
  accountRefusal,
  errorSelector,
  isApprovalRequired,
  isMerkleGateActive,
  spendRefusal,
} from './selectors.js';

/**
 * Which limits the chain reverts on and which ones only this service applies.
 *
 * A limit enforced in a service is a limit an operator with
 * database access can move, so calling it enforced would overstate what a principal is buying.
 * Anything in `service` is a policy this underwriter applies; anything in `contract` is a policy
 * the MandateAccount applies whether this service is running or not.
 */
export type Enforcement = {
  readonly contract: readonly string[];
  readonly service: readonly string[];
};

export const ENFORCEMENT: Enforcement = {
  contract: [
    'per-call cap',
    'daily rolling window',
    'monthly rolling window',
    'validity window',
    'merchant gate',
    'capability allowlist',
    'approval threshold',
    'pause and revocation',
    'escrow deadline bounds',
    'escrow minimum lock',
    'payee reputation cap',
  ],
  service: ['lifetime ceiling', 'action rules', 'hold and settlement bookkeeping'],
};

/** Every bucket a spend draws on, so a refusal names the one that ran out. */
export type Headroom = {
  readonly perCall: Micro;
  readonly daily: Micro;
  readonly monthly: Micro;
  readonly balance: Micro;
  readonly payeeCap: Micro;
  /** Document-only, and labelled as such in `enforcement`. */
  readonly ceiling: Micro;
  readonly documentDaily: Micro | null;
  readonly documentMonthly: Micro | null;
};

export type Quote = {
  readonly requestId: string;
  readonly decision: Decision;
  readonly source: DecisionSource;
  readonly bucket: Bucket | null;
  readonly account: Address;
  readonly accountVersion: bigint | null;
  readonly documentHash: Hex32;
  readonly headroom: Headroom | null;
  readonly deadline: DeadlineBounds | null;
  readonly anchor: AnchorStatus | null;
  readonly divergences: readonly Divergence[];
  readonly enforcement: Enforcement;
  /** The account's own answer, kept verbatim for support transcripts. */
  readonly chainRefusal: ChainRefusal | null;
  /**
   * The settlement asset's answer, when it is the asset that stopped the spend. Set on a refusal
   * the token issuer owns and null otherwise, including on an allow: a clear reading is not
   * something a caller has to act on, and reporting it would invite reading it as a guarantee that
   * the transfer will land.
   */
  readonly assetCondition: AssetCondition | null;
  readonly simulated: boolean;
};

export type Authorization = {
  readonly decision: Decision;
  readonly entry: LogEntry;
  readonly idempotent: boolean;
  readonly quote: Quote | null;
};

export type UnderwriterOptions = {
  readonly chain: MandateChain;
  readonly chainId: number;
  readonly account: Address;
  readonly document: MandateDocument;
  readonly log?: SpendLog;
  readonly sink?: DecisionSink;
  readonly onEvent?: EventSink;
  /**
   * How far the block that includes the lock may be ahead of the block the quote was taken
   * against. It only raises the lower deadline bound; see `deadlineBounds`.
   */
  readonly deadlineDriftSeconds?: bigint;
  /**
   * Re-check an allow by simulating the whole `spend` call. It is the only check that covers
   * every revert path at once, and it costs one extra `eth_call`. Requires a deadline on the
   * request.
   */
  readonly simulate?: boolean;
  /**
   * How long a held call may wait for a principal before an approval is refused rather than paid.
   *
   * A hold is a quote that has not been taken yet. The account it was measured against can be
   * paused, revoked, re-limited or expired while it sits, and an escrow deadline is minutes, not
   * days, so an approval past this is a payment against terms nobody looked at.
   */
  readonly holdExpirySeconds?: number;
};

const DEFAULT_DRIFT_SECONDS = 30n;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex32;

/** A day. Long enough for a principal in another timezone, short enough to still mean something. */
const DEFAULT_HOLD_EXPIRY_SECONDS = 24 * 60 * 60;

/** The fields a replayed request id has to match, and the name each one is reported under. */
const REPLAY_FIELDS = ['amountMicros', 'subject', 'action', 'merchant', 'capabilityId'] as const;

/** A spend with the two fields every chain read needs, filled in where they can be. */
type ResolvedSpend = SpendRequest & { readonly merchant: Address; readonly capabilityId: Hex32 };

/**
 * Fills in the capability and insists on the payee.
 *
 * Both are load-bearing: `previewSpend` takes a merchant and a capability, and the account's
 * allowlists are keyed on them. A capability the caller left out is derived from the action when
 * the action is a capability label, which is the shape every example uses. When it is not, the
 * request is rejected as invalid and the message names the field.
 *
 * Neither of these is a refusal. A refusal says a policy was applied and the spend did not pass
 * it; naming a policy when the real cause is an omitted field sends the caller to read a mandate
 * that never had anything to say about their request.
 */
function resolveSpend(request: SpendRequest): ResolvedSpend {
  if (request.merchant === undefined) {
    throw new RequestError(
      'merchant is required: it is the payee the account\'s merchant gate and the escrow\'s reputation cap are both read against',
      { field: 'merchant' },
    );
  }

  const capabilityId = request.capabilityId ?? capabilityFromAction(request.action);
  if (capabilityId === null) {
    throw new RequestError(
      `capabilityId is required: the account holds its allowlist as the keccak of a capability label, and the action "${request.action}" is not one. Send capabilityId, or write the action as a label such as doc.summarize:1 and it will be derived.`,
      { field: 'capabilityId', action: request.action },
    );
  }

  return { ...request, merchant: request.merchant, capabilityId };
}

/**
 * The class a v2 account checks the spend against: a hire when the action is a `hire:` label,
 * a service otherwise. A bare label is a service, which is what every v1 mandate spent as.
 */
function spendClassOf(request: SpendRequest): number {
  return classOfLabel(request.action) === 'hire' ? 1 : 0;
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * What a replayed request id changed about the spend, or null when it changed nothing.
 *
 * Everything a decision was measured against is compared. `at` is deliberately not: a client that
 * retries without restating the timestamp gets a fresh one from the route, and refusing that would
 * turn every ordinary retry into an error. Everything that decides how much money moves and where
 * it goes is here.
 */
function replayMismatch(
  prior: DecisionBody,
  request: ResolvedSpend,
): { readonly field: (typeof REPLAY_FIELDS)[number]; readonly recorded: string; readonly presented: string } | null {
  if (prior.amount_micros !== request.amountMicros) {
    return {
      field: 'amountMicros',
      recorded: prior.amount_micros.toString(10),
      presented: request.amountMicros.toString(10),
    };
  }
  if (prior.subject !== request.subject) {
    return { field: 'subject', recorded: prior.subject, presented: request.subject };
  }
  if (prior.action !== request.action) {
    return { field: 'action', recorded: prior.action, presented: request.action };
  }
  if (!sameAddress(prior.merchant, request.merchant)) {
    return { field: 'merchant', recorded: prior.merchant ?? 'none', presented: request.merchant };
  }
  if (!sameAddress(prior.capability_id, request.capabilityId)) {
    return { field: 'capabilityId', recorded: prior.capability_id ?? 'none', presented: request.capabilityId };
  }
  return null;
}

function refuseReplay(prior: DecisionBody, request: ResolvedSpend): void {
  const changed = replayMismatch(prior, request);
  if (changed === null) return;

  throw new RequestReplayedError(
    `requestId ${request.requestId} was already decided on this journal with a different ${changed.field}: ${changed.recorded}, and this request presents ${changed.presented}. A retry returns the decision that was taken, so it has to name the same spend. Send a new requestId for a new spend.`,
    {
      requestId: request.requestId,
      field: changed.field,
      recorded: changed.recorded,
      presented: changed.presented,
    },
  );
}

type ChainVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'hold'; readonly threshold: Micro }
  | { readonly kind: 'refuse'; readonly refusal: ChainRefusal };

/**
 * Decides whether a spend is allowed, and refuses unless it can establish that it is.
 *
 * The MandateAccount is the source of truth. Everything the contract enforces is read from the
 * contract, and the document is checked against it. Where the two disagree the contract wins and
 * the disagreement is emitted as a trust event, because a document that no longer describes the
 * live limits is an operational fault whoever benefits from it.
 *
 * Every path that cannot reach an answer refuses: a chain that will not answer, a selector this
 * build does not recognise, a Merkle gate with no proof. The alternative is a payment authorised
 * by an absence of information.
 */
export class Underwriter {
  readonly account: Address;
  readonly chainId: number;
  readonly document: MandateDocument;
  readonly log: SpendLog;

  readonly #chain: MandateChain;
  readonly #sink: DecisionSink;
  readonly #onEvent: EventSink | undefined;
  readonly #drift: bigint;
  readonly #simulate: boolean;
  readonly #documentHash: Hex32;
  readonly #holdExpirySeconds: number;

  constructor(options: UnderwriterOptions) {
    this.account = options.account;
    this.chainId = options.chainId;
    this.document = options.document;
    this.log = options.log ?? new SpendLog();

    this.#chain = options.chain;
    this.#sink = options.sink ?? nullSink;
    this.#onEvent = options.onEvent;
    this.#drift = options.deadlineDriftSeconds ?? DEFAULT_DRIFT_SECONDS;
    this.#simulate = options.simulate ?? false;
    this.#documentHash = documentHash(options.document);
    this.#holdExpirySeconds = options.holdExpirySeconds ?? DEFAULT_HOLD_EXPIRY_SECONDS;
  }

  get documentHash(): Hex32 {
    return this.#documentHash;
  }

  /**
   * Prices a spend against the account, the document and the escrow, without recording anything.
   *
   * `replay` is internal: `settle` passes the held call it is resolving so the hold's own
   * reservation is not counted against the approval it is about to allow. No caller has a reason
   * to set it.
   */
  async quote(spend: SpendRequest, replay: ReplayOptions = {}): Promise<Quote> {
    assertRequest(spend);
    const request = resolveSpend(spend);

    const bound = this.#bindingRefusal(request);
    if (bound !== null) return this.#refusal(request, bound, 'underwriter');

    let state: AccountState;
    let terms: EscrowTerms;
    let standing: MerchantStanding;
    let controls: IssuerControls;
    let nowSeconds: bigint;
    let blockNumber: bigint | undefined;
    let merchantAllowed: boolean;
    let capabilityAllowed: boolean;

    const { merchant, capabilityId } = request;

    try {
      // One height for the whole decision. A `setLimits` landing between two reads would otherwise
      // have the journal name a version that decided nothing, and the pool is free to answer two
      // reads from providers a block apart.
      const head = await this.#chain.latestBlock?.();
      blockNumber = head?.number;
      nowSeconds = head?.timestamp ?? (await this.#chain.blockTimestamp());
      state = await this.#chain.readAccount(this.account, blockNumber);
      [terms, merchantAllowed, capabilityAllowed, controls] = await Promise.all([
        this.#chain.readEscrowTerms(state.escrow, blockNumber),
        this.#chain.readMerchantAllowed(this.account, merchant, blockNumber),
        this.#chain.readCapabilityAllowed(this.account, capabilityId, blockNumber),
        // The token's own view of the two parties, in the wave that was already in flight. The
        // account is the payer here: `Escrow.lock` pulls the amount out of it, so a freeze on the
        // account stops the spend as surely as a cap does, and it is not the principal's to lift.
        this.#chain.readIssuerControls(state.settlementAsset, [this.account, merchant], blockNumber),
      ]);
      standing = await this.#chain.readMerchantStanding(terms, merchant, blockNumber);
    } catch (error) {
      this.#reportUnreachable(request.requestId, error);
      return this.#refusal(request, RefuseReason.ChainUnavailable, 'underwriter');
    }

    assertClock(request.at, nowSeconds, this.#drift);

    const reconciliation = reconcile(this.document, state, {
      chainId: this.chainId,
      merchant: { address: merchant, allowed: merchantAllowed },
      capability: { id: capabilityId, allowed: capabilityAllowed },
    });
    for (const divergence of reconciliation.divergences) {
      safeEmit(this.#onEvent, {
        type: 'divergence',
        requestId: request.requestId,
        account: this.account,
        accountVersion: state.version,
        divergence,
      });
    }

    const bounds = deadlineBounds(nowSeconds, terms, this.#drift);
    const windows = documentWindows(this.document, this.log, Date.parse(request.at), replay);
    const committed = this.log.committedMicros(Number.NEGATIVE_INFINITY, replay);
    const headroom: Headroom = {
      perCall: state.remaining.perCall,
      daily: state.remaining.daily,
      monthly: state.remaining.monthly,
      balance: state.balanceMicros,
      payeeCap: standing.capMicros,
      ceiling: micro(
        this.document.ceilingMicros > committed ? this.document.ceilingMicros - committed : 0n,
      ),
      documentDaily: windows.daily?.remainingMicros ?? null,
      documentMonthly: windows.monthly?.remainingMicros ?? null,
    };

    const context = { request, state, headroom, bounds, reconciliation };

    // Inside a guard of its own, because `previewSpend` is a chain read like the ones above and a
    // chain read that does not answer is a refusal, never an exception on its way out of this
    // service. Escaping here would leave the caller a 503 with no decision and no journal entry,
    // against this class's own rule that every path that cannot reach an answer refuses.
    let verdict: ChainVerdict;
    try {
      verdict = await this.#accountVerdict(request, state, merchant, capabilityId, blockNumber);
    } catch (error) {
      this.#reportUnreachable(request.requestId, error);
      return this.#quote(context, refuse(RefuseReason.ChainUnavailable), 'account', null);
    }

    if (verdict.kind === 'refuse') {
      return this.#quote(context, refuse(verdict.refusal.reason), 'account', verdict.refusal);
    }

    // After the account, because the mandate's own terms are what a principal came here to have
    // applied. Before the escrow, because the escrow's terms are ours and this one is not: a
    // refusal from here is the token issuer's, and no limit anybody sets on this side moves it.
    const asset = assetCondition(controls, { payer: this.account, payee: merchant });
    if (asset !== null) {
      return this.#quote(context, refuse(asset.reason), 'asset', null, false, asset);
    }

    const escrowReason = escrowPreflight({
      amountMicros: request.amountMicros,
      minLockMicros: terms.minLockMicros,
      balanceMicros: state.balanceMicros,
      standing,
      bounds,
      ...(request.deadline === undefined ? {} : { deadline: request.deadline }),
    });
    if (escrowReason !== null) return this.#quote(context, refuse(escrowReason), 'escrow', null);

    const documentDecision = evaluateDocument(this.document, this.log, request, replay);
    if (documentDecision.decision === 'refuse') {
      return this.#quote(context, documentDecision, 'document', null);
    }

    if (verdict.kind === 'hold') return this.#quote(context, hold(verdict.threshold), 'account', null);
    if (documentDecision.decision === 'hold') return this.#quote(context, documentDecision, 'document', null);

    if (this.#simulate) {
      // The facilitator asks whether a spend is permitted before it has chosen a deadline, so a
      // request without one is simulated against the earliest the escrow would take. Every revert
      // path other than the TTL behaves the same at any deadline inside the window.
      const deadline = request.deadline ?? bounds.earliest;
      const simulated = await this.#simulateSpend(request, state, merchant, capabilityId, deadline, blockNumber);
      if (simulated !== null) {
        if (simulated === 'unavailable') {
          return this.#refusal(request, RefuseReason.ChainUnavailable, 'simulation');
        }
        return this.#quote(context, refuse(simulated.reason), 'simulation', simulated, true);
      }
      return this.#quote(context, { decision: 'allow' }, 'account', null, true);
    }

    return this.#quote(context, { decision: 'allow' }, 'account', null);
  }

  /**
   * Decides a request and records the outcome, honouring a retry.
   *
   * A request id already on the log returns its recorded decision without reading the chain and
   * without appending a second entry. That is what makes a client retry safe: the decision is
   * the one that was taken, not a fresh one against limits that have since moved.
   *
   * The id alone does not earn that answer. The recorded decision is handed back only when the
   * spend presented matches the spend it was taken about, because the caller applies the verdict
   * to the request it sent: a replayed id carrying a larger amount and a different payee would
   * otherwise be paid against a decision no chain read, cap, window or approval ever saw. A replay
   * that changes any of those is refused and names the field that moved.
   */
  async authorize(spend: SpendRequest): Promise<Authorization> {
    assertRequest(spend);

    // Resolved before the journal is consulted, so the capability a replay is compared on is the
    // one the decision was taken against, whatever the caller happened to spell out.
    const request = resolveSpend(spend);

    const prior = this.log.decisionEntryFor(request.requestId);
    if (prior !== null && prior.body.kind === 'decision') {
      refuseReplay(prior.body, request);
      return { decision: prior.body.decision, entry: prior, idempotent: true, quote: null };
    }

    const quote = await this.quote(request);
    const { entry, idempotent } = this.log.buildDecision(
      {
        requestId: request.requestId,
        subject: request.subject,
        action: request.action,
        amountMicros: request.amountMicros,
        at: request.at,
        ...(request.merchant === undefined ? {} : { merchant: request.merchant }),
        ...(request.capabilityId === undefined ? {} : { capabilityId: request.capabilityId }),
        account: this.account,
        ...(quote.accountVersion === null ? {} : { accountVersion: quote.accountVersion }),
        documentHash: this.#documentHash,
      },
      quote.decision,
    );

    // Two calls sharing a request id both clear the guard above while the first is reading the
    // chain. The second gets the first one's entry back here, and appending it a second time
    // would write a duplicate line to the sink and then throw on `push`, leaving a journal that
    // no longer reloads.
    if (idempotent) {
      const body = entry.body;
      // Checked here too: the two calls got past the guard above together, so this is the first
      // moment the second one can be compared against what the first one recorded.
      if (body.kind === 'decision') refuseReplay(body, request);
      return {
        decision: body.kind === 'decision' ? body.decision : quote.decision,
        entry,
        idempotent: true,
        quote: null,
      };
    }

    await this.#sink.append(entry);
    this.log.push(entry);

    safeEmit(this.#onEvent, {
      type: 'decision',
      requestId: request.requestId,
      subject: request.subject,
      account: this.account,
      accountVersion: quote.accountVersion,
      decision: quote.decision,
      source: quote.source,
      bucket: quote.bucket,
      entryHash: entry.entry_hash,
      root: this.log.root(),
      at: request.at,
    });

    return { decision: quote.decision, entry, idempotent: false, quote };
  }

  /**
   * Resolves a held call. The hold is never rewritten; the resolution is a second entry.
   *
   * An approval is underwritten again before it is granted. A hold is a quote that was never
   * taken: while it waited, the account can have been paused, revoked or re-limited, the mandate
   * can have expired, the payee can have come off the allowlist and the balance can have gone. The
   * consent a principal gives is consent to the spend, not a standing instruction to pay whatever
   * the terms have since become, so the whole quote is re-run against the request body the hold
   * recorded and only the amount it reserved is carried over.
   *
   * An approval that no longer underwrites is recorded as a denial carrying the reason. The
   * alternative is a hold left open, and an open hold holds its reservation against the ceiling
   * and the rolling windows for as long as nobody resolves it.
   */
  async settle(
    heldRequestId: string,
    resolution: 'approve' | 'deny',
    at: string,
    merchantProof?: readonly Hex32[],
  ): Promise<{ entry: LogEntry; decision: Decision; quote: Quote | null }> {
    const reviewed = resolution === 'approve' ? await this.#reviewHold(heldRequestId, at, merchantProof) : null;
    const settled: 'approve' | 'deny' = reviewed !== null && reviewed.decision.decision !== 'allow' ? 'deny' : resolution;
    const reason = reviewed !== null && reviewed.decision.decision === 'refuse' ? reviewed.decision.reason : undefined;

    const entry = this.log.buildSettlement(heldRequestId, settled, at, reason);
    await this.#sink.append(entry);
    this.log.push(entry);

    safeEmit(this.#onEvent, {
      type: 'settlement',
      requestId: heldRequestId,
      resolution: settled,
      entryHash: entry.entry_hash,
      root: this.log.root(),
      at,
    });

    // A principal who declines is not a limit that ran out. Reporting the ceiling here would have
    // the facilitator record a breach of a limit nobody reached.
    if (settled === 'deny') {
      return {
        entry,
        decision: reviewed?.decision ?? refuse(RefuseReason.ApprovalDenied),
        quote: reviewed?.quote ?? null,
      };
    }

    return { entry, decision: { decision: 'allow' }, quote: reviewed?.quote ?? null };
  }

  /**
   * Records money the escrow gave back, so the ceiling and the rolling windows stop counting it.
   *
   * The underwriter appends it and nothing else does, for the same reason nothing else appends a
   * decision: the journal is one hash chain with one writer, and the reservation the lifetime
   * ceiling rests on is only a reservation while that stays true. What the underwriter cannot do
   * is see the credit happen, since `Escrow.timeout` and `Escrow.resolve` are called by whoever
   * notices the deadline. So the party watching the escrow reports it here, by the request id the
   * lock was opened for and the lock's own id, and this service reads that lock before it believes
   * a word of it: a refund credits the ceiling back, and a credit taken on the caller's word is a
   * ceiling anyone who can reach this route can reset.
   */
  async refund(
    spendRequestId: string,
    amountMicros: Micro,
    at: string,
    origin: RefundOrigin = {},
  ): Promise<{ entry: LogEntry; refundedMicros: Micro; remainingMicros: Micro }> {
    const escrowId = await this.#confirmRefund(amountMicros, origin.escrowId);

    const entry = this.log.buildRefund(spendRequestId, amountMicros, at, { ...origin, escrowId });
    await this.#sink.append(entry);
    this.log.push(entry);

    return {
      entry,
      refundedMicros: amountMicros,
      remainingMicros: this.log.refundableMicros(spendRequestId) ?? ZERO_MICRO,
    };
  }

  /**
   * Establishes, from the escrow, that the lock a refund names gave this account its money back.
   * Anything it cannot establish is a refusal. Returns the lock id in the form the journal keeps.
   */
  async #confirmRefund(amountMicros: Micro, rawEscrowId: string | undefined): Promise<string> {
    if (rawEscrowId === undefined || !/^\d+$/.test(rawEscrowId)) {
      throw new RequestError(
        'escrowId is required: it is the escrow lock the refund came from, as a decimal string, and the refund is checked against that lock on chain',
        { field: 'escrowId' },
      );
    }
    const id = BigInt(rawEscrowId);
    const escrowId = id.toString(10);

    for (const recorded of this.log.entries) {
      if (recorded.body.kind === 'refund' && recorded.body.escrow_id === escrowId) {
        throw new LogError('log_not_refundable', `escrow lock ${escrowId} has already been recorded as a refund`, {
          escrowId,
        });
      }
    }

    const readLock = this.#chain.readEscrowLock;
    if (readLock === undefined) {
      throw new LogError(
        'log_not_refundable',
        'this underwriter has no way to read an escrow lock, so it cannot check the refund against the chain',
        { escrowId },
      );
    }

    const state = await this.#chain.readAccount(this.account);
    const lock = await readLock.call(this.#chain, state.escrow, id);

    const status = ESCROW_REFUNDED_STATUSES.get(lock.status);
    if (status === undefined) {
      throw new LogError(
        'log_not_refundable',
        `escrow lock ${escrowId} has not returned anything to its payer: only a lock that timed out, was cancelled or was resolved has`,
        { escrowId, status: lock.status },
      );
    }
    if (lock.payer.toLowerCase() !== this.account.toLowerCase()) {
      throw new LogError(
        'log_not_refundable',
        `escrow lock ${escrowId} was paid for by ${lock.payer}, not by ${this.account}, so nothing it returned belongs to this journal`,
        { escrowId },
      );
    }
    if (amountMicros > lock.amountMicros) {
      throw new LogError(
        'log_not_refundable',
        `escrow lock ${escrowId} held ${lock.amountMicros} micro-USD and the refund claims ${amountMicros}`,
        { escrowId, claimed: amountMicros.toString(10) },
      );
    }

    return escrowId;
  }

  /**
   * Re-prices a held call at the moment it is approved.
   *
   * The recorded body is the request; only `at` moves, to the settlement's own timestamp, because
   * every window and the validity check are measured against it and the chain will not accept a
   * clock a day behind its own. The hold's reservation is replayed as released so the amount is
   * measured once, not twice.
   *
   * The merchant proof is not on the journal, because the entry hash would move if it were, so an
   * account behind a Merkle gate needs it presented again with the approval. Without it the gate
   * cannot be decided and the approval is refused, as the first decision would have been.
   */
  async #reviewHold(
    heldRequestId: string,
    at: string,
    merchantProof: readonly Hex32[] | undefined,
  ): Promise<{ decision: Decision; quote: Quote | null }> {
    const prior = this.log.decisionEntryFor(heldRequestId);
    if (prior === null || prior.body.kind !== 'decision' || prior.body.decision.decision !== 'hold') {
      // The fault `buildSettlement` raises, word for word, so "that id is not a held call" has one
      // answer whichever check reaches it first.
      throw new LogError(
        'log_not_held',
        `${heldRequestId} names no held call, so there is nothing to approve. GET /v1/journal/{subject} shows which decisions are holds.`,
        { requestId: heldRequestId },
      );
    }

    const body = prior.body;
    const ageSeconds = Math.floor((Date.parse(at) - Date.parse(body.at)) / 1000);
    if (ageSeconds > this.#holdExpirySeconds) {
      return { decision: refuse(RefuseReason.HoldExpired), quote: null };
    }

    if (body.merchant === undefined || body.capability_id === undefined) {
      // A hold from a journal written before either was recorded. The payee and the capability are
      // what the account's gates and the escrow's cap are read against, so there is no way to
      // underwrite it again, and paying out on a check nobody can run is the one answer this
      // service does not give.
      return { decision: refuse(RefuseReason.MerchantGateUndecidable), quote: null };
    }

    const request: SpendRequest = {
      requestId: body.request_id,
      subject: body.subject,
      action: body.action,
      amountMicros: body.amount_micros,
      at,
      merchant: body.merchant,
      capabilityId: body.capability_id,
      ...(merchantProof === undefined ? {} : { merchantProof }),
    };

    const quote = await this.quote(request, { released: heldRequestId });

    // A second hold means the threshold still binds, which it does: this is the call the principal
    // has just consented to. Only a refusal stops the approval.
    return { decision: quote.decision.decision === 'refuse' ? quote.decision : { decision: 'allow' }, quote };
  }

  #reportUnreachable(requestId: string, error: unknown): void {
    safeEmit(this.#onEvent, {
      type: 'chain_unavailable',
      requestId,
      account: this.account,
      reason: RefuseReason.ChainUnavailable,
      detail: isBursarError(error) ? error.message : String(error),
    });
  }

  #bindingRefusal(request: SpendRequest): RefuseReason | null {
    // Above uint128 the amount cannot be encoded for the account, let alone fit a cap.
    if (request.amountMicros > MAX_AMOUNT_MICROS) return RefuseReason.OverPerCallCap;
    if (request.amountMicros === ZERO_MICRO) return RefuseReason.ZeroAmount;
    if (request.subject !== this.document.subject) return RefuseReason.WrongSubject;
    if (this.document.account !== null && this.document.account.toLowerCase() !== this.account.toLowerCase()) {
      return RefuseReason.DocumentAccountMismatch;
    }
    if (this.document.chainId !== null && this.document.chainId !== this.chainId) {
      return RefuseReason.DocumentAccountMismatch;
    }
    return null;
  }

  /**
   * Reads the account's own verdict and closes the one term it cannot answer.
   *
   * `MandateAccount._reason` evaluates the merchant gate second to last, after every cap and
   * before the approval threshold. So `MerkleGateActive` carries more than a refusal to answer:
   * it says every check before the merchant passed. Verifying the proof against the root the
   * account reports and then applying the account's own threshold reproduces the rest of that
   * function exactly. The documented `previewSpend` gap becomes a real answer.
   */
  async #accountVerdict(
    request: SpendRequest,
    state: AccountState,
    merchant: Address,
    capabilityId: Hex32,
    blockNumber: bigint | undefined,
  ): Promise<ChainVerdict> {
    const preview = await this.#chain.previewSpend(
      this.account,
      merchant,
      capabilityId,
      request.amountMicros,
      blockNumber,
      spendClassOf(request),
    );

    if (preview.allowed) return { kind: 'allow' };
    if (isApprovalRequired(preview.selector)) {
      return { kind: 'hold', threshold: state.limits.approvalThresholdMicros };
    }

    if (isMerkleGateActive(preview.selector)) {
      if (state.merchantGate.kind !== 'merkleRoot') {
        return { kind: 'refuse', refusal: accountRefusal(preview.selector) };
      }
      const proof = request.merchantProof;
      if (proof === undefined) return { kind: 'refuse', refusal: accountRefusal(preview.selector) };
      if (!verifyMerchantProof(state.merchantGate.root, merchant, proof)) {
        // The selector the account would have used had it been given the proof.
        return { kind: 'refuse', refusal: accountRefusal(errorSelector('BadMerkleProof')) };
      }
      return request.amountMicros >= state.limits.approvalThresholdMicros
        ? { kind: 'hold', threshold: state.limits.approvalThresholdMicros }
        : { kind: 'allow' };
    }

    return { kind: 'refuse', refusal: accountRefusal(preview.selector) };
  }

  async #simulateSpend(
    request: SpendRequest,
    state: AccountState,
    merchant: Address,
    capabilityId: Hex32,
    deadline: bigint,
    blockNumber: bigint | undefined,
  ): Promise<ChainRefusal | 'unavailable' | null> {
    try {
      const result = await this.#chain.simulateSpend({
        account: this.account,
        agent: state.agent,
        merchant,
        capabilityId,
        // The lock's input is the payer's business and moves no check `spend` runs.
        inputCommit: ZERO_BYTES32,
        inputURI: '',
        amountMicros: request.amountMicros,
        deadline,
        merchantProof: request.merchantProof ?? [],
        spendClass: spendClassOf(request),
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
      return result.ok ? null : spendRefusal(result.selector ?? '0x00000000');
    } catch (error) {
      if (error instanceof ChainUnavailableError) return 'unavailable';
      throw error;
    }
  }

  #refusal(request: SpendRequest, reason: RefuseReason, source: DecisionSource): Quote {
    return {
      requestId: request.requestId,
      decision: refuse(reason),
      source,
      bucket: bucketFor(reason),
      account: this.account,
      accountVersion: null,
      documentHash: this.#documentHash,
      headroom: null,
      deadline: null,
      anchor: null,
      divergences: [],
      enforcement: ENFORCEMENT,
      chainRefusal: null,
      assetCondition: null,
      simulated: false,
    };
  }

  #quote(
    context: {
      request: SpendRequest;
      state: AccountState;
      headroom: Headroom;
      bounds: DeadlineBounds;
      reconciliation: ReturnType<typeof reconcile>;
    },
    decision: Decision,
    source: DecisionSource,
    chainRefusal: ChainRefusal | null,
    simulated = false,
    asset: AssetCondition | null = null,
  ): Quote {
    return {
      requestId: context.request.requestId,
      decision,
      source,
      bucket: decision.decision === 'refuse' ? bucketFor(decision.reason) : null,
      account: this.account,
      accountVersion: context.state.version,
      documentHash: this.#documentHash,
      headroom: context.headroom,
      deadline: context.bounds,
      anchor: context.reconciliation.anchor,
      divergences: context.reconciliation.divergences,
      enforcement: ENFORCEMENT,
      chainRefusal,
      assetCondition: asset,
      simulated,
    };
  }
}
