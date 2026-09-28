import { getAddress, isHex } from 'viem';
import { micro, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Authorization, Permit, Permit2Transfer, PaymentRequirements } from './types.js';

/**
 * Narrowing of everything a payer sends.
 *
 * The payment header is attacker controlled, so nothing here trusts a declared type. Each reader
 * returns the narrowed value or null, and the verifier turns null into a refusal reason. Amounts
 * come back as `Micro`, six-decimal atomic units, which is the only representation of money this
 * repo has.
 */
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Every field read by `readUint` is encoded as a Solidity `uint256` further down. A larger value
 * has no on-chain meaning, and left unchecked it reaches viem's encoder, which throws where the
 * verifier is supposed to be returning a refusal.
 */
const UINT256_MAX = 2n ** 256n - 1n;

export function readAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== 'string') return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

export function sameAddress(a: unknown, b: unknown): boolean {
  const left = readAddress(a);
  const right = readAddress(b);
  return left !== null && right !== null && left === right;
}

/** Atomic units from a wire value. Rejects decimals, exponents and unsafe numbers. */
export function readMicro(value: unknown): Micro | null {
  // Amounts are uint256 on chain too, so the same bound applies (see UINT256_MAX).
  if (typeof value === 'bigint') return inRange(value) === null ? null : micro(value);
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const amount = toMicro(value);
    return inRange(amount) === null ? null : amount;
  } catch {
    return null;
  }
}

function readUint(value: unknown): bigint | null {
  if (typeof value === 'bigint') return inRange(value);
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.trim())) return null;
  return inRange(BigInt(value.trim()));
}

function inRange(value: bigint): bigint | null {
  return value >= 0n && value <= UINT256_MAX ? value : null;
}

export function readBytes32(value: unknown): `0x${string}` | null {
  return typeof value === 'string' && BYTES32.test(value) ? (value.toLowerCase() as `0x${string}`) : null;
}

export function readSignature(value: unknown): `0x${string}` | null {
  if (typeof value !== 'string' || !isHex(value)) return null;
  // 65 bytes for an EOA, longer for a contract wallet's EIP-1271 blob. Anything shorter than a
  // single word is not a signature in any scheme and would only reach the chain to revert.
  return value.length >= 66 ? (value as `0x${string}`) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readAuthorization(value: unknown): Authorization | null {
  const source = record(value);
  if (source === null) return null;

  const from = readAddress(source['from']);
  const to = readAddress(source['to']);
  const amount = readMicro(source['value']);
  const validAfter = readUint(source['validAfter']);
  const validBefore = readUint(source['validBefore']);
  const nonce = readBytes32(source['nonce']);
  if (from === null || to === null || amount === null) return null;
  if (validAfter === null || validBefore === null || nonce === null) return null;

  return { from, to, value: amount, validAfter, validBefore, nonce };
}

export function readPermit(value: unknown): Permit | null {
  const source = record(value);
  if (source === null) return null;

  const owner = readAddress(source['owner']);
  const spender = readAddress(source['spender']);
  const amount = readMicro(source['value']);
  const nonce = readUint(source['nonce']);
  const deadline = readUint(source['deadline']);
  if (owner === null || spender === null || amount === null) return null;
  if (nonce === null || deadline === null) return null;

  return { owner, spender, value: amount, nonce, deadline };
}

export function readPermit2(value: unknown): Permit2Transfer | null {
  const source = record(value);
  if (source === null) return null;

  const owner = readAddress(source['owner']);
  const token = readAddress(source['token']);
  const spender = readAddress(source['spender']);
  const amount = readMicro(source['amount']);
  const nonce = readUint(source['nonce']);
  const deadline = readUint(source['deadline']);
  if (owner === null || token === null || spender === null || amount === null) return null;
  if (nonce === null || deadline === null) return null;

  return { owner, token, spender, amount, nonce, deadline };
}

/**
 * The amount a payment must carry.
 *
 * Version 1 calls it `maxAmountRequired` and version 2 calls it `amount`. The scheme is `exact`,
 * so despite the v1 name it is never a ceiling: a payment for more is refused as firmly as one
 * for less.
 */
export function requiredAmount(requirements: PaymentRequirements): Micro | null {
  const raw = requirements.amount ?? requirements.maxAmountRequired;
  if (raw === undefined || raw === null) return null;
  return readMicro(raw);
}
