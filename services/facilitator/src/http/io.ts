import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestError } from '../errors.js';

/**
 * Reading a request and writing a response, with two rules that are not negotiable.
 *
 * The raw bytes of the body are kept alongside the parsed object, because a payment is signed over
 * exactly what the client sent. Hashing a round-tripped object would compute a digest of something
 * nobody signed.
 *
 * Amounts are serialised as strings. Every money value in this service is a bigint, JSON has one
 * number type and it is a double, and `JSON.stringify` throws on a bigint. Turning them into
 * strings at the edge is the only representation that survives.
 */

export const MAX_BODY_BYTES = 64 * 1_024;

export type ApiRequest = {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly bytes: Uint8Array;
  /** The peer's address on the socket. Absent where a test builds a request by hand. */
  readonly remoteAddress?: string;
};

export type ApiResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

export function ok(body: unknown, headers?: Readonly<Record<string, string>>): ApiResponse {
  return { status: 200, body, headers };
}

export function created(body: unknown): ApiResponse {
  return { status: 201, body };
}

export function failure(status: number, error: string, detail?: string): ApiResponse {
  return { status, body: detail ? { error, detail } : { error } };
}

/** bigint to string, everywhere, at one place in the pipeline. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

export async function readBody(request: IncomingMessage): Promise<{ body: unknown; bytes: Uint8Array }> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RequestError(413, 'body_too_large', `The request body is limited to ${MAX_BODY_BYTES} bytes.`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      // Stop reading, but leave the socket alone: destroying it here kills the connection before
      // the 413 is written, so the client sees a reset and never learns why. Nothing further is
      // buffered, and node discards the rest of the body once the response is sent.
      request.pause();
      throw new RequestError(413, 'body_too_large', `The request body is limited to ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }

  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) return { body: {}, bytes };

  try {
    return { body: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
  } catch {
    throw new RequestError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

export function send(response: ServerResponse, result: ApiResponse): void {
  const payload = encodeJson(result.body ?? {});
  response.writeHead(result.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...result.headers,
  });
  response.end(payload);
}

export function bearer(headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.toLowerCase().startsWith('bearer ')) return null;
  return value.slice(7).trim();
}

/**
 * Constant-time comparison of the presented token against the configured one.
 *
 * A byte-by-byte early exit leaks the token's prefix to anyone who can measure the response, which
 * is a slow but entirely practical way to recover it.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null || presented.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}
