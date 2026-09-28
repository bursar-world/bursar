/**
 * The exact bytes an escrow commitment covers, and the shape of a job document inside them.
 *
 * An agent commits to its arguments through this server and the provider recomputes that
 * commitment from the published bytes. Both have to serialise identically, so one implementation
 * in `@bursar/core` serves every package. RFC 8785 (JCS): keys sort by
 * UTF-16 code unit, numbers take their ECMAScript form, no whitespace survives.
 */

import { canonicalStringify } from '@bursar/core';

import { invalidArguments } from './errors.js';
import type { JobSpecInput } from './types.js';

export { canonicalStringify, capabilityId, commitCanonical, toDataUri } from '@bursar/core';

/**
 * A job document as both halves hash it: the task, the arguments, and what counts as delivered.
 *
 * It carries the work and nothing the settlement already holds. Who is being paid, how much, for
 * which capability and by when are all on the lock, and repeating any of them here would be a
 * second copy that can disagree with the first.
 *
 * `@bursar/sdk` builds the same document for an agent that hires without this server, and both are
 * pinned to the same commitment in their own suites, so the two cannot drift apart silently.
 */
export type JobDocument = {
  readonly task: string;
  readonly input: Record<string, unknown>;
  readonly acceptance?: readonly string[];
};

/**
 * The largest job document a provider will read, one mebibyte, matching the worker's own body
 * limit. Over it the provider refuses the job while the escrow still holds the money.
 */
export const MAX_JOB_BYTES = 1_048_576;

/**
 * Normalises a spec into the document that gets hashed.
 *
 * Two callers who mean the same job have to produce the same bytes, so an absent input and an
 * empty one are one document, and an empty acceptance list is no list rather than a claim that
 * nothing counts.
 */
export function jobDocument(spec: JobSpecInput): JobDocument {
  const task = spec.task.trim();

  if (task === '') {
    throw invalidArguments(
      'task is the one line saying what the provider is being paid to do. It is committed with the ' +
        'payment, so it is also what a resolver reads if the delivery is contested.',
    );
  }

  const acceptance = spec.acceptance.filter((line) => line.trim() !== '');

  if (acceptance.length !== spec.acceptance.length) {
    throw invalidArguments(
      'Each acceptance line says one thing the delivery has to do. An empty line says nothing and ' +
        'still changes the commitment, so it is refused rather than dropped.',
    );
  }

  const document: JobDocument = {
    task,
    input: spec.input ?? {},
    ...(acceptance.length === 0 ? {} : { acceptance }),
  };

  const bytes = Buffer.byteLength(canonicalStringify(document, 'spec'), 'utf8');

  if (bytes > MAX_JOB_BYTES) {
    throw invalidArguments(
      `This job serialises to ${bytes} bytes and a provider reads at most ${MAX_JOB_BYTES}. Send the ` +
        'arguments themselves, not a corpus: publish anything larger yourself and reference it from ' +
        'the task.',
      { bytes, maxBytes: MAX_JOB_BYTES },
    );
  }

  return document;
}
