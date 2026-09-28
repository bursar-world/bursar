import type { OutboxMessage, SinkResult, TrustEventSink } from './types.js';

/**
 * Delivers a batch over HTTP to whatever consumes trust events.
 *
 * The consumer may answer in two ways. A plain 2xx accepts the whole batch, which is all a simple
 * receiver needs to implement. A 2xx carrying `{"accepted": ["<eventId>", ...]}` accepts part of
 * one. A receiver can then take what it can parse and leave the rest to be retried or quarantined
 * individually, without failing the batch for one bad message.
 */

export type HttpSinkOptions = {
  readonly url: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly name?: string;
};

/** 4xx other than these will fail the same way for ever, so retrying only delays the diagnosis. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 423, 425, 429]);

function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status);
}

export function createHttpSink(options: HttpSinkOptions): TrustEventSink {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    name: options.name ?? 'http',

    async deliver(messages: readonly OutboxMessage[]): Promise<SinkResult> {
      if (messages.length === 0) {
        return { delivered: [], statusCode: null, error: null, permanent: false };
      }

      const body = JSON.stringify({ events: messages.map((message) => message.payload) });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;

      let response: Response;
      try {
        response = await fetchFn(options.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // A transport failure says nothing about the message, so it is always worth another try.
        return {
          delivered: [],
          statusCode: null,
          error: error instanceof Error ? error.message : String(error),
          permanent: false,
        };
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return {
          delivered: [],
          statusCode: response.status,
          error: `${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
          permanent: isPermanent(response.status),
        };
      }

      const answer = await readAccepted(response);

      // A consumer that set out to answer in the documented shape and produced something else has
      // not told us what it took. Reading that as the whole batch drops every event in it, for
      // good, on the word of a body nobody could parse.
      if (answer.kind === 'unreadable') {
        return {
          delivered: [],
          statusCode: response.status,
          error: `consumer answered ${response.status} with ${answer.detail}`,
          permanent: false,
        };
      }

      if (answer.kind === 'whole') {
        return {
          delivered: messages.map((message) => message.eventId),
          statusCode: response.status,
          error: null,
          permanent: false,
        };
      }

      const known = new Set(messages.map((message) => message.eventId));
      const delivered = answer.ids.filter((id) => known.has(id));
      return {
        delivered,
        statusCode: response.status,
        error:
          delivered.length === messages.length
            ? null
            : `consumer accepted ${delivered.length} of ${messages.length}`,
        permanent: false,
      };
    },
  };
}

/**
 * What a 2xx said about the events in the batch.
 *
 * `whole` is the documented plain acceptance: an empty body, or any body from a consumer that never
 * claimed to be sending JSON. `unreadable` is a consumer that declared JSON and then sent something
 * this cannot be read out of, which is a delivery to try again rather than a batch to discard.
 */
type Acceptance =
  | { readonly kind: 'whole' }
  | { readonly kind: 'partial'; readonly ids: string[] }
  | { readonly kind: 'unreadable'; readonly detail: string };

async function readAccepted(response: Response): Promise<Acceptance> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) return { kind: 'whole' };
  if (!/\bjson\b/i.test(response.headers.get('content-type') ?? '')) return { kind: 'whole' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', detail: 'a body it declared as JSON and that is not' };
  }

  if (!parsed || typeof parsed !== 'object') return { kind: 'whole' };
  const accepted = (parsed as { accepted?: unknown }).accepted;
  if (accepted === undefined) return { kind: 'whole' };
  if (!Array.isArray(accepted) || accepted.some((id) => typeof id !== 'string')) {
    return { kind: 'unreadable', detail: 'an "accepted" field that is not a list of event ids' };
  }
  return { kind: 'partial', ids: accepted as string[] };
}
