import { RequestError } from '../errors.js';

/** The SQLSTATEs a request can reach from the outside. */
const SQLSTATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  exclusionViolation: '23P01',
  invalidText: '22P02',
  numericOutOfRange: '22003',
  serializationFailure: '40001',
  deadlock: '40P01',
  statementTimeout: '57014',
} as const;

/**
 * Whether a failure is a named unique constraint losing a race.
 *
 * The idempotent writes in this ledger read their reference under `FOR UPDATE` first, but a row
 * that does not exist yet cannot be locked, so two identical requests arriving together both get
 * past that read and one loses on the insert. Recognising which constraint it lost on is what lets
 * the loser re-read and return the winner's result instead of surfacing a database error to a
 * caller who did nothing wrong.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const failure = driverFailure(error);
  if (failure === null || failure.code !== SQLSTATE.uniqueViolation) return false;
  return constraint === undefined || failure.constraint === constraint;
}

type DriverFailure = {
  readonly code: string;
  readonly constraint: string | undefined;
  readonly column: string | undefined;
};

function driverFailure(error: unknown): DriverFailure | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; constraint?: unknown; column?: unknown };
  if (typeof candidate.code !== 'string') return null;
  return {
    code: candidate.code,
    constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
    column: typeof candidate.column === 'string' ? candidate.column : undefined,
  };
}

/**
 * What a foreign key means to whoever sent the request.
 *
 * Every one of these columns points at a row the caller is responsible for creating, so the answer
 * is the same 404 the route would give if it had looked the row up itself, naming the thing
 * that is missing and the route that makes one. The constraint name is derived from the column,
 * because the schema names every key `<table>_<column>_fkey` and a hand-written table of thirty
 * entries would fall behind the first migration that adds a thirty-first.
 */
const MISSING_ROW: Readonly<Record<string, { readonly code: string; readonly detail: string }>> = {
  agent_id: {
    code: 'account_not_found',
    detail: 'No agent account by that id. Create one with POST /accounts before spending against it.',
  },
  pool_id: {
    code: 'pool_not_found',
    detail: 'No pool by that id. Create one with POST /pools before spending against it.',
  },
  authorization_id: {
    code: 'authorization_not_found',
    detail: 'No authorisation by that id. Take a decision with POST /underwrite, or record one with POST /authorizations.',
  },
  reservation_id: { code: 'reservation_not_found', detail: 'No reservation by that id. Open one with POST /reservations.' },
  settlement_id: { code: 'settlement_not_found', detail: 'No settlement by that id.' },
  debt_id: { code: 'debt_not_found', detail: 'No debt by that id.' },
  position_id: { code: 'collateral_position_not_found', detail: 'No collateral position by that id.' },
  asset_id: {
    code: 'collateral_asset_not_found',
    detail: 'No collateral asset by that id. This facilitator takes the settlement asset as collateral and nothing else.',
  },
};

/**
 * The conditions a caller can break that the schema enforces.
 *
 * Each one is a product rule a request can violate, so it gets the sentence a customer needs: what
 * is not allowed, and what to send instead. Anything not listed is an invariant no request should
 * be able to reach, and it gets the generic answer below, with no constraint name in it.
 */
const REFUSED: Readonly<Record<string, string>> = {
  chk_pools_credit_is_collateral_only:
    'Only a collateral pool may carry a borrowing cap. Send ltvCapBps 0, or set lane to collateral.',
  chk_reserves_debt_is_collateral_only: 'Only the collateral lane carries an outstanding balance.',
  chk_debts_collateral_lane_only: 'Only the collateral lane opens a debt.',
  chk_collateral_event_lane: 'Collateral is posted in the collateral lane only.',
  chk_funding_lane: 'Prefunding applies to the prefund lane only.',
  chk_reservations_prefund_locks: 'A reservation in the prefund lane has to lock the amount it holds.',
  chk_reservations_others_lock_nothing: 'Only the prefund lane locks a balance; every other lane holds nothing.',
  chk_accounts_status: 'An account is either active or suspended.',
  chk_pools_status: 'A pool is active, paused or frozen.',
  chk_pools_ltv: 'ltvCapBps is between 0 and 10000.',
};

/**
 * Turns a driver failure into the answer the caller gets, or null when it is not one.
 *
 * Without this a missing pool arrives as `internal_error` with a constraint name in the log, which
 * tells the one person who can read the log what the caller already knew and tells the caller
 * nothing. Nothing here echoes the driver's own message: it carries table and column names, which
 * are this service's business and not the customer's.
 */
export function databaseError(error: unknown): RequestError | null {
  const failure = driverFailure(error);
  if (failure === null) return null;

  switch (failure.code) {
    case SQLSTATE.foreignKeyViolation: {
      const column = columnFromConstraint(failure.constraint);
      const missing = column === undefined ? undefined : MISSING_ROW[column];
      if (missing) return new RequestError(404, missing.code, missing.detail);
      return new RequestError(
        409,
        'reference_not_found',
        'This change points at a record that does not exist. Create it first, then send this again.',
      );
    }

    case SQLSTATE.checkViolation: {
      const refusal = failure.constraint === undefined ? undefined : REFUSED[failure.constraint];
      if (refusal) return new RequestError(400, 'field_invalid', refusal);
      return new RequestError(
        409,
        'ledger_refused',
        'The ledger refuses this change because it would break a rule it keeps. Nothing was written.',
      );
    }

    case SQLSTATE.notNullViolation:
      return new RequestError(
        400,
        'field_required',
        failure.column === undefined
          ? 'The request is missing a value the ledger requires.'
          : `${camel(failure.column)} is required.`,
      );

    case SQLSTATE.uniqueViolation:
      return new RequestError(
        409,
        'already_recorded',
        'A record with that identifier already exists. Read it back, or send a new identifier.',
      );

    case SQLSTATE.exclusionViolation:
      return new RequestError(409, 'already_recorded', 'That record overlaps one already held.');

    case SQLSTATE.invalidText:
      return new RequestError(
        400,
        'field_invalid',
        'One of the identifiers in this request is not in the form the ledger stores it in.',
      );

    case SQLSTATE.numericOutOfRange:
      return new RequestError(
        400,
        'field_invalid',
        'An amount in this request is larger than a money column holds, which is just under 100,000,000 USDG.',
      );

    // Contention, not a fault: the same request sent again is likely to commit.
    case SQLSTATE.serializationFailure:
    case SQLSTATE.deadlock:
      return new RequestError(
        409,
        'ledger_busy',
        'Another change to the same records committed first and this one was rolled back. Send it again.',
      );

    case SQLSTATE.statementTimeout:
      return new RequestError(
        503,
        'ledger_unavailable',
        'The ledger did not finish this change inside its statement timeout and rolled it back. Nothing was written.',
      );

    default:
      return null;
  }
}

/**
 * `bursar_authorizations_pool_id_fkey` names its column, which is the only place it is named: a
 * foreign key violation reports the constraint and the referencing table, never the column.
 */
function columnFromConstraint(constraint: string | undefined): string | undefined {
  const match = constraint === undefined ? null : /_([a-z0-9]+_id)_fkey$/.exec(constraint);
  return match?.[1];
}

function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}
