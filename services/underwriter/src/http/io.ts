import type { IncomingMessage, ServerResponse } from 'node:http';

import { BodyTooLargeError } from '../errors.js';
import { RequestError } from '../errors.js';

/*
 * Every amount here is a bigint and JSON has one number type, a double. `JSON.stringify` throws on
 * a bigint, so they are written as strings at this one place and read back as strings at the
 * other end.
 */

export const MAX_BODY_BYTES = 64 * 1_024;

export type ApiRequest = {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
};

export type ApiResponse = {
  readonly status: number;
  readonly body: unknown;
};

export const ok = (body: unknown): ApiResponse => ({ status: 200, body });

export const failure = (status: number, error: string, detail?: string): ApiResponse => ({
  status,
  body: detail ? { error, detail } : { error },
});

export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString(10) : item));
}

export async function readBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLargeError(`The request body is limited to ${MAX_BODY_BYTES} bytes.`);
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
      throw new BodyTooLargeError(`The request body is limited to ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }

  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) return {};

  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new RequestError('The request body is not valid JSON.');
  }
}

export function send(response: ServerResponse, result: ApiResponse): void {
  const payload = encodeJson(result.body ?? {});
  response.writeHead(result.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function bearer(headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.toLowerCase().startsWith('bearer ')) return null;
  return value.slice(7).trim();
}

/**
 * Constant-time comparison. A byte-by-byte early exit leaks the token's prefix to anyone who can
 * measure the response, which is a slow but practical way to recover it.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null || presented.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}
