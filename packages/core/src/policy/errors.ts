import { BursarError } from '../errors.js';

/**
 * A malformed document, request or log, distinct from a spend being refused. A refusal is a
 * valid answer to the question that was asked; these are states a caller must not reach.
 *
 * The codes keep the underwriter's spelling. The evaluator was lifted out of that service so the
 * console could run it on drafts, and a code that changed on the way would break every caller
 * that branches on it.
 */
export class DocumentError extends BursarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('underwriter_document_invalid', message, details);
  }
}

export class RequestError extends BursarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('underwriter_request_invalid', message, details);
  }
}
