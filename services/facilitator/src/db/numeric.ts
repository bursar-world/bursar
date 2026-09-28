import { BursarError, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';

/**
 * The boundary between a `Micro` bigint and a NUMERIC(20,6) money column.
 *
 * Money columns hold atomic micro-USD, matching `microToAtomicString` in the core package and the
 * six-decimal units the contracts and x402 payloads already use. The declared scale of six is
 * never used: every value is an integer, every delta the ledger applies is an integer, and each
 * money column carries a CHECK that pins the fraction to zero. A column that ever comes back with
 * a fractional part means something outside this service wrote to the ledger, and reading one
 * throws.
 *
 * Precision 20 with scale 6 leaves fourteen integer digits, so one column tops out a shade under
 * 100,000,000 USDG. That is the per-row ceiling for a balance, a debt, or a pool reserve.
 */

/** Largest value a NUMERIC(20,6) money column can hold once the fraction is pinned to zero. */
export const MAX_COLUMN_MICRO = 99_999_999_999_999n as Micro;

export class NumericColumnError extends BursarError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('numeric_column_invalid', message, details);
    this.name = 'NumericColumnError';
  }
}

/** Binds an amount for insertion. Postgres widens the integer to the column's scale itself. */
export function microToNumeric(value: Micro): string {
  if (value > MAX_COLUMN_MICRO || value < -MAX_COLUMN_MICRO) {
    throw new NumericColumnError(
      `${value} micro-USD exceeds what a NUMERIC(20,6) money column can hold`,
      { value: value.toString(), max: MAX_COLUMN_MICRO.toString() },
    );
  }
  return value.toString();
}

/**
 * Reads a money column back.
 *
 * Postgres renders NUMERIC(20,6) with its declared scale, so `1500000` comes back as
 * `1500000.000000`. The trailing zeros are dropped here. A non-zero fraction is sub-micro dust
 * that no code path in this service can produce, so it is reported.
 */
export function numericToMicro(raw: string | number | null | undefined, column: string): Micro {
  if (raw === null || raw === undefined) return 0n as Micro;

  const text = typeof raw === 'number' ? String(raw) : raw.trim();
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new NumericColumnError(`column ${column} holds "${text}", which is not a NUMERIC value`, {
      column,
      raw: text,
    });
  }

  const fraction = match[2] ?? '';
  if (fraction.length > 0 && /[^0]/.test(fraction)) {
    throw new NumericColumnError(
      `column ${column} holds ${text}, a fraction of one micro-USD; the ledger stores atomic units only`,
      { column, raw: text },
    );
  }

  return toMicro(match[1] ?? '0');
}

/** Reads an optional money column, keeping the difference between unset and zero. */
export function optionalNumericToMicro(
  raw: string | number | null | undefined,
  column: string,
): Micro | null {
  if (raw === null || raw === undefined) return null;
  return numericToMicro(raw, column);
}

/** Reads a bigint-valued count column, which Postgres also renders as a string. */
export function countToNumber(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const value = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}
