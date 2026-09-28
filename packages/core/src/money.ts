import { BursarError } from './errors.js';

/**
 * One unit system end to end: six-decimal micro-USD held as a bigint.
 *
 * The ledger column is NUMERIC(20,6), x402 payloads carry six-decimal atomic units, USDG has six
 * decimals, and the contracts take uint128 in the same units. Nothing here converts to or from
 * the eighteen-decimal native asset, because on Robinhood Chain that asset is ETH: a different
 * thing, at a price this package does not know and will not guess. Gas lives in gas-float.ts,
 * measured in wei and branded so it cannot be added to a payment.
 */
declare const microUsd: unique symbol;
export type Micro = bigint & { readonly [microUsd]: true };

export const MICRO_DECIMALS = 6;
export const MICRO_SCALE = 1_000_000n;
export const ZERO_MICRO = 0n as Micro;

export class MoneyError extends BursarError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('money_invalid', message, details);
  }
}

/** Brands an amount that is already in atomic units. No conversion happens. */
export function micro(atomic: bigint): Micro {
  return atomic as Micro;
}

/**
 * Accepts the wire forms atomic units arrive in: a bigint from a contract read, a string from a
 * JSON payload or a NUMERIC column, or a number from JSON that has not lost precision yet.
 * Numbers that are not safe integers are rejected rather than rounded, since a float here is the
 * exact failure this type exists to prevent.
 */
export function toMicro(atomic: bigint | number | string): Micro {
  if (typeof atomic === 'bigint') return atomic as Micro;

  if (typeof atomic === 'number') {
    if (!Number.isSafeInteger(atomic)) {
      throw new MoneyError(
        `${atomic} is not a safe integer number of micro-USD. Pass atomic units as a bigint or a string.`,
        { input: atomic },
      );
    }
    return BigInt(atomic) as Micro;
  }

  const trimmed = atomic.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new MoneyError(`"${atomic}" is not an integer number of micro-USD atomic units.`, {
      input: atomic,
    });
  }
  return BigInt(trimmed) as Micro;
}

/**
 * Parses a decimal USD string such as "12.50" into micro-USD. Strict: no exponents, no thousands
 * separators, no more than six decimal places, and no bare "." on either side. An input
 * with seven decimals is a unit mistake somewhere upstream, and silently truncating it hides that.
 */
export function parseMicro(decimal: string): Micro {
  const input = decimal.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(input);
  if (!match) {
    throw new MoneyError(
      `"${decimal}" is not a USD amount with at most ${MICRO_DECIMALS} decimal places.`,
      { input: decimal },
    );
  }

  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';
  const scaled = BigInt(whole) * MICRO_SCALE + BigInt(fraction.padEnd(MICRO_DECIMALS, '0'));
  return (sign === '-' ? -scaled : scaled) as Micro;
}

export type FormatOptions = {
  /** Always show at least this many decimal places. Two keeps whole amounts reading as money. */
  readonly minDecimals?: number;
  /** Never show more than this many. Six is the full precision the ledger holds. */
  readonly maxDecimals?: number;
  /** Thousands separators. Off by default so output stays safe to round-trip through parseMicro. */
  readonly grouped?: boolean;
  /** Prefix with "$". */
  readonly symbol?: boolean;
};

/**
 * Display only. Never parse the result of this back into an amount for arithmetic; `maxDecimals`
 * truncates, and a grouped string is not valid input to parseMicro.
 */
export function formatMicro(value: Micro, options: FormatOptions = {}): string {
  const { minDecimals = 2, maxDecimals = MICRO_DECIMALS, grouped = false, symbol = false } = options;
  if (minDecimals < 0 || maxDecimals > MICRO_DECIMALS || minDecimals > maxDecimals) {
    throw new MoneyError(
      `Decimal bounds must satisfy 0 <= minDecimals <= maxDecimals <= ${MICRO_DECIMALS}.`,
      { minDecimals, maxDecimals },
    );
  }

  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / MICRO_SCALE;
  const fraction = (magnitude % MICRO_SCALE).toString().padStart(MICRO_DECIMALS, '0');

  let shown = fraction.slice(0, maxDecimals);
  while (shown.length > minDecimals && shown.endsWith('0')) shown = shown.slice(0, -1);

  const head = grouped ? whole.toLocaleString('en-US') : whole.toString();
  const body = shown.length > 0 ? `${head}.${shown}` : head;
  return `${negative ? '-' : ''}${symbol ? '$' : ''}${body}`;
}

export function addMicro(...values: readonly Micro[]): Micro {
  let total = 0n;
  for (const value of values) total += value;
  return total as Micro;
}

export function subMicro(a: Micro, b: Micro): Micro {
  return (a - b) as Micro;
}

export function negMicro(value: Micro): Micro {
  return -value as Micro;
}

/**
 * Basis points, truncated toward zero to match how the contracts compute fees in Solidity. Any
 * other rounding puts the off-chain expectation a wei away from what settles.
 */
export function mulBps(value: Micro, bps: number): Micro {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new MoneyError(`Basis points must be a non-negative integer, got ${bps}.`, { bps });
  }
  return ((value * BigInt(bps)) / 10_000n) as Micro;
}

export function minMicro(a: Micro, b: Micro): Micro {
  return a < b ? a : b;
}

export function maxMicro(a: Micro, b: Micro): Micro {
  return a > b ? a : b;
}

export function clampMicro(value: Micro, low: Micro, high: Micro): Micro {
  if (low > high) {
    throw new MoneyError('Clamp bounds are inverted.', { low: low.toString(), high: high.toString() });
  }
  return minMicro(maxMicro(value, low), high);
}

export function compareMicro(a: Micro, b: Micro): -1 | 0 | 1 {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function isPositiveMicro(value: Micro): boolean {
  return value > 0n;
}

/** Guards the boundary where a negative amount would be a debit the caller did not intend. */
export function assertNonNegative(value: Micro, label: string): Micro {
  if (value < 0n) {
    throw new MoneyError(`${label} must not be negative, got ${formatMicro(value)}.`, {
      label,
      value: value.toString(),
    });
  }
  return value;
}

/** The form a NUMERIC(20,6) column and an x402 payload both want: plain atomic units. */
export function microToAtomicString(value: Micro): string {
  return value.toString();
}
