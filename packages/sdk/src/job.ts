/**
 * What one agent hands another when it hires it, and how both sides prove what was asked for and
 * what came back.
 *
 * An escrow lock carries two hashes and two strings: a commitment to the request and a commitment
 * to the delivery, each with a URI where the bytes can be read. Nothing on chain says what shape
 * those bytes take, so payer and provider have to agree here or the money sits locked against a
 * document the provider will not read. The agreement is this file and `@bursar/core`'s canonical
 * JSON, which the provider-side worker hashes with too.
 *
 * The document holds the work and nothing else. Who is being paid, how much, for which capability
 * and by when are all on the lock already, and repeating them here would create a second copy
 * that can disagree with the first.
 */

import { canonicalStringify, commitCanonical, toDataUri } from '@bursar/core';
import type { Hex } from 'viem';

import { InvalidArgumentError } from './errors.js';

/** A job as the hiring agent writes it. */
export type JobSpec = {
  /** What is being bought, in words the provider reads. Required: a hire with no brief is a tip. */
  readonly task: string;
  /** The machine arguments the capability runs on. Omitted means none, which commits as `{}`. */
  readonly input?: Record<string, unknown>;
  /** What the payer will judge the delivery against. Omitted means the task text alone. */
  readonly acceptance?: readonly string[];
};

/**
 * The job as it is committed and published: the exact object whose canonical JSON the lock's
 * `inputCommit` covers, and the exact body the provider's capability is called with.
 */
export type JobDocument = {
  readonly task: string;
  readonly input: Record<string, unknown>;
  readonly acceptance?: readonly string[];
};

/**
 * The largest job document a provider will read, one mebibyte, matching the worker's own body
 * limit. Over it the provider refuses the job while the escrow still holds the money, so the
 * funds sit against a document nobody will open until the deadline returns them.
 */
export const MAX_JOB_BYTES = 1_048_576;

const DATA_URI_PREFIX = 'data:application/json;base64,';

/**
 * Normalises a spec into the document both sides hash.
 *
 * Two callers who mean the same job have to produce the same bytes, so an absent `input` and an
 * empty one are one document, and an empty acceptance list is no list rather than a claim that
 * nothing counts.
 */
export function jobDocument(spec: JobSpec): JobDocument {
  const task = typeof spec.task === 'string' ? spec.task.trim() : '';

  if (task === '') {
    throw new InvalidArgumentError(
      'task',
      'A hire needs a task: one line saying what the provider is being paid to do. It is committed ' +
        'with the payment, so it is also what a resolver reads if the delivery is contested.',
    );
  }

  const acceptance = spec.acceptance === undefined ? [] : [...spec.acceptance];

  for (const [index, line] of acceptance.entries()) {
    if (typeof line !== 'string' || line.trim() === '') {
      throw new InvalidArgumentError(
        `acceptance[${index}]`,
        'Each acceptance line says one thing the delivery has to do. An empty line says nothing and ' +
          'changes the commitment, so it is refused rather than dropped.',
      );
    }
  }

  const document: JobDocument = {
    task,
    input: spec.input ?? {},
    ...(acceptance.length === 0 ? {} : { acceptance }),
  };

  const bytes = new TextEncoder().encode(canonicalStringify(document, 'spec')).byteLength;

  if (bytes > MAX_JOB_BYTES) {
    throw new InvalidArgumentError(
      'spec',
      `This job serialises to ${bytes} bytes and a provider reads at most ${MAX_JOB_BYTES}. Send ` +
        'the arguments themselves, not a corpus: publish anything larger yourself and reference it ' +
        'from the task.',
      { bytes, maxBytes: MAX_JOB_BYTES },
    );
  }

  return document;
}

/** The hash the lock carries for a job. The provider recomputes it before it starts work. */
export function jobCommit(spec: JobSpec): Hex {
  return commitCanonical(jobDocument(spec));
}

/**
 * The job inline, as the lock publishes it.
 *
 * A data URI travels with the lock, so a provider can read the brief straight off the chain
 * without a server of the payer's staying up. Anything the payer would rather host is passed as a
 * `deliverFrom` URI instead, and the commitment still pins which bytes were meant.
 */
export function jobURI(spec: JobSpec): string {
  return toDataUri(canonicalStringify(jobDocument(spec), 'spec'));
}

/**
 * Reads a published job back, from the provider's side or the payer's.
 *
 * Only the inline form is decoded. A URI pointing somewhere else is a fetch, and a client library
 * that follows an arbitrary URI on a counterparty's word is a request forgery waiting to be
 * pointed at something internal. Fetch it yourself under your own policy and pass the text here.
 */
export function readJobURI(uri: string): JobDocument {
  if (uri.slice(0, DATA_URI_PREFIX.length).toLowerCase() !== DATA_URI_PREFIX) {
    throw new InvalidArgumentError(
      'uri',
      'This job was not published inline, so there is nothing in the URI itself to read. Fetch it ' +
        'under your own policy and pass the text to parseJobDocument.',
      { uri },
    );
  }

  const payload = uri.slice(DATA_URI_PREFIX.length);

  let text: string;
  try {
    const binary = atob(payload);
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new InvalidArgumentError('uri', 'This job URI is not base64-encoded UTF-8.', { uri });
  }

  return parseJobDocument(text);
}

/** The published bytes as a document, checked for the shape both sides committed to. */
export function parseJobDocument(text: string): JobDocument {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidArgumentError('document', 'This job document is not JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidArgumentError('document', 'A job document is a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const task = record['task'];
  const input = record['input'];
  const acceptance = record['acceptance'];

  if (typeof task !== 'string' || task === '') {
    throw new InvalidArgumentError('document.task', 'A job document names the task it was paid for.');
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InvalidArgumentError('document.input', "A job document's input is a JSON object.");
  }

  if (acceptance !== undefined && !Array.isArray(acceptance)) {
    throw new InvalidArgumentError(
      'document.acceptance',
      "A job document's acceptance is a list of lines, when it carries one at all.",
    );
  }

  return {
    task,
    input: input as Record<string, unknown>,
    ...(acceptance === undefined ? {} : { acceptance: acceptance.map(String) }),
  };
}

/**
 * Whether a delivery is the one the provider committed to.
 *
 * The lock's `outputCommit` is the hash of the delivered document in canonical JSON. Recomputing
 * it is the payer's whole check: bytes that hash to it are the bytes the provider was paid for,
 * and bytes that do not are somebody's later edit, whoever served them.
 *
 * It says nothing about whether the work is good. That judgement is the payer's, and a dispute is
 * where it goes.
 */
export function verifyDelivery(args: { readonly outputCommit: Hex; readonly output: unknown }): boolean {
  return commitCanonical(args.output).toLowerCase() === args.outputCommit.toLowerCase();
}
