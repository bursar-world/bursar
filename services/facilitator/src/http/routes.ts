import { isBursarError, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { RESERVATION_TTL_SECONDS } from '../config.js';
import { databaseError } from '../db/errors.js';
import type { Database } from '../db/sql.js';
import { RequestError } from '../errors.js';
import type { LaneLedger } from '../lanes/ledger.js';
import { LANE_MODES, toLaneMode } from '../lanes/types.js';
import type { LaneMode } from '../lanes/types.js';
import type { TrustStore } from '../trust/store.js';
import { authorizationFrom } from '../underwriting/underwriter.js';
import type { UnderwriteRequest, UnderwriterLookup } from '../underwriting/underwriter.js';
import type { Facilitator } from '../x402/facilitator.js';
import { readRequest } from '../x402/facilitator.js';
import { FACILITATOR_REASON } from '../x402/contract.js';
import type { PublicSurface } from '../x402/public.js';
import type { ApiRequest, ApiResponse } from './io.js';
import { created, failure, ok } from './io.js';

/**
 * The route table, as a function from request to response.
 *
 * No sockets and no framework, so every route is exercised in a test by calling this with an
 * object. The node server in `server.ts` does nothing but adapt one shape to the other.
 */

/**
 * What `/readyz` answers, on both services.
 *
 * `ready` is one boolean over several checks and the checks travel with it, because an operator
 * looking at a 503 needs to know which dependency produced it before they can do anything about
 * it. The facilitator and the underwriter answer the same shape on the same path.
 */
export type Readiness = {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, unknown>>;
};

/** One dependency's answer. `ready` false on any of them takes the whole probe down. */
export type Check = { readonly ready: boolean } & Readonly<Record<string, unknown>>;

export type RouterOptions = {
  readonly db: Database;
  readonly facilitator: Facilitator;
  readonly ledger: LaneLedger;
  readonly trust: TrustStore;
  readonly reservationTtlMs: number;
  readonly treasury: string;
  readonly describe: () => Readonly<Record<string, unknown>>;
  /** Absent on a deployment that only settles and takes its decisions from somewhere else. */
  readonly underwriterFor?: UnderwriterLookup;
  readonly health?: () => Promise<Readonly<Record<string, unknown>>>;
  /** Absent only where a test builds a router by hand; the service always supplies it. */
  readonly ready?: () => Promise<Readiness>;
  /** The keyless `/x402` routes. Absent, they answer 404 and say what opens them. */
  readonly open?: PublicSurface;
};

export type Router = (request: ApiRequest) => Promise<ApiResponse>;

/**
 * The routes a provider's resource server calls: the x402 surface, discovery and the two probes.
 * They open to FACILITATOR_AUTH_TOKEN. Everything else writes or reads the lane ledger and the
 * trust journal and opens to FACILITATOR_ADMIN_TOKEN alone. A path not in this set is admin,
 * unknown paths included, so a new route has to be placed here on purpose to reach providers.
 */
export const PROVIDER_ROUTES: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/supported', '/config', '/verify', '/settle']);

/**
 * The standard x402 facilitator surface, open to anyone: the routes a client or resource server
 * built on the reference packages expects under one base URL, here `/x402`. Nothing else under that
 * prefix is public, so a new route there has to be added here on purpose.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/x402/supported', '/x402/verify', '/x402/settle']);

export type RouteClass = 'public' | 'provider' | 'admin';

export function routeClass(path: string): RouteClass {
  if (PUBLIC_ROUTES.has(path)) return 'public';
  return PROVIDER_ROUTES.has(path) ? 'provider' : 'admin';
}

type Route = {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handle: (request: ApiRequest, params: readonly string[]) => Promise<ApiResponse>;
};

export function createRouter(options: RouterOptions): Router {
  const { facilitator, ledger, trust, db, open } = options;

  const closed = (): ApiResponse =>
    failure(
      404,
      'not_found',
      'The keyless x402 routes are not open on this deployment. FACILITATOR_PUBLIC_EXACT=true opens them.',
    );

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/x402\/supported$/,
      handle: async (request) => (open ? open.supported(request) : closed()),
    },

    {
      method: 'POST',
      pattern: /^\/x402\/verify$/,
      handle: async (request) => (open ? open.verify(request) : closed()),
    },

    {
      method: 'POST',
      pattern: /^\/x402\/settle$/,
      handle: async (request) => (open ? open.settle(request) : closed()),
    },

    {
      method: 'GET',
      pattern: /^\/healthz$/,
      handle: async () => ok(options.health ? await options.health() : { status: 'ok' }),
    },

    {
      /**
       * Whether this process can serve a request now, which is a different question from health
       * and gets a different answer. A supervisor restarts on `/healthz`; an orchestrator routes
       * on this. The underwriter answers the same shape on the same path.
       */
      method: 'GET',
      pattern: /^\/readyz$/,
      handle: async () => {
        if (!options.ready) return ok({ ready: true });
        const readiness = await options.ready();
        return { status: readiness.ready ? 200 : 503, body: { ready: readiness.ready, ...readiness.checks } };
      },
    },

    {
      method: 'GET',
      pattern: /^\/supported$/,
      handle: async () => ok(await facilitator.supported()),
    },

    {
      method: 'GET',
      pattern: /^\/config$/,
      handle: async () => ok(options.describe()),
    },

    {
      method: 'POST',
      pattern: /^\/verify$/,
      handle: async (request) => {
        const parsed = readRequest(request.body);
        if (!parsed.ok) return { status: 400, body: { isValid: false, invalidReason: parsed.reason } };
        return ok(await facilitator.verify(parsed.request));
      },
    },

    {
      method: 'POST',
      pattern: /^\/settle$/,
      handle: async (request) => {
        const parsed = readRequest(request.body);
        if (!parsed.ok) {
          return {
            status: 400,
            body: {
              success: false,
              settled: false,
              broadcast: false,
              errorReason: parsed.reason,
              transaction: '',
              network: '',
            },
          };
        }
        const result = await facilitator.settle(parsed.request);
        // A refused settlement is a complete answer, not a server fault. The one status that is
        // not 200 is the budget, because a caller can usefully back off on 429 and cannot on 200.
        const rateLimited =
          result.errorReason === FACILITATOR_REASON.dailyBudget ||
          result.errorReason === FACILITATOR_REASON.payerRate;
        return { status: rateLimited ? 429 : 200, body: result };
      },
    },

    {
      method: 'POST',
      pattern: /^\/accounts$/,
      handle: async (request) => {
        const body = object(request.body);
        return created(
          await ledger.upsertAccount({
            agentId: text(body, 'agentId'),
            payerWallet: text(body, 'payerWallet'),
            repayWallet: text(body, 'repayWallet'),
            mandateAccount: optionalAddress(body, 'mandateAccount'),
            networks: optionalList(body, 'networks'),
            perCallCapMicro: optionalMicro(body, 'perCallCapMicro'),
            dailyCapMicro: optionalMicro(body, 'dailyCapMicro'),
            monthlyCapMicro: optionalMicro(body, 'monthlyCapMicro'),
            approvalThresholdMicro: optionalMicro(body, 'approvalThresholdMicro'),
          }),
        );
      },
    },

    {
      method: 'GET',
      pattern: /^\/accounts\/([^/]+)$/,
      handle: async (_request, [agentId]) => {
        const id = decodeURIComponent(agentId ?? '');
        const account = await ledger.getAccount(id);
        return account ? ok(account) : failure(404, 'account_not_found', missingAccount(id));
      },
    },

    {
      method: 'POST',
      pattern: /^\/accounts\/([^/]+)\/status$/,
      handle: async (request, [agentId]) => {
        const id = decodeURIComponent(agentId ?? '');
        const account = await ledger.getAccount(id);
        if (!account) return failure(404, 'account_not_found', missingAccount(id));
        await ledger.setAccountStatus(id, accountStatus(object(request.body)));
        return ok(await ledger.getAccount(id));
      },
    },

    {
      method: 'GET',
      pattern: /^\/accounts\/([^/]+)\/transactions$/,
      handle: async (request, [agentId]) =>
        ok({
          transactions: await ledger.listTransactions(
            decodeURIComponent(agentId ?? ''),
            limitOf(request, 50),
          ),
        }),
    },

    {
      method: 'POST',
      pattern: /^\/pools$/,
      handle: async (request) => {
        const body = object(request.body);
        const lane = laneOf(body);
        return created(
          await ledger.upsertPool({
            poolId: text(body, 'poolId'),
            lane,
            status: statusOf(body),
            ltvCapBps: integer(body, 'ltvCapBps', 0),
            minHealthFactor: ratio(body, 'minHealthFactor', 1.5),
            maxSingleMicro: micro(body, 'maxSingleMicro'),
          }),
        );
      },
    },

    {
      method: 'GET',
      pattern: /^\/pools\/([^/]+)$/,
      handle: async (_request, [poolId]) => {
        const id = decodeURIComponent(poolId ?? '');
        const pool = await ledger.getPool(id);
        if (!pool) return failure(404, 'pool_not_found', missingPool(id));
        return ok({ pool, reserve: await ledger.getPoolReserve(id) });
      },
    },

    {
      method: 'POST',
      pattern: /^\/lanes\/([^/]+)\/prefund$/,
      handle: async (request, [agentId]) => {
        const body = object(request.body);
        return ok(
          await ledger.applyFunding({
            agentId: decodeURIComponent(agentId ?? ''),
            poolId: text(body, 'poolId'),
            referenceId: text(body, 'referenceId'),
            amountMicro: micro(body, 'amountMicro'),
            eventType: movement(body),
            txHash: optionalText(body, 'txHash'),
          }),
        );
      },
    },

    {
      method: 'GET',
      pattern: /^\/lanes\/([^/]+)\/prefund$/,
      handle: async (request, [agentId]) =>
        ok({
          events: await ledger.listFunding(
            decodeURIComponent(agentId ?? ''),
            limitOf(request, 50),
            request.query.get('poolId') ?? undefined,
          ),
        }),
    },

    {
      method: 'POST',
      pattern: /^\/lanes\/([^/]+)\/collateral$/,
      handle: async (request, [agentId]) => {
        const body = object(request.body);
        return ok(
          await ledger.applyCollateral({
            agentId: decodeURIComponent(agentId ?? ''),
            poolId: text(body, 'poolId'),
            collateralAccount: text(body, 'collateralAccount'),
            assetId: text(body, 'assetId'),
            referenceId: text(body, 'referenceId'),
            amountMicro: micro(body, 'amountMicro'),
            eventType: movement(body),
            txHash: optionalText(body, 'txHash'),
          }),
        );
      },
    },

    {
      method: 'POST',
      pattern: /^\/lanes\/([^/]+)\/repay$/,
      handle: async (request, [agentId]) => {
        const body = object(request.body);
        return ok(
          await ledger.applyRepayment({
            agentId: decodeURIComponent(agentId ?? ''),
            referenceId: text(body, 'referenceId'),
            amountMicro: micro(body, 'amountMicro'),
            source: repaymentSource(body),
            txHash: optionalText(body, 'txHash'),
            poolId: optionalText(body, 'poolId') ?? undefined,
          }),
        );
      },
    },

    {
      method: 'GET',
      pattern: /^\/lanes\/([^/]+)\/([^/]+)$/,
      // After the fixed lane paths, because this pattern matches every one of them and the first
      // match wins: ahead of them, `GET /lanes/:agentId/prefund` read "prefund" as a pool id.
      handle: async (_request, [agentId, poolId]) => {
        // Checked here as well as in the ledger so a missing row answers in the words and shape
        // every other route uses for it, instead of the ledger's log message.
        const agent = decodeURIComponent(agentId ?? '');
        const pool = decodeURIComponent(poolId ?? '');
        if ((await ledger.getAccount(agent)) === null) {
          return failure(404, 'account_not_found', missingAccount(agent));
        }
        if ((await ledger.getPool(pool)) === null) {
          return failure(404, 'pool_not_found', missingPool(pool));
        }
        return ok(await ledger.statement(agent, pool));
      },
    },

    {
      method: 'POST',
      pattern: /^\/authorizations$/,
      handle: async (request) => {
        const body = object(request.body);
        const lane = laneOf(body);
        return created(
          await ledger.recordAuthorization({
            agentId: text(body, 'agentId'),
            payerWallet: text(body, 'payerWallet'),
            repayWallet: text(body, 'repayWallet'),
            requestNonce: text(body, 'requestNonce'),
            network: text(body, 'network'),
            lane,
            poolId: text(body, 'poolId'),
            requestedMicro: micro(body, 'requestedMicro'),
            approved: flag(body, 'approved'),
            approvedMicro: micro(body, 'approvedMicro'),
            availableMicro: micro(body, 'availableMicro'),
            outstandingMicro: micro(body, 'outstandingMicro'),
            reasonCodes: optionalList(body, 'reasonCodes'),
            policyId: optionalText(body, 'policyId'),
            policyVersion: optionalText(body, 'policyVersion'),
            requestHash: optionalText(body, 'requestHash'),
            documentHash: optionalText(body, 'documentHash'),
          }),
        );
      },
    },

    {
      method: 'POST',
      pattern: /^\/underwrite$/,
      handle: async (request) => {
        if (!options.underwriterFor) {
          throw new RequestError(
            501,
            'underwriter_not_configured',
            'This facilitator does not decide spends. Post a decision to /authorizations instead.',
          );
        }

        const body = object(request.body);
        const lane = laneOf(body);

        const agentId = text(body, 'agentId');
        const underwriter = await options.underwriterFor(agentId);
        if (!underwriter) {
          throw new RequestError(
            404,
            'no_underwriter_for_agent',
            `No mandate is underwritten for ${agentId}. Check the agentId, or add a mandate for that subject to the document source this deployment's underwriter reads.`,
          );
        }

        const requestNonce = text(body, 'requestNonce');
        const merchant = optionalAddress(body, 'merchant');
        const capabilityId = optionalHex32(body, 'capabilityId');
        const merchantProof = optionalProof(body, 'merchantProof');
        const spend: UnderwriteRequest = {
          agentId,
          payerWallet: text(body, 'payerWallet'),
          repayWallet: text(body, 'repayWallet'),
          requestNonce,
          network: text(body, 'network'),
          lane,
          poolId: text(body, 'poolId'),
          subject: text(body, 'subject'),
          action: text(body, 'action'),
          amountMicro: micro(body, 'amountMicro'),
          ...(merchant === null ? {} : { merchant }),
          ...(capabilityId === null ? {} : { capabilityId }),
          ...(merchantProof === null ? {} : { merchantProof }),
          ...(optionalText(body, 'requestHash') === null
            ? {}
            : { requestHash: optionalText(body, 'requestHash') as string }),
        };

        // Both of these are read before the decision is taken, not after it is recorded. The
        // decision costs chain reads and is appended to the spend journal, where it reserves
        // against the mandate's lifetime ceiling. Discovering afterwards that there is nowhere to
        // record it would leave that reservation standing for a call the ledger never accepted.
        if ((await ledger.getAccount(agentId)) === null) {
          throw new RequestError(404, 'account_not_found', missingAccount(agentId));
        }
        if ((await ledger.getPool(spend.poolId)) === null) {
          throw new RequestError(404, 'pool_not_found', missingPool(spend.poolId));
        }

        const result = await underwriter.authorize({
          requestId: requestNonce,
          subject: spend.subject,
          action: spend.action,
          amountMicros: spend.amountMicro,
          at: new Date().toISOString(),
          ...(merchant === null ? {} : { merchant }),
          ...(capabilityId === null ? {} : { capabilityId }),
          ...(merchantProof === null ? {} : { merchantProof }),
        });

        // Debt already owed is what an approval has to be measured against, so it is read here.
        // A client that reported its own outstanding balance would be setting its own credit
        // limit.
        const outstanding = await ledger.outstandingMicro(agentId, spend.poolId);
        const record = await ledger.recordAuthorization(
          authorizationFrom(spend, result, outstanding),
        );

        return created({
          authorization: record,
          decision: result.decision,
          mandateAccount: underwriter.account,
          idempotent: result.idempotent,
        });
      },
    },

    {
      method: 'POST',
      pattern: /^\/reservations$/,
      handle: async (request) => {
        const body = object(request.body);
        return created(
          await ledger.openReservation({
            authorizationId: uuid(text(body, 'authorizationId'), 'authorizationId'),
            merchantWallet: text(body, 'merchantWallet'),
            amountMicro: micro(body, 'amountMicro'),
            ttlMs: ttlMs(body, options.reservationTtlMs),
          }),
        );
      },
    },

    {
      method: 'GET',
      pattern: /^\/reservations\/([^/]+)$/,
      handle: async (_request, [id]) => {
        const reservationId = uuid(id, 'reservationId');
        const reservation = await ledger.getReservation(reservationId);
        return reservation
          ? ok(reservation)
          : failure(
              404,
              'reservation_not_found',
              `No reservation by the id ${reservationId}. Open one with POST /reservations against an approved authorisation.`,
            );
      },
    },

    {
      method: 'POST',
      pattern: /^\/reservations\/([^/]+)\/release$/,
      handle: async (_request, [id]) => {
        const reservationId = uuid(id, 'reservationId');
        const released = await ledger.releaseReservation(reservationId);
        return released
          ? ok({ released: true })
          : failure(
              409,
              'reservation_not_open',
              `Reservation ${reservationId} is not open, so nothing was released. GET /reservations/${reservationId} reports the state it is in.`,
            );
      },
    },

    {
      method: 'POST',
      pattern: /^\/reservations\/([^/]+)\/consume$/,
      handle: async (request, [id]) => {
        const body = object(request.body);
        return ok(
          await ledger.consumeReservation({
            reservationId: uuid(id, 'reservationId'),
            asset: text(body, 'asset'),
            feeMicro: optionalMicro(body, 'feeMicro') ?? toMicro(0),
          }),
        );
      },
    },

    {
      method: 'POST',
      pattern: /^\/reservations\/expire$/,
      handle: async (request) => ok({ expired: await ledger.expireReservations(limitOf(request, 200)) }),
    },

    {
      method: 'GET',
      pattern: /^\/settlements\/pending\/([^/]+)$/,
      handle: async (request, [merchant]) =>
        ok({
          settlements: await ledger.listAuthorizedSettlements(
            address(decodeURIComponent(merchant ?? ''), 'merchant'),
            limitOf(request, 100),
          ),
        }),
    },

    {
      method: 'POST',
      pattern: /^\/settlements\/net$/,
      handle: async (request) => {
        const body = object(request.body);
        const ids = optionalList(body, 'settlementIds');
        if (ids.length === 0) {
          throw new RequestError(
            400,
            'settlement_ids_required',
            'settlementIds must name at least one settlement. GET /settlements/pending/{merchant} lists what is authorised and unpaid.',
          );
        }
        return ok({
          settled: await ledger.markSettled({
            settlementIds: ids.map((id) => uuid(id, 'settlementIds')),
            txHash: text(body, 'txHash'),
            treasury: options.treasury,
          }),
        });
      },
    },

    {
      method: 'GET',
      pattern: /^\/trust\/outbox$/,
      handle: async (request) =>
        ok({
          counts: await trust.counts(db),
          deadLetters: await trust.listDeadLetters(db, limitOf(request, 20)),
        }),
    },

    {
      method: 'POST',
      pattern: /^\/trust\/outbox\/redrive$/,
      handle: async (request) => {
        const body = object(request.body);
        return ok(
          await db.transaction((client) =>
            trust.redrive(client, {
              limit: integer(body, 'limit', 50),
              eventId: optionalText(body, 'eventId') ?? undefined,
            }),
          ),
        );
      },
    },

    {
      method: 'POST',
      pattern: /^\/trust\/outbox\/replay$/,
      handle: async (request) => {
        const body = object(request.body);
        return ok(
          await db.transaction((client) =>
            trust.replay(client, {
              fromOffset: BigInt(integer(body, 'fromOffset', 0)),
              limit: integer(body, 'limit', 500),
              subject: optionalText(body, 'subject') ?? undefined,
            }),
          ),
        );
      },
    },

    {
      method: 'GET',
      pattern: /^\/trust\/events$/,
      handle: async (request) =>
        ok({
          events: await trust.readJournal(db, {
            fromOffset: bigintQuery(request, 'fromOffset'),
            limit: limitOf(request, 50),
            subject: request.query.get('subject') ?? undefined,
          }),
        }),
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
    return failure(404, 'not_found', `${request.method} ${request.path} is not a route on this facilitator.`);
  };
}


/**
 * Turns a thrown error into the status and code a caller can act on.
 *
 * A driver failure is translated before the fallback, because a foreign key or a check constraint
 * is the schema rejecting something the caller asked for. Left to reach here as an unknown, it
 * answers 500 with the condition written only in this service's log, where the one person who can
 * read it learns what the caller already knew.
 */
export function errorResponse(error: unknown): ApiResponse {
  // Only `decodeURIComponent` on a path segment throws this here: a `%` not followed by two hex
  // digits is a malformed request, not a fault in this service.
  if (error instanceof URIError) {
    return {
      status: 400,
      body: { error: 'path_invalid', detail: 'The request path is not valid percent-encoding.' },
    };
  }
  const refusal = error instanceof RequestError ? error : databaseError(error);
  if (refusal) {
    return {
      status: refusal.status,
      body: {
        error: refusal.code,
        detail: refusal.message,
        ...(Object.keys(refusal.details).length > 0 ? { details: refusal.details } : {}),
      },
    };
  }
  if (isBursarError(error)) {
    const status = error.code.endsWith('_not_found') ? 404 : 409;
    return { status, body: { error: error.code, detail: error.message, details: error.details } };
  }
  return { status: 500, body: { error: 'internal_error' } };
}

/** The two rows every spend needs, worded the same wherever a route finds one missing. */
function missingAccount(agentId: string): string {
  return `No agent account by the id ${agentId}. Create one with POST /accounts before spending against it.`;
}

function missingPool(poolId: string): string {
  return `No pool by the id ${poolId}. Create one with POST /pools before spending against it.`;
}

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'body_invalid', 'The request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/**
 * The lane a request names.
 *
 * The three it may name are the three `GET /config` advertises, and the refusal repeats them so a
 * caller does not have to go and read that route to find out what it got wrong.
 */
function laneOf(body: Record<string, unknown>): LaneMode {
  const lane = toLaneMode(text(body, 'lane'));
  if (lane === null) {
    throw new RequestError(
      400,
      'lane_invalid',
      `lane must be one of ${LANE_MODES.join(', ')}`,
      { lanes: LANE_MODES },
    );
  }
  return lane;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequestError(400, 'field_required', `${field} must be a non-empty string`);
  }
  return value.trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An identifier on its way to a `uuid` column.
 *
 * Postgres raises `invalid_text_representation` on anything else, which reaches the error handler
 * as a driver fault and answers 500. The caller sent a bad identifier, which is a 400. Saying so
 * costs one regular expression and no round trip to the database.
 */
function uuid(value: string | undefined, field: string): string {
  const raw = (value ?? '').trim();
  if (!UUID.test(raw)) {
    throw new RequestError(400, 'field_invalid', `${field} must be a UUID`);
  }
  return raw;
}

/** A journal offset, which is an int8 and too wide for a JSON number. */
function bigintQuery(request: ApiRequest, field: string): bigint {
  const raw = request.query.get(field);
  if (raw === null) return 0n;
  if (!/^\d{1,19}$/.test(raw.trim())) {
    throw new RequestError(400, 'field_invalid', `${field} must be a non-negative integer`);
  }
  return BigInt(raw.trim());
}

function optionalText(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new RequestError(400, 'field_invalid', `${field} must be a string`);
  }
  return value.trim() || null;
}

function optionalAddress(body: Record<string, unknown>, field: string): `0x${string}` | null {
  const value = optionalText(body, field);
  return value === null ? null : address(value, field);
}

function address(value: string, field: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    throw new RequestError(400, 'field_invalid', `${field} must be a 20-byte hex address`);
  }
  return value.trim() as `0x${string}`;
}

/** A capability id is the keccak of its label, so it is a word wide, not an address. */
function optionalHex32(body: Record<string, unknown>, field: string): `0x${string}` | null {
  const value = optionalText(body, field);
  if (value === null) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RequestError(400, 'field_invalid', `${field} must be a 32-byte hex value`);
  }
  return value as `0x${string}`;
}

/**
 * A Merkle path, checked here so a malformed one is a 400 naming the field rather than a refusal
 * the underwriter words in terms of the merchant gate. The ceiling is a path far deeper than any
 * allow-list needs, and keeps the body from carrying an arbitrary number of hashes to the chain.
 */
const MAX_PROOF_DEPTH = 64;

function optionalProof(body: Record<string, unknown>, field: string): readonly `0x${string}`[] | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > MAX_PROOF_DEPTH ||
    value.some((node) => typeof node !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(node))
  ) {
    throw new RequestError(
      400,
      'field_invalid',
      `${field} must be an array of at most ${MAX_PROOF_DEPTH} 32-byte hex values`,
    );
  }
  return value as `0x${string}`[];
}

function optionalList(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new RequestError(400, 'field_invalid', `${field} must be an array of strings`);
  }
  return value as string[];
}

function flag(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') {
    throw new RequestError(400, 'field_invalid', `${field} must be true or false`);
  }
  return value;
}

function integer(body: Record<string, unknown>, field: string, fallback: number): number {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RequestError(400, 'field_invalid', `${field} must be an integer`);
  }
  return value;
}

function ratio(body: Record<string, unknown>, field: string, fallback: number): number {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RequestError(400, 'field_invalid', `${field} must be a positive number`);
  }
  return value;
}

/**
 * Money, as atomic micro-USD.
 *
 * A JSON number is a double, so anything above nine billion micro-USD has already lost precision
 * by the time it arrives. Strings are the only form accepted, and a number is rejected with a
 * message that says why.
 */
function micro(body: Record<string, unknown>, field: string): Micro {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new RequestError(
      400,
      'field_invalid',
      `${field} must be a string of atomic micro-USD; a JSON number cannot hold one exactly`,
    );
  }
  try {
    return toMicro(value);
  } catch {
    throw new RequestError(400, 'field_invalid', `${field} is not an integer number of micro-USD`);
  }
}

function optionalMicro(body: Record<string, unknown>, field: string): Micro | null {
  return body[field] === undefined || body[field] === null ? null : micro(body, field);
}

function movement(body: Record<string, unknown>): 'deposit' | 'withdraw' {
  const value = text(body, 'eventType');
  if (value !== 'deposit' && value !== 'withdraw') {
    throw new RequestError(400, 'field_invalid', 'eventType must be deposit or withdraw');
  }
  return value;
}

function repaymentSource(body: Record<string, unknown>): 'settlement' | 'transfer' | 'collateral' {
  const value = text(body, 'source');
  if (value !== 'settlement' && value !== 'transfer' && value !== 'collateral') {
    throw new RequestError(400, 'field_invalid', 'source must be settlement, transfer or collateral');
  }
  return value;
}

function ttlMs(body: Record<string, unknown>, fallbackMs: number): number {
  const seconds = integer(body, 'ttlSeconds', 0);
  if (seconds === 0) return fallbackMs;
  if (seconds < RESERVATION_TTL_SECONDS.min || seconds > RESERVATION_TTL_SECONDS.max) {
    throw new RequestError(
      400,
      'field_invalid',
      `ttlSeconds must be between ${RESERVATION_TTL_SECONDS.min} and ${RESERVATION_TTL_SECONDS.max}`,
    );
  }
  return seconds * 1_000;
}

function accountStatus(body: Record<string, unknown>): 'active' | 'suspended' {
  const value = text(body, 'status');
  if (value !== 'active' && value !== 'suspended') {
    throw new RequestError(400, 'field_invalid', 'status must be active or suspended');
  }
  return value;
}

function statusOf(body: Record<string, unknown>): 'active' | 'paused' | 'frozen' {
  const value = optionalText(body, 'status') ?? 'active';
  if (value !== 'active' && value !== 'paused' && value !== 'frozen') {
    throw new RequestError(400, 'field_invalid', 'status must be active, paused or frozen');
  }
  return value;
}

function limitOf(request: ApiRequest, fallback: number): number {
  const raw = request.query.get('limit');
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RequestError(400, 'limit_invalid', 'limit must be a positive integer');
  }
  return value;
}
