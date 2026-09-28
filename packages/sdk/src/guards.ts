import { getAddress, isHex, size } from 'viem';
import type { Address, Hex } from 'viem';
import type { Micro } from '@bursar/core';

import { InvalidArgumentError } from './errors.js';

export const UINT64_MAX = 2n ** 64n - 1n;
export const UINT128_MAX = 2n ** 128n - 1n;
export const UINT256_MAX = 2n ** 256n - 1n;

/**
 * Range-checks a value against the field it is headed for. An out-of-range amount fails with the
 * field name attached, not as an ABI encoding error a long way from the call.
 *
 * The type is checked as well as the range. TypeScript says this is a bigint, and a JavaScript
 * caller, a JSON payload or a value read out of a database says otherwise often enough that the
 * comparisons below would wave `1.5` and `"abc"` straight through to viem.
 */
export function checkRange(field: string, value: bigint, max: bigint): bigint {
  if (typeof value !== 'bigint') {
    throw new InvalidArgumentError(
      field,
      `${field} must be a bigint, received ${describe(value)}. Amounts are integers, never floats: ` +
        'write 1.5 USDG as 1500000n micro-USD.',
      { value: String(value), type: typeof value },
    );
  }

  if (value < 0n || value > max) {
    throw new InvalidArgumentError(
      field,
      `${field} must be between 0 and ${max}, received ${value}.`,
      { value: value.toString(), max: max.toString() },
    );
  }

  return value;
}

/** An amount of the settlement asset, checked against the uint128 the contracts hold it in. */
export function checkAmount(field: string, value: Micro): Micro {
  checkRange(field, value, UINT128_MAX);
  return value;
}

/** An amount that has to move money. Zero is refused by the account, and rejected here first. */
export function checkPositiveAmount(field: string, value: Micro): Micro {
  if (typeof value === 'bigint' && value <= 0n) {
    throw new InvalidArgumentError(field, `${field} must be greater than zero, received ${value}.`, {
      value: value.toString(),
    });
  }

  return checkAmount(field, value);
}

/** Seconds, as a caller spells them, checked against the uint64 the contracts hold them in. */
export function toSeconds(field: string, value: number | bigint): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidArgumentError(field, `${field} must be a whole number of seconds, received ${value}.`, {
        value,
      });
    }

    return checkRange(field, BigInt(value), UINT64_MAX);
  }

  if (typeof value !== 'bigint') {
    throw new InvalidArgumentError(
      field,
      `${field} must be a whole number of seconds, received ${describe(value)}.`,
      { value: String(value), type: typeof value },
    );
  }

  return checkRange(field, value, UINT64_MAX);
}

/** An escrow lock id, checked against the uint256 the escrow issues them in. */
export function checkEscrowId(field: string, value: bigint): bigint {
  return checkRange(field, value, UINT256_MAX);
}

/** A 32-byte value: a capability id, a commitment, a Merkle root, an approval id. */
export function checkBytes32(field: string, value: Hex): Hex {
  if (typeof value !== 'string' || !isHex(value) || size(value) !== 32) {
    throw new InvalidArgumentError(field, `${field} must be 32 bytes of hex, received ${describe(value)}.`, {
      value: String(value),
    });
  }

  return value;
}

/**
 * An address a caller supplied, checksummed.
 *
 * Every address here decides where funds land or who may move them. A typo has to stop at the
 * field that took it, not inside an ABI encoder with no idea which argument it was. Casing is not
 * a check: the contracts compare raw bytes, and rejecting a lowercase address would reject the
 * form most tools print. What comes back is the checksummed spelling of what went in.
 */
export function checkAddress(field: string, value: Address): Address {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(field, `${field} must be a 0x address, received ${describe(value)}.`, {
      value: String(value),
      type: typeof value,
    });
  }

  try {
    return getAddress(value);
  } catch {
    throw new InvalidArgumentError(field, `${field} is not a 0x address: ${value}`, { value });
  }
}

/**
 * A capability, as either spelling: a `"name:version"` label or a 32-byte id.
 *
 * Checked because the hashing step never fails. A number, an object or a null hashes to a
 * perfectly valid capability id that no mandate has ever allowed. The payment carrying it is
 * refused on chain, and the reason names the capability, never the argument.
 */
export function checkCapability(field: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidArgumentError(
      field,
      `${field} must be a capability label such as "gpu.render:1", or a 32-byte id. Received ` +
        `${describe(value)}.`,
      { value: String(value), type: typeof value },
    );
  }

  return value;
}

/**
 * A signature, as the contracts take it: bytes of any length, or `0x` for none.
 *
 * Length is the contract's business, but hex is not. viem does not check a `bytes` argument at
 * all, so `"nope"` encodes as its own four ASCII bytes and the mistake arrives as a paid-for
 * revert instead of an argument error.
 */
export function checkSignature(field: string, value: Hex | undefined): Hex {
  if (value === undefined) return '0x';

  if (typeof value !== 'string' || !isHex(value)) {
    throw new InvalidArgumentError(field, `${field} must be 0x-prefixed hex, received ${describe(value)}.`, {
      value: String(value),
    });
  }

  return value;
}

/** Each node of a Merkle proof. A wrong-length node names its own position in the error. */
export function checkProof(field: string, value: readonly Hex[]): readonly Hex[] {
  if (!Array.isArray(value)) {
    throw new InvalidArgumentError(field, `${field} must be an array of 32-byte proof nodes.`, {
      type: typeof value,
    });
  }

  return value.map((node, index) => checkBytes32(`${field}[${index}]`, node));
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return value === null ? 'null' : 'an object';

  return String(value);
}
