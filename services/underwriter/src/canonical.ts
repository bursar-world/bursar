import { createHash } from 'node:crypto';

import { DocumentError } from './errors.js';

/**
 * The value shapes the canonical encoder accepts. `undefined` members of an object are dropped.
 * That is what lets an extended record stay byte-compatible with the narrower record it grew out
 * of: fields nobody set never reach the preimage.
 */
export type CanonicalValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/**
 * Compact JSON with no whitespace, keys emitted in insertion order.
 *
 * The hash preimage this feeds is pinned by a conformance vector whose roots were produced by a
 * struct serializer, so field order is the declaration order of the record. Sorting here would
 * change every root.
 *
 * A bigint is written as a bare integer literal, which is how a six-decimal micro-USD amount
 * reaches the preimage without ever passing through a float.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      // JSON.stringify owns the escaping rules for control characters and surrogates.
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString(10);
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new DocumentError('canonical JSON admits only safe integers as numbers', { value });
      }
      return value.toString(10);
    case 'object':
      break;
    default:
      throw new DocumentError(`canonical JSON cannot encode ${typeof value}`, { value: String(value) });
  }

  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(canonicalJson).join(',')}]`;
  }

  const record = value as { readonly [key: string]: CanonicalValue | undefined };
  const parts: string[] = [];
  for (const key of Object.keys(record)) {
    const member = record[key];
    if (member === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${parts.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The 32-byte SHA-256 of a canonical encoding, in the 0x form a bytes32 argument takes. */
export function sha256Bytes32(text: string): `0x${string}` {
  return `0x${sha256Hex(text)}`;
}
