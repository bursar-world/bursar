import { BursarError } from '@bursar/core';

/**
 * Failures the lane ledger raises, each one a named condition a caller can branch on.
 *
 * The ledger runs inside a database transaction, so every one of these aborts and rolls back. The
 * code is what an HTTP handler maps to a status; the message is for the operator reading a log.
 */
export class LedgerError extends BursarError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = 'LedgerError';
  }
}

/**
 * Credit lives in the collateral lane and nowhere else.
 *
 * Raised when a caller asks the ledger to open a debt against a prefunded or direct lane.
 * It is a programming error, not an input error, and it is checked in code as well as by a
 * CHECK constraint on the debts table, because the boundary is a product commitment and one
 * enforcement point is not enough.
 */
export class LaneDoesNotExtendCredit extends LedgerError {
  constructor(lane: string) {
    super(
      'lane_extends_no_credit',
      `the ${lane} lane settles against funds already held, so it cannot open a debt`,
      { lane },
    );
    this.name = 'LaneDoesNotExtendCredit';
  }
}

/** Configuration the process cannot start without, or that contradicts itself. */
export class FacilitatorConfigError extends BursarError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = 'FacilitatorConfigError';
  }
}

/** A request the HTTP layer refuses before any state is touched. */
export class RequestError extends BursarError {
  readonly status: number;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = 'RequestError';
    this.status = status;
  }
}
