import { Buffer } from 'node:buffer';
import { isHex, keccak256, size, toBytes } from 'viem';
import type { Hex } from 'viem';

/**
 * A TypeError that names the member it choked on.
 *
 * An agent assembling arguments for a paid call gets one shot at a commitment, and "canonical
 * JSON does not support bigint" leaves it guessing which of thirty fields was wrong. The path
 * turns that into a one-line fix.
 */
function refuse(path: string, detail: string): TypeError {
  return new TypeError(`Canonical JSON does not support ${detail} (at ${path})`);
}

function serialize(value: unknown, seen: Set<object>, path: string): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw refuse(path, 'non-finite numbers');
    return JSON.stringify(value);
  }

  if (typeof value === 'bigint') {
    // A bigint has no JSON form, and guessing one commits to bytes the payee cannot reproduce.
    throw refuse(path, 'bigint; send a large integer as a string');
  }

  if (typeof value !== 'object') throw refuse(path, typeof value);
  if (seen.has(value)) throw refuse(path, 'cyclic values');

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      // Array.from visits the holes that map skips; JCS emits null for them, as JSON.stringify does.
      const items = Array.from(value, (item, index) =>
        item === undefined ? 'null' : serialize(item, seen, `${path}[${index}]`),
      );

      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw refuse(path, 'anything but plain objects');
    }

    const source = value as Record<string, unknown>;
    // Members are emitted here rather than via JSON.stringify because JavaScript hoists
    // integer-like keys ahead of the sorted order that JCS requires.
    const members = Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(source[key], seen, `${path}.${key}`)}`);

    return `{${members.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Serializes JSON as UTF-8-ready text with recursively sorted object keys and no whitespace.
 * Output follows RFC 8785 (JCS): keys sort by UTF-16 code unit, numbers take their ECMAScript
 * form. Two parties that never exchange bytes still agree on the hash of the same document.
 */
export function canonicalStringify(value: unknown, label = 'input'): string {
  return serialize(value, new Set(), label);
}

/**
 * The commitment a lock carries for its input, and a released lock carries for its output. The
 * escrow stores the hash alone, so the payload can live anywhere the two parties agree on while
 * the chain still pins which payload was meant.
 */
export function commitCanonical(value: unknown): Hex {
  return keccak256(toBytes(canonicalStringify(value)));
}

/**
 * Hashes a `"name:version"` capability label, for example `"gpu.render:1"`. The label is hashed
 * as raw UTF-8, not as canonical JSON, so it never gains quotes.
 */
export function capabilityId(capability: string): Hex {
  return keccak256(toBytes(capability));
}

/**
 * A capability as either form: a label to hash, or an id already computed. Labels are the
 * developer-facing spelling and ids are what the contract holds, and a caller should not have to
 * decide which one an argument wants.
 */
export function toCapabilityId(capability: string): Hex {
  return isHex(capability) && size(capability) === 32 ? capability : capabilityId(capability);
}

/**
 * Publishes the committed bytes inline, so a payee can verify the commitment straight from the
 * lock without fetching anything. Large payloads belong behind a URI of the caller's own.
 */
export function toDataUri(canonical: string): string {
  return `data:application/json;base64,${Buffer.from(toBytes(canonical)).toString('base64')}`;
}
