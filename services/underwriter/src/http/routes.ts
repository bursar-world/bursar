import { isBursarError, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';

import type { Address, Hex32 } from '../document.js';
import { InvalidRequest, RequestError } from '../errors.js';
import type { RequestProblem } from '../errors.js';
import type { SpendRequest } from '../policy.js';
import type { MandateRegistry } from '../registry.js';
import { type ApiRequest, type ApiResponse, failure, ok } from './io.js';

/*
 * The route table, as a function from request to response.
 *
 * No sockets and no framework, so every route is exercised by calling this with an object and the
 * server is left with nothing to do but adapt one shape to the other.
 *
 * Health and readiness are separate questions. `/healthz` says the process is up and serving,
 * which is what a supervisor restarts on. `/readyz` says this process can take a decision right
 * now: it holds the journals it claimed, it has at least one mandate bound, and the chain answered.
 * Collapsing them would have an orchestrator restart a process whose only problem is an RPC
 * endpoint, and route traffic to one that has no mandate to decide against.
 */

export type Readiness = {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, unknown>>;
};

export type RouterOptions = {
  readonly registry: MandateRegistry;
  readonly describe: () => Readonly<Record<string, unknown>>;
  readonly ready: () => Promise<Readiness>;
};

export type Router = (request: ApiRequest) => Promise<ApiResponse>;

type Route = {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handle: (request: ApiRequest, params: readonly string[]) => Promise<ApiResponse>;
};

export function createRouter(options: RouterOptions): Router {
  const { registry } = options;

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/healthz$/,
      handle: async () => ok({ status: 'ok', mandates: registry.subjects().length, ...options.describe() }),
    },

    {
      method: 'GET',
      pattern: /^\/readyz$/,
      handle: async () => {
        const readiness = await options.ready();
        return { status: readiness.ready ? 200 : 503, body: { ready: readiness.ready, ...readiness.checks } };
      },
    },

    {
      method: 'GET',
      pattern: /^\/v1\/mandates$/,
      handle: async () => ok({ source: registry.source, mandates: registry.mandates() }),
    },

    {
      method: 'GET',
      pattern: /^\/v1\/mandates\/([^/]+)$/,
      handle: async (_request, [subject]) => {
        const wanted = pathSegment(subject, 'subject');
        const mandate = registry.mandates().find((entry) => entry.subject === wanted);
        return mandate ? ok(mandate) : notBound(wanted);
      },
    },

    {
      method: 'POST',
      pattern: /^\/v1\/underwrite$/,
      handle: async (request) => {
        const fields = new Fields(request.body);
        const subject = fields.text('subject');
        const spend = spendRequest(fields, subject);
        const result = await registry.authorize(spend.subject, spend);
        return result === null ? notBound(spend.subject) : ok(result);
      },
    },

    {
      method: 'POST',
      pattern: /^\/v1\/settlements$/,
      handle: async (request) => {
        const fields = new Fields(request.body);
        const subject = fields.text('subject');
        const requestId = fields.text('requestId');
        const resolution = fields.oneOf('resolution', ['approve', 'deny'] as const);
        const at = fields.optionalText('at');
        const proof = fields.merkleProof('merchantProof');

        fields.check();
        if (subject === undefined || requestId === undefined || resolution === undefined) {
          throw new InvalidRequest(fields.problems);
        }

        const result = await registry.settle(subject, requestId, resolution, at ?? new Date().toISOString(), proof);
        return result === null ? notBound(subject) : ok(result);
      },
    },

    {
      /**
       * Records money the escrow gave back, against the decision that spent it.
       *
       * The escrow is what refunds: `timeout` returns a lock's amount to the payer and `resolve`
       * can return part of one, and both credit the MandateAccount's own buckets. This service
       * cannot see either happen, so whoever watches the escrow reports it here by the request id
       * the lock was opened for and the lock's id. Without it the rolling windows and the lifetime
       * ceiling this service applies keep counting a payment the chain has already undone.
       *
       * `escrowId` is required and the lock is read before anything is recorded; see
       * `Underwriter.refund`.
       */
      method: 'POST',
      pattern: /^\/v1\/refunds$/,
      handle: async (request) => {
        const fields = new Fields(request.body);
        const subject = fields.text('subject');
        const requestId = fields.text('requestId');
        const amountMicros = fields.micro('amountMicro', 'amountMicros');
        const at = fields.optionalText('at');
        const escrowId = fields.text('escrowId');
        const txHash = fields.hex('txHash', 32);

        fields.check();
        if (subject === undefined || requestId === undefined || amountMicros === undefined || escrowId === undefined) {
          throw new InvalidRequest(fields.problems);
        }

        const result = await registry.refund(subject, requestId, amountMicros, at ?? new Date().toISOString(), {
          escrowId,
          ...(txHash === undefined ? {} : { txHash }),
        });
        return result === null ? notBound(subject) : ok(result);
      },
    },

    {
      /**
       * The journal, so the facilitator's `bursar_authorizations` can be reconciled against the
       * record the decisions were taken on. Every entry carries its own hash and the
       * chain recomputes from the genesis hash, so a reader needs nothing from this process
       * beyond the bytes.
       *
       * Paged, because a journal only grows and a route that hands the whole of one back is a
       * request that gets slower every day it runs. `from` is a sequence number and `nextFrom` in
       * the answer is the one to ask for next; `intact` is the verdict on the whole chain, not on
       * the page.
       */
      method: 'GET',
      pattern: /^\/v1\/journal\/([^/]+)$/,
      handle: async (request, [subject]) => {
        const wanted = pathSegment(subject, 'subject');
        const from = wholeNumber(request.query, 'from');
        const limit = wholeNumber(request.query, 'limit');
        const view = registry.journal(wanted, {
          ...(from === undefined ? {} : { from }),
          ...(limit === undefined ? {} : { limit }),
        });
        return view ? ok(view) : notBound(wanted);
      },
    },
  ];

  return async (request) => {
    const answers = new Set<string>();
    for (const route of routes) {
      const match = route.pattern.exec(request.path);
      if (!match) continue;
      if (route.method !== request.method) {
        answers.add(route.method);
        continue;
      }
      return route.handle(request, match.slice(1));
    }

    if (answers.size > 0) {
      return failure(
        405,
        'method_not_allowed',
        `${request.path} answers ${[...answers].sort().join(' and ')}, not ${request.method}.`,
      );
    }
    return failure(404, 'not_found', `${request.method} ${request.path} is not a route on this underwriter.`);
  };
}

function notBound(subject: string): ApiResponse {
  return failure(
    404,
    'no_mandate_for_subject',
    `No mandate here names the subject ${subject}. GET /v1/mandates lists the subjects this process speaks for.`,
  );
}

/**
 * A path segment, decoded.
 *
 * `decodeURIComponent` throws on a stray percent sign, and a URI nobody can read is a request
 * problem, not a fault in this service. Left to escape it reaches the server's catch-all as an
 * ordinary error and is answered with a 500, which tells a caller to retry something no retry
 * will fix.
 */
function pathSegment(raw: string | undefined, field: string): string {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    throw new RequestError(`The ${field} in the path is not valid percent-encoding.`, { field });
  }
}

/** A whole number from the query string, or nothing. Anything else is refused by name. */
function wholeNumber(query: URLSearchParams, field: string): number | undefined {
  const raw = query.get(field);
  if (raw === null || raw.trim() === '') return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw new InvalidRequest([{ field, reason: `"${raw}"`, expected: 'a whole number' }]);
  }
  return Number(raw.trim());
}

/**
 * The detail keys a caller is allowed to see.
 *
 * `details` is written for whoever made the request and travels over HTTP. The same objects carry
 * things written for an operator reading this service's own log: the path a journal file is on,
 * the host and process id holding a claim, how many connections a pool opens. None of that helps
 * the caller and all of it describes the inside of a machine they are not on, so the list is
 * explicit and anything not on it stays here.
 */
const PUBLIC_DETAILS: ReadonlySet<string> = new Set([
  'problems',
  'field',
  'action',
  'requestId',
  'subject',
  'account',
  'at',
  'chainSeconds',
  'driftSeconds',
  'recorded',
  'presented',
  'refundable',
  'claimed',
  'escrowId',
  'status',
  'expected',
  'index',
]);

function publicDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (PUBLIC_DETAILS.has(key)) shown[key] = value;
  }
  return Object.keys(shown).length === 0 ? undefined : shown;
}

/**
 * The conditions whose message is written for an operator, not the caller.
 *
 * A journal that is held names the host and process holding it; a broken one names the file it is
 * in and how far it replayed; an exhausted pool names its size and the variable that moves it. All
 * of that is for the log, where the server writes it, and the caller gets the condition in one
 * fixed sentence under the same code.
 */
const OPERATOR_FACING: Readonly<Record<string, string>> = {
  underwriter_journal_held: 'This underwriter does not hold the spend journal for this account, so it takes no decision for it.',
  log_broken: 'The spend journal for this account could not be read or written. Nothing was recorded.',
  underwriter_database_pool_exhausted: 'This underwriter cannot open another spend journal right now.',
};

/** Whether the caller was given a fixed sentence in place of the message, which then belongs in the log. */
export function operatorFacing(error: unknown): boolean {
  return isBursarError(error) && error.code in OPERATOR_FACING;
}

/** Turns a thrown error into the status and code a caller can act on. */
export function errorResponse(error: unknown): ApiResponse {
  if (!isBursarError(error)) return { status: 500, body: { error: 'internal_error' } };

  const status = STATUS[error.code] ?? 409;
  const details = publicDetails(error.details);
  const detail = OPERATOR_FACING[error.code] ?? error.message;
  return { status, body: { error: error.code, detail, ...(details === undefined ? {} : { details }) } };
}

const STATUS: Readonly<Record<string, number>> = {
  underwriter_request_invalid: 400,
  underwriter_body_too_large: 413,
  underwriter_document_invalid: 422,
  underwriter_journal_held: 409,
  underwriter_request_replayed: 409,
  underwriter_chain_unavailable: 503,
  underwriter_database_pool_exhausted: 500,
  log_out_of_order: 409,
  log_not_held: 409,
  log_already_settled: 409,
  log_not_refundable: 409,
  log_broken: 500,
};

/**
 * A body being read, collecting everything wrong with it in one pass.
 *
 * Each reader returns `undefined` for a field it could not read and records why. Nothing is used
 * until `check` has run, and `check` throws when anything was recorded, so the undefined never
 * reaches a decision.
 */
class Fields {
  readonly #body: Record<string, unknown>;
  readonly #problems: RequestProblem[] = [];

  constructor(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new RequestError('The request body must be a JSON object.');
    }
    this.#body = body as Record<string, unknown>;
  }

  get problems(): readonly RequestProblem[] {
    return this.#problems;
  }

  /** Throws with every problem at once. Call before reading anything a decision depends on. */
  check(): void {
    if (this.#problems.length > 0) throw new InvalidRequest(this.#problems);
  }

  text(field: string): string | undefined {
    const value = this.#body[field];
    if (value === undefined || value === null) return this.#missing(field, 'a non-empty string');
    if (typeof value !== 'string' || value.trim() === '') {
      return this.#wrong(field, typeName(value), 'a non-empty string');
    }
    return value.trim();
  }

  optionalText(field: string): string | undefined {
    const value = this.#body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return this.#wrong(field, typeName(value), 'a string');
    return value.trim() || undefined;
  }

  oneOf<T extends string>(field: string, allowed: readonly T[]): T | undefined {
    const value = this.text(field);
    if (value === undefined) return undefined;
    if (!allowed.includes(value as T)) return this.#wrong(field, `"${value}"`, `one of ${allowed.join(', ')}`);
    return value as T;
  }

  /**
   * Money, as atomic micro-USD in a string.
   *
   * A JSON number is a double, so anything above nine billion micro-USD has already lost precision
   * by the time it arrives. A number is rejected with a message that says why.
   */
  micro(field: string, alias?: string): Micro | undefined {
    const name = alias !== undefined && this.#body[field] === undefined ? alias : field;
    const value = this.#body[name];
    if (value === undefined || value === null) {
      return this.#missing(field, 'a decimal string of atomic micro-USD, for example "1500000"');
    }
    if (typeof value !== 'string') {
      return this.#wrong(
        name,
        typeName(value),
        'a decimal string of atomic micro-USD; a JSON number is a double and cannot hold one exactly',
      );
    }
    try {
      return toMicro(value);
    } catch {
      return this.#wrong(name, `"${value}"`, 'a whole number of micro-USD');
    }
  }

  hex(field: string, bytes: 20 | 32, presence: 'required' | 'optional' = 'optional'): `0x${string}` | undefined {
    const value = this.optionalText(field);
    const expected = `a ${bytes}-byte hex value, 0x and ${bytes * 2} hex digits`;
    if (value === undefined) return presence === 'required' ? this.#missing(field, expected) : undefined;
    if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
      return this.#wrong(field, `"${value}"`, expected);
    }
    return value as `0x${string}`;
  }

  /** A unix second, as a string, for the same reason amounts are strings. */
  seconds(field: string): bigint | undefined {
    const value = this.optionalText(field);
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) return this.#wrong(field, `"${value}"`, 'a whole number of unix seconds, as a string');
    return BigInt(value);
  }

  merkleProof(field: string): readonly Hex32[] | undefined {
    const value = this.#body[field];
    if (value === undefined || value === null) return undefined;
    const expected = 'an array of 32-byte hex values';
    if (!Array.isArray(value)) return this.#wrong(field, typeName(value), expected);
    if (value.some((node) => typeof node !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(node))) {
      return this.#wrong(field, 'an array with a value that is not 32 bytes of hex', expected);
    }
    return value as Hex32[];
  }

  #missing(field: string, expected: string): undefined {
    this.#problems.push({ field, reason: 'missing', expected });
    return undefined;
  }

  #wrong(field: string, reason: string, expected: string): undefined {
    this.#problems.push({ field, reason, expected });
    return undefined;
  }
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/**
 * The spend a decision is taken on.
 *
 * `amountMicros` is accepted as a deprecated spelling of `amountMicro`, which is the one name both
 * services use for this quantity.
 */
function spendRequest(fields: Fields, subject: string | undefined): SpendRequest {
  const requestId = fields.text('requestId');
  const action = fields.text('action');
  const amountMicros = fields.micro('amountMicro', 'amountMicros');
  const at = fields.optionalText('at');
  // Required here, and reported with everything else that is wrong, so there is no second round
  // trip: every decision reads the account's merchant gate and the escrow's cap against it.
  const merchant = fields.hex('merchant', 20, 'required');
  const capabilityId = fields.hex('capabilityId', 32);
  const deadline = fields.seconds('deadline');
  const proof = fields.merkleProof('merchantProof');

  fields.check();
  if (subject === undefined || requestId === undefined || action === undefined || amountMicros === undefined) {
    throw new InvalidRequest(fields.problems);
  }

  return {
    requestId,
    subject,
    action,
    amountMicros,
    at: at ?? new Date().toISOString(),
    ...(merchant === undefined ? {} : { merchant: merchant as Address }),
    ...(capabilityId === undefined ? {} : { capabilityId: capabilityId as Hex32 }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(proof === undefined ? {} : { merchantProof: proof }),
  };
}
