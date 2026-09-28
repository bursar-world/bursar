import { BursarError } from '@bursar/core';

/**
 * A malformed document or request. Defined in @bursar/core beside the evaluator that raises them,
 * and re-exported so `instanceof` agrees across both packages.
 */
import { DocumentError, RequestError } from '@bursar/core';

export { DocumentError, RequestError };

/** One thing wrong with one field, in the same three parts a configuration problem is reported in. */
export type RequestProblem = {
  readonly field: string;
  readonly reason: string;
  readonly expected: string;
};

/**
 * Everything wrong with a request, in one answer.
 *
 * The startup loader reports every missing variable at once with what each one expects, and there
 * is no reason a request body deserves less. Reporting the first fault and stopping turns learning
 * a five-field body into five round trips, each one a decision the caller cannot take yet.
 */
export class InvalidRequest extends RequestError {
  readonly problems: readonly RequestProblem[];

  constructor(problems: readonly RequestProblem[]) {
    super(
      `The request is not usable:\n${problems.map((p) => `  ${p.field}: ${p.reason} (expected ${p.expected})`).join('\n')}`,
      { problems },
    );
    this.problems = problems;
  }
}

/**
 * A request id already on the journal, presented again with different terms.
 *
 * A retry has to be free, so an identical replay returns the decision that was taken. A replay
 * that changes the amount, the payee, the capability, the action or the subject is not a retry:
 * it asks this service to hand back a verdict that was reached about a different spend, and the
 * caller applies that verdict to the new amount. Answering it would authorise money no mandate was
 * ever read against, so it is refused and the caller is told which field moved.
 */
export class RequestReplayedError extends BursarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('underwriter_request_replayed', message, details);
  }
}

/** A request body past the ceiling. Separate from a malformed one so the status says which. */
export class BodyTooLargeError extends BursarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('underwriter_body_too_large', message, details);
  }
}

export type LogErrorCode =
  | 'log_out_of_order'
  | 'log_not_held'
  | 'log_already_settled'
  | 'log_not_refundable'
  | 'log_broken';

/**
 * A fault in operating the decision log: appending out of order, settling a call that is not
 * held, or settling one twice.
 */
export class LogError extends BursarError {
  constructor(code: LogErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

/**
 * The chain could not be read. Raised only where a caller asks for chain state directly. The
 * underwriter itself turns this into a refusal instead of letting it propagate, because a
 * silent chain must never become a silent approval.
 *
 * The failure underneath is kept on `cause` and never in `details`. `details` is written for a
 * customer and reaches them over HTTP; a transport library's own message, complete with its
 * documentation link, belongs in this service's log and nowhere else.
 */
export class ChainUnavailableError extends BursarError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super('underwriter_chain_unavailable', message, details);
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Configuration this process cannot run on. Raised before anything binds a port or reads a
 * mandate, and every message names the variable an operator has to set.
 */
export class UnderwriterConfigError extends BursarError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

/**
 * Another process already speaks for this MandateAccount.
 *
 * The lifetime ceiling is reserved in the spend journal, so two processes appending to one
 * account's journal would each reserve against it and the ceiling would admit twice what the
 * principal wrote. Exiting at startup is the only answer that keeps the reservation authoritative.
 */
export class JournalHeldError extends BursarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('underwriter_journal_held', message, details);
  }
}
