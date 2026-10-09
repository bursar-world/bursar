import { formatMicro, MICRO_SCALE } from '@bursar/core';
import type { Micro } from '@bursar/core';

/**
 * USDG for a screen. `@bursar/core` owns the arithmetic and the exact string; these are the two
 * readings a surface wants, and they exist so every amount in the product is spaced and
 * suffixed the same way.
 */
export function usd(value: Micro): string {
  return formatMicro(toCents(value), { minDecimals: 2, maxDecimals: 2, grouped: true, symbol: true });
}

const CENT = 10_000n;

/**
 * The nearest cent, half away from zero. Cutting the digits instead shows 0.079952 as $0.07 and
 * 0.0099 paid to a provider as $0.00, which reads as nothing arrived.
 */
export function toCents(value: Micro): Micro {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rounded = ((magnitude + CENT / 2n) / CENT) * CENT;
  return (negative ? -rounded : rounded) as Micro;
}

/** Full six-decimal precision, for a fee or a gas figure where the last digits carry meaning. */
export function usdExact(value: Micro): string {
  return formatMicro(value, { minDecimals: 2, maxDecimals: 6, grouped: true, symbol: true });
}

/**
 * A payout or refund in a sentence: cents from a dollar up, where the last digits are noise, and every
 * digit below one, where rounding would make a fee taken from $0.0995 vanish into "$0.10 of the $0.10".
 */
export function usdShare(value: Micro): string {
  const magnitude = value < 0n ? -value : value;
  return magnitude >= DOLLAR ? usd(value) : usdExact(value);
}

const DOLLAR = 1_000_000n;

/** Cents, unless rounding would show a balance that holds something as $0.00. */
export function usdHeld(value: Micro): string {
  return value > 0n && toCents(value) === 0n ? usdExact(value) : usd(value);
}

export function usdg(value: Micro): string {
  return `${formatMicro(value, { minDecimals: 2, maxDecimals: 6, grouped: true })} USDG`;
}

/** A share of a whole, 0 to 100, for a bar or a label. Returns null when the whole is zero. */
export function shareOf(part: Micro, whole: Micro): number | null {
  if (whole <= 0n) return null;
  return Number((part * 10_000n) / whole) / 100;
}

/** Basis points as a percentage string: 200 reads "2%". */
export function bps(value: number): string {
  const percent = value / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

export { MICRO_SCALE };
