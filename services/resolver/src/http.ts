import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { isBursarError } from '@bursar/core';
import { encodeEvidence, parseEvidence, verifyEvidence } from '@bursar/sdk';
import { getAddress, isAddressEqual } from 'viem';
import type { Address } from 'viem';

import { LockStatus } from './chain.js';
import type { ChainPort } from './chain.js';
import type { Served } from './config.js';
import { evidenceHash, isOperatorParty } from './evidence.js';
import type { DisputeRecord, Journal } from './journal.js';
import { describeError } from './log.js';
import type { Logger } from './log.js';
import { POLICY_VERSION, isRulingScore } from './policy.js';
import { timeline } from './schedule.js';
import type { Voter } from './voter.js';
import type { Health } from './watcher.js';

/** A signed delivery with its output inline fits comfortably. Anything bigger belongs at a URL. */
export const MAX_BODY_BYTES = 64 * 1_024;

/** Per dispute. Only a party can sign one, so this bounds a party, not the public. */
export const MAX_SUBMISSIONS = 32;

const MAX_REASON_CHARS = 2_000;

/** Said on every publication, because it is the first thing a reader of a ruling should know (D-1). */
export const OPERATED_BY =
  'All three bonded resolvers on this registry are operated by Bursar. The ruling follows the published policy, and every input it counted is listed here.';

export type HttpOptions = {
  readonly chain: ChainPort;
  readonly journal: Journal;
  readonly voter: Voter;
  readonly served: readonly Served[];
  readonly chainId: number;
  readonly operatorToken: string | null;
  readonly operatorAddresses: readonly Address[] | null;
  readonly health: () => Health;
  readonly pollMs: number;
  readonly logger: Logger;
  readonly now?: () => number;
};

type Reply = { readonly status: number; readonly body: unknown };

const reply = (status: number, body: unknown): Reply => ({ status, body });
const refuse = (status: number, error: string, detail: string): Reply => ({ status, body: { error, detail } });

export function createHandler(options: HttpOptions): (request: { method: string; path: string; query: URLSearchParams; body: unknown; token: string | null }) => Promise<Reply> {
  const { chain, journal, voter } = options;
  const now = options.now ?? (() => Date.now());

  function servedFor(escrow: Address): Served | undefined {
    return options.served.find((entry) => isAddressEqual(entry.escrow, escrow));
  }

  function servedByRegistry(raw: string | null): Served | undefined {
    if (raw === null) return options.served[0];
    try {
      const registry = getAddress(raw);
      return options.served.find((entry) => entry.registry === registry);
    } catch {
      return undefined;
    }
  }

  async function evidence(body: unknown): Promise<Reply> {
    let submission;
    try {
      submission = parseEvidence(body);
    } catch (error) {
      return refuse(400, 'evidence_invalid', describeError(error));
    }

    if (submission.chainId !== options.chainId) {
      return refuse(400, 'wrong_chain', `This service rules on chain ${options.chainId}, and the evidence was signed for ${submission.chainId}.`);
    }
    const served = servedFor(submission.escrow);
    if (served === undefined) return refuse(404, 'escrow_not_served', `No registry this service votes on rules for escrow ${submission.escrow}.`);

    const escrowId = submission.kind === 'delivery' ? submission.evidence.escrowId : submission.statement.escrowId;
    const lock = await chain.lock(served.escrow, escrowId);
    if (lock.status !== LockStatus.Disputed || lock.releasedAt !== 0n) {
      return refuse(409, 'not_in_dispute', `Lock ${escrowId} is not held in dispute, so there is no ruling for this evidence to reach.`);
    }

    const signer = submission.kind === 'delivery' ? lock.payee : lock.payer;
    if (!(await verifyEvidence(submission, signer))) {
      return refuse(
        403,
        'wrong_signer',
        submission.kind === 'delivery'
          ? `Delivery evidence has to be signed by the payee on the lock, ${lock.payee}.`
          : `A payer statement has to be signed by the payer on the lock, ${lock.payer}.`,
      );
    }

    const disputeId = await chain.disputeIdOf(served.registry, escrowId);
    if (disputeId === 0n) return refuse(409, 'no_dispute', `Lock ${escrowId} has no dispute on the registry.`);

    const record = await voter.open(served, disputeId);
    const head = await chain.head();
    const cutoff = timeline(record).evidenceCutoff;
    const hash = evidenceHash(submission);

    let full = false;
    await journal.update(served.registry, disputeId, (current) => {
      if (current === undefined) return undefined;
      if (current.submissions.some((entry) => entry.hash === hash)) return undefined;
      if (current.submissions.length >= MAX_SUBMISSIONS) {
        full = true;
        return undefined;
      }
      return {
        ...current,
        submissions: [...current.submissions, { receivedAt: head.timestamp, hash, signer, wire: encodeEvidence(submission) }],
      };
    });
    if (full) return refuse(409, 'inbox_full', `Dispute ${disputeId} already holds ${MAX_SUBMISSIONS} submissions.`);

    return reply(202, {
      accepted: true,
      disputeId: disputeId.toString(),
      hash,
      // Evidence after the cutoff is kept and published and does not move the score.
      counted: submission.kind === 'delivery' && head.timestamp <= cutoff,
      cutoff: iso(cutoff),
    });
  }

  async function override(body: unknown, token: string | null): Promise<Reply> {
    if (options.operatorToken === null) return refuse(403, 'overrides_disabled', 'RESOLVER_OPERATOR_TOKEN is not set, so this service takes no overrides.');
    if (token === null || !tokenMatches(token, options.operatorToken)) return refuse(401, 'unauthorized', 'Send the operator token as Authorization: Bearer <token>.');
    if (options.operatorAddresses === null) {
      return refuse(403, 'overrides_disabled', 'RESOLVER_OPERATOR_ADDRESSES is not set, so this service cannot tell which disputes the operator is party to, and takes no overrides.');
    }

    const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const rawId = input['disputeId'];
    const score = input['score'];
    const reason = typeof input['reason'] === 'string' ? input['reason'].trim() : '';
    if (typeof rawId !== 'string' || !/^\d{1,20}$/.test(rawId)) return refuse(400, 'dispute_invalid', 'disputeId is a decimal string.');
    if (!isRulingScore(score)) return refuse(400, 'score_invalid', 'An override score is one of 0, 60, 72 or 90.');
    if (reason === '' || reason.length > MAX_REASON_CHARS) return refuse(400, 'reason_invalid', `An override carries a written reason of up to ${MAX_REASON_CHARS} characters.`);

    const served = servedByRegistry(typeof input['registry'] === 'string' ? input['registry'] : null);
    if (served === undefined) return refuse(404, 'registry_not_served', 'This service does not vote on that registry.');

    const disputeId = BigInt(rawId);
    const record = await voter.open(served, disputeId);
    const head = await chain.head();
    const cutoff = timeline(record).evidenceCutoff;
    if (head.timestamp > cutoff) return refuse(409, 'after_cutoff', `The evidence cutoff for dispute ${disputeId} passed at ${iso(cutoff)}.`);

    const lock = await chain.lock(served.escrow, record.escrowId);
    if (isOperatorParty(lock, options.operatorAddresses)) {
      return refuse(409, 'operator_party', 'The operator is a party to this dispute, so it cannot overrule it. The dispute is ruled by P0 to P5.');
    }

    await journal.update(served.registry, disputeId, (current) =>
      current === undefined ? undefined : { ...current, overrides: [...current.overrides, { receivedAt: head.timestamp, score, reason }] },
    );
    options.logger.warn('override_received', { disputeId, score, reason });
    return reply(202, { accepted: true, disputeId: rawId, score });
  }

  async function ruling(id: string, registry: string | null): Promise<Reply> {
    if (!/^\d{1,20}$/.test(id)) return refuse(400, 'dispute_invalid', 'A dispute id is a whole number.');
    const served = servedByRegistry(registry);
    if (served === undefined) return refuse(404, 'registry_not_served', 'This service does not vote on that registry.');

    const record = await journal.get(served.registry, BigInt(id));
    if (record === undefined) return refuse(404, 'unknown', `This service holds no record of dispute ${id}.`);
    if (!record.published) {
      // The commit is sealed on chain. Saying what it seals would hand a score to anyone watching.
      return reply(200, { status: 'sealed', disputeId: id, registry: served.registry, revealsFrom: iso(record.commitEndsAt), operatedBy: OPERATED_BY });
    }
    return reply(200, publication(record));
  }

  function health(): Reply {
    const state = options.health();
    const stale = state.lastPollAt === null || now() - state.lastPollAt > options.pollMs * 3;
    return reply(stale ? 503 : 200, {
      status: stale ? 'stale' : 'ok',
      lastPollAt: state.lastPollAt === null ? null : new Date(state.lastPollAt).toISOString(),
      lastError: state.lastError,
      openDisputes: state.open,
      served: state.served.map((entry) => ({
        name: entry.name,
        contractSet: entry.contractSet,
        registry: entry.registry,
        escrow: entry.escrow,
        lastScannedBlock: entry.lastScannedBlock === null ? null : entry.lastScannedBlock.toString(),
        openDisputes: entry.open,
      })),
      policyVersion: POLICY_VERSION,
    });
  }

  return async ({ method, path, query, body, token }) => {
    if (method === 'GET' && path === '/health') return health();
    if (method === 'POST' && path === '/evidence') return evidence(body);
    if (method === 'POST' && path === '/override') return override(body, token);

    const match = /^\/rulings\/([^/]+)$/.exec(path);
    if (method === 'GET' && match?.[1] !== undefined) return ruling(match[1], query.get('registry'));

    return refuse(404, 'not_found', 'Routes: GET /health, POST /evidence, POST /override, GET /rulings/:disputeId.');
  };
}

/** What a published ruling says. Every figure a reader might check is here and nothing sealed is. */
export function publication(record: DisputeRecord): Record<string, unknown> {
  const ruling = record.ruling;
  const revealed = record.votes.filter((vote) => vote.revealTx !== null);
  const scores = [...new Set(revealed.map((vote) => vote.score))];
  // Normally one score, the ruling's. After a restart that lost the journal the committed score is
  // the one revealed, and the publication says so rather than showing a ruling it cannot vouch for.
  const note =
    ruling === null
      ? 'This service lost its ruling record for this dispute and revealed the score it had sealed, recovered from the chain.'
      : ruling.score !== null && scores.some((score) => score !== ruling.score)
        ? 'The revealed score differs from the recorded ruling. The revealed score is what the registry counted.'
        : null;

  return {
    status: 'published',
    disputeId: record.disputeId.toString(),
    registry: record.registry,
    escrow: record.escrow,
    escrowId: record.escrowId.toString(),
    policyVersion: ruling?.policyVersion ?? POLICY_VERSION,
    rule: ruling?.ruleId ?? null,
    score: scores.length === 1 ? scores[0] : (ruling?.score ?? null),
    reasons: ruling?.reasons ?? [],
    operatorParty: record.snapshot?.operatorParty ?? false,
    snapshotBlock: record.snapshot?.block.toString() ?? null,
    inputHash: record.snapshot?.inputHash ?? null,
    evidenceHashes: ruling?.evidenceHashes ?? [],
    evidence: record.submissions.map((entry) => ({
      hash: entry.hash,
      kind: entry.wire.kind,
      signer: entry.signer,
      receivedAt: iso(entry.receivedAt),
      counted: ruling !== null && ruling.evidenceHashes.includes(entry.hash),
      ...(entry.wire.kind === 'payer-statement' ? { statement: entry.wire.statement.reason } : { outputURI: entry.wire.evidence.outputURI }),
    })),
    votes: record.votes.map((vote) => ({ resolver: vote.address, key: vote.key, score: vote.revealTx === null ? null : vote.score, commitTx: vote.commitTx, revealTx: vote.revealTx })),
    outcome:
      record.outcome === null
        ? null
        : { status: record.outcome.status, medianScore: record.outcome.medianScore, refundBps: record.outcome.refundBps, finalizeTx: record.finalizeTx },
    note,
    operatedBy: OPERATED_BY,
  };
}

function iso(seconds: bigint): string {
  return new Date(Number(seconds) * 1_000).toISOString();
}

/** Constant time, so the response time says nothing about how much of a guess was right. */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

export type RunningServer = { readonly port: number; close(): Promise<void> };

export function serve(
  handle: ReturnType<typeof createHandler>,
  options: { readonly host: string; readonly port: number; readonly logger: Logger },
): Promise<RunningServer> {
  const server: Server = createServer((incoming, outgoing) => {
    void respond(handle, incoming, outgoing, options.logger);
  });
  // A client that opens a connection and sends nothing holds a socket until these expire.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeIdleConnections();
          }),
      });
    });
  });
}

async function respond(
  handle: ReturnType<typeof createHandler>,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  logger: Logger,
): Promise<void> {
  let result: Reply;
  try {
    const url = new URL(incoming.url ?? '/', 'http://resolver');
    const body = incoming.method === 'POST' ? await readBody(incoming) : undefined;
    if (body === TOO_LARGE) {
      result = refuse(413, 'too_large', `A request body is at most ${MAX_BODY_BYTES} bytes.`);
    } else if (body === NOT_JSON) {
      result = refuse(400, 'not_json', 'The request body is not JSON.');
    } else {
      result = await handle({
        method: incoming.method ?? 'GET',
        path: url.pathname.replace(/\/+$/, '') || '/',
        query: url.searchParams,
        body,
        token: bearer(incoming.headers['authorization']),
      });
    }
  } catch (error) {
    logger.error('http_failed', { path: incoming.url ?? '', reason: describeError(error) });
    result = refuse(isBursarError(error) ? 502 : 500, 'internal', 'The request could not be completed. Nothing was recorded.');
  }

  const payload = JSON.stringify(result.body, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  outgoing.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  outgoing.end(payload);
}

const TOO_LARGE = Symbol('too-large');
const NOT_JSON = Symbol('not-json');

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      request.pause();
      return TOO_LARGE;
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function bearer(header: string | undefined): string | null {
  if (header === undefined || !header.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim();
}

