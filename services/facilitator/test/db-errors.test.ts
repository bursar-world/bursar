import { describe, expect, it } from 'vitest';

import { databaseError, isUniqueViolation } from '../src/db/errors.js';
import { errorResponse } from '../src/http/routes.js';

/**
 * What the schema rejecting a write looks like from outside.
 *
 * Every one of these reached a caller as `internal_error` with the condition written only in this
 * service's log. The driver's own fields are what a real failure carries: `code` is the SQLSTATE,
 * `constraint` names what was broken, and `detail` quotes the offending row, which is why none of
 * it is echoed back.
 */

type DriverError = Error & { code: string; constraint?: string; column?: string; detail?: string };

function driverError(fields: { code: string; constraint?: string; column?: string; detail?: string }): DriverError {
  return Object.assign(new Error('error: insert or update violates constraint'), fields);
}

describe('a database failure reaching the caller', () => {
  it('reports a missing pool as the 404 the route would have given', () => {
    const failure = databaseError(
      driverError({
        code: '23503',
        constraint: 'bursar_authorizations_pool_id_fkey',
        detail: 'Key (pool_id)=(p1) is not present in table "bursar_pools".',
      }),
    );

    expect(failure?.status).toBe(404);
    expect(failure?.code).toBe('pool_not_found');
    expect(failure?.message).toContain('POST /pools');
  });

  it('reports a missing agent account the same way, from the same shape of key', () => {
    const failure = databaseError(
      driverError({ code: '23503', constraint: 'bursar_reservations_agent_id_fkey' }),
    );

    expect(failure?.status).toBe(404);
    expect(failure?.code).toBe('account_not_found');
    expect(failure?.message).toContain('POST /accounts');
  });

  it('turns a product rule the schema keeps into the sentence that fixes the request', () => {
    const failure = databaseError(
      driverError({ code: '23514', constraint: 'chk_pools_credit_is_collateral_only' }),
    );

    expect(failure?.status).toBe(400);
    expect(failure?.message).toContain('ltvCapBps 0');
  });

  it('says nothing was written when it cannot name the rule, rather than naming a constraint', () => {
    const failure = databaseError(driverError({ code: '23514', constraint: 'chk_something_internal' }));

    expect(failure?.status).toBe(409);
    expect(failure?.code).toBe('ledger_refused');
    expect(failure?.message).not.toContain('chk_');
  });

  it('separates contention, which is worth retrying, from a fault, which is not', () => {
    expect(databaseError(driverError({ code: '40001' }))?.code).toBe('ledger_busy');
    expect(databaseError(driverError({ code: '57014' }))?.status).toBe(503);
  });

  it('leaves anything that is not a driver failure alone', () => {
    expect(databaseError(new TypeError('undefined is not a function'))).toBeNull();
    expect(databaseError(driverError({ code: 'XX000' }))).toBeNull();
  });

  it('carries the translation through the response the HTTP layer writes', () => {
    const response = errorResponse(driverError({ code: '23503', constraint: 'bursar_debts_pool_id_fkey' }));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'pool_not_found' });
    expect(JSON.stringify(response.body)).not.toContain('fkey');
  });

  it('still recognises the unique violation the idempotent writes race on', () => {
    const race = driverError({ code: '23505', constraint: 'bursar_funding_events_reference_key' });

    expect(isUniqueViolation(race, 'bursar_funding_events_reference_key')).toBe(true);
    expect(isUniqueViolation(race, 'another_constraint')).toBe(false);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
  });
});
